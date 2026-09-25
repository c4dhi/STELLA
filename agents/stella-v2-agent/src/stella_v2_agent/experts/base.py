"""Base expert configuration model.

Defines the ExpertConfig dataclass that represents a loadable expert
definition from a JSON file, with environment variable overrides.
"""

import logging
from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional

logger = logging.getLogger(__name__)


# Allowed verdict-directive actions. See VerdictDirective for semantics.
VERDICT_ACTIONS = ("inform", "prepend", "override", "short_circuit")


@dataclass
class VerdictDirective:
    """What the arbitration stage does with the final response when an expert
    returns a given verdict.

    This is the clinical-determinism knob: instead of letting the response LLM
    interpret a flagged dimension, the configured ``template`` (a literature-
    informed, {{placeholder}}-aware string) is spoken verbatim.

    action:
      - "inform"        → default. Feed tone/guidance into the Response Generator
                          (the LLM still writes the reply). ``template`` is ignored.
      - "prepend"       → speak ``template`` first, then the generated response.
      - "override"      → speak ONLY ``template``; the Response Generator is bypassed,
                          but post-response processing (deliverables, progress) still runs.
      - "short_circuit" → speak ONLY ``template``; bypass everything downstream.
    template: literature-informed text (supports {{placeholders}}). Empty for "inform".
    description: plain-language explanation of what this verdict means. The label +
        description are handed to the classifying LLM so it knows when to pick this
        verdict; the action/template are NOT shown to the LLM (arbitration-layer concern).
    """
    action: str = "inform"
    template: str = ""
    description: str = ""

    @staticmethod
    def coerce(value: Any) -> "VerdictDirective":
        """Normalize a value (dict from config/JSON, or an instance) into a VerdictDirective."""
        if isinstance(value, VerdictDirective):
            return value
        if isinstance(value, dict):
            action = str(value.get("action", "inform"))
            if action not in VERDICT_ACTIONS:
                # Don't fail closed silently: a typo like "overide" would otherwise
                # downgrade a deterministic safety directive to "let the LLM decide"
                # with no trace. Coerce (so the turn stays safe) but make it loud so
                # the misconfiguration is caught. Publish-time validation should
                # reject this before it ever reaches runtime.
                logger.warning(
                    "Unknown verdict action %r — falling back to 'inform'. "
                    "Valid actions: %s",
                    action, ", ".join(VERDICT_ACTIONS),
                )
                action = "inform"
            return VerdictDirective(
                action=action,
                template=str(value.get("template", "")),
                description=str(value.get("description", "")),
            )
        return VerdictDirective()

    @staticmethod
    def coerce_map(value: Any) -> Dict[str, "VerdictDirective"]:
        """Normalize a {verdict: directive-like} mapping into {verdict: VerdictDirective}."""
        if not isinstance(value, dict):
            return {}
        return {str(k): VerdictDirective.coerce(v) for k, v in value.items()}

    def to_dict(self) -> Dict[str, Any]:
        return {"action": self.action, "template": self.template, "description": self.description}


@dataclass
class ExpertConfig:
    """Configuration for a single expert, loaded from JSON.

    Attributes:
        name: Unique expert identifier (e.g. "noise_detection").
        description: What this expert does (shown in the agent configurator's
            expert summary; #363 removed the Input Gate that also consumed it).
        priority: Higher priority wins in arbitration conflicts.
        enabled: Whether this expert is active.
        model: LLM model to use for this expert.
        temperature: LLM temperature.
        max_tokens: Maximum tokens for expert response.
        can_call_functions: Whether this expert uses tool calling (e.g. set_deliverable, complete_task).
            When True, the expert runs in tool-calling mode (OPENAI_DIRECT, no JSON mode).
            When False, the expert runs in JSON mode (OPENAI_LANGCHAIN, structured JSON output).
        system_prompt: The expert's system prompt.
        output_schema: Expected output format (for documentation, not enforced by code).
        output_format: Compact JSON example appended to the compiled prompt so the LLM knows the schema.
            Not used for tool-calling experts (output_format should be empty when can_call_functions=True).
        tools: Optional allow-list of tool names this expert may call. Empty (the
            default) means every registered tool, which is the historical
            behaviour. Naming them is worth doing for two reasons measured on
            prod: the schemas are ~1500 tokens of the ~5900-token
            task_extraction prompt and are re-sent every turn, and a tool the
            expert has no use for is still an action it can choose — gpt-4o-mini
            reached for skip_task on 4 of 9 replayed turns where gpt-4o reached
            for it on none.
    """
    name: str
    description: str = ""
    priority: int = 50
    enabled: bool = True
    model: str = "gpt-4o-mini"
    temperature: float = 0.1
    max_tokens: int = 150
    can_call_functions: bool = False
    system_prompt: str = ""
    output_schema: Dict[str, Any] = field(default_factory=dict)
    output_format: str = ""
    trigger_criteria: str = ""
    history_limit: int = 0  # 0 = use runner default (8 for most, 10 for task_extraction)
    min_confidence: float = 0.0  # 0 = not applicable (unused with tool-calling experts)
    # Tool allow-list (names). Empty = all registered tools.
    tools: List[str] = field(default_factory=list)
    # Per-verdict deterministic response directives: {verdict_value: VerdictDirective}.
    # Drives literature-informed override/prepend/short_circuit at arbitration time.
    verdict_directives: Dict[str, VerdictDirective] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Coerce verdict_directives whether they arrive as dicts (JSON/config) or instances.
        self.verdict_directives = VerdictDirective.coerce_map(self.verdict_directives)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ExpertConfig":
        """Create an ExpertConfig from a dictionary (typically loaded from JSON)."""
        return cls(
            name=data["name"],
            description=data.get("description", ""),
            priority=data.get("priority", 50),
            enabled=data.get("enabled", True),
            model=data.get("model", "gpt-4o-mini"),
            temperature=data.get("temperature", 0.1),
            max_tokens=data.get("max_tokens", 150),
            can_call_functions=data.get("can_call_functions", False),
            system_prompt=data.get("system_prompt", ""),
            output_schema=data.get("output_schema", {}),
            output_format=data.get("output_format", ""),
            trigger_criteria=data.get("trigger_criteria", ""),
            history_limit=data.get("history_limit", 0),
            min_confidence=data.get("min_confidence", 0.0),
            verdict_directives=data.get("verdict_directives", {}),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "priority": self.priority,
            "enabled": self.enabled,
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "can_call_functions": self.can_call_functions,
            "system_prompt": self.system_prompt,
            "output_schema": self.output_schema,
            "output_format": self.output_format,
            "trigger_criteria": self.trigger_criteria,
            "history_limit": self.history_limit,
            "min_confidence": self.min_confidence,
            "verdict_directives": {
                k: v.to_dict() for k, v in self.verdict_directives.items()
            },
        }
