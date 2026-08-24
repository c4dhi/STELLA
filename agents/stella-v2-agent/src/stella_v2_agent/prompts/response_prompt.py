"""System prompt builder for the Response Generator stage.

Composes the final system prompt from:
- Base persona and conversation guidelines
- State machine context (current state, tasks, deliverables)
- Arbitration directive (injected expert guidance)
- Optional custom system prompt from the plan
"""

from typing import Dict, Any, List, Optional

from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_agent_sdk.language import LANGUAGE_NAMES
from stella_v2_agent.prompts.template import render_prompt
from stella_agent_sdk.prompts import format_history


def build_response_system_prompt(
    sm_context: Dict[str, Any],
    directive: ResponseDirective,
    plan_system_prompt: Optional[str] = None,
    custom_persona: Optional[str] = None,
    custom_guidelines: Optional[str] = None,
    conversation_history: Optional[List[Dict[str, str]]] = None,
    history_limit: int = 10,
    bridge: str = "",
) -> str:
    """Build the complete system prompt for the Response Generator.

    The persona is used verbatim (so a plan-authored persona is never
    reinterpreted), and the conversation guidelines are rendered through the
    template interface: the editable guidelines decide WHERE the turn's runtime
    context goes via {{conversationHistory}}, {{stateContext}}, {{directive}},
    {{language}} and {{bridge}}. Nothing is appended in code — the template owns
    the layout.

    Args:
        sm_context: State machine context for conversation awareness.
        directive: Arbitration directive with expert guidance.
        plan_system_prompt: Optional custom system prompt from the plan.
        custom_persona: Optional custom persona from Agent Configurator.
        custom_guidelines: Optional custom guidelines from Agent Configurator.
        conversation_history: Recent turns, exposed as {{conversationHistory}}.
        history_limit: How many recent turns to include.
        bridge: The short acknowledgment already spoken to the user this turn
            (the Bridge stage). Exposed as {{bridge}} so the editable guidelines
            can instruct the reply to continue seamlessly from it instead of
            restarting. This is a RESPONSE-GENERATOR-only variable — experts
            never see the bridge (see PROMPT_VARIABLES note). Empty when no
            bridge was spoken.

    Returns:
        Complete system prompt string.
    """
    sections: List[str] = []

    # 1. Persona — verbatim, NOT rendered, so any {{...}} in a plan persona is
    #    left untouched. Plan persona + configurator persona stack; else default.
    if plan_system_prompt and custom_persona:
        sections.append(plan_system_prompt)
        sections.append(custom_persona)
    elif plan_system_prompt:
        sections.append(plan_system_prompt)
    elif custom_persona:
        sections.append(custom_persona)
    else:
        sections.append(_default_persona())

    # 2. Guidelines — rendered with the turn's context as template variables, so
    #    the configured prompt places state / directive / history / language
    #    wherever it wants instead of code bolting them on after the fact.
    guidelines = custom_guidelines or _conversation_guidelines()
    ctx = {
        "conversationHistory": format_history(conversation_history, history_limit),
        "stateContext": _state_machine_section(sm_context),
        "directive": directive.to_prompt_section() if directive else "",
        "language": _language_directive(
            sm_context.get("language"), pinned=bool(sm_context.get("language_pinned"))
        ) or "",
        "bridge": bridge or "",
        # Runtime flags so the editable guidelines own the "just collected /
        # phase completing / just transitioned" behavioral prose via {{#if ...}}.
        **_state_conditions(sm_context),
    }
    sections.append(render_prompt(guidelines, ctx))

    return "\n\n".join(s for s in sections if s)


def _language_directive(language: Optional[str], pinned: bool = False) -> Optional[str]:
    """Build a deterministic 'respond in <language>' instruction.

    Returns None for unknown/auto so the existing heuristic language rules stand.

    The FIRST words matter most: the persona and guidelines carry a standing
    "respond in the same language the user speaks" rule, and on an opening turn
    — where the user has said nothing yet, or only something short and garbled —
    that rule has no answer, so the model reaches for an English greeting and
    only switches afterwards ("Hey there! Ich bin ..."). Both variants below
    therefore name the greeting explicitly rather than trusting "every word" to
    cover it.

    ``pinned`` marks a deployment fixed to one language (STELLA_LANGUAGE): there
    is nothing to detect and nothing to match, so the wording must not invite the
    model to infer a language from the user at all.
    """
    if not language or language == "auto":
        return None
    name = LANGUAGE_NAMES.get(language, language)
    head = (
        f"LANGUAGE (highest priority — overrides every other instruction, "
        f"including any rule about matching the user's language):\n"
        f"- Respond ENTIRELY in {name}. Every single word, including any examples, must be in {name}.\n"
        f"- This includes your GREETING and the very first sentence of your reply. "
        f"Never open in another language and switch afterwards.\n"
    )
    if pinned:
        return head + (
            f"- This deployment is FIXED to {name}. It is not a guess and not a detection: "
            f"speak {name} even when the user's input is empty, unclear, garbled, or in "
            f"another language. Do not switch languages under any circumstance."
        )
    return head + (
        f"- This is the language detected for this conversation; do not switch languages on your own."
    )


def build_response_user_message(user_input: str) -> str:
    """The current user turn — the data being responded to. All prior context is
    placed by the system prompt via {{conversationHistory}}, so the user message
    is just the bare input."""
    return user_input


def _default_persona() -> str:
    """Minimal fallback persona. The production persona comes from the plan and/or
    the agent.yaml ``persona`` slot; this is used only when neither is set."""
    return """You are STELLA — a warm, genuinely curious conversation partner with a personality of your own, working toward collecting specific information through real conversation, not a form.

- Respond in the SAME LANGUAGE the user speaks (German if they speak German, English if English).
- Keep responses to 30-50 words (this is a voice conversation).
- NEVER mention internal systems, experts, deliverables, or technical metadata.
- React to the specific thing the user said; never re-ask something they already answered.
- Ask for missing information naturally, one thing at a time."""


def _conversation_guidelines() -> str:
    """Minimal fallback guidelines. The full, editable conversation style lives in
    agent.yaml (response_generator → conversation_guidelines) and is what runs in
    production; this is used only when no configured guidelines are provided."""
    return """CONVERSATIONAL STYLE (spoken aloud via TTS), in the user's language and its natural spoken register:
- React to the SPECIFIC thing the user said — never praise the mere act of answering ("solid routine!", "helpful to know!"), and never re-ask something they already told you.
- Offer a thought as often as you ask; not every turn needs a question. Don't run "acknowledge + question" every turn — that's what makes you a questionnaire.
- Natural contractions and the occasional light filler. Reuse the user's own words.
- 1-3 sentences, ~25-45 words. At most one question per turn. No markdown, bullets, or emojis.
{{#if taskJustCollected}}{{#if stateCompleting}}

The user just gave everything this phase needed. Don't re-ask any of it — acknowledge what they shared and glide into the next topic so it feels like a conversation, not a checklist.{{#if nextTopicHint}} Next topic: {{nextTopicHint}}{{/if}}{{else}}

The user just answered for this task. Don't re-ask it — acknowledge it naturally and connect it to where you head next.{{/if}}{{/if}}
{{#if stateJustChanged}}

You just moved into a new phase. Ease in — connect it to what you were just talking about rather than announcing a topic change.
{{/if}}
{{#if bridge}}

CONTINUE FROM WHAT YOU ALREADY SAID — you have just spoken this opener aloud: "{{bridge}}". Your reply is appended to it and spoken as ONE seamless utterance, so:
- The opener already carried the reaction and empathy — open directly on the FORWARD move (the next thought, observation, or question). Do NOT re-acknowledge, re-empathize, or reflect their answer back again.
- Do NOT restate, rephrase, define, or re-explain what the opener already conveyed. Never open with a textbook definition of something you just referenced.
- Do NOT add a second greeting or acknowledgment — the opener already did that.
- Pick up mid-breath, as the same person continuing: bring something real (react to the specific thing they said and/or move forward), don't reset and start the thought over.
{{/if}}
{{#if directive}}

{{directive}}
{{/if}}
{{#if stateContext}}

{{stateContext}}
{{/if}}
{{#if conversationHistory}}

Conversation so far:
{{conversationHistory}}
{{/if}}
{{#if language}}

{{language}}
{{/if}}"""


def _state_machine_section(sm_context: Dict[str, Any]) -> str:
    if not sm_context:
        return ""

    parts: List[str] = ["CURRENT CONVERSATION CONTEXT (internal — never mention these labels to the user):"]

    state = sm_context.get("state", {})
    if state:
        parts.append(f"Phase: {state.get('title', 'Unknown')}")
        desc = state.get("description", "")
        if desc:
            parts.append(f"Goal: {desc}")

    mode = sm_context.get("processing_mode", "")
    if mode == "strict":
        parts.append("Mode: Sequential — complete current task before moving on")
    elif mode == "loose":
        parts.append("Mode: Flexible — collect information in natural order")

    # Determine which deliverables were just collected this turn
    collected_keys = set(sm_context.get("_collected_keys", []))

    # Always show the current task instruction — the agent may need to perform
    # an action (e.g. "introduce yourself") even if deliverables were collected.
    current_task = sm_context.get("current_task")
    if current_task:
        parts.append(f"Current task: {current_task.get('description', '')}")
        instruction = current_task.get("instruction", "")

        # If any deliverables for this task were just collected, suppress the
        # instruction (which typically says "ask the user...") to prevent
        # re-asking about information already provided. The behavioral guidance
        # for that case (acknowledge, transition, ease into a new phase) is no
        # longer hardcoded here — it lives in the editable conversation
        # guidelines, gated on the {{taskJustCollected}} / {{stateCompleting}} /
        # {{stateJustChanged}} runtime flags (see _state_conditions).
        task_del_keys = set(current_task.get("deliverable_keys", []))
        task_keys_just_collected = task_del_keys & collected_keys

        if not task_keys_just_collected and instruction:
            parts.append(f"Instruction: {instruction}")

    # Filter out just-collected deliverables from the pending list.
    deliverables = sm_context.get("deliverables", [])
    pending = [d for d in deliverables if d.get("status") == "pending" and d["key"] not in collected_keys]
    completed = [d for d in deliverables if d.get("status") == "completed"]
    # Show just-collected keys as completed so the LLM knows they were provided
    for d in deliverables:
        if d.get("status") == "pending" and d["key"] in collected_keys:
            completed.append({"key": d["key"], "value": "(just provided)"})

    if pending:
        parts.append("Still need to collect:")
        for d in pending:
            line = f"  - {d['key']}: {d['description']}"
            if d.get("acceptance_criteria"):
                line += f" (criteria: {d['acceptance_criteria']})"
            parts.append(line)

    if completed:
        parts.append("Already collected:")
        for d in completed:
            parts.append(f"  - {d['key']}: {d.get('value', '?')}")

    progress = sm_context.get("progress", {})
    pct = progress.get("percentage", 0)
    if pct > 0:
        parts.append(f"Overall progress: {pct:.0f}%")

    return "\n".join(parts)


def _state_conditions(sm_context: Dict[str, Any]) -> Dict[str, Any]:
    """Compute the per-turn runtime flags the response guidelines reference via
    {{#if ...}} blocks. This is what lets the EDITABLE guidelines own the
    behavioral NOTE prose (acknowledge what was shared, don't re-ask, ease into a
    new phase) instead of hardcoding it in _state_machine_section.

    Returns:
        taskJustCollected: the user just provided a deliverable for the current task.
        stateCompleting:   …and that completed every pending deliverable in the phase.
        stateJustChanged:  the conversation just transitioned into a new phase.
        nextTopicHint:     the next phase/task hint (only when stateCompleting).
    """
    flags: Dict[str, Any] = {
        "taskJustCollected": False,
        "stateCompleting": False,
        "stateJustChanged": bool(sm_context.get("state_just_changed")) if sm_context else False,
        "nextTopicHint": "",
    }
    if not sm_context:
        return flags

    collected_keys = set(sm_context.get("_collected_keys", []))
    current_task = sm_context.get("current_task")
    if current_task and (set(current_task.get("deliverable_keys", [])) & collected_keys):
        flags["taskJustCollected"] = True
        all_pending_keys = {
            d["key"] for d in sm_context.get("deliverables", [])
            if d.get("status") == "pending"
        }
        if all_pending_keys.issubset(collected_keys):
            flags["stateCompleting"] = True
            hint, _, _ = _get_next_state_hint(sm_context)
            flags["nextTopicHint"] = hint or ""
    return flags


def _get_next_state_hint(sm_context: Dict[str, Any]) -> tuple:
    """Look up the next state from the full plan to guide transitions.

    Includes the first task's full instruction so the agent can ask
    the right question immediately without waiting for the next turn.

    Returns:
        Tuple of (hint_text, first_task_id, first_task_has_deliverables).
    """
    full_plan = sm_context.get("full_plan", [])
    current_state = sm_context.get("state", {})
    current_id = current_state.get("id")

    if not full_plan or not current_id:
        return "", None, False

    for i, state in enumerate(full_plan):
        if state.get("id") == current_id and i + 1 < len(full_plan):
            next_state = full_plan[i + 1]
            title = next_state.get("title", "")
            if not title:
                return "", None, False
            tasks = next_state.get("tasks", [])
            if tasks:
                first_task = tasks[0]
                task_id = first_task.get("id")
                has_deliverables = first_task.get("has_deliverables", len(first_task.get("deliverables", [])) > 0)
                instruction = first_task.get("instruction", "")
                if instruction:
                    hint = f"{title}. Your first task: {first_task.get('description', '')} — {instruction}"
                else:
                    hint = f"{title}. First task: {first_task.get('description', '')}"
                return hint, task_id, has_deliverables
            return title, None, False
    return "", None, False
