"""Stage 3: Deterministic Arbitration — priority-based conflict resolution.

No LLM call. Pure Python logic. Target latency: ~1ms.

Takes expert verdicts sorted by priority and produces a ResponseDirective
that is injected into the Response Generator's system prompt.

What each verdict leads to is configuration (#222), read from the expert's
``verdict_directives``: whether it is a flag, the tone, what the reply must
avoid, the reaction (follow-up, redirect, ask about pending items, ask to
repeat) and which experts it overrides. The built-in expert files carry what
used to be code tables here. Nothing below knows an expert by name; priority
decides between experts, as before.
"""

import logging
import time
from typing import List, Dict, Any, Optional

from stella_agent_sdk import prompts as sdk_prompts

from stella_v2_agent.models.expert_verdict import ExpertVerdict
from stella_v2_agent.models.arbitration_result import ArbitrationResult, ResponseDirective
from stella_v2_agent.experts.base import ExpertConfig, VerdictDirective

logger = logging.getLogger(__name__)


# The reactions this arbitration carries out (agent.yaml declares the same list).
STEERING_REACTIONS = ("ask_followup", "redirect", "ask_about_pending")

# Verdicts that never flag when an expert's file doesn't say which do (an
# expert without rules, e.g. a custom one saved before #222).
_QUIET_VERDICTS = ("none", "clear", "no_probe", "on_track")

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

    Higher expert priority wins; the verdict rules come from the expert configs.
    """

    def __init__(self, compiler_version: str = "1.0.0"):
        # The arbitration node's tone_map (expert → tone), when a configuration
        # sets one, wins over the tone a verdict's rule names.
        self._tone_map: Dict[str, str] = {}
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
        configs: Dict[str, ExpertConfig] = expert_configs or {}

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
            if v.success and _is_flagging(v, configs)
        ]

        # 1. Deterministic verdict directives (priority-ordered).
        #    The highest-priority expert whose verdict maps to a non-"inform"
        #    directive replaces (override / short_circuit) or augments (prepend)
        #    the LLM-generated response with a literature-informed template.
        winner_verdict, winner_directive = self._select_directive(sorted_verdicts, expert_configs)
        if winner_directive is not None:
            template_text = self._template_for_language(winner_directive, sm_context)
            resolved = self._resolve_template(template_text, sm_context, user_input)
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
            directive.tone = self._tone_for(winner_verdict, configs)
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
            # tone / must_avoid / steering guidance.

        # 2. Build directive from active verdicts in priority order. An expert
        #    whose recommendation is bookkeeping (surfaces_recommendation: false,
        #    e.g. task extraction's "Set 2 deliverables") never steers the reply.
        conversational_verdicts = [
            v for v in active_verdicts if _surfaces(configs.get(v.expert_name))
        ]

        if conversational_verdicts:
            primary = conversational_verdicts[0]
            favored_expert = primary.expert_name
            directive.tone = self._tone_for(primary, configs)
            # Primary action — ONE direction from the highest-priority expert.
            directive.primary_action = primary.recommendation
        elif active_verdicts:
            favored_expert = active_verdicts[0].expert_name
            directive.tone = "neutral"

        # What the reply must avoid, from each flagging verdict's rule.
        for v in active_verdicts:
            directive.must_avoid.extend(_rule(configs, v).must_avoid if _rule(configs, v) else [])

        # 3. Steering reactions, in priority order. A follow-up or redirect is
        #    taken from the first expert whose verdict asks for one; asking about
        #    the pending items only fills the gap when nothing steered yet
        #    (priority is load-bearing: a targeted follow-up beats a generic one).
        for v in sorted_verdicts:
            rule = _rule(configs, v)
            if not v.success or rule is None:
                continue
            if rule.reaction == "ask_followup" and not _steered(directive):
                directive.ask_followup = True
                directive.followup_question = _reaction_text(v, rule)
            elif rule.reaction == "redirect" and not _steered(directive):
                directive.force_redirect = True
                directive.redirect_message = _reaction_text(v, rule)

        for v in sorted_verdicts:
            signals = v.raw_output.get("deliverable_signals", []) if v.success else []
            if isinstance(signals, list) and signals:
                directive.deliverable_signals = [s for s in signals if isinstance(s, str)]
                break

        # 4. Ask about the pending items (e.g. the conversation is stuck).
        for v in sorted_verdicts:
            rule = _rule(configs, v)
            if not v.success or rule is None or rule.reaction != "ask_about_pending":
                continue
            if _steered(directive):
                break
            redirect = _reaction_text(v, rule)
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
            break

        # 5. Build expert summary
        directive.expert_summary = self._build_summary(sorted_verdicts)

        # 6. Detect conflicts
        conflicts = self._detect_conflicts(active_verdicts, configs)

        latency_ms = (time.time() - start_time) * 1000
        return ArbitrationResult(
            directive=directive,
            conflicts=conflicts,
            favored_expert=favored_expert,
            latency_ms=latency_ms,
        )

    def _tone_for(self, verdict: ExpertVerdict, configs: Dict[str, ExpertConfig]) -> str:
        """A tone_map entry for the expert (configuration) wins, then the verdict's rule."""
        if verdict.expert_name in self._tone_map:
            return self._tone_map[verdict.expert_name]
        rule = _rule(configs, verdict)
        return (rule.tone if rule else "") or "neutral"

    def _select_directive(
        self,
        sorted_verdicts: List[ExpertVerdict],
        expert_configs: Optional[Dict[str, "ExpertConfig"]],
    ):
        """Pick the highest-priority non-"inform" verdict directive.

        Precedence per verdict, in priority order:
        1. An explicit ``verdict_directives[verdict]`` entry on the expert config
           (an explicit "inform" entry is honored — it suppresses the fallback).
        (The old noise_detection "unclear" fallback is gone: its file says
        ``short_circuit``, which is what asks the participant to repeat.)

        Returns (winning_verdict, VerdictDirective) or (None, None).
        """
        for v in sorted_verdicts:
            if not v.success:
                continue
            cfg = expert_configs.get(v.expert_name) if expert_configs else None
            vd: Optional[VerdictDirective] = None
            if cfg is not None and v.verdict in cfg.verdict_directives:
                vd = cfg.verdict_directives[v.verdict]
            if vd is not None and vd.action != "inform":
                return v, vd
        return None, None

    def _template_for_language(
        self, directive: "VerdictDirective", sm_context: Optional[Dict[str, Any]]
    ) -> str:
        """The winning verdict directive's template in the turn's language.

        ``template_i18n`` is an optional ``{language: text}`` map of overrides;
        an entry for the turn's resolved language wins, otherwise ``template``
        (today's single string, unchanged) is used — the same fallback shape
        as ``_GATE_FAILURE_MESSAGES_BY_LANG`` (#705). Kept separate from
        ``template`` itself (rather than letting it hold a dict) because the
        Agent Configurator's TypeScript contract and its reader both assume
        ``template`` is always a plain string."""
        language = (sm_context or {}).get("language") or ""
        key = language.split("-")[0].lower()
        return directive.template_i18n.get(key, directive.template)

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

    def _detect_conflicts(
        self, active_verdicts: List[ExpertVerdict], configs: Dict[str, ExpertConfig]
    ) -> List[str]:
        """A flagging verdict whose rule ``overrides`` another flagging expert."""
        conflicts: List[str] = []
        if len(active_verdicts) < 2:
            return conflicts
        flagged = {v.expert_name: v for v in active_verdicts}
        for v in active_verdicts:
            rule = _rule(configs, v)
            for other in (rule.overrides if rule else []):
                loser = flagged.get(other)
                if loser is None or other == v.expert_name:
                    continue
                cfg = configs.get(v.expert_name)
                winner = "safety" if cfg is not None and cfg.safety else v.expert_name
                conflicts.append(
                    f"{v.expert_name} ({v.verdict}) conflicts with {other} ({loser.verdict}): "
                    f"{winner} takes priority"
                )
        return conflicts


def _rule(configs: Dict[str, ExpertConfig], verdict: ExpertVerdict) -> Optional[VerdictDirective]:
    cfg = configs.get(verdict.expert_name)
    return cfg.verdict_directives.get(verdict.verdict) if cfg is not None else None


def _is_flagging(verdict: ExpertVerdict, configs: Dict[str, ExpertConfig]) -> bool:
    """Whether the verdict flags something: its rule's ``flag`` when set,
    otherwise any verdict but the quiet ones (an expert without rules)."""
    rule = _rule(configs, verdict)
    if rule is not None and rule.flag is not None:
        return rule.flag
    cfg = configs.get(verdict.expert_name)
    if cfg is not None and any(d.flag is not None for d in cfg.verdict_directives.values()):
        return False  # the expert says which verdicts flag; this one isn't listed
    return bool(verdict.verdict) and verdict.verdict not in _QUIET_VERDICTS


def _surfaces(cfg: Optional[ExpertConfig]) -> bool:
    return cfg is None or cfg.surfaces_recommendation


def _steered(directive: ResponseDirective) -> bool:
    return directive.ask_followup or directive.force_redirect


def _reaction_text(verdict: ExpertVerdict, rule: VerdictDirective) -> str:
    """The text a reaction carries: the verdict field its rule names, else the recommendation."""
    field_name = rule.reaction_field or "recommendation"
    if field_name == "recommendation":
        return verdict.recommendation or ""
    value = verdict.raw_output.get(field_name)
    return str(value) if value else (verdict.recommendation or "")
