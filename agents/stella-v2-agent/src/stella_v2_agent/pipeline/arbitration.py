"""Stage 3: Deterministic Arbitration — priority-based conflict resolution.

No LLM call. Pure Python logic. Target latency: ~1ms.

Takes expert verdicts sorted by priority and produces a ResponseDirective
that is injected into the Response Generator's system prompt.

Conflict resolution rules:
- noise_detection "unclear" → short-circuit: ask user to repeat (highest priority override)
- medical/legal > task_extraction > probing > timekeeper
- If two experts contradict, higher priority wins
"""

import logging
import time
from typing import List, Dict, Any, Optional

from stella_agent_sdk import prompts as sdk_prompts

from stella_v2_agent.models.expert_verdict import ExpertVerdict
from stella_v2_agent.models.arbitration_result import ArbitrationResult, ResponseDirective
from stella_v2_agent.experts.base import ExpertConfig, VerdictDirective

logger = logging.getLogger(__name__)


# Default tone mapping: expert name → tone when that expert flags something
_DEFAULT_TONE_MAP: Dict[str, str] = {
    "medical": "cautious",
    "legal": "cautious",
    "noise_detection": "neutral",
    "task_extraction": "friendly",
    "probing": "curious",
    "timekeeper": "encouraging",
}

# Default verdicts that indicate the expert flagged something noteworthy
_DEFAULT_FLAGGING_VERDICTS: Dict[str, set] = {
    "noise_detection": {"unclear", "partial"},
    "medical": {"low", "high", "critical"},
    "legal": {"low", "high", "critical"},
    "task_extraction": {"tool_calls_executed"},
    "probing": {"needs_clarification", "gentle_redirect"},
    "timekeeper": {"slowing", "stuck", "force_advance"},
}

_DEFAULT_GATE_FAILURE_MESSAGE = "Sorry, I didn't quite catch that. Could you say it again?"
# Locale-keyed defaults, selected PER TURN from the resolved conversation language
# (see gate_failure_message_for). This used to be picked once in apply_config()
# from a `language` key in the arbitration node config — but nothing ever puts one
# there, so it always stayed English and leaked an English line into an otherwise
# German turn. An explicit `gate_failure_message` override still wins verbatim.
_GATE_FAILURE_MESSAGES_BY_LANG: Dict[str, str] = {
    "en": _DEFAULT_GATE_FAILURE_MESSAGE,
    "de": "Entschuldigung, das hab ich leider nicht verstanden. Könntest du das nochmal sagen?",
}


class Arbitration:
    """Deterministic arbitration engine: resolves expert conflicts without an LLM.

    Priority ordering (higher priority number = higher importance):
    noise_detection (100) > medical (95) > legal (90) > task_extraction (70) > probing (60) > timekeeper (50)
    """

    def __init__(self, compiler_version: str = "1.0.0"):
        self._tone_map: Dict[str, str] = dict(_DEFAULT_TONE_MAP)
        self._flagging_verdicts: Dict[str, set] = {
            k: set(v) for k, v in _DEFAULT_FLAGGING_VERDICTS.items()
        }
        self._gate_failure_message = _DEFAULT_GATE_FAILURE_MESSAGE
        # Operator-typed override (wins verbatim, in whatever language they wrote)
        # kept apart from the locale default so the two can't shadow each other.
        self._gate_failure_override: Optional[str] = None
        # Compiler version used to resolve {{placeholders}} in verdict templates.
        # Kept in sync with the agent's PROMPT_COMPILER_VERSION via set_compiler_version().
        self._compiler_version = compiler_version

    def set_compiler_version(self, version: str) -> None:
        """Pin the prompt-compiler version used for verdict template resolution."""
        if version:
            self._compiler_version = version

    def apply_config(self, config: dict) -> None:
        """Apply configuration overrides from Agent Configurator."""
        if "tone_map" in config and isinstance(config["tone_map"], dict):
            self._tone_map.update(config["tone_map"])
        # Pick a locale-appropriate default before any explicit override.
        lang = config.get("language")
        if isinstance(lang, str):
            lang_key = lang.split("-")[0].lower()
            if lang_key in _GATE_FAILURE_MESSAGES_BY_LANG:
                self._gate_failure_message = _GATE_FAILURE_MESSAGES_BY_LANG[lang_key]
        if "gate_failure_message" in config:
            self._gate_failure_override = str(config["gate_failure_message"])
            self._gate_failure_message = self._gate_failure_override

    def gate_failure_message_for(self, language: Optional[str]) -> str:
        """The "didn't catch that" line in the turn's resolved language.

        Precedence: operator override (verbatim) → locale default for the
        resolved language → whatever apply_config settled on.
        """
        if self._gate_failure_override:
            return self._gate_failure_override
        if language:
            key = language.split("-")[0].lower()
            if key in _GATE_FAILURE_MESSAGES_BY_LANG:
                return _GATE_FAILURE_MESSAGES_BY_LANG[key]
        return self._gate_failure_message

    @property
    def gate_failure_message(self) -> str:
        return self._gate_failure_message

    def resolve(
        self,
        verdicts: List[ExpertVerdict],
        sm_context: Optional[Dict[str, Any]] = None,
        expert_configs: Optional[Dict[str, "ExpertConfig"]] = None,
        user_input: str = "",
    ) -> ArbitrationResult:
        """Resolve expert verdicts into a ResponseDirective.

        Args:
            verdicts: List of ExpertVerdict objects from the Expert Pool.
            sm_context: State machine context (for redirect/template resolution).
            expert_configs: name → ExpertConfig map, used to look up each expert's
                per-verdict deterministic directives (verdict_directives).
            user_input: The user's current message (for {{user_message}} resolution
                in verdict templates).

        Returns:
            ArbitrationResult containing the ResponseDirective for the Response Generator.
        """
        start_time = time.time()

        directive = ResponseDirective()
        conflicts: List[str] = []
        favored_expert = ""

        if not verdicts:
            latency_ms = (time.time() - start_time) * 1000
            return ArbitrationResult(directive=directive, latency_ms=latency_ms)

        # Sort by priority descending (highest priority first)
        sorted_verdicts = sorted(verdicts, key=lambda v: v.priority, reverse=True)

        # Filter to only successful verdicts that flagged something
        active_verdicts = [
            v for v in sorted_verdicts
            if v.success and self._is_flagging(v)
        ]

        # 1. Deterministic verdict directives (priority-ordered).
        #    The highest-priority expert whose verdict maps to a non-"inform"
        #    directive replaces (override / short_circuit) or augments (prepend)
        #    the LLM-generated response with a literature-informed template.
        #    The legacy noise_detection "unclear" short-circuit is expressed here
        #    as a synthesized fallback so it still wins by priority when an expert
        #    config carries no directive.
        winner_verdict, winner_directive = self._select_directive(sorted_verdicts, expert_configs)
        if winner_directive is not None:
            resolved = self._resolve_template(winner_directive.template, sm_context, user_input)
            if not resolved.strip() and winner_directive.action != "prepend":
                # Empty/failed template on a REPLACE action (override / short_circuit,
                # incl. the seeded noise short_circuit) → locale-aware safe default,
                # so we never speak an empty turn. NOT applied to prepend: there an
                # empty template must mean "add nothing before the reply", not inject
                # the "didn't catch that" line ahead of an otherwise-normal answer.
                resolved = self.gate_failure_message_for((sm_context or {}).get("language"))
            directive.action = winner_directive.action
            directive.directive_source = winner_verdict.expert_name
            directive.resolved_response = resolved
            directive.tone = self._tone_map.get(winner_verdict.expert_name, "neutral")
            favored_expert = winner_verdict.expert_name

            if winner_directive.action in ("override", "short_circuit"):
                # Back-compat flags so existing short_circuit consumers keep working.
                directive.short_circuit = True
                directive.redirect_message = resolved
                directive.expert_summary = self._build_summary(sorted_verdicts)
                latency_ms = (time.time() - start_time) * 1000
                return ArbitrationResult(
                    directive=directive,
                    conflicts=[f"{favored_expert} {winner_directive.action} replaced the response"],
                    favored_expert=favored_expert,
                    latency_ms=latency_ms,
                )
            # action == "prepend": keep going so the generated reply still gets
            # tone / must_avoid / probing / timekeeper guidance.

        # 2. Build directive from active verdicts in priority order
        #    IMPORTANT: task_extraction recommendations are internal metadata
        #    (e.g. "Collected user_name") — never surface them in the response.
        conversational_verdicts = [
            v for v in active_verdicts if v.expert_name != "task_extraction"
        ]

        if conversational_verdicts:
            primary = conversational_verdicts[0]
            favored_expert = primary.expert_name

            # Set tone from highest-priority flagging expert
            directive.tone = self._tone_map.get(primary.expert_name, "neutral")

            # Primary action — ONE direction from the highest-priority expert.
            directive.primary_action = primary.recommendation
        elif active_verdicts:
            # Only task_extraction flagged — keep neutral tone, no action directives
            favored_expert = active_verdicts[0].expert_name
            directive.tone = "neutral"

        # Must-avoid from medical/legal
        for v in active_verdicts:
            if v.expert_name in ("medical", "legal"):
                if v.verdict in ("high", "critical"):
                    if v.expert_name == "medical":
                        directive.must_avoid.append("specific medical diagnoses or treatment plans")
                    elif v.expert_name == "legal":
                        directive.must_avoid.append("specific legal advice or interpretations")

        # 3. Handle probing agent (follow-up decisions + deliverable signals)
        probing_verdict = self._find_verdict(sorted_verdicts, "probing")
        if probing_verdict and probing_verdict.success:
            if probing_verdict.verdict == "needs_clarification":
                directive.ask_followup = True
                directive.followup_question = probing_verdict.recommendation
            elif probing_verdict.verdict == "gentle_redirect":
                directive.force_redirect = True
                directive.redirect_message = probing_verdict.recommendation

            # Extract deliverable signals from probing's raw output
            signals = probing_verdict.raw_output.get("deliverable_signals", [])
            if isinstance(signals, list) and signals:
                directive.deliverable_signals = [s for s in signals if isinstance(s, str)]

        # 4. Handle timekeeper — when stuck, steer toward the pending deliverable
        #    to prevent going in circles, but ONLY if probing hasn't already
        #    steered this turn. Priority ordering is load-bearing here: probing
        #    (60) outranks timekeeper (50), so probing's targeted follow-up or
        #    redirect wins. With the Input Gate removed (#363) both experts report
        #    every turn, so this gap-fill (act only when probing tapped out to
        #    no_probe) is the common path, not an edge case.
        timekeeper_verdict = self._find_verdict(sorted_verdicts, "timekeeper")
        probing_already_steered = directive.ask_followup or directive.force_redirect
        if timekeeper_verdict and timekeeper_verdict.success and not probing_already_steered:
            if timekeeper_verdict.verdict in ("stuck", "force_advance"):
                # Build a specific redirect using pending deliverable info
                redirect = timekeeper_verdict.recommendation or ""
                if sm_context:
                    pending = [
                        d.get("description", d.get("key", ""))
                        for d in sm_context.get("deliverables", [])
                        if d.get("status") == "pending"
                    ]
                    if pending:
                        redirect = f"Ask directly about: {', '.join(pending[:2])}. Do not ask follow-up questions about other topics."

                directive.ask_followup = True
                directive.followup_question = redirect

        # 5. Build expert summary
        directive.expert_summary = self._build_summary(sorted_verdicts)

        # 6. Detect conflicts
        conflicts = self._detect_conflicts(active_verdicts)

        latency_ms = (time.time() - start_time) * 1000
        return ArbitrationResult(
            directive=directive,
            conflicts=conflicts,
            favored_expert=favored_expert,
            latency_ms=latency_ms,
        )

    def _is_flagging(self, verdict: ExpertVerdict) -> bool:
        """Check if the expert's verdict indicates it flagged something."""
        flagging_set = self._flagging_verdicts.get(verdict.expert_name)
        if flagging_set:
            return verdict.verdict in flagging_set
        # For unknown experts, any non-empty verdict is considered flagging
        return bool(verdict.verdict) and verdict.verdict not in ("none", "clear", "no_probe", "on_track")

    def _find_verdict(self, verdicts: List[ExpertVerdict], expert_name: str) -> Optional[ExpertVerdict]:
        """Find a specific expert's verdict in the list."""
        for v in verdicts:
            if v.expert_name == expert_name:
                return v
        return None

    def _select_directive(
        self,
        sorted_verdicts: List[ExpertVerdict],
        expert_configs: Optional[Dict[str, "ExpertConfig"]],
    ):
        """Pick the highest-priority non-"inform" verdict directive.

        Precedence per verdict, in priority order:
        1. An explicit ``verdict_directives[verdict]`` entry on the expert config
           (an explicit "inform" entry is honored — it suppresses the fallback).
        2. Otherwise, the legacy noise_detection "unclear" → short_circuit fallback,
           so un-migrated configs still ask the user to repeat.

        Returns (winning_verdict, VerdictDirective) or (None, None).
        """
        for v in sorted_verdicts:
            if not v.success:
                continue
            cfg = expert_configs.get(v.expert_name) if expert_configs else None
            vd: Optional[VerdictDirective] = None
            if cfg is not None and v.verdict in cfg.verdict_directives:
                vd = cfg.verdict_directives[v.verdict]
            elif v.expert_name == "noise_detection" and v.verdict == "unclear":
                vd = VerdictDirective(action="short_circuit", template="")
            if vd is not None and vd.action != "inform":
                return v, vd
        return None, None

    def _resolve_template(
        self, template: str, sm_context: Optional[Dict[str, Any]], user_input: str
    ) -> str:
        """Compile a verdict template's {{placeholders}}. Never raises.

        On compile failure (e.g. an unregistered compiler version, a malformed
        context) it FAILS CLOSED — returns "" so the caller substitutes the safe
        locale-aware default — rather than returning the raw template. Speaking a
        literal ``{{user_name}}`` on a safety-critical override is worse than the
        generic fallback line. ``speech_safe=True`` strips the {{placeholder}}
        scaffolding labels (e.g. "CURRENT USER MESSAGE:") that are meant for LLM
        system prompts, not for text spoken verbatim to the user."""
        if not template:
            return ""
        try:
            compiled = sdk_prompts.compile(
                template,
                version=self._compiler_version,
                sm_context=sm_context,
                conversation_history=None,
                user_input=user_input,
                speech_safe=True,
            )
            return compiled or ""
        except Exception as e:  # noqa: BLE001 — arbitration must stay deterministic & crash-free
            logger.warning(f"Verdict template compile failed ({e}); failing closed to safe default")
            return ""

    def _build_summary(self, sorted_verdicts: List[ExpertVerdict]) -> str:
        """One-line summary of all successful verdicts (for prompt/debug injection)."""
        return ", ".join(
            f"{v.expert_name}: {v.verdict} ({v.confidence:.2f})"
            for v in sorted_verdicts
            if v.success
        )

    def _detect_conflicts(self, active_verdicts: List[ExpertVerdict]) -> List[str]:
        """Detect contradictions between expert verdicts."""
        conflicts = []

        if len(active_verdicts) < 2:
            return conflicts

        # Check if medical/legal wants caution but probing wants more questions
        safety_experts = [v for v in active_verdicts if v.expert_name in ("medical", "legal")]
        probing_expert = next((v for v in active_verdicts if v.expert_name == "probing"), None)

        if safety_experts and probing_expert:
            for se in safety_experts:
                if se.verdict in ("high", "critical"):
                    conflicts.append(
                        f"{se.expert_name} ({se.verdict}) conflicts with probing ({probing_expert.verdict}): "
                        f"safety takes priority"
                    )

        return conflicts
