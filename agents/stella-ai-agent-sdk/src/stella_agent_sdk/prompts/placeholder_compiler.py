"""Placeholder prompt compiler: resolves {{placeholder}} tokens against runtime state.

Shared SDK compiler used by any agent (stella-v2 expert prompts, stella-light
persona/guidelines/plan prompts, ...). A prompt is scanned for {{name}} tokens and
each is replaced with the corresponding runtime value from the state-machine
context, so configured prompts can reference live plan/conversation state.

Use it via the SDK registry so an agent can pick the compiler it wants:

    from stella_agent_sdk.prompts import get_compiler
    compiler = get_compiler("placeholder")(sm_context, conversation_history=h, user_input=t)
    text = compiler.compile(raw_prompt)

Available placeholders:
  {{plan}}                    Full plan (all states, tasks, deliverables)
  {{current_focus}}           Active task + pending deliverables with acceptance criteria
  {{pending_deliverables}}    Pending deliverables list with required/optional flags
  {{collected_deliverables}}  Already collected deliverable keys
  {{turns_without_progress}}  Counter since last deliverable was collected
  {{current_state}}           Current state name + description + processing mode
  {{progress_percentage}}     Overall progress percentage
  {{processing_mode}}         Processing mode (sequential/flexible)
  {{history_N}}               Last N messages from conversation (e.g. {{history_10}})
  {{user_message}}            The current user message
  {{language}}                Resolved session language (e.g. "German")
  {{persona.<key>}}           A value defined once on the deployed Persona, so
                              identity is stated in one place and referenced
                              everywhere. Built-ins: name, voice, language.

Unknown placeholders are left as-is to avoid silently breaking prompts.
"""

import re
from typing import Dict, Any, List, Optional

from stella_agent_sdk.prompts.base import PromptCompiler


# Matches simple {{name}}, parameterized {{history_10}}, and namespaced
# {{persona.key}} placeholders. The optional dotted segment is what lets a
# persona's author-defined variables be referenced without colliding with — or
# having to be registered alongside — the fixed runtime palette.
PLACEHOLDER_PATTERN = re.compile(r"\{\{(\w+(?:\.\w+)?)\}\}")
HISTORY_PATTERN = re.compile(r"\{\{history_(\d+)\}\}")
PERSONA_PATTERN = re.compile(r"^persona\.(\w+)$")

# Persona fields exposed as {{persona.*}} on top of the author-defined variables.
# Kept to identity facts: a prompt may want to name the agent, not to introspect
# its configuration.
PERSONA_BUILTIN_KEYS = ("name", "voice", "language")


# ---------------------------------------------------------------------------
# Placeholder resolvers — each takes sm_context and returns a string
# ---------------------------------------------------------------------------


def _resolve_plan(ctx: Dict[str, Any]) -> str:
    """Full plan: all states, tasks, deliverables with completion status."""
    full_plan = ctx.get("full_plan", [])
    if not full_plan:
        return _resolve_plan_legacy(ctx)

    parts: List[str] = ["=== FULL PLAN (extract deliverables from current state only) ==="]
    current_task_info = ctx.get("current_task")

    for state in full_plan:
        marker = " ← CURRENT" if state.get("is_current") else ""
        parts.append(f"\n## {state['title']}{marker}")

        for task in state.get("tasks", []):
            task_status = task.get("status", "pending")
            is_active = current_task_info and task.get("id") == current_task_info.get("id")
            task_marker = " ← ACTIVE TASK" if is_active else ""
            parts.append(
                f"  Task: {task['description']} [task_id={task.get('id', '?')}] ({task_status}){task_marker}"
            )

            for d in task.get("deliverables", []):
                status = d.get("status", "pending")
                req = "required" if d.get("required") else "optional"
                dtype = d.get("type", "string")

                if status == "completed":
                    parts.append(f"    ✓ {d['key']} = {d.get('value', '?')}")
                else:
                    parts.append(f"    ○ {d['key']} [{dtype}, {req}]: {d.get('description', '')}")

            if not task.get("has_deliverables"):
                parts.append("    (no deliverables — mark completed when performed)")

    return "\n".join(parts)


def _resolve_plan_legacy(ctx: Dict[str, Any]) -> str:
    """Fallback plan using only current state deliverables."""
    parts: List[str] = []
    deliverables = ctx.get("deliverables", [])
    pending = [d for d in deliverables if d.get("status") == "pending"]
    completed = [d for d in deliverables if d.get("status") == "completed"]

    if pending:
        parts.append("PENDING DELIVERABLES:")
        for d in pending:
            line = f"- {d['key']} ({d.get('type', 'string')}, {'required' if d.get('required') else 'optional'}): {d.get('description', '')}"
            criteria = d.get("acceptance_criteria", "")
            if criteria:
                line += f"\n  Acceptance: {criteria}"
            examples = d.get("examples", [])
            if examples:
                line += f"\n  Examples: {', '.join(str(e) for e in examples)}"
            parts.append(line)

    if completed:
        parts.append("\nCOMPLETED DELIVERABLES:")
        for d in completed:
            parts.append(f"- {d['key']}: {d.get('value', '?')}")

    return "\n".join(parts) if parts else "No plan data available."


def _resolve_current_focus(ctx: Dict[str, Any]) -> str:
    """Active task + pending deliverables with acceptance criteria."""
    full_plan = ctx.get("full_plan", [])
    current_state_info = ctx.get("state", {})
    current_task_info = ctx.get("current_task")
    mode = ctx.get("processing_mode", "loose")

    parts: List[str] = ["=== CURRENT FOCUS ==="]
    parts.append(f"State: {current_state_info.get('title', '?')}")
    if current_state_info.get("description"):
        parts.append(f"Goal: {current_state_info['description']}")
    if mode == 'goal':
        parts.append("Mode: goal-oriented (natural conversation toward objective)")
    elif mode == 'strict':
        parts.append("Mode: sequential (one task at a time)")
    else:
        parts.append("Mode: flexible (any order)")

    # Render goal context when in goal mode
    if mode == 'goal':
        goal_obj = current_state_info.get("goal_objective")
        if goal_obj:
            parts.append(f"Objective: {goal_obj}")
        goal_ctx = current_state_info.get("goal_context")
        if goal_ctx:
            parts.append(f"Context: {goal_ctx}")
        goal_bounds = current_state_info.get("goal_boundaries")
        if goal_bounds:
            parts.append(f"Boundaries: {goal_bounds}")
        goal_success = current_state_info.get("goal_success_description")
        if goal_success:
            parts.append(f"Success looks like: {goal_success}")

    if current_task_info:
        parts.append(f"Active task: {current_task_info.get('description', '?')}")
        parts.append(f"Active task_id: {current_task_info.get('id', '?')}")
        if current_task_info.get("instruction"):
            parts.append(f"Instruction: {current_task_info['instruction']}")

    # Show current state's pending deliverables with full detail
    current_state_id = current_state_info.get("id", "")
    current_plan_state = next((s for s in full_plan if s.get("id") == current_state_id), None)
    if current_plan_state:
        pending_in_current = []
        for task in current_plan_state.get("tasks", []):
            for d in task.get("deliverables", []):
                if d.get("status") == "pending":
                    pending_in_current.append(d)

        if pending_in_current:
            parts.append("")
            parts.append("PRIORITY — extract these if the user provided them:")
            for d in pending_in_current:
                req = "required" if d.get("required") else "optional"
                line = f"  ○ {d['key']} [{d.get('type', 'string')}, {req}]: {d.get('description', '')}"
                criteria = d.get("acceptance_criteria", "")
                if criteria:
                    line += f" (criteria: {criteria})"
                examples = d.get("examples", [])
                if examples:
                    line += f" (e.g. {', '.join(str(e) for e in examples)})"
                parts.append(line)

        # Already-collected deliverables in this state, surfaced as explicit
        # CORRECTION targets. Once collected they drop out of the pending list
        # above, so without this the extraction expert only sees them as "done"
        # (✓) in {{plan}} and won't revisit them when the user corrects an
        # earlier answer ("oh no, I like basketball" after "running"). Listing
        # them here — with their stored value — gives the expert an actionable
        # hook to overwrite on a correction (#278).
        collected_in_current = [
            d
            for task in current_plan_state.get("tasks", [])
            for d in task.get("deliverables", [])
            if d.get("status") == "completed"
        ]
        if collected_in_current:
            parts.append("")
            parts.append(
                "ALREADY COLLECTED — overwrite ONLY if the user corrects or "
                "contradicts the stored value (re-extract the SAME key with the "
                "new value); otherwise leave as-is:"
            )
            for d in collected_in_current:
                parts.append(f"  ✓ {d['key']} = {d.get('value', '?')}")

        # Explicitly list task IDs to prevent using descriptions as task_id.
        no_deliverable_tasks = [
            t for t in current_plan_state.get("tasks", [])
            if not t.get("has_deliverables") and t.get("status") != "completed"
        ]
        if no_deliverable_tasks:
            parts.append("")
            parts.append("TASK IDs for complete_task/batch_update.tasks:")
            for task in no_deliverable_tasks:
                parts.append(f"  - task_id={task.get('id', '?')} | {task.get('description', '')}")

    return "\n".join(parts)


def _resolve_pending_deliverables(ctx: Dict[str, Any]) -> str:
    """Pending deliverables list with required/optional flags."""
    deliverables = ctx.get("deliverables", [])
    pending = [d for d in deliverables if d.get("status") == "pending"]

    if not pending:
        return "No pending deliverables."

    parts = ["PENDING DELIVERABLES (signal if user provided any):"]
    for d in pending:
        req_label = "REQUIRED" if d.get("required") else "OPTIONAL"
        parts.append(f"- {d['key']} [{req_label}]: {d.get('description', '')}")

    return "\n".join(parts)


def _resolve_collected_deliverables(ctx: Dict[str, Any]) -> str:
    """Already collected deliverable keys and values."""
    deliverables = ctx.get("deliverables", [])
    completed = [d for d in deliverables if d.get("status") == "completed"]

    if not completed:
        return "Already collected: nothing yet"
    return "Already collected: " + ", ".join(d["key"] for d in completed)


def _resolve_turns_without_progress(ctx: Dict[str, Any]) -> str:
    """Turns without deliverable progress counter."""
    turns = ctx.get("progress", {}).get("turns_without_deliverable", 0)
    return f"TURNS WITHOUT PROGRESS: {turns}"


def _resolve_current_state(ctx: Dict[str, Any]) -> str:
    """Current state name, description, and processing mode."""
    state = ctx.get("state", {})
    mode = ctx.get("processing_mode", "loose")

    parts = [f"Current state: {state.get('title', '?')}"]
    if state.get("description"):
        parts.append(f"Goal: {state['description']}")

    if mode == 'goal':
        parts.append("Mode: goal-oriented")
        goal_obj = state.get("goal_objective")
        if goal_obj:
            parts.append(f"Objective: {goal_obj}")
        goal_ctx = state.get("goal_context")
        if goal_ctx:
            parts.append(f"Context: {goal_ctx}")
        goal_bounds = state.get("goal_boundaries")
        if goal_bounds:
            parts.append(f"Boundaries: {goal_bounds}")
        goal_success = state.get("goal_success_description")
        if goal_success:
            parts.append(f"Success looks like: {goal_success}")
    elif mode == 'strict':
        parts.append("Mode: sequential")
    else:
        parts.append("Mode: flexible")

    return "\n".join(parts)


def _resolve_progress_percentage(ctx: Dict[str, Any]) -> str:
    """Overall progress percentage."""
    pct = ctx.get("progress", {}).get("percentage", 0)
    # Guard against a None/str percentage slipping in from a malformed context —
    # ``f"{pct:.0f}"`` would otherwise raise and crash the whole compile.
    try:
        return f"Overall progress: {float(pct):.0f}%"
    except (TypeError, ValueError):
        return "Overall progress: 0%"


def _resolve_processing_mode(ctx: Dict[str, Any]) -> str:
    """Processing mode (sequential/flexible)."""
    mode = ctx.get("processing_mode", "loose")
    return "sequential (one task at a time)" if mode == "strict" else "flexible (any order)"


def _resolve_history(ctx: Dict[str, Any], count: int) -> str:
    """Last N messages from conversation history.

    ``speech_safe`` (set for verdict templates spoken verbatim) drops the
    "CONVERSATION:" header and "[ROLE]:" labels — that scaffolding is for LLM
    system prompts, not TTS. ``count <= 0`` yields no messages (``{{history_0}}``
    must mean "last 0", not the whole history via ``history[-0:]``).
    """
    history = ctx.get("_conversation_history", [])
    speech_safe = ctx.get("_speech_safe", False)
    recent = history[-count:] if count > 0 else []
    if not recent:
        return "" if speech_safe else "CONVERSATION:\n(no messages yet)"

    # .get() rather than [] — a malformed message dict must not crash the compile.
    if speech_safe:
        return " ".join(str(msg.get("content", "")) for msg in recent).strip()
    lines = [f"[{str(msg.get('role', '')).upper()}]: {msg.get('content', '')}" for msg in recent]
    return "CONVERSATION:\n" + "\n".join(lines)


def _resolve_user_message(ctx: Dict[str, Any]) -> str:
    """The current user message.

    ``speech_safe`` returns the bare text; otherwise it carries the
    "CURRENT USER MESSAGE:" label for LLM system-prompt context.
    """
    user_input = ctx.get("_user_input", "")
    if ctx.get("_speech_safe", False):
        return user_input
    return f"CURRENT USER MESSAGE: {user_input}"


# Display names for the resolved-language placeholder. Kept here (not imported
# from an agent) because the SDK must not depend on a specific agent package;
# the v2 agent has its own canonical LANGUAGE_NAMES for its internal prompts.
_LANGUAGE_NAMES = {"en": "English", "de": "German"}


def _resolve_language(ctx: Dict[str, Any]) -> str:
    """The resolved session language as a human-readable name (#214).

    The agent writes the per-turn resolved language into ``sm_context["language"]``
    (single source of truth). Unknown/``auto``/absent → a generic phrase so the
    prompt stays grammatical when no language has been resolved.
    """
    lang = ctx.get("language")
    if not lang or lang == "auto":
        return "the user's language"
    return _LANGUAGE_NAMES.get(lang, lang)



# ---------------------------------------------------------------------------
# Registry (simple placeholders only — history_N is handled separately)
# ---------------------------------------------------------------------------

PLACEHOLDER_REGISTRY: Dict[str, Any] = {
    "plan": _resolve_plan,
    "current_focus": _resolve_current_focus,
    "pending_deliverables": _resolve_pending_deliverables,
    "collected_deliverables": _resolve_collected_deliverables,
    "turns_without_progress": _resolve_turns_without_progress,
    "current_state": _resolve_current_state,
    "progress_percentage": _resolve_progress_percentage,
    "processing_mode": _resolve_processing_mode,
    "user_message": _resolve_user_message,
    "language": _resolve_language,
}


# Canonical palette metadata for the built-in placeholders. This is the single
# source of truth for the {{placeholder}} "menu": agents mirror it in their
# manifest `runtimeVariables`, and the Configurator renders chips from it. Keep in
# sync with PLACEHOLDER_REGISTRY (resolvers) — a test asserts they match.
# `name` is the token base; `parametric=True` means {{name_N}} (e.g. history_8).
PLACEHOLDER_SPECS: List[Dict[str, Any]] = [
    {"name": "plan", "label": "plan", "parametric": False,
     "description": "Full plan: all states, tasks, deliverables",
     "preview": "States:\n  - welcome_intro (active)\nTasks:\n  - greeting (completed)"},
    {"name": "current_focus", "label": "current_focus", "parametric": False,
     "description": "Active task + pending deliverables with criteria",
     "preview": "Task: collect_basic_info\nPending:\n  - user_name (required)"},
    {"name": "pending_deliverables", "label": "pending_deliverables", "parametric": False,
     "description": "Pending deliverables with required/optional flags",
     "preview": "- user_name: User's first name [required]"},
    {"name": "collected_deliverables", "label": "collected_deliverables", "parametric": False,
     "description": "Already collected deliverable keys",
     "preview": "- age: 28\n- frequency: 3x per week"},
    {"name": "turns_without_progress", "label": "turns_without_progress", "parametric": False,
     "description": "Turns since last deliverable collected",
     "preview": "3"},
    {"name": "current_state", "label": "current_state", "parametric": False,
     "description": "Current state name + description",
     "preview": "welcome_intro: Greet the user and collect basic info"},
    {"name": "progress_percentage", "label": "progress_percentage", "parametric": False,
     "description": "Overall progress %",
     "preview": "42%"},
    {"name": "processing_mode", "label": "processing_mode", "parametric": False,
     "description": "Processing mode (sequential/flexible/goal)",
     "preview": "flexible (any order)"},
    {"name": "history", "label": "history_N", "parametric": True,
     "description": "Last N conversation messages (e.g. {{history_8}})",
     "preview": "[USER]: Hi\n[ASSISTANT]: Welcome! How can I help?"},
    {"name": "user_message", "label": "user_message", "parametric": False,
     "description": "The user's latest message",
     "preview": "I usually go running three times a week."},
    {"name": "language", "label": "language", "parametric": False,
     "description": "Resolved session language (single source of truth, #214)",
     "preview": "German"},
    {"name": "persona", "label": "persona.key", "parametric": True,
     "description": "A value defined on the deployed Persona (e.g. {{persona.name}}). "
                    "Built-ins: name, voice, language; anything else comes from the "
                    "persona's own variables.",
     "preview": "Grace"},
]


def _resolve_persona(ctx: Dict[str, Any], key: str) -> str:
    """Resolve {{persona.<key>}} from the deployed persona.

    Author-defined variables win over the built-in identity fields, so a persona
    that defines its own ``name`` variable gets that one rather than the row's
    display name.

    An unknown key resolves to the EMPTY STRING rather than being left as-is,
    which is the opposite of the policy for the fixed palette. The reasoning is
    the same one arbitration already applies to verdict templates: a literal
    ``{{persona.nickname}}`` reaching an LLM — or being spoken aloud — is worse
    than the sentence simply not containing it. The namespace is known, so a
    typo inside it is an authoring bug we should absorb quietly, not broadcast.
    """
    persona = ctx.get("persona") or {}
    variables = persona.get("variables") or {}

    if key in variables:
        return str(variables[key])
    if key in PERSONA_BUILTIN_KEYS:
        return str(persona.get(key) or "")
    return ""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def _compile_prompt(
    template: str,
    sm_context: Optional[Dict[str, Any]] = None,
    resolve_persona: bool = False,
) -> str:
    """Replace {{placeholder}} tokens in a prompt with resolved runtime values.

    Internal resolver. Agents must NOT call this directly — go through the
    versioned entry point ``stella_agent_sdk.prompts.compile(template, version=...)``
    so prompt compilation is always pinned to an explicit compiler version. This
    function is the version-less engine that the registered compiler delegates to.

    Handles both simple {{name}} and parameterized {{history_N}} placeholders.

    Args:
        template: The system prompt template containing {{placeholder}} tokens.
        sm_context: State machine context providing runtime values.

    Returns:
        The compiled prompt with placeholders replaced.
    """
    if not template or "{{" not in template:
        return template

    if not sm_context:
        return PLACEHOLDER_PATTERN.sub("[no context available]", template)

    # SINGLE pass over the template. Both {{history_N}} and simple {{name}} tokens
    # are resolved in one re.sub, whose replacement text is NEVER re-scanned. This
    # is deliberate: a previous two-pass design re-ran the simple-placeholder regex
    # over already-resolved {{history_N}} output, so a {{collected_deliverables}}
    # literal inside a past USER message would get expanded — input-driven
    # placeholder injection. One pass closes that.
    def replacer(match: "re.Match") -> str:
        token = match.group(0)
        history_match = HISTORY_PATTERN.fullmatch(token)
        if history_match:
            return _resolve_history(sm_context, int(history_match.group(1)))
        persona_match = PERSONA_PATTERN.match(match.group(1)) if resolve_persona else None
        if persona_match:
            # Resolved in THIS pass, so the substituted value is never re-scanned
            # for placeholders — same guarantee the comment above relies on. A
            # persona variable is author-supplied text and must not be able to
            # smuggle in a {{collected_deliverables}} of its own.
            return _resolve_persona(sm_context, persona_match.group(1))
        resolver = PLACEHOLDER_REGISTRY.get(match.group(1))
        if resolver is None:
            return token  # Unknown placeholder — leave as-is
        return resolver(sm_context)

    return PLACEHOLDER_PATTERN.sub(replacer, template)


def has_user_message_placeholder(template: str) -> bool:
    """Check if template contains {{user_message}}."""
    return "{{user_message}}" in template if template else False


def resolve_persona_tokens(text: Optional[str], persona: Optional[Dict[str, Any]]) -> Optional[str]:
    """Resolve ONLY {{persona.*}} tokens in author-written text.

    Used for plan-authored strings (state descriptions, task instructions,
    deliverable acceptance criteria), which are data rather than prompts: they get
    formatted INTO {{plan}} and {{current_focus}}, so running the full palette
    over them would let a plan reference the very placeholder it is rendered into.
    Restricting substitution to the persona namespace gives a plan author the one
    thing they actually need — the ability to name the agent without restating who
    it is — with no recursion and no access to conversation state.

    Single pass, and the substituted value is never re-scanned, so a persona
    variable cannot smuggle in a placeholder of its own.

    With no persona deployed every key is unknown, so tokens empty out rather than
    being left literal — the same trade as an unknown key, for the same reason.
    """
    if not text or "{{" not in text:
        return text
    ctx = {"persona": persona or {}}

    def replacer(match: "re.Match") -> str:
        persona_match = PERSONA_PATTERN.match(match.group(1))
        if persona_match is None:
            return match.group(0)  # not ours — leave every other token untouched
        return _resolve_persona(ctx, persona_match.group(1))

    return PLACEHOLDER_PATTERN.sub(replacer, text)


# ---------------------------------------------------------------------------
# Versioning primitives
# ---------------------------------------------------------------------------

# Semantic version of the placeholder grammar/behavior. Bump when placeholders are
# added/removed or their rendering changes, so prompts/configs can be reconciled
# against the grammar they were authored for.
COMPILER_VERSION = "1.0.0"

# 1.1.0 adds the {{persona.*}} namespace. It ships as a SEPARATE registered
# version rather than as a bump of 1.0.0, because get_compiler() raises on an
# unknown version — mutating COMPILER_VERSION in place would unregister 1.0.0 and
# break every prompt and saved configuration pinned to it.
COMPILER_VERSION_PERSONA = "1.1.0"

# The full set of placeholder names this compiler resolves. `history_N` is
# parameterized (any positive integer N), represented here by the sentinel
# "history_N".
KNOWN_PLACEHOLDERS = frozenset(PLACEHOLDER_REGISTRY) | {"history_N"}


def palette() -> List[Dict[str, Any]]:
    """Return a copy of the placeholder palette metadata (the Configurator menu).

    Agents declare a manifest ``runtimeVariables`` block mirroring these entries;
    this accessor lets tooling read the canonical set for the current version.
    """
    return [dict(spec) for spec in PLACEHOLDER_SPECS]


def validate_template(
    template: Optional[str],
    resolve_persona: bool = False,
) -> List[str]:
    """Return the sorted, de-duplicated list of UNKNOWN placeholder names in a prompt.

    An empty list means every {{token}} in the template is resolvable by this
    compiler version. Useful for authoring-time validation and for versioning
    checks (e.g. flagging a saved prompt that uses a placeholder a newer compiler
    version removed).
    """
    if not template:
        return []
    unknown = set()
    for match in PLACEHOLDER_PATTERN.finditer(template):
        name = match.group(1)
        if HISTORY_PATTERN.fullmatch(match.group(0)):
            continue  # {{history_N}} — always valid
        if resolve_persona and PERSONA_PATTERN.match(name):
            continue  # {{persona.*}} — the namespace is open by design
        if name not in PLACEHOLDER_REGISTRY:
            unknown.add(name)
    return sorted(unknown)


# ---------------------------------------------------------------------------
# Compiler class (registry-friendly wrapper)
# ---------------------------------------------------------------------------


class PlaceholderPromptCompiler(PromptCompiler):
    """Reusable {{placeholder}} resolver bound to a single runtime context.

    Ring it up once per turn with the live state-machine context (plus the current
    conversation history and user message), then call :meth:`compile` on any text
    prompt to resolve its placeholders:

        compiler = PlaceholderPromptCompiler(sm_context, conversation_history=h, user_input=t)
        persona = compiler.compile(raw_persona)
        guidelines = compiler.compile(raw_guidelines)

    This keeps callers from threading the context dict (and the per-turn history /
    user-message values) through every compile call.
    """

    NAME = "placeholder"
    VERSION = COMPILER_VERSION

    def __init__(
        self,
        sm_context: Optional[Dict[str, Any]] = None,
        conversation_history: Optional[List[Dict[str, str]]] = None,
        user_input: str = "",
        speech_safe: bool = False,
    ) -> None:
        # Copy so we never mutate the caller's context, then layer in the per-turn
        # runtime values that {{history_N}} and {{user_message}} need.
        self._ctx: Dict[str, Any] = dict(sm_context or {})
        self._ctx["_conversation_history"] = conversation_history or []
        self._ctx["_user_input"] = user_input or ""
        # When True, placeholder resolvers omit system-prompt scaffolding labels so
        # the output is safe to speak verbatim (used for arbitration verdict templates).
        self._ctx["_speech_safe"] = speech_safe

    #: Whether this compiler version resolves the {{persona.*}} namespace.
    RESOLVES_PERSONA = False

    def compile(self, template: Optional[str]) -> Optional[str]:
        if not template:
            return template
        return _compile_prompt(template, self._ctx, resolve_persona=self.RESOLVES_PERSONA)

    @classmethod
    def known_placeholders(cls) -> frozenset:
        """The set of placeholder names this compiler resolves."""
        return KNOWN_PLACEHOLDERS

    @classmethod
    def validate(cls, template: Optional[str]) -> List[str]:
        """Unknown placeholders in ``template`` (see :func:`validate_template`)."""
        return validate_template(template, resolve_persona=cls.RESOLVES_PERSONA)


class PersonaAwarePlaceholderCompiler(PlaceholderPromptCompiler):
    """1.1.0 — everything 1.0.0 resolves, plus the {{persona.*}} namespace.

    Lets identity be stated once on the Persona and referenced from an agent
    configuration's prompts or from a plan's own text, instead of being restated
    in each place. 1.0.0 keeps its exact behaviour (a {{persona.x}} token is left
    as-is there, like any other unknown placeholder), so nothing pinned to it
    changes.
    """

    VERSION = COMPILER_VERSION_PERSONA
    RESOLVES_PERSONA = True

    @classmethod
    def known_placeholders(cls) -> frozenset:
        return KNOWN_PLACEHOLDERS | {"persona.*"}

