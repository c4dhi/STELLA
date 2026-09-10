"""STELLA V2 Agent — streamlined 3-stage pipeline with deterministic arbitration.

Processing Flow (#363: no Input Gate — every enabled expert runs and self-gates):
1. Bridge Generator + Expert Pool — started together and run CONCURRENTLY (#455).
   The bridge streams sentence-by-sentence straight to TTS so the user hears a
   reply within a few hundred ms, while the Expert Pool produces its parallel
   structured verdicts on the same wall clock. The pool is joined before
   arbitration, so the turn costs max(bridge, experts), not their sum.
2. Deterministic Arbitration — priority-based conflict resolution (~1ms, no LLM).
   This is the sole gate: it filters out tapped-out (non-flagging) verdicts.
3. Response Generator — streaming final answer with arbitration context.

Key properties:
- No SAFE/UNSAFE distinction: every input flows through all stages.
- Experts self-gate — each runs every turn and abstains via a non-flagging
  verdict; there is no centralized relevance classifier (removed in #363).
- Experts return short structured verdicts (not free-form text).
- Arbitration is deterministic code (not an LLM call).
- Expert configs are loadable from outside (like plans).
- Garbled input is handled by the noise_detection expert's unclear → short-circuit
  verdict (it replaces the old Input-Gate-failure path).
"""

import asyncio
import json
import os
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator, Dict, Any, List, Optional

from stella_agent_sdk import BaseAgent
from stella_agent_sdk import AgentInput
from stella_agent_sdk import AgentOutput
from stella_agent_sdk import StatusSubtype, BargeInDecision
from stella_agent_sdk.services import StateMachineClient
from stella_agent_sdk.tools import ToolRegistry
from stella_agent_sdk.tools.state_machine import create_state_machine_tools
from stella_agent_sdk.tools.companion import create_companion_tools

from stella_agent_sdk.llm import LLMService
from stella_v2_agent.experts.registry import ExpertRegistry
from stella_agent_sdk.env import env_bool
from stella_v2_agent.pipeline.bridge_generator import (
    BridgeGenerator,
    BRIDGE_MODE_BRIEF,
    BRIDGE_MODE_FULL,
    BRIDGE_MODE_THINKING,
)
from stella_v2_agent.pipeline.expert_pool import ExpertPool
from stella_v2_agent.pipeline.arbitration import Arbitration
from stella_v2_agent.pipeline.response_generator import ResponseGenerator
from stella_agent_sdk.language import LanguageResolver
from stella_agent_sdk.agent import BargeInEvaluator
from stella_agent_sdk.progress import progress_from_full_state, build_last_transition
from stella_agent_sdk.prompts import resolve_persona_tokens
from stella_v2_agent.utils import normalize_transition_priority
import logging


# ── Per-turn speaking rate (#3 prosody) ──────────────────────────────────────
# The TTS provider synthesises at one fixed rate with one fixed affect, so
# without this every utterance in a conversation is acoustically identical —
# sympathy and enthusiasm come out the same. That is a large part of why a
# well-worded reply can still sound scripted, and it is invisible in a
# transcript.
#
# The turn's bridge mode is already a classifier for the turn's character, so it
# picks the rate for the WHOLE turn (bridge and reply alike) — a rate change
# inside one utterance would read as a glitch rather than as expression.
#
# Deliberately within a few percent: the Qwen3 provider implements rate by
# resampling, which shifts pitch along with it. A few percent reads as natural
# variation; a large factor reads as a different speaker.
_TURN_SPEED_BY_BRIDGE_MODE = {
    BRIDGE_MODE_BRIEF: 1.02,     # a quick beat, then straight on
    BRIDGE_MODE_FULL: 1.00,      # ordinary conversational rate
    BRIDGE_MODE_THINKING: 0.97,  # a heavier turn, taken slower
}


def _turn_speed(bridge_mode) -> float:
    """Speaking rate for this turn, or 1.0 when variation is off/unknown."""
    if not env_bool("STELLA_TTS_RATE_VARIATION", True):
        return 1.0
    return _TURN_SPEED_BY_BRIDGE_MODE.get(bridge_mode, 1.0)


logger = logging.getLogger(__name__)


# Prompt-compiler version this agent is written and tested against. Pinned on
# purpose (not the SDK's latest) so an SDK upgrade can't silently change how this
# agent's expert prompts compile. Bump deliberately when adopting a new compiler
# version. Can be overridden per deployment via config["compiler_version"].
PROMPT_COMPILER_VERSION = "1.1.0"


class StellaV2Agent(BaseAgent):
    """STELLA V2 Agent: 3-stage pipeline with deterministic arbitration.

    Pipeline stages (#363: no Input Gate — every enabled expert runs and self-gates):
    1. ExpertPool — run all enabled experts in parallel; each self-gates (abstains)
    2. Arbitration — deterministic conflict resolution, drops abstentions
    3. ResponseGenerator — streaming response with injected guidance
    (a Bridge is emitted up front for early TTS while the experts run)

    Post-response:
    - Process task_extraction deliverables through state machine
    - Handle state transitions
    - Emit progress updates
    """

    # This agent supports user barge-in: it ships a Barge-in Evaluator stage
    # and its pipeline config exposes the barge-in prompt. Barge-in support is
    # an intrinsic property of the agent (the configuration depends on it), not
    # a client-side preference. Operators can still force it off at the
    # deployment level via BARGE_IN_ENABLED=false.
    supports_barge_in = True

    # Teleprompter (#241): light up the reply word-by-word as it is spoken.
    # On by default for this agent; operators can force off with
    # STELLA_TELEPROMPTER_ENABLED=false.
    supports_teleprompter = True

    def __init__(
        self,
        llm_config_path: Optional[str] = None,
        experts_dir: Optional[str] = None,
        state_machine_address: Optional[str] = None,
    ):
        """Initialize the STELLA V2 Agent.

        Args:
            llm_config_path: Path to LLM configuration JSON file.
            experts_dir: Path to directory containing expert JSON configs.
            state_machine_address: gRPC address for state machine service.
        """
        super().__init__()

        self._agent_type = "stella-v2-agent"

        # Resolve config paths
        if llm_config_path is None:
            llm_config_path = self._find_config_file("config/llm_config.json")

        # State machine gRPC address
        self._state_machine_address = (
            state_machine_address
            or os.environ.get("STATE_MACHINE_ADDRESS", "localhost:50051")
        )

        # Explicit prompt-compiler version (never implicit/latest). Defaults to the
        # version this agent was authored against; overridable per deployment via
        # config["compiler_version"] in on_session_start.
        self._compiler_version: str = PROMPT_COMPILER_VERSION

        # Initialize core services
        self.llm_service = LLMService(config_path=llm_config_path)
        self.expert_registry = ExpertRegistry(experts_dir=experts_dir)

        # Initialize pipeline stages (no Input Gate — #363)
        self.bridge_generator = BridgeGenerator(self.llm_service)
        self.expert_pool = ExpertPool(
            self.llm_service, self.expert_registry,
            compiler_version=self._compiler_version,
        )
        self.arbitration = Arbitration(compiler_version=self._compiler_version)
        self.response_generator = ResponseGenerator(self.llm_service)
        self.barge_in_evaluator = BargeInEvaluator(self.llm_service)

        # Single source of truth for the conversation language (RFC §8).
        # One detection per turn, propagated to bridge + response + TTS.
        self.language_resolver = LanguageResolver()
        self._session_language: Optional[str] = None
        # Per-stream TTS voice (configured, not detected). See process().
        self._session_voice: Optional[str] = None

        # gRPC state machine client (initialized per session)
        self.sm_client: Optional[StateMachineClient] = None
        self.tool_registry: Optional[ToolRegistry] = None

        # Session state
        self.config: Dict[str, Any] = {}
        self._session_started_at: Optional[str] = None
        self._plan_config: Optional[Dict[str, Any]] = None  # stored for context building
        # Deployed Persona (#467): identity, resolved and snapshotted backend-side
        # at deploy time. Independent of the plan and of the pipeline config.
        self._persona_config: Optional[Dict[str, Any]] = None
        # Companion mode: the agent converses freely and loads one of the
        # allow-listed activities when the user picks it, instead of running a
        # single plan from the start. Absent config = plan-following, unchanged.
        self._companion_mode: bool = False
        self._available_plans: List[Dict[str, Any]] = []
        # Title of the activity currently running, for logs and the reply's context.
        self._active_activity: Optional[str] = None
        self._custom_history_limit: int = 20  # overridable via pipeline_config thresholds
        self._last_known_state_id: Optional[str] = None
        self._last_state_id: Optional[str] = None  # for detecting state transitions between turns
        self._last_post_response_state_id: Optional[str] = None  # for analytics emission
        self._turn_counter: int = 0  # monotonic turn counter for analytics
        # The reply currently being spoken, accumulated as it streams. On a
        # barge-in this is the "half-committed" message the user interrupted —
        # not yet in the recorded history — so we hand it to the Barge-in
        # Evaluator as the {{interruptedReply}} variable for in-context judging.
        self._last_reply_text: str = ""

        logger.info(
            f"Initialized with {self.expert_registry.enabled_count} experts"
        )

    # ─────────────────────────────────────────────────────────────────────
    # Analytics helpers
    # ─────────────────────────────────────────────────────────────────────

    def _elapsed_ms(self) -> float:
        """Milliseconds since stt_end for the current turn (analytics ground zero)."""
        if not self.has_audio or self.audio.turn_anchor_ts == 0:
            return 0.0
        return (time.perf_counter() - self.audio.turn_anchor_ts) * 1000

    # ─────────────────────────────────────────────────────────────────────
    # Main processing pipeline
    # ─────────────────────────────────────────────────────────────────────

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        """Process user input through the 4-stage pipeline.

        Yields AgentOutput messages: status updates, text chunks, debug info,
        deliverables, progress updates.
        """
        self._is_processing = True
        self._turn_counter += 1
        # Prefer the STT transcript_id forwarded via metadata so audio-stage and
        # agent-stage analytics share one turn_id. Fall back to a local counter
        # for non-audio inputs (text-only, tests).
        forwarded_turn_id = (input.metadata or {}).get("turn_id")
        turn_id = forwarded_turn_id or f"turn_{self._turn_counter}"

        # Barge-in context: when the SDK commits a user interruption it feeds the
        # new transcript back through process() with is_barge_in=True. Expose it
        # as a template variable so configurable prompts (notably the bridge) can
        # react to "the user just interrupted me".
        is_barge_in = bool((input.metadata or {}).get("is_barge_in"))
        prompt_variables: Dict[str, Any] = {
            "isBargeIn": is_barge_in,
            "bargeInTranscript": input.text if is_barge_in else "",
            "userInput": input.text,
        }

        # Handle on the concurrently-running Expert Pool (#455). Declared out
        # here so the `finally` below can always reap it, including when the
        # bridge raises or a barge-in closes this generator mid-stream.
        expert_task: Optional[asyncio.Task] = None

        try:
            # Fetch context
            history_limit = self._custom_history_limit
            history = await self._fetch_conversation_history(limit=history_limit)

            # Fetch state from gRPC backend (parallel calls for performance)
            sm_context = {}
            if self.sm_client:
                sm_context = await self._fetch_sm_context()

            # Resolve the turn language BEFORE the bridge fires, so bridge,
            # response prompt ({{language}}), and TTS all read one value and
            # stay coherent (RFC §8 single source of truth).
            # A plan that declares its language is PINNED to it: detection is
            # off, and STT is told what to transcribe. Whisper auto-detects from
            # a very short window and, guessing wrong, translates rather than
            # mis-hears — which is how a fully-German plan ran its whole session
            # in English. A declaration removes the guess entirely.
            plan_language = self._resolved_pin_language(self._plan_config)
            self.language_resolver.set_plan_language(plan_language)
            if self.has_audio:
                self.audio.set_stt_language(self.language_resolver.forced)
            # Prefer STT's independent acoustic detection (voice); fall back to
            # the text classifier when absent (typed input / no signal, §8.3).
            meta = input.metadata or {}
            detected_language = meta.get("detected_language") or None
            language_signal = (
                (detected_language, float(meta.get("language_confidence") or 0.0))
                if detected_language
                else None
            )
            resolved_language = self.language_resolver.resolve(input.text, signal=language_signal)
            self._session_language = resolved_language
            sm_context["language"] = resolved_language
            # Tell the response prompt whether this is a fixed-language deployment
            # or a per-turn detection — the two need different wording to stop the
            # model opening in English on an ambiguous first turn.
            sm_context["language_pinned"] = bool(self.language_resolver.forced)
            logger.info(f"Resolved language for turn: {resolved_language}")

            # Resolve the per-stream TTS voice. Unlike language there is no
            # detection — the voice is a configured choice (plan-level), stamped
            # on every chunk so bridge and response are spoken in one coherent
            # voice. Providers that support voice selection honor it; others
            # disregard it. None → provider/env default.
            # Persona owns voice identity (#467). plan.voice is gone: nothing ever
            # wrote it, and keeping a second source would reintroduce the ambiguity
            # the persona split removed.
            resolved_voice = (self._persona_config or {}).get("voice") or None
            self._session_voice = resolved_voice

            yield AgentOutput.status(
                input.session_id, "Processing your message...", StatusSubtype.PROCESSING
            )

            # ── Stages 1 + 2 run CONCURRENTLY (#455) ──
            # The Input Gate is gone (#363): every enabled expert runs each turn
            # and decides for itself whether to engage (abstaining with a
            # non-flagging verdict), with arbitration filtering the abstentions.
            # So nothing selects experts based on the bridge, and the two stages
            # are independent: the bridge reads only the user's text + history,
            # the experts read only the state-machine snapshot taken above.
            #
            # They used to run back to back — the pool was awaited AFTER the
            # bridge stream had fully drained — so the user heard the bridge
            # finish and then sat through the expert latency in silence. Kicking
            # the pool off HERE puts both on the same wall clock, making the
            # critical path max(bridge, experts) instead of bridge + experts.
            #
            # Contract for anything added between this line and the `await
            # expert_task` below: do not mutate `sm_context` or `history`, the
            # pool is reading them concurrently.
            experts_to_run = self.expert_registry.get_enabled_names()
            logger.info(f"Stage 2: Expert Pool (started, runs alongside bridge) — {experts_to_run}")
            expert_task = asyncio.create_task(
                self.expert_pool.run(experts_to_run, input.text, history, sm_context)
            )
            # Emitted next to bridge_start on purpose: the two elapsed_ms values
            # being equal IS the property this change buys, and drift between
            # them is how a regression would show up in the analytics timeline.
            yield AgentOutput.analytics_event(
                input.session_id, "expert_pool_start", turn_id, self._elapsed_ms(),
            )

            logger.info(f"Stage 1: Bridge for: '{input.text}'")
            yield AgentOutput.analytics_event(
                input.session_id, "bridge_start", turn_id, self._elapsed_ms(),
            )

            # Shared transcript_id for bridge + response (one seamless utterance)
            transcript_id = f"response_{uuid.uuid4().hex[:8]}"

            # Stream the bridge through the SAME accumulated-TEXT_CHUNK interface
            # the Response Generator uses: each emitted chunk is the full bridge so
            # far, and the SDK's run loop diffs it and hands every completed
            # sentence to TTS the instant it's ready. So the first sentence starts
            # speaking after a few hundred ms instead of waiting for the whole
            # (now richer) bridge — and the rest streams in behind it. is_final
            # stays False: the response continues this same transcript.
            bridge = ""
            bridge_ready_emitted = False
            # Set once the generator has classified the turn (it does so before
            # yielding anything, and still does it on a silent turn that yields
            # nothing at all), then reused for the reply so bridge and reply are
            # spoken at ONE rate — a rate change mid-utterance reads as a glitch.
            turn_speed = 1.0
            async for bridge_accum in self.bridge_generator.generate_stream(
                input.text, history, language=resolved_language, variables=prompt_variables
            ):
                if not bridge_accum:
                    continue
                bridge = bridge_accum
                # Track what's being spoken so a barge-in during the bridge still
                # has the (latest) half-committed message to evaluate.
                self._last_reply_text = bridge
                if not bridge_ready_emitted:
                    bridge_ready_emitted = True
                    # First audible byte of the turn — record the timing here.
                    yield AgentOutput.analytics_event(
                        input.session_id, "bridge_ready", turn_id, self._elapsed_ms(),
                        bridge_text=bridge,
                    )
                bridge_output = AgentOutput.text_chunk(
                    input.session_id,
                    bridge,
                    transcript_id=transcript_id,
                    is_final=False,
                )
                bridge_output.metadata["tts_source"] = "bridge"
                bridge_output.metadata["language"] = resolved_language
                if resolved_voice:
                    bridge_output.metadata["voice"] = resolved_voice
                turn_speed = _turn_speed(getattr(self.bridge_generator, "last_bridge_mode", None))
                bridge_output.metadata["speed"] = turn_speed
                yield bridge_output

            # Covers the silent turn too, where the loop above never ran.
            turn_speed = _turn_speed(getattr(self.bridge_generator, "last_bridge_mode", None))

            if bridge:
                logger.info(
                    f"Bridge ({getattr(self.bridge_generator, 'last_bridge_mode', None)}, "
                    f"rate {turn_speed:.2f}): '{bridge}'"
                )

            # ── Stage 2: Expert Pool — join the run started above ──
            # All enabled experts ran in parallel and self-gated; task_extraction
            # updates the state machine via tool calls (set_deliverable, etc.),
            # but we keep the ORIGINAL sm_context for response generation so the
            # agent still performs task instructions before advancing.
            # noise_detection also runs every turn and covers the old
            # gate-failure path via its arbitration short-circuit.
            #
            # By now the pool has had the whole bridge to work in, so this await
            # often returns immediately. Everything downstream — arbitration, the
            # collected-deliverables diff, response generation — still sees a
            # fully-completed pool, so ordering guarantees are unchanged.
            all_verdicts = await expert_task
            yield AgentOutput.analytics_event(
                input.session_id, "expert_pool_done", turn_id, self._elapsed_ms(),
            )

            for v in all_verdicts:
                yield AgentOutput.debug(
                    input.session_id,
                    f"Expert '{v.expert_name}': {v.verdict} ({v.confidence:.2f}) in {v.latency_ms:.0f}ms",
                    component=f"expert:{v.expert_name}",
                    **v.to_debug_dict(),
                )
                # A verdict says what an expert concluded, not what it DID. Tool
                # calls are the actual side effects of the turn — setting a
                # deliverable, advancing the plan, starting an activity — and
                # they were previously visible only in pod logs.
                for call in (v.raw_output or {}).get("tool_results", []) or []:
                    yield AgentOutput.tool_call(
                        input.session_id,
                        call.get("name", "unknown"),
                        caller=v.expert_name,
                        arguments=call.get("arguments"),
                        success=bool(call.get("success")),
                        data=call.get("data"),
                        error=call.get("error"),
                    )

            # Determine which deliverables were just collected by task_extraction
            # by comparing state machine before/after. This is more reliable than
            # reading deliverables_set from the runner's raw_output (which may
            # under-report due to batch_update result parsing issues).
            collected_keys: list = []
            if self.sm_client:
                pre_collected = set(sm_context.get("collected_deliverables", {}).keys())
                post_collected = await self.sm_client.get_collected_deliverables()
                collected_keys = [k for k in post_collected if k not in pre_collected]
                # Visibility for the "agent re-asks for info already given" class of
                # bug: the response prompt only suppresses an "ask …" instruction
                # for keys in collected_keys, so if task_extraction silently fails
                # to set a deliverable the user clearly provided, the agent re-asks.
                # This line makes that diagnosable from logs without a debugger.
                still_pending = [
                    d["key"] for d in sm_context.get("deliverables", [])
                    if d.get("status") == "pending" and d["key"] not in collected_keys
                ]
                logger.info(
                    "Deliverables this turn: collected_now=%s already=%s still_pending=%s",
                    collected_keys, sorted(pre_collected), still_pending,
                )

            # ── Stage 3: Deterministic Arbitration (original context) ──
            logger.info("Stage 3: Arbitration")
            arb_result = self.arbitration.resolve(
                all_verdicts,
                sm_context,
                expert_configs=self.expert_registry.as_map(),
                user_input=input.text,
            )

            # Companion routing (#467): the router's tools have already acted on the
            # state machine; this reconciles the agent's own view and tells the
            # reply what just happened. Folded in BEFORE the arbitration debug is
            # published so that debug line reports the directive the response is
            # actually written from, not a pre-companion draft of it.
            companion = (
                self._apply_companion_tool_results(all_verdicts)
                if self._companion_mode
                else {}
            )
            directive = arb_result.directive
            if companion:
                sm_context["companion"] = companion
                # Its OWN field, not primary_action: primary_action loses to any
                # expert follow-up question, and probing reliably produces one on
                # exactly the turns the router fires — "what can we do?" is a
                # probing cue too. Grace then spoke probing's question and invented
                # household chores while the real activity list sat unread.
                directive.routing_directive = self._companion_directive(companion)

            yield AgentOutput.debug(
                input.session_id,
                f"Arbitration: tone={arb_result.directive.tone}, favored={arb_result.favored_expert}",
                component="arbitration",
                **arb_result.to_debug_dict(),
            )

            # Analytics: safety/routing decision for this turn
            yield AgentOutput.analytics(
                input.session_id, stage="safety_routing", timing_ms=0,
                route="INTERCEPTED" if arb_result.directive.short_circuit else "SAFE",
                experts_consulted=experts_to_run,
                turn_id=turn_id,
            )

            if companion:
                for decision in self._companion_decisions(input.session_id, companion):
                    yield decision

            # Deterministic verdict directive: a flagging expert can replace the
            # generated response with a literature-informed template.
            deterministic_response = (
                directive.resolved_response
                or directive.redirect_message
                or self.arbitration.gate_failure_message_for(resolved_language)
            )
            if directive.action == "short_circuit":
                # Replace the response AND skip downstream processing entirely
                # (e.g. noise_detection "unclear" — nothing actionable this turn).
                # Reuse the bridge's transcript_id so the acknowledgment bridge and
                # the deterministic line are ONE finalized utterance — otherwise the
                # bridge (transcript_id, is_final=False) is left dangling and the
                # safety line is spoken as a separate, ungrouped TTS chunk.
                logger.info(f"Arbitration short_circuit by '{directive.directive_source}'")
                short_circuit_output = AgentOutput.text_chunk(
                    input.session_id, deterministic_response,
                    transcript_id=transcript_id, is_final=True,
                )
                short_circuit_output.metadata["language"] = resolved_language
                if resolved_voice:
                    short_circuit_output.metadata["voice"] = resolved_voice
                yield short_circuit_output
                return
            if directive.action == "override":
                # Replace the spoken response with the deterministic template, but
                # still run Stage 5 post-response processing (task_extraction already
                # mutated the state machine during Stage 2; reflect that progress).
                # Same transcript_id as the bridge so the two are one finalized
                # utterance (see short_circuit above).
                logger.info(f"Arbitration override by '{directive.directive_source}'")
                override_output = AgentOutput.text_chunk(
                    input.session_id, deterministic_response,
                    transcript_id=transcript_id, is_final=True,
                )
                override_output.metadata["language"] = resolved_language
                if resolved_voice:
                    override_output.metadata["voice"] = resolved_voice
                yield override_output

            # ── Stage 4: Response Generator (original context + collected keys filtered) ──
            # Skipped on "override": the deterministic template above already replaced
            # the spoken reply, but we still fall through to Stage 5 post-processing.
            # On "prepend": the literature template is spoken first, then the LLM continues.
            if directive.action != "override":
                # Pass collected keys so the response prompt filters them from "still need to collect",
                # preventing the agent from asking about deliverables the user already provided.
                logger.info("Stage 4: Response Generator (streaming)")
                yield AgentOutput.status(
                    input.session_id, "Generating response...", StatusSubtype.PROCESSING
                )
                yield AgentOutput.analytics_event(
                    input.session_id, "response_start", turn_id, self._elapsed_ms(),
                )

                # Re-anchor the response to the state the turn actually landed in:
                # a phase may have completed and advanced during Stage 2, and the
                # response must open the new phase rather than finish the old one.
                # The transition signal comes from the task_extraction verdict (the
                # SM tools report it) — no extra backend round-trips to detect.
                # Done here (not before arbitration) so it's skipped on override/
                # short-circuit turns where no LLM response is generated.
                te_raw = next(
                    (
                        v.raw_output for v in all_verdicts
                        if v.expert_name == "task_extraction" and v.success and v.raw_output
                    ),
                    {},
                )
                # Starting an activity is the SAME class of event as a mid-turn
                # phase advance: the state machine changed after `sm_context` was
                # read, so the turn-start snapshot no longer describes reality.
                # Here it describes a session with no plan at all, and the reply
                # would be improvised — the agent opened the fitness check-in by
                # inventing a frequency question while the plan sat waiting on
                # "greet and ask for name".
                started_state_id = companion.get("started_state_id")
                response_sm_context = await self._resolve_response_context(
                    sm_context,
                    resolved_language,
                    transitioned=bool(te_raw.get("transitioned")) or bool(started_state_id),
                    new_state_id=te_raw.get("new_state_id") or started_state_id,
                    session_completed=bool(te_raw.get("session_completed")),
                )
                response_sm_context["_collected_keys"] = collected_keys

                prepend_text = directive.resolved_response if directive.action == "prepend" else ""

                first_token_emitted = False
                async for output in self.response_generator.generate(
                    session_id=input.session_id,
                    user_input=input.text,
                    directive=arb_result.directive,
                    conversation_history=history,
                    sm_context=response_sm_context,
                    bridge=bridge,
                    prepend=prepend_text,
                    transcript_id=transcript_id,
                ):
                    if output.type.value == "text_chunk":
                        # Stamp the resolved language so the SDK sets the TTS voice
                        # for the main response, coherent with the bridge (RFC §8.2.1).
                        output.metadata["language"] = resolved_language
                        if resolved_voice:
                            output.metadata["voice"] = resolved_voice
                        # Same rate as the bridge — one turn, one voice setting.
                        output.metadata["speed"] = turn_speed
                        # Keep the latest accumulated reply so a barge-in mid-stream
                        # can evaluate against the half-committed message.
                        if output.content:
                            self._last_reply_text = output.content
                        if not first_token_emitted:
                            yield AgentOutput.analytics_event(
                                input.session_id, "response_first_token", turn_id, self._elapsed_ms(),
                            )
                            first_token_emitted = True
                    yield output

                yield AgentOutput.analytics_event(
                    input.session_id, "response_done", turn_id, self._elapsed_ms(),
                )

            # ── Stage 5: Post-response processing ──
            # Surface the extraction expert's tool-driven state changes (deliverables
            # set, tasks completed/skipped), emit progress updates, and handle session
            # completion. All task/deliverable mutation is performed by the agent's
            # explicit tool calls — there is no post-hoc auto-completion (#291).
            logger.info("Stage 5: Post-response processing")
            async for output in self._process_post_response(
                input.session_id, all_verdicts
            ):
                yield output

        except Exception as e:
            logger.error(f"Processing error: {e}")
            yield AgentOutput.error(
                input.session_id,
                f"Processing error: {str(e)}",
                error_type="processing_error",
                recoverable=True,
            )

        finally:
            self._is_processing = False
            if expert_task is not None:
                # Barge-in or a bridge error can leave the pool in flight.
                if not expert_task.done():
                    expert_task.cancel()
                # Retrieve the result/exception so a pool that failed before we
                # ever awaited it doesn't surface as asyncio's
                # "Task exception was never retrieved" at GC time. Not awaited:
                # this `finally` may run during generator close, where blocking
                # is not safe.
                expert_task.add_done_callback(
                    lambda t: t.cancelled() or t.exception()
                )

    # ─────────────────────────────────────────────────────────────────────
    # Post-response processing
    # ─────────────────────────────────────────────────────────────────────

    async def _process_post_response(
        self,
        session_id: str,
        expert_verdicts: list,
    ) -> AsyncIterator[AgentOutput]:
        """Process expert results after response generation completes.

        task_extraction mutates the backend state machine directly via its tools
        (set_deliverable / complete_task / skip_task / batch_update). Here we only:
        1. Read what those tools did from the verdict
        2. Emit AgentOutput.deliverable() for each set deliverable
        3. Increment the turn counter if no progress was made
        4. Fetch updated full state and emit progress / handle session end
        """
        if not self.sm_client:
            return

        deliverables_found = False
        tasks_completed = False

        # Process task_extraction verdict (tool-based)
        task_verdict = next(
            (v for v in expert_verdicts if v.expert_name == "task_extraction" and v.success),
            None,
        )
        if task_verdict and task_verdict.raw_output:
            raw = task_verdict.raw_output

            # Session termination: backend transitioned to __end__.
            # Emit the farewell before the progress update, then flag the agent
            # to stop accepting new turns (run_audio_loop checks _session_completed).
            if raw.get("session_completed"):
                farewell = raw.get("farewell_message")
                if farewell:
                    yield AgentOutput.text_final(session_id, farewell)
                self._session_completed = True
                logger.info(
                    f"Session {session_id} completed — agent will exit after this turn"
                )
                # Fall through so the final progress update is still emitted.

            deliverables_set = raw.get("deliverables_set", [])
            tasks_done = raw.get("tasks_completed", [])
            tasks_skipped = raw.get("tasks_skipped", [])

            if deliverables_set:
                deliverables_found = True
                # Fetch collected values from backend to emit accurate data
                collected = await self.sm_client.get_collected_deliverables()

                yield AgentOutput.debug(
                    session_id,
                    f"Tool extraction: {len(deliverables_set)} deliverables set",
                    component="post_response",
                    deliverable_keys=deliverables_set,
                )

                for key in deliverables_set:
                    value = collected.get(key)
                    yield AgentOutput.deliverable(session_id, key=key, value=value)

            # Completing OR skipping a task is progress (the agent addressed it).
            # All task state changes come from the agent's explicit tool calls now —
            # the backend never auto-completes a task from deliverable presence (#291).
            if tasks_done or tasks_skipped:
                tasks_completed = True
                yield AgentOutput.debug(
                    session_id,
                    f"Tasks addressed — completed: {tasks_done}, skipped: {tasks_skipped}",
                    component="post_response",
                    completed_task_ids=tasks_done,
                )

        # Fetch updated state once so we can:
        # 1) detect fallback completion when backend moved to __end__
        #    but tool payload did not set session_completed=true
        # 2) avoid incrementing turn counters after session termination
        full_state = await self.sm_client.get_full_state()
        reached_end_state = bool(full_state and full_state.get("current_state_id") == "__end__")

        # Fallback completion path:
        # If we reached __end__ but didn't receive session_completed in tool output,
        # emit the configured farewell from the plan metadata and stop the agent.
        if reached_end_state and not self._session_completed:
            farewell = None
            if task_verdict and task_verdict.raw_output:
                farewell = task_verdict.raw_output.get("farewell_message")
            if not farewell:
                farewell = self._plan_farewell_message()
            if farewell:
                yield AgentOutput.text_final(session_id, farewell)

            if self._companion_mode:
                # A finished activity is not a finished conversation. The companion
                # takes the floor back and keeps talking, so __end__ means "pop",
                # not "hang up" — the plan's own farewell still plays as the
                # hand-back line.
                finished = self._active_activity
                await self._return_to_companion(reason="activity reached its end")
                yield AgentOutput.decision(
                    session_id,
                    "activity_completed",
                    f"Finished “{finished}”" if finished else "Finished the activity",
                    detail="Back to free conversation",
                    component="companion_router",
                )
            else:
                self._session_completed = True
                logger.info(
                    f"Session {session_id} reached __end__ — fallback completion applied"
                )

        # Increment turn counter only when no progress was made and session is still active.
        if not deliverables_found and not tasks_completed and not reached_end_state:
            await self.sm_client.increment_turn()
            # Refresh state after counter update so the published progress is current.
            full_state = await self.sm_client.get_full_state()
            # increment_turn() re-evaluates transitions (#172), so an authored
            # turn_count_exceeded -> __end__ route can complete the session on this
            # very turn. Re-run the fallback completion here; otherwise the farewell
            # would only fire on the next cycle and the loop would accept a dangling
            # turn first (this turn's reached_end_state was computed pre-increment).
            if (
                full_state
                and full_state.get("current_state_id") == "__end__"
                and not self._session_completed
            ):
                reached_end_state = True
                farewell = self._plan_farewell_message()
                if farewell:
                    yield AgentOutput.text_final(session_id, farewell)
                if self._companion_mode:
                    # Same "pop, don't hang up" rule as the path above. An authored
                    # turn_count_exceeded -> __end__ route reaches the end HERE, so
                    # without this a stalled activity would end the whole session.
                    finished = self._active_activity
                    await self._return_to_companion(
                        reason="activity reached its end via turn increment"
                    )
                    yield AgentOutput.decision(
                        session_id,
                        "activity_completed",
                        f"Finished “{finished}”" if finished else "Finished the activity",
                        detail="Back to free conversation",
                        component="companion_router",
                    )
                else:
                    self._session_completed = True
                logger.info(
                    f"Session {session_id} reached __end__ via turn increment — "
                    "fallback completion applied"
                )

        # ── Analytics emissions ──
        last_transition = None
        if full_state:
            current_state_id = full_state.get("current_state_id")
            previous_state_id = self._last_post_response_state_id

            # Build transition metadata if the state changed during this turn.
            if current_state_id and current_state_id != previous_state_id:
                last_transition = self._build_last_transition_metadata(
                    previous_state_id, current_state_id
                )

            # Update tracker AFTER comparison so the next turn sees this turn's end state.
            self._last_post_response_state_id = current_state_id

            # Analytics: plan completion snapshot (emitted each turn for dashboard)
            # progress is int 0-100 from gRPC; convert to 0-1 ratio
            yield AgentOutput.analytics(
                session_id, stage="plan_completion", timing_ms=0,
                completion_rate=full_state.get("progress", 0) / 100,
                plan_reached_end=reached_end_state,
                plan_id=full_state.get("plan_id"),
            )

        # Emit final progress for this turn.
        companion_meta = self._companion_progress_metadata()
        full_state = full_state or {}
        if self._companion_mode and not self._plan_config:
            # The activity can have been dropped mid-turn — stopped by the user,
            # or reached its end — AFTER full_state was fetched. Trust the agent's
            # own view over that stale snapshot: publishing it would leave a
            # finished plan on the panel with nothing left to advance it.
            full_state = {}
        if full_state or companion_meta:
            current_state_id = full_state.get("current_state_id")
            last_transition = self._build_last_transition_metadata(
                from_state_id=self._last_known_state_id,
                to_state_id=current_state_id,
            )
            self._last_known_state_id = current_state_id

            # The progress panel renders this text to the user, so it must show
            # the resolved persona rather than the author's {{persona.*}} tokens.
            if full_state:
                self._resolve_persona_in_plan_text(full_state)
            progress_state = progress_from_full_state(
                full_state,
                plan=self._plan_config,
                session_started_at=self._session_started_at,
                extra_metadata={
                    "architecture": "stella_v2_pipeline",
                    "last_transition": last_transition,
                    **({"companion": companion_meta} if companion_meta else {}),
                },
            )
            yield AgentOutput.progress_update(
                session_id,
                progress_state,
                update_trigger="turn_completion",
                agent_name=self.agent_name,
                agent_icon="🧠",
            )

    # ─────────────────────────────────────────────────────────────────────
    # Session lifecycle
    # ─────────────────────────────────────────────────────────────────────

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        """Initialize session: load plan, configure experts, set up state machine."""
        await super().on_session_start(session_id, config)

        self._session_started_at = datetime.utcnow().isoformat() + "Z"
        self.config = config
        self._plan_config = None
        self._persona_config = self._load_persona_config(config)
        # Clear any resolved language from a previous session on this instance.
        self.language_resolver.reset()
        self._session_language = None
        self._session_voice = None
        # Explicit compiler version: config override, else the agent's pinned default.
        self._compiler_version = config.get("compiler_version") or PROMPT_COMPILER_VERSION

        # Load plan and initialize gRPC state machine
        plan = self._load_plan_config(config)

        # Declare the plan's language to STT BEFORE the first utterance. Doing it
        # on the first turn is too late: the opening utterance is exactly the one
        # that gets misdetected (it is short, and often starts with a name), and
        # it is what confirms the lock for the rest of the session.
        self.language_resolver.set_plan_language(self._resolved_pin_language(plan))
        if self.has_audio:
            self.audio.set_stt_language(self.language_resolver.forced)
            # Seed TTS too. The opening greeting is synthesised before any turn
            # resolves, so without this the agent's FIRST words come out in the
            # provider default while everything after them follows the plan.
            self.audio.set_tts_language(self.language_resolver.forced)
        # Companion mode is declared by the deploy config. A companion starts with
        # NO plan — it converses until the user picks an activity — so the state
        # machine connection cannot be gated on having one up front.
        self._companion_mode = config.get("mode") == "companion"
        self._available_plans = config.get("available_plans") or []
        self._active_activity = None
        if self._companion_mode:
            logger.info(
                "Companion mode: %d activit%s available",
                len(self._available_plans),
                "y" if len(self._available_plans) == 1 else "ies",
            )

        if plan or self._companion_mode:
            self._plan_config = plan

            # Connect to gRPC state machine service
            self.sm_client = StateMachineClient(
                session_id=session_id,
                address=self._state_machine_address,
            )
            await self.sm_client.connect()

            if plan:
                result = await self.sm_client.initialize(plan)
                if result and result.get("success"):
                    logger.info(f"State machine initialized via gRPC: {plan.get('title', 'Unknown')}")
                else:
                    error = result.get("error", "unknown") if result else "no response"
                    logger.error(f"Failed to initialize state machine: {error}")

            # Create tool registry with SDK state machine tools
            self.tool_registry = ToolRegistry()
            for tool in create_state_machine_tools(self.sm_client):
                self.tool_registry.register(tool)

            if self._companion_mode:
                for tool in create_companion_tools(self._available_plans, self.sm_client):
                    self.tool_registry.register(tool)

            # Wire tool registry into expert pool
            self.expert_pool.set_tool_registry(self.tool_registry)

            # A plan's system_prompt is deliberately NOT read (#467 phase 2).
            # Identity comes from the deployed Persona alone; a hand-authored plan
            # JSON cannot reintroduce a second source by carrying the old field.

        # Apply per-session expert overrides from config
        expert_overrides = config.get("expert_overrides", {})
        if expert_overrides:
            experts_dir = config.get("experts_dir")
            self.expert_registry = ExpertRegistry(
                experts_dir=experts_dir, overrides=expert_overrides
            )
            # Rebuild pipeline stages with updated registry
            self.expert_pool = ExpertPool(
                self.llm_service, self.expert_registry,
                tool_registry=self.tool_registry,
                compiler_version=self._compiler_version,
            )

        # Ensure the (possibly rebuilt) expert pool compiles prompts with the
        # session's resolved compiler version, honoring any config override.
        self.expert_pool.set_compiler_version(self._compiler_version)
        # Arbitration resolves {{placeholders}} in verdict templates with the same version.
        self.arbitration.set_compiler_version(self._compiler_version)

        # Apply LLM config overrides
        if "model" in config:
            self.llm_service.default_config.model = config["model"]
        if "temperature" in config:
            self.llm_service.default_config.temperature = config["temperature"]

        # Apply pipeline configuration (from Agent Configurator) — required
        pipeline_config = config.get("pipeline_config")
        if not pipeline_config:
            raise ValueError(
                "pipeline_config is required. Please select or create a pipeline "
                "configuration before deploying the agent."
            )
        self._apply_pipeline_config(pipeline_config)
        # AFTER the saved configuration, and deliberately so. The router is not an
        # assessment expert an operator opts into — it is the mechanism companion
        # mode is made of, in the same way task_extraction is the mechanism plans
        # are made of. Its enablement is therefore a function of the deploy MODE,
        # not of the expert list, and a saved configuration must not be able to
        # countermand it in either direction:
        #   * enabled in companion mode — otherwise a config that happens to carry
        #     `companion_router: {enabled: false}` (which is what the Configurator
        #     saves today, since it ships disabled) degrades the session into a
        #     companion that can never offer, start or stop anything, silently.
        #   * disabled in plan mode — otherwise an operator who switched it on to
        #     look at it pays for an LLM call every turn, for a router whose tools
        #     are not even registered.
        self.expert_registry.apply_config(
            {"experts": {"companion_router": {"enabled": self._companion_mode}}}
        )

        # Plan text is persona-resolved once for the session. _fetch_sm_context
        # resolves the per-turn copy it builds for prompts, but _plan_config is
        # also read directly (progress payloads, farewell), and those readers were
        # showing raw {{persona.name}} tokens in the UI.
        if self._plan_config:
            self._resolve_persona_in_plan_text(self._plan_config)

        # The Configurator's persona slot is gone (#467), so there is no ordering
        # hazard left here — identity has one source and this is simply where it
        # is handed to the stage that speaks it.
        if self._persona_config:
            self.response_generator.persona = self._persona_config.get("system_prompt")

        logger.info(f"Session started: {session_id}")

    async def on_ready(self, session_id: str) -> AsyncIterator[AgentOutput]:
        """Send initial progress state when agent joins the room."""
        if self.sm_client:
            # ``or {}`` so the companion branch below can read it uninitialised:
            # get_full_state() returns None when no plan row exists, which is the
            # normal state for a companion that has not started an activity.
            full_state = await self.sm_client.get_full_state() or {}
            # Before anything reads companion state: the session may already be in
            # an activity this pod knows nothing about.
            self._rehydrate_active_activity(full_state)
            # A companion joins with no plan at all, so gating on full_state alone
            # would publish nothing and the panel would have no way to learn what
            # this session can offer until the user happened to ask.
            companion_meta = self._companion_progress_metadata()
            if full_state or companion_meta:
                self._last_known_state_id = full_state.get("current_state_id")
                if full_state:
                    self._resolve_persona_in_plan_text(full_state)
                progress_state = progress_from_full_state(
                    full_state,
                    plan=self._plan_config,
                    session_started_at=self._session_started_at,
                    extra_metadata={
                        "architecture": "stella_v2_pipeline",
                        "last_transition": None,
                        **({"companion": companion_meta} if companion_meta else {}),
                    },
                )
                yield AgentOutput.progress_update(
                    session_id,
                    progress_state,
                    update_trigger="session_start",
                    agent_name=self.agent_name,
                    agent_icon="🧠",
                )

    def _apply_pipeline_config(self, pipeline_config: Dict[str, Any]) -> None:
        """Apply pipeline configuration overrides from Agent Configurator.

        Reads 'nodes' and 'thresholds' from the config dict and calls
        apply_config() on each pipeline stage.
        """
        nodes = pipeline_config.get("nodes", {})
        thresholds = pipeline_config.get("thresholds", {})

        # Apply per-node config overrides
        node_stage_map = {
            "expert_pool": self.expert_pool,
            "arbitration": self.arbitration,
            "response_generator": self.response_generator,
            "bridge_generator": self.bridge_generator,
            "barge_in": self.barge_in_evaluator,
        }

        for node_id, node_config in nodes.items():
            stage = node_stage_map.get(node_id)
            if stage and isinstance(node_config, dict) and hasattr(stage, "apply_config"):
                stage.apply_config(node_config)
                logger.info(f"Applied config to {node_id}")

        # Emotion tags (#face-emotions). MUST come after apply_config: the
        # guidelines this inspects are populated by it, so running earlier
        # inspected an empty generator and the warning below could never fire —
        # which is exactly how "the face never reacts" stayed undiagnosed.
        #
        # The flag only goes on while the pipeline is stripping tags. Asking the
        # model for markup nothing removes would have TTS read "playful" aloud.
        self.response_generator.emotion_tags = bool(
            getattr(self, "supports_emotion_tags", False)
            and getattr(self._audio_pipeline, "emotion_tags_enabled", False)
        )
        guidelines = getattr(self.response_generator, "custom_guidelines", None)
        logger.info(
            "[EMOTION-TAGS] enabled=%s, custom_guidelines=%s, carries_directive=%s",
            self.response_generator.emotion_tags,
            "yes" if guidelines else "no (SDK default)",
            "{{emotionTags}}" in guidelines if guidelines else "n/a",
        )
        if self.response_generator.emotion_tags and guidelines and "{{emotionTags}}" not in guidelines:
            # Nothing is appended in code — the guidelines own their layout — so
            # a configured template without the variable simply never asks for
            # tags, and the face never reacts with nothing to explain why.
            logger.warning(
                "[EMOTION-TAGS] Enabled, but the configured conversation "
                "guidelines do not reference {{emotionTags}} — the model will "
                "not be told the vocabulary and the face will not react. Add "
                "{{emotionTags}} to the guidelines."
            )

        # Apply expert registry config (experts and custom_experts are in expert_pool node)
        expert_pool_config = nodes.get("expert_pool", {})
        if isinstance(expert_pool_config, dict):
            experts_config = {
                k: v for k, v in expert_pool_config.items()
                if k in ("experts", "custom_experts")
            }
            if experts_config:
                self.expert_registry.apply_config(experts_config)
                # The expert pool reads the registry by reference, so updated
                # enabled/priority/custom-expert config takes effect with no
                # object rebuild.

        # Apply threshold overrides
        if "history_limit" in thresholds:
            self._custom_history_limit = int(thresholds["history_limit"])

        # Apply language resolver config (supported set, default, gating thresholds).
        language_config = pipeline_config.get("language")
        if isinstance(language_config, dict):
            self.language_resolver.apply_config(language_config)
            logger.info(f"Applied language config: {language_config}")

        logger.info(f"Pipeline config applied: {len(nodes)} nodes, {len(thresholds)} thresholds")

    async def on_session_end(self, session_id: str) -> Dict[str, Any]:
        """Cleanup and return session summary."""
        result = await super().on_session_end(session_id)

        summary: Dict[str, Any] = {
            "agent": "stella-v2-agent",
            "llm_stats": self.llm_service.get_usage_stats(),
            **result,
        }

        if self.sm_client:
            full_state = await self.sm_client.get_full_state()
            if full_state:
                summary["state_machine"] = {
                    "plan_id": full_state.get("plan_id"),
                    "plan_title": full_state.get("plan_title"),
                    "final_state": full_state.get("current_state_id"),
                    "progress_percentage": full_state.get("progress", 0) * 100,
                    "collected_deliverables": full_state.get("collected_deliverables", {}),
                }
            await self.sm_client.disconnect()
            self.sm_client = None
            self.tool_registry = None

        self.config = {}
        self._plan_config = None
        self._persona_config = None
        self._last_known_state_id = None
        logger.info(f"Session ended: {session_id}")
        return summary

    async def on_interrupt(self, session_id: str) -> None:
        """Handle user interrupt (barge-in)."""
        logger.info(f"Interrupt received: {session_id}")
        self._is_processing = False

    async def on_barge_in(self, session_id: str, transcript: str) -> BargeInDecision:
        """Evaluate a user barge-in via the configurable Barge-in Evaluator.

        Delegates to the LLM-backed evaluator (whose prompt/model are editable
        in the Agent Configurator). The conversation history is fetched and
        passed so the decision is made IN CONTEXT — e.g. an on-topic answer to
        the assistant's last question is a real turn, not noise. Returning
        COMMIT makes the SDK discard the rest of the current reply and process
        ``transcript`` as a new turn; RESUME continues from where it suspended.
        """
        logger.info(f"Evaluating barge-in: '{transcript[:50]}'")
        try:
            history = await self._fetch_conversation_history(
                limit=self.barge_in_evaluator.history_limit
            )
        except Exception as e:
            logger.warning(f"Barge-in: could not fetch history ({e}); evaluating without it")
            history = []
        # The reply being interrupted is still in flight (not yet in `history`),
        # so pass it explicitly as the {{interruptedReply}} runtime variable —
        # the half-committed message the evaluator must judge the interruption against.
        return await self.barge_in_evaluator.evaluate(
            transcript,
            conversation_history=history,
            variables={"interruptedReply": self._last_reply_text or ""},
        )

    async def on_config_update(self, session_id: str, config: Dict[str, Any]) -> None:
        """Handle runtime configuration update."""
        await super().on_config_update(session_id, config)
        self.config.update(config)

        if "model" in config:
            self.llm_service.default_config.model = config["model"]
        if "temperature" in config:
            self.llm_service.default_config.temperature = config["temperature"]

        logger.info(f"Config updated: {list(config.keys())}")

    # ─────────────────────────────────────────────────────────────────────
    # Helper methods
    # ─────────────────────────────────────────────────────────────────────

    @staticmethod
    def _companion_directive(companion: Dict[str, Any]) -> str:
        """Turn what the router did into one instruction for the reply.

        Naming the options explicitly matters: without them the model happily
        invents plausible-sounding activities that do not exist, which reads as a
        broken promise the moment the user picks one.
        """
        if companion.get("activities") is not None:
            activities = companion["activities"]
            if not activities:
                return (
                    "The user asked what you can do together, but no activities are "
                    "available. Say so plainly and keep the conversation going."
                )
            listed = "; ".join(
                f"{a.get('title')}" + (f" ({a.get('description')})" if a.get("description") else "")
                for a in activities
            )
            return (
                "The user asked what you can do together. Offer exactly these, in "
                f"your own words, and invite them to pick one: {listed}. "
                "Do not invent any others."
            )
        if companion.get("started"):
            return (
                f"The user just chose '{companion['started']}' and it is now starting. "
                "Acknowledge briefly, then do exactly what the current step below "
                "instructs — do not re-ask which activity they want, and do not "
                "invent an opening question of your own."
            )
        if companion.get("ended"):
            return (
                "The activity has just been stopped at the user's request. Close it "
                "warmly, do not try to resume it, and return to open conversation."
            )
        return ""

    @staticmethod
    def _companion_decisions(
        session_id: str, companion: Dict[str, Any]
    ) -> List[AgentOutput]:
        """Turn this turn's routing outcome into user-visible decision tags.

        One outcome can only be one of these — the router calls a single tool
        per turn — but returning a list keeps the caller a plain loop rather
        than a chain of conditionals it would have to keep in sync.
        """
        decisions: List[AgentOutput] = []
        activities = companion.get("activities")
        if activities is not None:
            titles = [a.get("title", "") for a in activities if a.get("title")]
            decisions.append(AgentOutput.decision(
                session_id,
                "activities_offered",
                f"Offered {len(titles)} activit{'y' if len(titles) == 1 else 'ies'}"
                if titles else "No activities available",
                options=titles,
                component="companion_router",
            ))
        if companion.get("started"):
            decisions.append(AgentOutput.decision(
                session_id,
                "activity_started",
                f"Started “{companion['started']}”",
                component="companion_router",
            ))
        if companion.get("ended"):
            title = companion.get("ended_title")
            decisions.append(AgentOutput.decision(
                session_id,
                "activity_ended",
                f"Left “{title}”" if title else "Left the activity",
                detail="Back to free conversation",
                component="companion_router",
            ))
        return decisions

    def _rehydrate_active_activity(self, full_state: Dict[str, Any]) -> None:
        """A companion that restarts mid-activity must remember it.

        on_session_start builds companion state from the DEPLOY config, which by
        definition carries no plan — but the state-machine row outlives the pod,
        so after a crash, a restart, or an auto-pause wake the session IS still
        in an activity while the agent believes it is not. Left unfixed the agent
        blanks the live plan off the panel on its first turn and authors replies
        with no plan context at all — the same failure as starting an activity
        without re-anchoring, arrived at from the other direction.
        """
        if not self._companion_mode or self._plan_config:
            return
        plan_id = full_state.get("plan_id")
        if not plan_id:
            return
        for activity in self._available_plans:
            if activity.get("id") == plan_id:
                self._plan_config = activity.get("plan")
                self._active_activity = activity.get("title")
                self._resolve_persona_in_plan_text(self._plan_config)
                logger.info(
                    "Resumed mid-activity after restart: %s", self._active_activity
                )
                return
        # The allow-list changed under a running activity (redeploy with a
        # different selection). Nothing to resume onto, so drop back to free
        # flow rather than running a plan the deployment no longer offers.
        logger.warning(
            "Session is in activity %s, which this deployment no longer offers — "
            "returning to free conversation",
            plan_id,
        )

    def _companion_progress_metadata(self) -> Optional[Dict[str, Any]]:
        """What the progress panel needs to know about companion state.

        Rides on every progress update so the panel can answer "is an activity
        running right now, and if not what can I pick?" from one payload,
        instead of the UI inferring it from a deploy-time snapshot that cannot
        know what happened mid-session.
        """
        if not self._companion_mode:
            return None
        return {
            "active_activity": self._active_activity,
            "activities": [
                {
                    "id": a.get("id"),
                    "title": a.get("title"),
                    "description": a.get("description"),
                }
                for a in self._available_plans
            ],
        }

    async def _return_to_companion(self, reason: str) -> None:
        """Drop the running activity and go back to free-flow conversation.

        Clears the state machine so every "no plan" path — prompts, progress,
        experts — applies unchanged, which is exactly the state a companion turn
        should be in. Leaves the session open: in companion mode the conversation
        outlives any single activity.
        """
        if self.sm_client:
            await self.sm_client.clear_plan()
        self._plan_config = None
        self._active_activity = None
        self._last_known_state_id = None
        logger.info("Back to companion mode (%s)", reason)

    def _apply_companion_tool_results(self, verdicts: List[Any]) -> Dict[str, Any]:
        """Read what the router did this turn, and reconcile the agent to it.

        The tools already performed their side effects against the state machine;
        this only syncs the agent's own view and returns what the reply needs to
        know. Returns a dict that is empty on the common turn where the router
        abstained.
        """
        outcome: Dict[str, Any] = {}
        for verdict in verdicts or []:
            if getattr(verdict, "expert_name", "") != "companion_router":
                continue
            for result in (verdict.raw_output or {}).get("tool_results", []) or []:
                data = result.get("data") or {}
                if data.get("offer_activities"):
                    outcome["activities"] = data.get("activities", [])
                if data.get("activity_started"):
                    self._active_activity = data.get("activity_title")
                    # The plan was loaded backend-side by the tool; adopt it locally
                    # so farewell/voice/language lookups resolve against it.
                    for activity in self._available_plans:
                        if activity.get("id") == data.get("activity_id"):
                            self._plan_config = activity.get("plan")
                            break
                    outcome["started"] = self._active_activity
                    # Where LoadPlan left the state machine. The response for THIS
                    # turn must be authored against it — see _resolve_response_context.
                    outcome["started_state_id"] = data.get("current_state_id")
                if data.get("activity_ended"):
                    # Capture the title BEFORE clearing it — the decision tag and
                    # the sidebar both need to name what was just left, and by the
                    # next line there is nothing left to name it with.
                    outcome["ended"] = True
                    outcome["ended_title"] = (
                        self._active_activity or data.get("activity_title")
                    )
                    self._plan_config = None
                    self._active_activity = None
                    self._last_known_state_id = None
        return outcome

    def _plan_farewell_message(self) -> Optional[str]:
        """Resolve the configured farewell from plan metadata, if any.

        Used by the fallback completion path when the session reaches __end__
        without a tool payload carrying the farewell (e.g. a turn_count_exceeded
        route firing during increment_turn).
        """
        if not self._plan_config:
            return None
        return (
            self._plan_config.get("metadata", {})
            .get("plan_builder", {})
            .get("canvas", {})
            .get("end_node_config", {})
            .get("farewell_message")
        )

    # Plan-authored fields that a plan author writes prose into, and which may
    # therefore want to name the agent. Structural fields (ids, types, statuses)
    # are deliberately excluded.
    _PLAN_TEXT_FIELDS = (
        "title", "description", "instruction", "acceptance_criteria",
        "goal_objective", "goal_context", "goal_depth_guidance",
        "goal_boundaries", "goal_success_description",
    )

    def _resolve_persona_in_plan_text(self, node: Any) -> None:
        """Resolve {{persona.*}} in plan-authored prose, in place.

        Walks the assembled plan structures rather than the raw plan config,
        because that is the form the prompt placeholders are rendered from.
        No-ops when no persona is deployed.
        """
        persona = self._persona_config
        if not persona:
            return

        if isinstance(node, dict):
            for key, value in node.items():
                if key in self._PLAN_TEXT_FIELDS and isinstance(value, str):
                    node[key] = resolve_persona_tokens(value, persona)
                else:
                    self._resolve_persona_in_plan_text(value)
        elif isinstance(node, list):
            for item in node:
                self._resolve_persona_in_plan_text(item)

    def _resolved_pin_language(self, plan: Optional[Dict[str, Any]]) -> Optional[str]:
        """The declared language for the session, or None to detect per turn.

        A plan's declaration always wins: a plan whose prompts and acceptance
        criteria are written in German is German wherever it is deployed, so the
        language belongs to that content. The persona's language is only a FALLBACK,
        for deployments that have no plan at all (companion mode) — it must never
        override a plan, or a stale persona setting could silently contradict the
        language the plan is actually written in.
        """
        return (plan or {}).get("language") or (self._persona_config or {}).get("language")

    def _load_persona_config(self, config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Read the persona snapshot the backend resolved at deploy time (#467).

        By value, never by reference: the backend writes the resolved fields into
        the deploy config, so editing or deleting a Persona reaches the NEXT
        deployment and can never restyle a session that is already running — the
        same rule pipeline_config follows on restart. It is also what makes a study
        session reproducible from its own config snapshot.

        Absent for agents deployed before personas existed, which is why every
        reader below treats it as optional.
        """
        persona = config.get("persona")
        if not isinstance(persona, dict) or not persona.get("system_prompt"):
            return None
        logger.info(
            "Loaded persona '%s' (%s)",
            persona.get("name", "unnamed"),
            "system default" if persona.get("is_system_default") else "operator-selected",
        )
        return persona

    def _load_plan_config(self, config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Load plan configuration from config or disk."""
        if "plan_id" in config:
            plan = self._load_plan(config["plan_id"])
            if plan:
                logger.info(f"Loaded plan '{config['plan_id']}' from disk")
                return plan
            logger.error(f"Failed to load plan '{config['plan_id']}'")

        elif "plan" in config:
            logger.info("Using direct plan from config")
            return config["plan"]

        return None

    def _load_plan(self, plan_id: str) -> Optional[Dict[str, Any]]:
        """Load a plan from disk by plan ID."""
        candidates: List[Path] = []

        env_dir = os.environ.get("STELLA_PLANS_DIR")
        if env_dir:
            candidates.append(Path(env_dir))

        candidates.append(Path("/app/stella-v2-agent/config/plans"))

        package_dir = Path(__file__).parent
        candidates.append(package_dir.parent.parent / "config" / "plans")

        for plans_dir in candidates:
            if not plans_dir.exists() or not plans_dir.is_dir():
                continue
            plan_file = plans_dir / f"{plan_id}.json"
            if plan_file.exists():
                try:
                    with open(plan_file, "r", encoding="utf-8") as f:
                        plan = json.load(f)
                    logger.info(f"Loaded plan from {plan_file}")
                    return plan
                except (json.JSONDecodeError, OSError) as e:
                    logger.error(f"Failed to load plan {plan_file}: {e}")

        logger.warning(f"Plan '{plan_id}' not found")
        return None

    def _build_last_transition_metadata(
        self,
        from_state_id: Optional[str],
        to_state_id: Optional[str],
    ) -> Optional[Dict[str, Any]]:
        """Build transition metadata for the frontend "branch chosen" explanation.

        Delegates to the shared SDK helper so light and v2 derive this
        identically (#310).
        """
        return build_last_transition(self._plan_config, from_state_id, to_state_id)

    def _find_config_file(self, relative_path: str) -> Optional[str]:
        """Find a config file by trying multiple locations."""
        candidates = [
            Path(f"/app/stella-v2-agent/{relative_path}"),
            Path(__file__).parent.parent.parent / relative_path,
            Path(relative_path),
        ]
        for path in candidates:
            if path.exists():
                return str(path)
        return None

    async def _resolve_response_context(
        self,
        sm_context: Dict[str, Any],
        resolved_language: Optional[str],
        transitioned: bool,
        new_state_id: Optional[str],
        session_completed: bool,
    ) -> Dict[str, Any]:
        """Return the sm_context to author the response against.

        task_extraction (Stage 2) can complete the current phase and ADVANCE the
        state machine mid-turn. The turn-start ``sm_context`` still describes the
        phase we just left, so authoring the response against it makes the agent
        keep talking about (and re-asking) the old phase while the progress panel
        — read from the post-turn backend state — correctly shows the new one. The
        two then disagree within a single turn (the #304 state-sync bug).

        Detection is free: the state-machine tools already return
        ``transitioned`` / ``new_state_id`` in their result data, surfaced on the
        task_extraction verdict — so we re-fetch the full context ONLY when a
        transition actually happened (no extra round-trips on the common,
        non-transition turn, and none just to detect).

        Falls back to the turn-start context (unchanged behaviour) when:
        * no transition happened — preserves finishing an in-progress task first;
        * the turn ended the session (``session_completed`` or
          ``new_state_id == "__end__"``) — the closing farewell is emitted in
          Stage 5; re-anchoring to the blank ``__end__`` sentinel would be wrong;
        * the re-fetch comes back unusable (gRPC hiccup / empty).
        """
        if not transitioned or session_completed or not new_state_id or new_state_id == "__end__":
            return sm_context
        if not self.sm_client:
            return sm_context

        refreshed = await self._fetch_sm_context()
        if not (refreshed and refreshed.get("state")):
            return sm_context

        refreshed["language"] = resolved_language
        # _fetch_sm_context already detects the change vs the turn-start state;
        # set it explicitly so the response eases into the new phase.
        refreshed["state_just_changed"] = True
        logger.info(
            f"State advanced mid-turn → {new_state_id}; "
            f"re-anchoring response to the new phase"
        )
        return refreshed

    async def _fetch_sm_context(self) -> Dict[str, Any]:
        """Fetch state from gRPC backend and build sm_context for the pipeline.

        Makes parallel gRPC calls, then assembles the dict structure that the
        template compiler's {{placeholders}} expect. Mirrors the shape of the
        old local StateMachine.get_context_for_prompt() / get_full_plan_context().
        """
        if not self.sm_client:
            return {}

        full_state, current_state, pending_tasks, pending_deliverables, collected = (
            await asyncio.gather(
                self.sm_client.get_full_state(),
                self.sm_client.get_current_state(),
                self.sm_client.get_pending_tasks(),
                self.sm_client.get_pending_deliverables(),
                self.sm_client.get_collected_deliverables(),
            )
        )

        if not full_state or not current_state:
            return {}

        current_state_id = full_state.get("current_state_id")

        # Build state description lookup from stored plan config
        state_descriptions: Dict[str, str] = {}
        if self._plan_config:
            for s in self._plan_config.get("states", []):
                state_descriptions[s.get("id", "")] = s.get("description", "")

        # Examples lookup from pending_deliverables (not in full_state)
        examples_map: Dict[str, list] = {
            d["key"]: d.get("examples", []) for d in pending_deliverables
        }

        # Build full_plan from full_state (for {{plan}} and {{current_focus}})
        full_plan: List[Dict[str, Any]] = []
        for state in full_state.get("states", []):
            state_entry: Dict[str, Any] = {
                "id": state.get("id"),
                "title": state.get("title"),
                "is_current": state.get("id") == current_state_id,
                "tasks": [],
            }
            for task in state.get("tasks", []):
                task_entry: Dict[str, Any] = {
                    "id": task.get("id"),
                    "description": task.get("description"),
                    "instruction": task.get("instruction", ""),
                    "status": task.get("status", "pending"),
                    "has_deliverables": len(task.get("deliverables", [])) > 0,
                    "deliverables": [],
                }
                for d in task.get("deliverables", []):
                    task_entry["deliverables"].append({
                        "key": d.get("key"),
                        "description": d.get("description"),
                        "type": d.get("type", "string"),
                        "required": d.get("required", True),
                        "status": d.get("status", "pending"),
                        "value": d.get("value"),
                        "acceptance_criteria": d.get("acceptance_criteria"),
                        "examples": examples_map.get(d.get("key", ""), []),
                    })
                state_entry["tasks"].append(task_entry)
            full_plan.append(state_entry)

        # Plan-authored text is written by a plan author who cannot know which
        # persona will run it, so {{persona.*}} is resolved here — once, centrally,
        # before any of it is formatted into a prompt. Nothing else is substituted:
        # this text becomes {{plan}} and {{current_focus}}, so resolving the wider
        # palette here would be recursive.
        self._resolve_persona_in_plan_text(full_plan)

        # Build deliverables list (pending with full detail + completed summary)
        deliverables_list: List[Dict[str, Any]] = [
            {
                "key": d.get("key"),
                "description": d.get("description"),
                "type": d.get("type", "string"),
                "required": d.get("required", True),
                "status": "pending",
                "acceptance_criteria": d.get("acceptance_criteria"),
                "examples": d.get("examples", []),
            }
            for d in pending_deliverables
        ]
        for key, value in collected.items():
            deliverables_list.append({
                "key": key,
                "status": "completed",
                "value": value,
            })

        # Current task from pending_tasks (exclude previews)
        current_tasks = [t for t in pending_tasks if not t.get("is_preview")]
        current_task = current_tasks[0] if current_tasks else None

        state_type = current_state.get("state_type", "loose")

        # Detect state transitions between turns
        state_just_changed = (
            self._last_state_id is not None
            and current_state_id != self._last_state_id
        )
        self._last_state_id = current_state_id

        return {
            # Persona reaches the prompt compiler through here, which is what makes
            # {{persona.*}} resolvable in expert prompts and verdict templates.
            "persona": self._persona_config or {},
            "full_plan": full_plan,
            "state": {
                "id": current_state.get("state_id"),
                "title": current_state.get("state_title"),
                "type": state_type,
                "description": state_descriptions.get(
                    current_state.get("state_id", ""), ""
                ),
                "goal_objective": current_state.get("goal_objective"),
                "goal_context": current_state.get("goal_context"),
                "goal_depth_guidance": current_state.get("goal_depth_guidance"),
                "goal_boundaries": current_state.get("goal_boundaries"),
                "goal_success_description": current_state.get("goal_success_description"),
            },
            "processing_mode": state_type,
            "available_tasks": current_tasks,
            "current_task": current_task,
            "deliverables": deliverables_list,
            "progress": {
                "percentage": current_state.get("progress", 0) * 100,
                "turns_without_deliverable": current_state.get(
                    "turns_without_progress", 0
                ),
            },
            "state_just_changed": state_just_changed,
            "collected_deliverables": collected,
        }

    async def _fetch_conversation_history(self, limit: int = 20) -> List[Dict[str, str]]:
        """Fetch conversation history from database via SDK."""
        if not self.has_history:
            return []
        try:
            messages = await self.get_chat_history(include_debug=False, limit=limit)
            history = []
            for msg in messages:
                role = "user" if msg.role == "user" else "assistant"
                if msg.content.strip():
                    history.append({"role": role, "content": msg.content})
            return history
        except Exception as e:
            logger.error(f"Failed to fetch history: {e}")
            return []
