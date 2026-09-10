"""Arbitration result model.

The deterministic arbitration stage produces a ResponseDirective
that is injected into the Response Generator's system prompt.
No LLM call — pure Python logic.
"""

from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional


@dataclass
class ResponseDirective:
    """Instructions for the Response Generator, built by the Arbitration stage.

    Attributes:
        tone: Suggested tone for the response (e.g. "cautious", "friendly", "neutral").
        must_avoid: Things the response MUST NOT mention.
        primary_action: The highest-priority expert's recommendation.
        expert_summary: One-line summary of all expert verdicts for prompt injection.
        ask_followup: If True, the response should include a follow-up question.
        followup_question: Specific follow-up question to include.
        force_redirect: If True, redirect conversation (e.g. probing agent override).
        redirect_message: Specific redirect message.
        short_circuit: If True, skip response generation and use redirect_message directly.
        action: Deterministic verdict action chosen by arbitration —
            "inform" (default, LLM writes the reply), "prepend", "override", or
            "short_circuit". This is the uniform contract that the agent's
            process() loop branches on (and the precursor to the Phase-2
            TurnContext.directive).
        resolved_response: The compiled, ready-to-speak literature template for the
            winning non-inform directive (empty for "inform").
        directive_source: Name of the expert whose verdict directive won (debug/analytics).
        routing_directive: Something that ALREADY happened to this session — the
            activity list was read, an activity started, one was dropped. Unlike
            every other field here it is a FACT, not an expert's suggestion, so
            it outranks them and cannot be arbitrated away. See to_prompt_section.
    """
    tone: str = "neutral"
    must_avoid: List[str] = field(default_factory=list)
    primary_action: str = ""
    expert_summary: str = ""
    ask_followup: bool = False
    followup_question: str = ""
    force_redirect: bool = False
    redirect_message: str = ""
    short_circuit: bool = False
    deliverable_signals: List[str] = field(default_factory=list)
    # Uniform deterministic-directive contract (Phase 1).
    action: str = "inform"
    resolved_response: str = ""
    directive_source: str = ""
    routing_directive: str = ""

    def to_prompt_section(self) -> str:
        """Render as a single coherent instruction for the response system prompt.

        CRITICAL: This must produce ONE clear direction. The LLM should never
        receive competing instructions (e.g. "focus on X" AND "ask about Y" AND
        "also consider Z"). That produces incoherent multi-direction responses.

        Priority: must_avoid > deliverable acknowledgment > routing_directive >
        follow-up question > primary_action. The follow-up question is folded INTO
        the primary action, not added on top.
        """
        lines: list[str] = []

        # Safety boundaries — always included
        if self.must_avoid:
            for item in self.must_avoid:
                lines.append(f"Avoid: {item}")

        # Acknowledge what the user just provided
        if self.deliverable_signals:
            signals_str = ", ".join(self.deliverable_signals)
            lines.append(
                f"The user just provided: {signals_str}. "
                "Acknowledge this naturally before moving on."
            )

        if self.tone and self.tone != "neutral":
            lines.append(f"Tone: {self.tone}")

        # Single direction — pick ONE, most-grounded first. A routing directive
        # reports a state change that has ALREADY been committed, so the reply has
        # to be built on it; an expert's follow-up was written from the same user
        # turn WITHOUT knowing the routing happened, and following it instead
        # produces a reply that contradicts what the session just did.
        if self.routing_directive:
            lines.append(self.routing_directive)
        elif self.ask_followup and self.followup_question:
            lines.append(f"Your response should lead to: {self.followup_question}")
        elif self.primary_action:
            lines.append(f"Focus: {self.primary_action}")

        if not lines:
            return ""

        return "GUIDANCE:\n" + "\n".join(lines)

    def to_debug_dict(self) -> Dict[str, Any]:
        """Serialize for AgentOutput.debug() metadata."""
        result: Dict[str, Any] = {
            "tone": self.tone,
            "primary_action": self.primary_action,
            "ask_followup": self.ask_followup,
            "short_circuit": self.short_circuit,
            "action": self.action,
        }
        if self.directive_source:
            result["directive_source"] = self.directive_source
        if self.routing_directive:
            result["routing_directive"] = self.routing_directive
        if self.resolved_response:
            result["resolved_response"] = self.resolved_response
        if self.deliverable_signals:
            result["deliverable_signals"] = self.deliverable_signals
        if self.must_avoid:
            result["must_avoid"] = self.must_avoid
        if self.followup_question:
            result["followup_question"] = self.followup_question
        if self.force_redirect:
            result["force_redirect"] = self.force_redirect
        return result


@dataclass
class ArbitrationResult:
    """Full result from the arbitration stage.

    Attributes:
        directive: The ResponseDirective for the Response Generator.
        conflicts: Description of any expert conflicts that were resolved.
        favored_expert: Name of the expert whose recommendation won.
        latency_ms: Time taken for arbitration in milliseconds.
    """
    directive: ResponseDirective = field(default_factory=ResponseDirective)
    conflicts: List[str] = field(default_factory=list)
    favored_expert: str = ""
    latency_ms: float = 0.0

    def to_debug_dict(self) -> Dict[str, Any]:
        return {
            "directive": self.directive.to_debug_dict(),
            "conflicts": self.conflicts,
            "favored_expert": self.favored_expert,
            "latency_ms": round(self.latency_ms, 1),
        }
