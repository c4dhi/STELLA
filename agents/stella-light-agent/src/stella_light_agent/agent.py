"""
Stella Light Agent - Simplified single-LLM agent with prompt-based guardrails.

This is a lightweight version of stella-agent that:
- Uses a single LLM call instead of InputGate/ExpertPool/Aggregator pipeline
- Embeds safety guardrails directly in the system prompt
- Manages state exclusively through the SDK toolbox (gRPC state machine)
- Supports streaming responses
"""

import asyncio
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator, Dict, Any, List, Optional

from stella_agent_sdk import BaseAgent
from stella_agent_sdk import AgentInput
from stella_agent_sdk import AgentOutput
from stella_agent_sdk import StatusSubtype, BargeInDecision
from stella_agent_sdk.tools import ToolRegistry
from stella_agent_sdk.tools.state_machine import create_state_machine_tools
from stella_agent_sdk.services import StateMachineClient
from stella_agent_sdk.progress import progress_from_full_state, build_last_transition

from stella_agent_sdk.llm import LLMService
from stella_agent_sdk.agent import BargeInEvaluator
from stella_agent_sdk.language import LanguageResolver
from stella_light_agent.tool_processor import ToolProcessor, ToolProcessorResult
from stella_light_agent.prompts import LightPromptBuilder
from stella_agent_sdk import prompts as sdk_prompts


# Prompt-compiler version this agent is written and tested against. Pinned on
# purpose (not the SDK's latest) so an SDK upgrade can't silently change how this
# agent's prompts compile. Bump deliberately when adopting a new compiler version.
# Can be overridden per deployment via config["compiler_version"].
PROMPT_COMPILER_VERSION = "1.0.0"


class StellaLightAgent(BaseAgent):
    """
    Stella Light Agent - Simplified single-LLM agent.

    Processing Flow:
    1. Build unified prompt with state context + guardrails
    2. Single LLM call with tool calling
    3. Execute tools (set_deliverable, complete_task, skip_task, skip_state)
    4. State machine updates via gRPC (the single source of truth)
    5. Emit progress update
    """

    # This agent supports user barge-in: it ships a Barge-in Evaluator stage
    # (the same COMMIT/RESUME classifier as stella-v2) whose prompt/model are
    # editable in the Agent Configurator. Effective only when barge-in is also
    # enabled at the deployment level (BARGE_IN_ENABLED / INTERRUPT_MODE).
    supports_barge_in = True

    def __init__(
        self,
        llm_config_path: Optional[str] = None,
        state_machine_address: Optional[str] = None
    ):
        """
        Initialize the Stella Light Agent.

        Args:
            llm_config_path: Path to LLM configuration JSON file
            state_machine_address: gRPC address for state machine service

        State is managed exclusively through the SDK toolbox against the external
        gRPC state machine — the single source of truth. There is no in-process
        fallback engine.
        """
        super().__init__()

        # Set agent type to match the Docker image name (used for gRPC registration)
        self._agent_type = "stella-light-agent"

        # Determine config path
        if llm_config_path is None:
            llm_config_path = self._find_config_file("config/llm_config.json")

        # Initialize LLM service
        self.llm_service = LLMService(config_path=llm_config_path)

        # Barge-in evaluator (COMMIT/RESUME classifier), configurable via the
        # Agent Configurator's "Barge-in Evaluator" node — same as stella-v2.
        self.barge_in_evaluator = BargeInEvaluator(self.llm_service)

        # Prompt builder (tool-based state management).
        self.prompt_builder = LightPromptBuilder()

        # Conversation-language resolution (shared SDK logic — single source of
        # truth, identical to stella-v2). One resolved language per turn flows to
        # the prompt's {{language}} directive and to TTS via output metadata.
        self.language_resolver = LanguageResolver()
        self._session_language: Optional[str] = None

        # Tool-based components (initialized per session).
        # State machine shares the same gRPC port as agent registration (50051).
        self._state_machine_address = state_machine_address or os.environ.get(
            "STATE_MACHINE_ADDRESS", "localhost:50051"
        )
        self.sm_client: Optional[StateMachineClient] = None
        self.tool_registry: Optional[ToolRegistry] = None
        self.tool_processor: Optional[ToolProcessor] = None

        # Session config
        self.config: Dict[str, Any] = {}
        self._session_started_at: Optional[str] = None
        # Raw plan dict kept so progress updates can surface each state's
        # transitions (the "Possible Next States" preview on the frontend).
        self._plan_config: Optional[Dict[str, Any]] = None
        # Last state seen on a progress emit, so the next update can describe the
        # "branch chosen" (last_transition) at parity with stella-v2 (#310).
        self._last_known_state_id: Optional[str] = None
        self._plan_system_prompt: Optional[str] = None
        # Configurator overrides injected via SDK config (pipeline_config).
        # Light exposes a single combined System Prompt (identity + conversational style).
        self._custom_system_prompt: Optional[str] = None
        # Legacy fields, still honored for configs saved before persona/guidelines were merged.
        self._custom_persona: Optional[str] = None
        self._custom_guidelines: Optional[str] = None
        # Operator-editable prose blocks (response.* slots) — default text lives in
        # the prompt builder; these override it so the developer owns them from the
        # config screen without code edits.
        self._custom_safety_guidelines: Optional[str] = None
        self._custom_state_transition_note: Optional[str] = None
        self._history_limit: int = 20
        # Explicit prompt-compiler version (never implicit/latest). Defaults to the
        # version this agent was authored against; can be overridden via config.
        self._compiler_version: str = PROMPT_COMPILER_VERSION
        # Set when the PREVIOUS turn transitioned to a new state, so the next turn's
        # prompt can fire the transition warning and stop soliciting the old state's
        # deliverables (#306). The live get_current_state has no "did it just change"
        # bit, so we derive it from the prior turn's tool result.
        self._state_just_changed: bool = False

        print("[StellaLightAgent] Initialized (tool-based state management)")

    def _find_config_file(self, relative_path: str) -> Optional[str]:
        """Find config file in various locations."""
        locations = [
            Path(relative_path),
            Path(__file__).parent.parent.parent / relative_path,
            Path("/app") / relative_path,
        ]

        for location in locations:
            if location.exists():
                return str(location)

        return None

    def _apply_pipeline_config(self, pipeline_config: Dict[str, Any]) -> None:
        """Apply Agent Configurator overrides injected via SDK config.

        Reads the single 'response' node and the 'history_limit' threshold from the
        pipeline_config dict (shape: { nodes: {...}, thresholds: {...} }) and applies
        them to the LLM service and prompt builder. Mirrors stella-v2's
        _apply_pipeline_config but for the light agent's single-LLM architecture.
        """
        nodes = pipeline_config.get("nodes", {}) or {}
        thresholds = pipeline_config.get("thresholds", {}) or {}

        response = nodes.get("response", {}) or {}
        if "model" in response:
            self.llm_service.default_config.model = response["model"]
        if "temperature" in response:
            self.llm_service.default_config.temperature = float(response["temperature"])
        if "max_tokens" in response:
            self.llm_service.default_config.max_tokens = int(response["max_tokens"])
        # Combined identity + conversational style (current). Legacy persona/guidelines
        # are still read so configs saved before the merge keep working.
        if response.get("system_prompt"):
            self._custom_system_prompt = response["system_prompt"]
        if response.get("persona"):
            self._custom_persona = response["persona"]
        if response.get("conversation_guidelines"):
            self._custom_guidelines = response["conversation_guidelines"]
        if response.get("safety_guidelines"):
            self._custom_safety_guidelines = response["safety_guidelines"]
        if response.get("state_transition_note"):
            self._custom_state_transition_note = response["state_transition_note"]

        if "history_limit" in thresholds:
            try:
                self._history_limit = int(thresholds["history_limit"])
            except (TypeError, ValueError):
                pass

        # Barge-in Evaluator overrides (prompt/model/temperature/max_tokens).
        barge_in = nodes.get("barge_in", {}) or {}
        if isinstance(barge_in, dict) and barge_in:
            self.barge_in_evaluator.apply_config(barge_in)

        # Language resolver overrides (supported/default/thresholds) — same shared
        # SDK resolver and config surface as stella-v2.
        language_config = nodes.get("language", {}) or {}
        if isinstance(language_config, dict) and language_config:
            self.language_resolver.apply_config(language_config)

        print(
            f"[StellaLightAgent] Pipeline config applied: "
            f"model={self.llm_service.default_config.model}, "
            f"temperature={self.llm_service.default_config.temperature}, "
            f"max_tokens={self.llm_service.default_config.max_tokens}, "
            f"system_prompt={'custom' if (self._custom_system_prompt or self._custom_persona or self._custom_guidelines) else 'default'}, "
            f"history_limit={self._history_limit}"
        )

    def _inject_configured_prompts(
        self,
        sm_context: Dict[str, Any],
        conversation_history: List[Dict[str, str]],
        user_input: str,
    ) -> None:
        """Resolve {{placeholder}} tokens in configured prompts and inject them.

        Mirrors stella-v2's template compilation so the Configurator's persona /
        conversation_guidelines and the plan system prompt can reference live runtime
        values ({{plan}}, {{current_focus}}, {{history_N}}, {{user_message}}, ...).
        Compiled per turn because history/user-message placeholders change each turn.
        """
        # Resolve {{placeholder}} tokens in each configured prompt through the SDK's
        # single compile entry point (prompt + compiler version -> final prompt).
        def render(text: Optional[str]) -> Optional[str]:
            return sdk_prompts.compile(
                text,
                version=self._compiler_version,
                sm_context=sm_context,
                conversation_history=conversation_history,
                user_input=user_input,
            )

        if self._custom_system_prompt:
            sm_context["custom_system_prompt"] = render(self._custom_system_prompt)
        if self._custom_persona:
            sm_context["custom_persona"] = render(self._custom_persona)
        if self._custom_guidelines:
            sm_context["custom_guidelines"] = render(self._custom_guidelines)
        if self._custom_safety_guidelines:
            sm_context["custom_safety_guidelines"] = render(self._custom_safety_guidelines)
        if self._custom_state_transition_note:
            sm_context["custom_state_transition_note"] = render(self._custom_state_transition_note)
        # The plan system prompt may also contain placeholders.
        if sm_context.get("plan_system_prompt"):
            sm_context["plan_system_prompt"] = render(sm_context["plan_system_prompt"])

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        """
        Initialize session with configuration.

        Args:
            session_id: Unique session identifier
            config: Session configuration including plan
        """
        self.config = config
        self._session_started_at = datetime.now(timezone.utc).isoformat()
        self._plan_system_prompt = None
        self._custom_system_prompt = None
        self._custom_persona = None
        self._custom_guidelines = None
        self._custom_safety_guidelines = None
        self._custom_state_transition_note = None
        self._history_limit = 20
        self._state_just_changed = False
        # Fresh language lock per session so a resolved language never leaks
        # between conversations (config — supported/default/thresholds — kept).
        self.language_resolver.reset()
        self._session_language = None
        # Explicit compiler version: config override, else the agent's pinned default.
        self._compiler_version = config.get("compiler_version") or PROMPT_COMPILER_VERSION

        print(f"[StellaLightAgent] Session started: {session_id}")
        print(f"[StellaLightAgent] Config keys: {list(config.keys())}")

        # Load plan configuration
        plan_config = self._load_plan_config(config)
        # Retain the raw plan so progress updates can expose per-state transitions.
        self._plan_config = plan_config

        # Declare the plan's language to STT BEFORE the first utterance. Doing it
        # on the first turn is too late: the opening utterance is exactly the one
        # that gets misdetected (it is short, and often starts with a name), and
        # it is what confirms the lock for the rest of the session.
        self.language_resolver.set_plan_language((plan_config or {}).get("language"))
        if self.has_audio:
            self.audio.set_stt_language(self.language_resolver.forced)

        # Initialize tool-based state management (the only path).
        await self._init_tool_mode(session_id, plan_config)

        # Extract custom system prompt from plan if provided
        if plan_config and "system_prompt" in plan_config:
            self._plan_system_prompt = plan_config["system_prompt"]
            print("[StellaLightAgent] Using custom system prompt from plan")

        # Apply LLM config overrides
        llm_overrides = config.get("llm", {})
        if llm_overrides:
            if "model" in llm_overrides:
                self.llm_service.default_config.model = llm_overrides["model"]
            if "temperature" in llm_overrides:
                self.llm_service.default_config.temperature = llm_overrides["temperature"]

        # Apply pipeline configuration from the Agent Configurator (same principle as
        # stella-v2): persona/guidelines/model/temperature/max_tokens + history_limit
        # injected through the SDK config as pipeline_config.
        pipeline_config = config.get("pipeline_config")
        if pipeline_config:
            self._apply_pipeline_config(pipeline_config)

    def _load_plan_config(self, config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Load plan configuration from config or disk."""
        plan_config = None

        # First check for plan_id - load plan from disk
        if "plan_id" in config:
            plan_id = config["plan_id"]
            plan_path = self._find_plan_file(plan_id)
            if plan_path:
                with open(plan_path) as f:
                    plan_config = json.load(f)
                print(f"[StellaLightAgent] Loaded plan '{plan_id}' from disk")
            else:
                print(f"[StellaLightAgent] Plan file not found: {plan_id}")

        elif "plan" in config:
            # Also support inline plan config
            plan_config = config.get("plan")
            if isinstance(plan_config, str):
                # It's a plan ID string
                plan_path = self._find_plan_file(plan_config)
                if plan_path:
                    with open(plan_path) as f:
                        plan_config = json.load(f)
                else:
                    print(f"[StellaLightAgent] Plan file not found: {plan_config}")
                    plan_config = None

        return plan_config

    async def _init_tool_mode(
        self, session_id: str, plan_config: Optional[Dict[str, Any]]
    ) -> None:
        """Initialize tool-based state management."""
        # Create state machine client and connect
        self.sm_client = StateMachineClient(
            session_id=session_id,
            address=self._state_machine_address
        )
        await self.sm_client.connect()
        print(f"[StellaLightAgent] Connected to state machine at {self._state_machine_address}")

        # Initialize state machine with plan
        if plan_config:
            try:
                result = await self.sm_client.initialize(plan_config)
                print(f"[StellaLightAgent] State machine initialized: {result.get('success')}")
            except Exception as e:
                print(f"[StellaLightAgent] Failed to initialize state machine: {e}")

        # Create tool registry and register state machine tools
        self.tool_registry = ToolRegistry()
        sm_tools = create_state_machine_tools(self.sm_client)
        for tool in sm_tools:
            self.tool_registry.register(tool)

        print(f"[StellaLightAgent] Registered {len(sm_tools)} state machine tools")

        # Create tool processor
        self.tool_processor = ToolProcessor(
            llm_service=self.llm_service,
            tool_registry=self.tool_registry
        )

    def _find_plan_file(self, plan_id: str) -> Optional[str]:
        """Find plan file by ID."""
        locations = [
            Path(f"config/plans/{plan_id}.json"),
            Path(__file__).parent.parent.parent / f"config/plans/{plan_id}.json",
            Path("/app/config/plans") / f"{plan_id}.json",
        ]

        for location in locations:
            if location.exists():
                return str(location)

        return None

    async def on_ready(self, session_id: str) -> AsyncIterator[AgentOutput]:
        """
        Called when agent is ready to start.
        Send initial progress state to frontend.
        """
        print(f"[StellaLightAgent] on_ready called, sm_client={self.sm_client is not None}")

        # Send the initial progress snapshot from the external state machine.
        if self.sm_client:
            try:
                print("[StellaLightAgent] Fetching full state from state machine...")
                full_state = await self.sm_client.get_full_state()
                print(f"[StellaLightAgent] Full state received: {full_state is not None}, keys: {list(full_state.keys()) if full_state else 'None'}")

                if full_state:
                    # Anchor the transition tracker; the initial snapshot has no
                    # prior state, so there is no branch to report yet.
                    self._last_known_state_id = full_state.get("current_state_id")
                    progress_state = progress_from_full_state(
                        full_state,
                        plan=self._plan_config,
                        session_started_at=self._session_started_at,
                        extra_metadata={"last_transition": None},
                    )
                    print(f"[StellaLightAgent] Built progress state with {len(progress_state.groups)} groups")
                    yield AgentOutput.progress_update(
                        session_id,
                        progress_state,
                        update_trigger="session_start",
                        agent_name="stella-light-agent",
                        agent_icon="💡"
                    )
                    print("[StellaLightAgent] Progress update yielded")
                else:
                    print("[StellaLightAgent] No full state returned - state machine may not be initialized")
            except Exception as e:
                print(f"[StellaLightAgent] Failed to get initial state: {e}")
                import traceback
                traceback.print_exc()
        else:
            print("[StellaLightAgent] No sm_client available")

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        """
        Process user input through single LLM call with streaming.

        Args:
            input: AgentInput containing user text and metadata

        Yields:
            AgentOutput messages (status, text chunks, deliverables, progress)
        """
        self._is_processing = True

        try:
            # Show processing status
            yield AgentOutput.status(
                input.session_id,
                "Processing your message...",
                StatusSubtype.PROCESSING
            )

            print(f"[StellaLightAgent] Processing: '{input.text}'")

            async for output in self._process_with_tools(input):
                yield output

        except Exception as e:
            print(f"[StellaLightAgent] Error: {e}")
            import traceback
            traceback.print_exc()
            yield AgentOutput.error(
                input.session_id,
                str(e),
                error_type="processing_error",
                recoverable=True
            )
        finally:
            self._is_processing = False

    async def _process_with_tools(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        """Process input using tool-based state management."""
        # Fetch conversation history
        conversation_history = await self._fetch_conversation_history(limit=self._history_limit)

        # Get state machine context from external service
        sm_context = {}
        if self.sm_client:
            try:
                # Parallelize all state machine calls for reduced latency
                # (~100-200ms sequential -> ~25-50ms parallel)
                state, tasks, deliverables, collected = await asyncio.gather(
                    self.sm_client.get_current_state(),
                    self.sm_client.get_pending_tasks(),
                    self.sm_client.get_pending_deliverables(),
                    self.sm_client.get_collected_deliverables()
                )

                print(f"[StellaLightAgent] get_current_state returned: {state}")
                if state:
                    sm_context = self._build_context_from_state(state)
                    # Deliverable-driven steering inputs (#306): surface the stuck
                    # counter and whether the previous turn moved to a new state.
                    sm_context["turns_without_progress"] = state.get(
                        "turns_without_progress", 0
                    )
                    sm_context["state_just_changed"] = self._state_just_changed
                    # Consume the signal immediately so a mid-turn failure can't
                    # carry a stale "just transitioned" into the next turn. The
                    # end-of-turn assignment below re-sets it from this turn's result.
                    self._state_just_changed = False

                print(f"[StellaLightAgent] Pending tasks: {len(tasks)}, Pending deliverables: {len(deliverables)}, Collected: {len(collected)}")

                # Separate current tasks from preview tasks (for strict mode)
                current_tasks = [t for t in tasks if not t.get("is_preview")]
                preview_tasks = [t for t in tasks if t.get("is_preview")]

                sm_context["available_tasks"] = current_tasks  # Tasks to work on now
                sm_context["preview_tasks"] = preview_tasks   # Next tasks (for smooth transitions)

                # Include all deliverable fields for the prompt
                sm_context["deliverables"] = [
                    {
                        "key": d.get("key"),
                        "description": d.get("description"),
                        "type": d.get("type", "string"),
                        "required": d.get("required", True),
                        "status": "pending",
                        "acceptance_criteria": d.get("acceptance_criteria"),
                        "examples": d.get("examples"),
                        "enum_values": d.get("enum_values"),  # For enum types
                        "task_id": d.get("task_id"),
                    }
                    for d in deliverables
                ]

                # Add collected deliverables for update capability
                sm_context["collected_deliverables"] = collected

                # Set current_task to the first pending task (for prompt context)
                if current_tasks:
                    sm_context["current_task"] = current_tasks[0]
                    print(f"[StellaLightAgent] Current task: {current_tasks[0].get('description')}")
                    if current_tasks[0].get('instruction'):
                        print(f"[StellaLightAgent] Task instruction: {current_tasks[0].get('instruction')}")

                # Set next_task for strict mode transitions
                if preview_tasks:
                    sm_context["next_task"] = preview_tasks[0]
                    print(f"[StellaLightAgent] Next task (preview): {preview_tasks[0].get('description')}")

                print(f"[StellaLightAgent] sm_context keys: {list(sm_context.keys())}")

            except Exception as e:
                print(f"[StellaLightAgent] Failed to get state context: {e}")
                import traceback
                traceback.print_exc()
        else:
            print("[StellaLightAgent] WARNING: sm_client is None!")

        # Add custom system prompt from plan if available
        if self._plan_system_prompt:
            sm_context["plan_system_prompt"] = self._plan_system_prompt
            print(f"[StellaLightAgent] Using plan system prompt: {self._plan_system_prompt[:100]}...")

        # Resolve the conversation language for this turn (single source of truth,
        # shared SDK logic — identical to stella-v2). A declared plan language
        # pins it; otherwise STT's acoustic detection (input metadata) decides
        # when confident, else the bundled text classifier reads input.text.
        # Flows to {{language}} and to TTS via output metadata below.
        # A plan that declares its language is PINNED to it: detection is
        # off, and STT is told what to transcribe. Whisper auto-detects from
        # a very short window and, guessing wrong, translates rather than
        # mis-hears — which is how a fully-German plan ran its whole session
        # in English. A declaration removes the guess entirely.
        self.language_resolver.set_plan_language(
            (self._plan_config or {}).get("language")
        )
        if self.has_audio:
            self.audio.set_stt_language(self.language_resolver.forced)
        meta = getattr(input, "metadata", None) or {}
        detected_language = meta.get("detected_language") or None
        language_signal = (
            (detected_language, float(meta.get("language_confidence") or 0.0))
            if detected_language
            else None
        )
        self._session_language = self.language_resolver.resolve(
            input.text, signal=language_signal
        )
        sm_context["language"] = self._session_language
        print(f"[StellaLightAgent] Resolved language for turn: {self._session_language}")

        # Inject configured prompts, resolving {{placeholder}} variables against
        # the live runtime context (same principle as stella-v2).
        self._inject_configured_prompts(sm_context, conversation_history, input.text)

        # Build prompts
        system_prompt = self.prompt_builder.build_system_prompt(sm_context)
        # Spoken-reply (Phase 1) prompt: authored as if the user's latest answer is
        # already being recorded, so the reply moves forward instead of re-confirming
        # what they just said. Phase 2 still extracts from `system_prompt` (#304).
        text_system_prompt = self.prompt_builder.build_system_prompt(
            sm_context, for_text_response=True
        )
        user_message = self.prompt_builder.build_user_message(
            user_input=input.text,
            conversation_history=conversation_history,
            context=sm_context
        )

        # Log prompt info for debugging
        print(f"[StellaLightAgent] System prompt length: {len(system_prompt)} chars")
        if "Information to Collect" in system_prompt:
            print("[StellaLightAgent] ✓ System prompt includes deliverable instructions")
        else:
            print("[StellaLightAgent] ✗ System prompt MISSING deliverable instructions!")

        # Process through ToolProcessor
        result: Optional[ToolProcessorResult] = None
        async for output in self.tool_processor.process(
            session_id=input.session_id,
            system_prompt=system_prompt,
            user_message=user_message,
            text_system_prompt=text_system_prompt,
        ):
            if isinstance(output, ToolProcessorResult):
                result = output
            else:
                # Stamp the resolved language so the SDK routes TTS to the right
                # voice (parity with stella-v2). Guard: not every output carries a
                # mutable metadata dict.
                if self._session_language and getattr(output, "metadata", None) is not None:
                    output.metadata["language"] = self._session_language
                yield output

        # Handle results
        if result:
            # Emit deliverables
            for key in result.deliverables_set:
                # Get the actual value from the state machine
                try:
                    collected = await self.sm_client.get_collected_deliverables()
                    value = collected.get(key)
                    if value is not None:
                        yield AgentOutput.deliverable(input.session_id, key=key, value=value)
                except Exception as e:
                    print(f"[StellaLightAgent] Failed to get deliverable value: {e}")

            # Log tool usage
            if result.tool_calls_made:
                print(f"[StellaLightAgent] Tool calls: {[tc['name'] for tc in result.tool_calls_made]}")
            if result.deliverables_set:
                print(f"[StellaLightAgent] Deliverables set: {result.deliverables_set}")
            if result.tasks_completed:
                print(f"[StellaLightAgent] Tasks completed: {result.tasks_completed}")
            if result.tasks_skipped:
                print(f"[StellaLightAgent] Tasks skipped: {result.tasks_skipped}")
            if result.transitioned:
                print(f"[StellaLightAgent] Transitioned to: {result.new_state_id}")

        # Remember whether this turn moved to a new state so NEXT turn's prompt can
        # acknowledge the transition and stop soliciting the old state's deliverables
        # (#306 precise-skip follow-through).
        self._state_just_changed = bool(result.transitioned) if result else False

        # Increment turn counter only if no progress was made. Completing OR skipping
        # a task is progress (the agent explicitly addressed it) (#291).
        if result and not result.deliverables_set and not result.tasks_completed and not result.tasks_skipped:
            try:
                await self.sm_client.increment_turn()
            except Exception as e:
                print(f"[StellaLightAgent] Failed to increment turn: {e}")

        # Emit progress update with full state
        if self.sm_client:
            try:
                full_state = await self.sm_client.get_full_state()
                if full_state:
                    # Describe the "branch chosen" if the state changed this turn,
                    # then advance the tracker (parity with stella-v2, #310).
                    current_state_id = full_state.get("current_state_id")
                    last_transition = build_last_transition(
                        self._plan_config, self._last_known_state_id, current_state_id
                    )
                    self._last_known_state_id = current_state_id
                    progress_state = progress_from_full_state(
                        full_state,
                        plan=self._plan_config,
                        session_started_at=self._session_started_at,
                        extra_metadata={"last_transition": last_transition},
                    )
                    yield AgentOutput.progress_update(
                        input.session_id,
                        progress_state,
                        update_trigger="turn_completion",
                        agent_name="stella-light-agent",
                        agent_icon="💡"
                    )
            except Exception as e:
                print(f"[StellaLightAgent] Failed to emit progress: {e}")

    def _build_context_from_state(self, state: Dict[str, Any]) -> Dict[str, Any]:
        """Build prompt context from external state machine state."""
        # Handle both 'state_title' (from gRPC) and 'title' (from direct dict)
        title = state.get("state_title") or state.get("title", "Unknown")
        state_type = state.get("state_type") or state.get("type", "loose")

        return {
            "processing_mode": state_type,
            "state": {
                "title": title,
                "description": state.get("description", ""),
            },
            "progress": {
                "percentage": state.get("progress", 0) * 100,
            },
            "state_just_changed": False,
        }

    async def on_interrupt(self, session_id: str) -> None:
        """Handle user interruption (barge-in)."""
        print(f"[StellaLightAgent] Interrupt received: {session_id}")
        if self.tool_processor:
            self.tool_processor.cancel()
        self._is_processing = False

    async def on_barge_in(self, session_id: str, transcript: str) -> BargeInDecision:
        """Evaluate a user barge-in via the configurable Barge-in Evaluator.

        Delegates to the LLM-backed evaluator (whose prompt/model are editable in
        the Agent Configurator). The conversation history is fetched and passed so
        the decision is made IN CONTEXT — e.g. an on-topic answer to the assistant's
        last question is a real turn, not noise. COMMIT makes the SDK discard the
        rest of the current reply and process ``transcript`` as a new turn; RESUME
        continues from where it suspended. Same behavior as stella-v2.
        """
        print(f"[StellaLightAgent] Evaluating barge-in: '{transcript[:50]}'")
        try:
            history = await self._fetch_conversation_history(
                limit=self.barge_in_evaluator.history_limit
            )
        except Exception as e:
            print(f"[StellaLightAgent] Barge-in: could not fetch history ({e}); evaluating without it")
            history = []
        return await self.barge_in_evaluator.evaluate(transcript, conversation_history=history)

    async def on_config_update(self, session_id: str, config: Dict[str, Any]) -> None:
        """Handle runtime configuration updates."""
        print(f"[StellaLightAgent] Config update: {list(config.keys())}")
        self.config.update(config)

        # Apply LLM overrides
        llm_overrides = config.get("llm", {})
        if llm_overrides:
            if "model" in llm_overrides:
                self.llm_service.default_config.model = llm_overrides["model"]
            if "temperature" in llm_overrides:
                self.llm_service.default_config.temperature = llm_overrides["temperature"]

    async def on_session_end(self, session_id: str) -> Dict[str, Any]:
        """
        Clean up session and return summary.

        Returns:
            Summary with collected deliverables and statistics
        """
        print(f"[StellaLightAgent] Session ending: {session_id}")

        summary = {
            "agent": "stella-light-agent",
            "mode": "tool-based",
            "llm_stats": self.llm_service.get_usage_stats(),
        }

        if self.sm_client:
            try:
                state = await self.sm_client.get_current_state()
                deliverables = await self.sm_client.get_collected_deliverables()
                summary["deliverables"] = deliverables
                summary["progress"] = state.get("progress", 0) if state else 0
            except Exception as e:
                print(f"[StellaLightAgent] Failed to get session summary: {e}")

            # Disconnect state machine client
            await self.sm_client.disconnect()
            self.sm_client = None
            self.tool_registry = None
            self.tool_processor = None

        # Reset for next session
        self.llm_service.reset_stats()
        self._session_started_at = None
        self._last_known_state_id = None

        return summary

    async def _fetch_conversation_history(self, limit: int = 20) -> List[Dict[str, str]]:
        """Fetch conversation history from the SDK."""
        try:
            history = await self.get_chat_history()
            if history:
                return [
                    {"role": msg.role, "content": msg.content}
                    for msg in history[-limit:]
                ]
        except Exception as e:
            print(f"[StellaLightAgent] Failed to fetch history: {e}")

        return []
