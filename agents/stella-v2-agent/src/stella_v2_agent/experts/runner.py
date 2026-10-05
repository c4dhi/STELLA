"""Expert runner: executes a single expert LLM call and returns a structured verdict.

Each expert gets:
- Its own system prompt (compiled with {{placeholder}} resolution)
- User input + conversation history
- JSON mode OR tool calling depending on can_call_functions

The runner handles timeouts, parsing, and error recovery.
"""

import asyncio
import json
import re
import time
from typing import Dict, Any, List, Optional

from stella_agent_sdk.tools import BaseTool
from stella_agent_sdk import prompts as sdk_prompts

from stella_v2_agent.experts.base import ExpertConfig
from stella_v2_agent.experts.template_compiler import (
    has_user_message_placeholder,
    HISTORY_PATTERN,
)
from stella_v2_agent.models.expert_verdict import ExpertVerdict
from stella_agent_sdk.llm import LLMService, LLMConfig, LLMMessage, LLMProvider
import logging

logger = logging.getLogger(__name__)


class ExpertRunner:
    """Runs a single expert and returns a structured ExpertVerdict.

    Supports two execution modes:
    - JSON mode (default): LLM returns structured JSON, parsed into verdict
    - Tool mode (can_call_functions=True): LLM calls tools directly, results tracked in verdict

    The runner:
    1. Compiles the expert's system prompt (resolves {{placeholder}} tokens)
    2. Builds the user message (conversation history + current message)
    3. Calls the LLM (JSON mode or tool mode)
    4. Parses/executes results into an ExpertVerdict
    5. Handles timeouts and failures gracefully
    """

    def __init__(self, llm_service: LLMService, *, compiler_version: str):
        """Args:
            llm_service: Shared LLM service used for expert calls.
            compiler_version: Prompt-compiler version this runner resolves
                {{placeholder}} tokens with. Required and explicit — there is no
                implicit "latest", so an SDK upgrade can't silently change how an
                expert's prompt compiles. Threaded down from the agent's pinned
                PROMPT_COMPILER_VERSION (overridable per deployment via config).
        """
        self._llm_service = llm_service
        self._compiler_version = compiler_version

    async def run(
        self,
        config: ExpertConfig,
        user_input: str,
        conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any],
        tools: Optional[List[BaseTool]] = None,
    ) -> ExpertVerdict:
        """Execute a single expert and return its verdict.

        Args:
            config: The expert's configuration.
            user_input: Current user message.
            conversation_history: Recent conversation messages.
            sm_context: State machine context for {{placeholder}} resolution.
            tools: Available tools (only used when config.can_call_functions=True).

        Returns:
            ExpertVerdict with the expert's structured response.
        """
        if config.can_call_functions and tools:
            return await self._run_with_tools(config, user_input, conversation_history, sm_context, tools)
        return await self._run_json_mode(config, user_input, conversation_history, sm_context)

    async def _run_json_mode(
        self,
        config: ExpertConfig,
        user_input: str,
        conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any],
    ) -> ExpertVerdict:
        """Execute expert in JSON mode (structured JSON output)."""
        start_time = time.time()

        try:
            messages = self._build_messages(config, user_input, conversation_history, sm_context)
            llm_config = self._build_llm_config(config)

            response = await self._llm_service.generate(
                messages=messages,
                config=llm_config,
                component_name=f"expert:{config.name}",
            )

            latency_ms = (time.time() - start_time) * 1000

            return self._parse_verdict(config, response.content, latency_ms)

        except Exception as e:
            latency_ms = (time.time() - start_time) * 1000
            logger.error(f"Expert '{config.name}' failed: {e}")
            return ExpertVerdict(
                expert_name=config.name,
                verdict="error",
                confidence=0.0,
                recommendation=f"Expert failed: {str(e)[:100]}",
                priority=config.priority,
                latency_ms=latency_ms,
                success=False,
                error_message=str(e),
            )

    async def _run_with_tools(
        self,
        config: ExpertConfig,
        user_input: str,
        conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any],
        tools: List[BaseTool],
    ) -> ExpertVerdict:
        """Execute expert in tool-calling mode.

        Single LLM call with tools enabled. The LLM calls tools (e.g.
        set_deliverable, complete_task) which execute against the backend
        state machine directly. No agentic loop — one call, execute tools, done.
        """
        start_time = time.time()

        try:
            # Build messages — same as JSON mode but without output_format. The
            # canonical tool-usage contract is auto-injected from the SDK (single
            # source of truth) — tool-calling experts must NOT hand-write it in
            # their prompt.
            messages = self._build_messages(
                config, user_input, conversation_history, sm_context,
                append_output_format=False,
                tools=tools,
            )

            # Use OPENAI_DIRECT provider (supports tool calling, unlike LANGCHAIN)
            tool_schemas = [t.to_openai_schema() for t in tools]
            llm_config = LLMConfig(
                model=config.model,
                temperature=config.temperature,
                max_tokens=config.max_tokens,
                provider=LLMProvider.OPENAI_DIRECT,
                streaming=False,
                json_mode=False,
                tools=tool_schemas,
                tool_choice="auto",
            )

            response = await self._llm_service.generate(
                messages=messages,
                config=llm_config,
                component_name=f"expert:{config.name}",
            )

            # Execute tool calls in parallel
            deliverables_set: List[str] = []
            tasks_completed: List[str] = []
            tool_calls_made: List[Dict[str, Any]] = []
            # Initialise here so the session_completed scan below is always safe,
            # even when the LLM returns no tool calls.
            results: List[Dict[str, Any]] = []

            if response.tool_calls:
                tool_map = {t.name: t for t in tools}

                async def _execute_single(tc):
                    tool = tool_map.get(tc.name)
                    if not tool:
                        return {"name": tc.name, "error": f"Unknown tool: {tc.name}", "success": False}
                    try:
                        result = await tool.execute(**tc.arguments)
                        entry = {
                            "name": tc.name,
                            "arguments": tc.arguments,
                            "success": result.success,
                            "data": result.data,
                        }
                        if not result.success and result.error:
                            entry["error"] = result.error
                        return entry
                    except Exception as e:
                        return {"name": tc.name, "arguments": tc.arguments, "error": str(e), "success": False}

                results = await asyncio.gather(*[_execute_single(tc) for tc in response.tool_calls])

                for r in results:
                    tool_calls_made.append(r)
                    if r["name"] == "batch_update":
                        # batch_update can have partial success; still surface any
                        # successful deliverables/tasks included in its data payload.
                        data = r.get("data", {}) or {}
                        for d in data.get("deliverables_set", []):
                            if d.get("key"):
                                deliverables_set.append(d["key"])
                        for t in data.get("tasks_completed", []):
                            if t.get("task_id"):
                                tasks_completed.append(t["task_id"])
                    elif r.get("success"):
                        if r["name"] == "set_deliverable":
                            key = r.get("arguments", {}).get("key")
                            if key:
                                deliverables_set.append(key)
                        elif r["name"] == "complete_task":
                            task_id = r.get("arguments", {}).get("task_id")
                            if task_id:
                                tasks_completed.append(task_id)

            # Check if any tool result signals that the plan reached __end__.
            # We only need the first match — all tool calls within a turn share the same session.
            session_completed = False
            farewell_message: Optional[str] = None
            summary_behavior: Optional[str] = None
            # Whether a tool advanced the state machine this turn, and where to.
            # Surfaced so the response can be re-anchored to the new phase without
            # re-querying the backend (agent.py _resolve_response_context).
            transitioned = False
            new_state_id: Optional[str] = None
            for r in results:
                data = r.get("data", {}) or {}
                # Read completion metadata even if batch_update had partial failures.
                if data.get("transitioned") and not transitioned:
                    transitioned = True
                    new_state_id = data.get("new_state_id")
                # First-wins, matching ``transitioned`` above: if two tools both
                # complete the session in one turn, keep the first's farewell /
                # summary rather than letting a later result overwrite it.
                if data.get("session_completed") and not session_completed:
                    session_completed = True
                    farewell_message = data.get("farewell_message")
                    summary_behavior = data.get("summary_behavior")

            latency_ms = (time.time() - start_time) * 1000
            verdict = "tool_calls_executed" if tool_calls_made else "no_tool_calls"

            logger.info(
                f"Expert '{config.name}' tool mode: "
                f"{len(tool_calls_made)} calls, {len(deliverables_set)} deliverables, "
                f"{len(tasks_completed)} tasks in {latency_ms:.0f}ms"
                + (", session_completed=True" if session_completed else "")
            )

            return ExpertVerdict(
                expert_name=config.name,
                verdict=verdict,
                confidence=1.0,
                recommendation=f"Set {len(deliverables_set)} deliverables" if deliverables_set else "No extractions",
                priority=config.priority,
                latency_ms=latency_ms,
                success=True,
                raw_output={
                    "tool_results": tool_calls_made,
                    "deliverables_set": deliverables_set,
                    "tasks_completed": tasks_completed,
                    "text_content": response.content or "",
                    # Set when any tool triggered an __end__ transition.
                    # _process_post_response in agent.py reads this to emit
                    # the farewell and set _session_completed on the agent.
                    "session_completed": session_completed,
                    "farewell_message": farewell_message,
                    "summary_behavior": summary_behavior,
                    # State advanced this turn (and the landed state id), for
                    # post-transition response re-anchoring in agent.py.
                    "transitioned": transitioned,
                    "new_state_id": new_state_id,
                },
            )

        except Exception as e:
            latency_ms = (time.time() - start_time) * 1000
            logger.error(f"Expert '{config.name}' tool mode failed: {e}")
            return ExpertVerdict(
                expert_name=config.name,
                verdict="error",
                confidence=0.0,
                recommendation=f"Tool mode failed: {str(e)[:100]}",
                priority=config.priority,
                latency_ms=latency_ms,
                success=False,
                error_message=str(e),
            )

    def _build_messages(
        self,
        config: ExpertConfig,
        user_input: str,
        conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any],
        append_output_format: bool = True,
        tools: Optional[List[BaseTool]] = None,
    ) -> List[LLMMessage]:
        """Build LLM messages for the expert call.

        System prompt is compiled with {{placeholder}} resolution from sm_context.
        If the template uses {{history_N}} / {{user_message}}, those are resolved
        inline and NOT duplicated in the user message. Otherwise the legacy
        behavior (history + user message in the API user role) is preserved.

        Args:
            append_output_format: If False, skip appending output_format
                (used in tool mode where tools replace structured JSON output).
            tools: The tools this call can use. Each one's ``guidance`` (the SDK's
                usage contract for it) is appended once — so an expert is taught
                exactly the tools it has, from code, never from its editable
                prompt.
        """
        template = config.system_prompt or ""

        # Detect placeholder usage before compilation
        prompt_has_history = bool(HISTORY_PATTERN.search(template))
        prompt_has_user_msg = has_user_message_placeholder(template)

        # Compile system prompt through the SDK's single, version-pinned entry
        # point — resolve all {{placeholders}} against the live runtime context.
        # The compiler copies sm_context internally and layers in the per-turn
        # history / user message, so we never mutate the shared context here.
        # Guarded: a malformed sm_context (e.g. a bad progress value or a message
        # missing role/content) must not crash the expert turn. Unlike arbitration,
        # this path has no outer try/except, so we fall back to the raw template
        # (placeholders unresolved) and let the expert still run.
        try:
            compiled_prompt = sdk_prompts.compile(
                template,
                version=self._compiler_version,
                sm_context=sm_context,
                conversation_history=conversation_history,
                user_input=user_input,
            )
        except Exception as e:  # noqa: BLE001 — never let prompt compilation kill the turn
            logger.warning(
                "Prompt compile failed for expert '%s' (%s); using raw template",
                config.name, e,
            )
            compiled_prompt = template

        # The usage contract of each tool this expert can call, once per distinct
        # text. It used to be the state-machine contract for ANY tool-calling
        # expert, which taught companion_router set_deliverable rules it could
        # not even call.
        for guidance in dict.fromkeys(t.guidance for t in tools or [] if t.guidance):
            compiled_prompt += "\n\n" + guidance

        # Append output format instruction if configured (not in tool mode)
        if append_output_format and config.output_format:
            compiled_prompt += f"\n\nRespond with compact JSON: {config.output_format}"

        # Generic verdict interface: the allowed verdict LABELS + their explanations
        # come from config (verdict_directives), not a hardcoded enum baked into the
        # prompt. The label and explanation are handed to the LLM so it knows what
        # each verdict means; the per-verdict ACTION is NOT shown (it is applied
        # deterministically in the arbitration layer). Operators can add/rename
        # verdicts and edit explanations without touching prompt text or code.
        if append_output_format and config.verdict_directives:
            lines = []
            for label, directive in config.verdict_directives.items():
                description = getattr(directive, "description", "") or ""
                lines.append(f'- "{label}": {description}' if description else f'- "{label}"')
            if lines:
                compiled_prompt += (
                    "\n\nClassify into exactly ONE of these verdicts:\n" + "\n".join(lines)
                )

        messages = [LLMMessage(role="system", content=compiled_prompt)]

        # Build user message — only include what wasn't resolved via placeholders
        user_parts: List[str] = []

        if not prompt_has_history and conversation_history:
            default_limit = 8
            limit = config.history_limit if config.history_limit > 0 else default_limit
            recent = conversation_history[-limit:]
            history_lines = [f"[{msg['role'].upper()}]: {msg['content']}" for msg in recent]
            user_parts.append("CONVERSATION:\n" + "\n".join(history_lines))

        if not prompt_has_user_msg:
            user_parts.append(f"CURRENT USER MESSAGE: {user_input}")
        else:
            # Still need a user message for API compliance
            user_parts.append(user_input)

        messages.append(LLMMessage(role="user", content="\n\n".join(user_parts)))
        return messages

    def _build_llm_config(self, config: ExpertConfig) -> LLMConfig:
        """Build LLM config for JSON-mode expert call.

        JSON-mode experts use OPENAI_LANGCHAIN with json_mode=True.
        Tool-calling experts use OPENAI_DIRECT instead — see _run_with_tools().
        """
        return LLMConfig(
            model=config.model,
            temperature=config.temperature,
            max_tokens=config.max_tokens,
            provider=LLMProvider.OPENAI_LANGCHAIN,
            streaming=False,
            json_mode=True,
        )

    def _parse_verdict(
        self, config: ExpertConfig, raw_content: str, latency_ms: float
    ) -> ExpertVerdict:
        """Parse the expert's JSON response into an ExpertVerdict."""
        try:
            data = json.loads(raw_content)
        except json.JSONDecodeError:
            logger.error(f"Expert '{config.name}' returned invalid JSON: {raw_content[:200]}")
            return ExpertVerdict(
                expert_name=config.name,
                verdict="parse_error",
                confidence=0.0,
                recommendation="Expert returned invalid JSON",
                priority=config.priority,
                latency_ms=latency_ms,
                success=False,
                error_message=f"Invalid JSON: {raw_content[:100]}",
            )

        return ExpertVerdict(
            expert_name=config.name,
            verdict=data.get("verdict", ""),
            confidence=float(data.get("confidence", 0.0)),
            recommendation=data.get("recommendation", ""),
            flags={
                k: v for k, v in data.items()
                if k not in ("verdict", "confidence", "recommendation")
            },
            priority=config.priority,
            latency_ms=latency_ms,
            success=True,
            raw_output=data,
        )
