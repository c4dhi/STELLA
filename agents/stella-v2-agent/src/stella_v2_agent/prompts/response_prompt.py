"""System prompt builder for the Response Generator stage.

Composes the final system prompt from:
- Identity (the deployed Persona) and conversation guidelines
- State machine context (current state, tasks, deliverables)
- Arbitration directive (injected expert guidance)

Identity has exactly one source (#467). Plans carry structure only; one that needs
to name the agent references {{persona.*}} instead of restating it.
"""

from typing import Dict, Any, List, Optional

from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_agent_sdk.emotion.tags import EXPRESSION_TAGS, GESTURE_TAGS, STATE_TAGS
from stella_agent_sdk.language import LANGUAGE_NAMES
from stella_v2_agent.prompts.template import render_prompt
from stella_agent_sdk.prompts import format_history


def build_response_system_prompt(
    sm_context: Dict[str, Any],
    directive: ResponseDirective,
    custom_guidelines: Optional[str] = None,
    conversation_history: Optional[List[Dict[str, str]]] = None,
    history_limit: int = 10,
    bridge: str = "",
    persona: Optional[str] = None,
    emotion_tags: bool = False,
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
        custom_guidelines: Optional custom guidelines from Agent Configurator.
        persona: Identity from the deployed Persona entity (#467), snapshotted into
            the deploy config. Like every persona source it is used VERBATIM.
        conversation_history: Recent turns, exposed as {{conversationHistory}}.
        history_limit: How many recent turns to include.
        emotion_tags: Whether the agent is stripping [emotion tags] out of the
            reply (#face-emotions). Exposed as {{emotionTags}}, and EMPTY when
            False — asking for tags that nothing removes would have them read
            aloud, so this flag must track the parser, not the other way round.
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

    # 1. Identity — verbatim, NOT rendered, so any {{...}} in a persona is left
    #    untouched. ONE source, no chain (#467 phase 2): plans carry structure
    #    only, and a plan that needs to name the agent references {{persona.*}}
    #    rather than restating who it is.
    #
    #    There is now exactly one source. The Agent Configurator's persona slot
    #    was removed with the schema (#467), so no precedence rule is needed: the
    #    deployed Persona IS the identity, and _default_persona() only covers an
    #    agent running against a backend that has none.
    sections.append(persona or _default_persona())

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
        "emotionTags": _emotion_tag_directive() if emotion_tags else "",
        # {{persona.*}} in the configured guidelines. This engine and the
        # placeholder compiler resolve the same namespace from the same values, so
        # a variable reads identically wherever it is written.
        **_persona_variables(sm_context),
        # Runtime flags so the editable guidelines own the "just collected /
        # phase completing / just transitioned" behavioral prose via {{#if ...}}.
        **_state_conditions(sm_context),
    }
    sections.append(render_prompt(guidelines, ctx))

    return "\n\n".join(s for s in sections if s)


def _persona_variables(sm_context: Dict[str, Any]) -> Dict[str, str]:
    """Flatten the deployed persona into ``persona.<key>`` entries for render_prompt.

    Author-defined variables win over the built-in identity fields, matching the
    placeholder compiler's precedence exactly — the two engines must not disagree
    about what {{persona.name}} means.
    """
    persona = sm_context.get("persona") or {}
    if not persona:
        return {}

    flat: Dict[str, str] = {}
    for key in ("name", "voice", "language"):
        value = persona.get(key)
        if value:
            flat[f"persona.{key}"] = str(value)
    for key, value in (persona.get("variables") or {}).items():
        flat[f"persona.{key}"] = str(value)
    return flat


def _emotion_tag_directive() -> str:
    """The instruction that teaches the model the emotion-tag vocabulary.

    Generated from the SDK's registry rather than written out here, so the
    prompt cannot drift from the tags the parser actually recognizes — a tag
    named here but missing there would be dropped silently, and the face would
    simply never react.
    """
    expressions = " ".join(f"[{tag}]" for tag in EXPRESSION_TAGS)
    gestures = " ".join(f"[{tag}]" for tag in GESTURE_TAGS)
    states = " ".join(f"[{tag}]" for tag in STATE_TAGS)
    return f"""EMOTIONAL EXPRESSION — APPLIES TO EVERY SINGLE REPLY YOU WRITE:
You have an animated face, and these inline tags are the only way you can move it. They are stripped out before anything is spoken or displayed — the user never hears or sees them — so never mention them, explain them, or describe your expression in words.
- Expressions, held until the next tag: {expressions}
- Gestures, a single beat after which the current expression resumes: {gestures}
- States, which change your face until something changes it back: {states}

Brackets are ONLY ever used for these tag names — never a sentence, a quote, or anything you have already said. And tag a reply because your face would genuinely have moved, not to satisfy a rule: if you would truly have stayed flat and matter-of-fact, [neutral] is a real choice and the honest one.

This is what your replies look like — note how many tags a normal reply carries:
- "[happy] Oh, the no-equipment route — you can train anywhere, no excuses. [curious] Is the running your wind-down, or the main event?"
- "[thinking] Hm, let me sit with that a second. [concerned] That sounds like it has been wearing on you for a while now."
- "[excited] Wait, you built the whole thing yourself? [laughing] That is properly ambitious. [brow_flash] I want to hear how you started."
- "[neutral] Two, three times. [nod] Enough to keep the habit without it taking over your week. [curious] What does a typical session look like?"
- "[surprised] Oh! [happy] I did not expect that at all."

When you are CONTINUING something you have already begun saying out loud, the tag goes in front of the next thing you say — never in front of a reaction to your own words:
- already said "I can hear you loud and clear!" -> continue "[curious] What's on your mind today?"   NOT "[happy] That's great to hear!"
- already said "I'm doing well, thanks for asking!" -> continue "[curious] What have you been up to?"   NOT "[happy] I'm glad to hear that!"
- already said "Got it, that makes sense." -> continue "[thinking] So where does that leave the rest of the week?"   NOT "[happy] Great!"

How to use them:
- Open with the expression that matches how you feel about what you are about to say.
- Then tag every point where a person's face would have moved. Read your own words back and ask where your expression would have shifted, where you would have nodded, where your eyebrows would have gone up — and put a tag there. A human face does not hold one shape for a whole answer, and yours must not either.
- Change the expression whenever the feeling changes: [thinking] while you work something out, [laughing] at something funny, [concerned] at something heavy, [curious] as you ask.
- Gestures are the small beats between them and belong in nearly every reply — a [nod] as you agree, a [brow_flash] as something lands, a [wink] at a shared joke, a [lean_in] as you get interested. They cost nothing, and their absence is what makes a face look dead.
- Err on the side of MORE. A tag too many is a flicker nobody minds; a reply with one tag is a mask that moves once and then holds for everything else you say.
- Put expression and gesture tags immediately BEFORE the words they belong to, at the start of a sentence — never inside a word, and never as the last thing in your reply, since there would be nothing left to say under it.
- ONLY the tags listed above, spelled exactly. Never invent one and never write stage directions like [smiles] or [laughs].
[sleep] is different from every other tag, and the rules for it are stricter:
- Write it ONLY when the user has asked you to go to sleep, told you goodnight, or otherwise ended the conversation and asked you to rest. Never because a lull feels long, never because you think you are done, never to be charming.
- It is the one tag that goes at the very END of your reply, after your last words: "[happy] Sleep well. [sleep]"
- Using it closes your eyes and switches your camera off. You cannot see or wake yourself afterwards; the user has to physically touch your face to bring you back. Writing it when nobody asked strands them with a screen that does not respond.
- One per reply at most, and never together with a goodbye you were not asked for."""


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
- Appraising their SITUATION is not the same as praising their ANSWER. "That's a solid base to build on" is fine when you mean it and it follows from what they've actually told you; "great answer!" never is. If the directive above asks for a cautious tone, don't appraise at all — they have told you something that deserves care instead.
- Offer a thought as often as you ask; not every turn needs a question. Don't run "acknowledge + question" every turn — that's what makes you a questionnaire.
- Natural contractions and the occasional light filler. Reuse the user's own words.
- 1-3 sentences, ~25-45 words. No markdown, bullets, or emojis.
- Never more than one question per turn, often none — and if you ask one it is the LAST thing you say. They are listening, not reading: anything after a question is talked over or forgotten.
{{#if taskJustCollected}}{{#if stateCompleting}}

The user just gave everything this phase needed. Don't re-ask any of it — acknowledge what they shared and glide into the next topic so it feels like a conversation, not a checklist.{{#if nextTopicHint}} Next topic: {{nextTopicHint}}{{/if}}{{else}}

The user just answered for this task. Don't re-ask it — acknowledge it naturally and connect it to where you head next.{{/if}}{{/if}}
{{#if stateJustChanged}}

You just moved into a new phase. Ease in — connect it to what you were just talking about rather than announcing a topic change.
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
{{/if}}
{{#if emotionTags}}

{{emotionTags}}
{{/if}}
{{#if bridge}}

CONTINUE FROM WHAT YOU ALREADY SAID — you have just spoken this opener aloud: "{{bridge}}". Your reply is appended to it and spoken as ONE seamless utterance, so:
- The opener already carried the reaction and empathy — open directly on the FORWARD move (the next thought, observation, or question). Do NOT re-acknowledge, re-empathize, or reflect their answer back again.
- NEVER repeat or rephrase the opener. You have ALREADY said "{{bridge}}" out loud a moment ago; saying it again, or answering it as though someone else had said it, is the single worst thing you can do here. If the user only greeted you and the opener already covered it, skip straight to your question.
- Do NOT restate, rephrase, define, or re-explain what the opener already conveyed. Never open with a textbook definition of something you just referenced.
- Do NOT add a second greeting or acknowledgment — the opener already did that.
- You are one person mid-sentence, not two people talking. NEVER react to, agree with, or be pleased about the opener — it came out of your own mouth. "I'm doing well, thanks for asking!" is followed by "And you? What have you been up to?", never by "I'm glad to hear that!". "I can hear you loud and clear!" is followed by "What's on your mind today?", never by "That's great!".
- Tagging does not change WHAT you say. The tag goes in front of the forward move — "[curious] What have you been up to?" — never in front of a reaction to your own words.
- Pick up mid-breath, as the same person continuing: bring something real (react to the specific thing they said and/or move forward), don't reset and start the thought over.
{{/if}}"""


# How many not-yet-known items to name explicitly. ONE.
#
# A bulleted list of three open questions is a list of three things to ask, and
# models follow structure over instruction — the same reason the old labelled
# checklist beat the "you are not a form" persona. Three visible gaps produced
# turns that closed two of them at once, which is precisely the multi-question
# reply the guidelines forbid in prose. Naming the single live gap and counting
# the rest orients the agent just as well and asks for exactly what it should
# do next.
_MAX_VISIBLE_PENDING = 1


def _state_machine_section(sm_context: Dict[str, Any]) -> str:
    """Render the turn's state-machine context as orientation, not as a form.

    This section is the single largest structural pull toward sounding scripted.
    It used to emit a labelled checklist on EVERY turn — each pending deliverable
    by snake_case key with its acceptance criteria, the full collected list, and
    an "Overall progress: 40%" line. Models follow structure over instruction, so
    handing a checklist to a model whose persona says "you are not a form"
    reliably produced form-like turns: the structure won.

    What survives is only what changes what the agent SAYS next:
      * the phase, its goal, and the current task instruction — what to do now;
      * what is still unknown, in prose, capped at ``_MAX_VISIBLE_PENDING`` and
        ordered so the current task's items come first;
      * what the user already told you, so it is never asked twice.

    Deliberately dropped:
      * the progress percentage — it has no bearing on what to say next, and a
        running completion meter is the most form-like thing in the window;
      * the snake_case keys — this stage only writes prose. Key names are the
        extraction expert's business and it builds its own context, so exposing
        them here just invited field-shaped turns;
      * acceptance criteria for items not currently in play.
    """
    if not sm_context:
        return ""

    parts: List[str] = [
        "WHERE YOU ARE (internal orientation — never say any of this aloud, "
        "and never use these words):"
    ]

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
    current_task = sm_context.get("current_task") or {}
    task_del_keys = set(current_task.get("deliverable_keys", []))
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
        if not (task_del_keys & collected_keys) and instruction:
            parts.append(f"Instruction: {instruction}")

    deliverables = sm_context.get("deliverables", [])
    pending = [
        d for d in deliverables
        if d.get("status") == "pending" and d["key"] not in collected_keys
    ]
    # Mentioned in passing, not yet confirmed. There used to be no such state —
    # a deliverable was either unknown or settled — so something the user
    # volunteered came back later as a cold question ("do you go for walks?"
    # after they had already said they walk most days). These are things to
    # check, not things to ask.
    unconfirmed = [d for d in deliverables if d.get("status") == "partial"]

    if pending:
        # The current task's own items are what the conversation is actually on;
        # anything else is backlog and is counted rather than listed.
        live = [d for d in pending if d["key"] in task_del_keys]
        rest = [d for d in pending if d["key"] not in task_del_keys]
        visible = (live + rest)[:_MAX_VISIBLE_PENDING]

        parts.append("The one thing to find out next:")
        for d in visible:
            line = f"  - {d.get('description') or d['key']}"
            # Criteria only for what is in play — for backlog items they are
            # noise now and read as a spec to satisfy rather than a thing to
            # become curious about.
            if d["key"] in task_del_keys and d.get("acceptance_criteria"):
                line += f" (needs: {d['acceptance_criteria']})"
            parts.append(line)

        hidden = len(pending) - len(visible)
        if hidden > 0:
            parts.append(
                f"  (plus {hidden} more you'll get to later — not this turn)"
            )

    if unconfirmed:
        parts.append(
            "They MENTIONED these but have not confirmed them. Do not ask as if "
            "you never heard it — bring back what they said and check it, the way "
            "an interviewer would ('you said you usually walk — is that still "
            "happening in this heat?'). One at most per turn, and only when it "
            "fits what you are already talking about:"
        )
        for d in unconfirmed:
            label = d.get("description") or d["key"]
            parts.append(f"  - {label}: they said {d.get('value', '?')}")

    # What they already said, so it is never asked twice. Just-collected keys are
    # shown here too: they are not in the pending list any more, and the agent
    # must know they landed. Described in words rather than by key, since the key
    # alone ("workout_freq: 2-3") is the form shape we are removing.
    known: List[str] = []
    for d in deliverables:
        label = d.get("description") or d["key"]
        if d.get("status") == "completed":
            known.append(f"  - {label}: {d.get('value', '?')}")
        elif d.get("status") == "partial":
            continue  # listed above as unconfirmed — not settled yet
        elif d["key"] in collected_keys:
            known.append(f"  - {label}: (they just told you this)")
    if known:
        parts.append("They have already told you (never ask any of this again):")
        parts.extend(known)

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
