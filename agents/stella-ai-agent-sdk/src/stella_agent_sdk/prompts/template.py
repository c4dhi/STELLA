"""Lightweight prompt-template rendering — the shared engine for configurable
prompts across agents.

SINGLE SOURCE OF TRUTH. The render engine (``render_prompt``), the
``PromptVariable`` descriptor, and the ``format_history`` helper live here so
every agent renders configurable prompts identically. Each agent declares its
OWN list of ``PromptVariable``s (the variables its pipeline exposes) but imports
the engine from here.

Supported syntax (Handlebars-ish, intentionally minimal):

- ``{{var}}``                      → substituted with the variable's value
                                      (booleans render as "yes"/"no", missing
                                      variables render as an empty string).
- ``{{#if var}}…{{/if}}``          → kept only when ``var`` is truthy.
- ``{{#if var}}…{{else}}…{{/if}}`` → if/else.
- ``{{#unless var}}…{{/unless}}``  → kept only when ``var`` is falsy.

Blocks may be nested. Unknown variables are treated as falsy/empty rather than
raising, so a prompt is never broken by a typo at runtime.
"""

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


@dataclass(frozen=True)
class PromptVariable:
    """A template variable that prompts may reference. Agents build their own
    registry of these and surface it to the Agent Configurator so editors know
    what they can reference."""

    name: str
    type: str  # "boolean" | "string"
    description: str


# A dotted segment is allowed so namespaced values ({{persona.name}}) can be
# referenced here too, keeping this engine's vocabulary aligned with the
# placeholder compiler's. Unknown names stay falsy/empty, as before.
_VAR_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\s*\}\}")

# Innermost if/unless block: a block whose body contains no further block
# openers (``{{#``), so iterating resolves nested blocks from the inside out.
_IF_BLOCK_RE = re.compile(
    r"\{\{#if\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}"
    r"((?:(?!\{\{#).)*?)"
    r"(?:\{\{else\}\}((?:(?!\{\{#).)*?))?"
    r"\{\{/if\}\}",
    re.DOTALL,
)
_UNLESS_BLOCK_RE = re.compile(
    r"\{\{#unless\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}"
    r"((?:(?!\{\{#).)*?)"
    r"\{\{/unless\}\}",
    re.DOTALL,
)


def _is_truthy(value: Any) -> bool:
    """Truthiness for template conditionals. Strings like "false"/"no"/"0"
    are treated as falsy so values that arrive as text behave intuitively."""
    if isinstance(value, str):
        return value.strip().lower() not in ("", "false", "no", "0", "none")
    return bool(value)


def _render_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "yes" if value else "no"
    return str(value)


def render_prompt(template: str, variables: Dict[str, Any]) -> str:
    """Render ``template`` against ``variables``.

    Resolves conditional blocks first (inside-out for nesting), then substitutes
    remaining ``{{var}}`` references. Never raises on unknown variables.
    """
    if not template or "{{" not in template:
        return template

    text = template

    # Resolve conditional blocks repeatedly until none remain. Each pass only
    # matches innermost blocks (no nested openers in the body), so nesting is
    # resolved from the inside out.
    for _ in range(50):  # generous bound; guards against pathological input
        def _if_sub(m: "re.Match") -> str:
            var, if_body, else_body = m.group(1), m.group(2), m.group(3)
            return if_body if _is_truthy(variables.get(var)) else (else_body or "")

        def _unless_sub(m: "re.Match") -> str:
            var, body = m.group(1), m.group(2)
            return "" if _is_truthy(variables.get(var)) else body

        text, n1 = _IF_BLOCK_RE.subn(_if_sub, text)
        text, n2 = _UNLESS_BLOCK_RE.subn(_unless_sub, text)
        if not (n1 or n2):
            break

    # Substitute plain variable references.
    text = _VAR_RE.sub(lambda m: _render_value(variables.get(m.group(1))), text)
    return text


def format_history(
    conversation_history: Optional[List[Dict[str, str]]],
    limit: int,
) -> str:
    """Recent turns as ``[ROLE]: text`` lines (most recent last), trimmed to
    ``limit``. Returns "" when there's nothing to show, so a template's
    ``{{#if conversationHistory}}`` drops the whole block. Shared so every stage
    and agent formats history identically."""
    if not conversation_history or limit <= 0:
        return ""
    recent = conversation_history[-limit:]
    return "\n".join(
        f"[{(msg.get('role') or 'user').upper()}]: {msg.get('content', '')}"
        for msg in recent
    )
