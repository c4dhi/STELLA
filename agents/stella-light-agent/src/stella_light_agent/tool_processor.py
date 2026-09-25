"""
Tool-based processor for stella-light-agent.

Optimized for low-latency voice interactions:
- Phase 1: Text-only LLM call -> streams to TTS immediately
- Phase 2: Tool execution in background while TTS narrates
"""

import asyncio
import json
import uuid
from dataclasses import dataclass, field
from typing import AsyncIterator, Dict, Any, List, Optional

from stella_agent_sdk import AgentOutput
from stella_agent_sdk.tools import ToolRegistry, BaseTool, ToolResult

from stella_agent_sdk.llm import (
    LLMService,
    LLMConfig,
    LLMProvider,
    LLMMessage,
    LLMResponse,
    LLMStreamingCallback,
    LLMToolCall,
)


@dataclass
class ToolProcessorResult:
    """Result from ToolProcessor."""
    message: str
    tool_calls_made: List[Dict[str, Any]] = field(default_factory=list)
    deliverables_set: List[str] = field(default_factory=list)
    tasks_completed: List[str] = field(default_factory=list)
    tasks_skipped: List[str] = field(default_factory=list)
    transitioned: bool = False
    new_state_id: Optional[str] = None
    # Set when a tool moved the plan to __end__ (backend reports session_completed).
    session_completed: bool = False
    farewell_message: Optional[str] = None


class TextStreamingCallback(LLMStreamingCallback):
    """Simple callback for streaming text-only responses."""

    def __init__(self, transcript_id: str, token_queue: asyncio.Queue):
        self.transcript_id = transcript_id
        self.token_queue = token_queue
        self.accumulated_text = ""

    async def on_token(self, token: str, accumulated_text: str) -> None:
        """Handle each new token from the LLM."""
        self.accumulated_text = accumulated_text
        await self.token_queue.put(("token", token))

    async def on_complete(self, final_response: LLMResponse) -> None:
        """Called when streaming is complete."""
        await self.token_queue.put(("complete", self.accumulated_text))

    async def on_error(self, error: Exception) -> None:
        """Called when an error occurs."""
        await self.token_queue.put(("error", str(error)))

    async def on_tool_call(self, tool_call: LLMToolCall) -> None:
        """Not used in text-only mode."""
        pass


class ToolProcessor:
    """
    Optimized tool processor for low-latency voice interactions.

    Architecture (text-first, tools-background):
    1. Phase 1: LLM call WITHOUT tools -> guaranteed text, streams to TTS immediately
    2. Phase 2: LLM call WITH tools -> executes in background while TTS narrates

    This ensures the user hears a response immediately while tool execution
    (saving deliverables, state transitions) happens during audio playback.
    """

    def __init__(
        self,
        llm_service: LLMService,
        tool_registry: ToolRegistry,
        max_tool_iterations: int = 5
    ):
        """
        Initialize the tool processor.

        Args:
            llm_service: LLM service for generating responses
            tool_registry: Registry containing available tools
            max_tool_iterations: Maximum number of tool call rounds (for Phase 2)
        """
        self.llm_service = llm_service
        self.tool_registry = tool_registry
        self.max_tool_iterations = max_tool_iterations
        self.cancelled = False

    def cancel(self):
        """Cancel current processing."""
        self.cancelled = True

    async def process(
        self,
        session_id: str,
        system_prompt: str,
        user_message: str,
        text_system_prompt: Optional[str] = None,
    ) -> AsyncIterator[AgentOutput]:
        """
        Process input with optimized text-first architecture.

        Flow:
        1. Text-only LLM call -> streams immediately to TTS
        2. Yield final text chunk (TTS starts narrating)
        3. Tool LLM call -> executes while user listens
        4. Yield result with tool execution info

        Args:
            session_id: Current session ID
            system_prompt: Complete system prompt for the tool/extraction pass
                (Phase 2) — keeps the collection-pressure steering.
            user_message: User's input message
            text_system_prompt: Optional system prompt for the spoken pass
                (Phase 1). Lets the agent author the reply assuming the user's
                latest answer is being recorded — so it moves forward instead of
                re-confirming what was just said — while Phase 2 still extracts
                from the unchanged collection context. Falls back to
                ``system_prompt`` when not provided.

        Yields:
            AgentOutput messages (text chunks, final result)
        """
        self.cancelled = False
        transcript_id = f"tool_{uuid.uuid4().hex[:8]}"

        # Phase 2 (tool/extraction) context — unchanged collection pressure.
        messages = [
            LLMMessage(role="system", content=system_prompt),
            LLMMessage(role="user", content=user_message)
        ]
        # Phase 1 (spoken reply) context — assumes the answer is being recorded.
        text_messages = [
            LLMMessage(role="system", content=text_system_prompt or system_prompt),
            LLMMessage(role="user", content=user_message)
        ]

        # Get tool schemas for Phase 2
        tool_schemas = self.tool_registry.get_openai_schemas()

        print(f"[ToolProcessor] Starting text-first processing")
        print(f"[ToolProcessor] Tools available: {[t['function']['name'] for t in tool_schemas] if tool_schemas else 'none'}")

        # ═══════════════════════════════════════════════════════════════════
        # PHASE 1: Text-only response (immediate streaming to TTS)
        # ═══════════════════════════════════════════════════════════════════
        print(f"[ToolProcessor] Phase 1: Text-only LLM call (streaming)")

        text_config = LLMConfig(
            provider=LLMProvider.OPENAI_DIRECT,
            model=self.llm_service.default_config.model,
            temperature=self.llm_service.default_config.temperature,
            max_tokens=self.llm_service.default_config.max_tokens,
            streaming=True,
            tools=None,  # No tools - forces text-only response
            tool_choice=None
        )

        token_queue: asyncio.Queue = asyncio.Queue()
        callback = TextStreamingCallback(transcript_id, token_queue)
        accumulated_text = ""

        # Start LLM generation
        llm_task = asyncio.create_task(
            self.llm_service.generate(
                messages=text_messages,
                config=text_config,
                callback=callback,
                component_name="tool_processor_text"
            )
        )

        # Stream text chunks to user
        try:
            while True:
                if self.cancelled:
                    llm_task.cancel()
                    return

                try:
                    event_type, content = await asyncio.wait_for(
                        token_queue.get(), timeout=0.1
                    )

                    if event_type == "token":
                        accumulated_text += content
                        yield AgentOutput.text_chunk(
                            session_id,
                            accumulated_text.strip(),
                            transcript_id=transcript_id,
                            is_final=False
                        )

                    elif event_type == "error":
                        yield AgentOutput.error(
                            session_id,
                            f"LLM error: {content}",
                            error_type="llm_error",
                            recoverable=True
                        )
                        return

                    elif event_type == "complete":
                        break

                except asyncio.TimeoutError:
                    if llm_task.done():
                        break

            await llm_task

        except asyncio.CancelledError:
            return
        except Exception as e:
            yield AgentOutput.error(
                session_id,
                str(e),
                error_type="processing_error",
                recoverable=True
            )
            return

        print(f"[ToolProcessor] Phase 1 complete: '{accumulated_text[:100]}...' ({len(accumulated_text)} chars)")

        # Yield final text chunk - TTS starts processing immediately
        if accumulated_text.strip():
            yield AgentOutput.text_chunk(
                session_id,
                accumulated_text.strip(),
                transcript_id=transcript_id,
                is_final=True
            )
        else:
            print("[ToolProcessor] WARNING: No text generated in Phase 1!")

        # ═══════════════════════════════════════════════════════════════════
        # PHASE 2: Tool execution (runs while TTS narrates)
        # ═══════════════════════════════════════════════════════════════════
        result = ToolProcessorResult(message=accumulated_text.strip())

        if tool_schemas:
            print(f"[ToolProcessor] Phase 2: Tool LLM call (background)")

            # Non-streaming call with tools to determine what to execute
            tool_config = LLMConfig(
                provider=LLMProvider.OPENAI_DIRECT,
                model=self.llm_service.default_config.model,
                temperature=self.llm_service.default_config.temperature,
                max_tokens=1000,  # Shorter - we only need tool calls, not long text
                streaming=False,  # No streaming needed
                tools=tool_schemas,
                tool_choice="auto"
            )

            try:
                # Extraction runs from the plain [system, user] context. We do NOT
                # feed Phase 1's spoken reply into this pass: an earlier attempt to
                # do so (plus an explicit "record what you acknowledged" directive)
                # backfired badly — because the reply asks the NEXT question, the
                # extractor keyed off the wrong deliverable (recorded a placeholder
                # into preferred_exercise when the user only gave their name) and
                # skipped tasks for missing info. Mapping the user's latest message
                # to deliverables is the reliable baseline; improving recall of
                # already-stated answers belongs in the prompt/steering work (#306).
                tool_response = await self.llm_service.generate(
                    messages=messages,
                    config=tool_config,
                    callback=None,
                    component_name="tool_processor_tools"
                )

                if tool_response.tool_calls:
                    print(f"[ToolProcessor] Phase 2: Executing {len(tool_response.tool_calls)} tool(s) in parallel")
                    for tc in tool_response.tool_calls:
                        print(f"[ToolProcessor] Tool: {tc.name}({tc.arguments})")

                    # Execute tools in parallel
                    await self._execute_tools(tool_response.tool_calls, result)
                else:
                    print(f"[ToolProcessor] Phase 2: No tool calls needed")

            except Exception as e:
                print(f"[ToolProcessor] Phase 2 error (non-fatal): {e}")
                # Don't fail - the user already got their text response
        else:
            print(f"[ToolProcessor] Phase 2: Skipped (no tools registered)")

        print(f"[ToolProcessor] Complete - deliverables: {result.deliverables_set}, transitioned: {result.transitioned}")

        # Yield the final result
        yield result

    async def _execute_tools(
        self,
        tool_calls: List[LLMToolCall],
        result: ToolProcessorResult
    ) -> None:
        """
        Execute tool calls in parallel and update result.

        Args:
            tool_calls: List of tool calls to execute
            result: Result object to update with tool execution info
        """
        async def execute_single_tool(tool_call: LLMToolCall):
            tool = self.tool_registry.get(tool_call.name)
            if tool is None:
                print(f"[ToolProcessor] Unknown tool: {tool_call.name}")
                return (tool_call, None, f"Unknown tool: {tool_call.name}")

            try:
                tool_result = await tool.execute(**tool_call.arguments)
                print(f"[ToolProcessor] Tool '{tool_call.name}' result: {tool_result.success}")
                return (tool_call, tool_result, None)
            except Exception as e:
                print(f"[ToolProcessor] Tool execution error: {e}")
                return (tool_call, None, str(e))

        # Execute all tools in parallel
        tool_results = await asyncio.gather(
            *[execute_single_tool(tc) for tc in tool_calls]
        )

        # Process results
        for tool_call, tool_result, error in tool_results:
            if error:
                continue  # Skip failed tools

            # Track tool usage
            result.tool_calls_made.append({
                "name": tool_call.name,
                "arguments": tool_call.arguments,
                "success": tool_result.success
            })

            # Any state-machine tool can end the session (the last task or goal
            # completing reaches __end__); remember it and the farewell to speak.
            if tool_result.success and tool_result.data and tool_result.data.get("session_completed"):
                result.session_completed = True
                result.farewell_message = (
                    tool_result.data.get("farewell_message") or result.farewell_message
                )

            # Track specific tool effects
            if tool_call.name == "set_deliverable" and tool_result.success:
                key = tool_call.arguments.get("key")
                if key:
                    result.deliverables_set.append(key)
                if tool_result.data and tool_result.data.get("transitioned"):
                    result.transitioned = True
                    result.new_state_id = tool_result.data.get("new_state_id")

            elif tool_call.name == "complete_task" and tool_result.success:
                task_id = tool_call.arguments.get("task_id")
                if task_id:
                    result.tasks_completed.append(task_id)
                if tool_result.data and tool_result.data.get("transitioned"):
                    result.transitioned = True
                    result.new_state_id = tool_result.data.get("new_state_id")

            elif tool_call.name == "skip_task" and tool_result.success:
                task_id = tool_call.arguments.get("task_id")
                if task_id:
                    result.tasks_skipped.append(task_id)
                if tool_result.data and tool_result.data.get("transitioned"):
                    result.transitioned = True
                    result.new_state_id = tool_result.data.get("new_state_id")

            elif tool_call.name == "skip_state" and tool_result.success:
                # The whole state was skipped — record its tasks as skipped progress.
                if tool_result.data:
                    result.tasks_skipped.extend(tool_result.data.get("tasks_skipped", []))
                    if tool_result.data.get("transitioned"):
                        result.transitioned = True
                        result.new_state_id = tool_result.data.get("new_state_id")

            elif tool_call.name == "batch_update" and tool_result.success:
                # batch_update bundles deliverables + completes + skips in one call.
                data = tool_result.data or {}
                for d in data.get("deliverables_set", []):
                    if d.get("key"):
                        result.deliverables_set.append(d["key"])
                for t in data.get("tasks_completed", []):
                    if t.get("task_id"):
                        result.tasks_completed.append(t["task_id"])
                for t in data.get("tasks_skipped", []):
                    if t.get("task_id"):
                        result.tasks_skipped.append(t["task_id"])
                if data.get("session_completed"):
                    result.transitioned = True
