"""Tests for the Response Generator stage (Stage 4 of the stella-v2 pipeline).

All testable logic here is pure Python — no LLM calls, no I/O.
We test:
- ResponseDirective.to_prompt_section(): directive → prompt text
- build_response_system_prompt(): persona/guideline/context composition
- build_response_user_message(): history + user input formatting
- ResponseGenerator.apply_config(): runtime config overrides
"""

from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.pipeline.response_generator import ResponseGenerator
from stella_v2_agent.prompts.response_prompt import (
    build_response_system_prompt,
    _state_machine_section,
    build_response_user_message,
)


# ---------------------------------------------------------------------------
# ResponseDirective.to_prompt_section()
# ---------------------------------------------------------------------------

def test_empty_directive_returns_empty_string():
    # A default directive with no meaningful content should produce no prompt section.
    assert ResponseDirective().to_prompt_section() == ""


def test_neutral_tone_is_not_included_in_prompt():
    # "neutral" is the default — no point telling the LLM to be neutral explicitly.
    result = ResponseDirective(tone="neutral").to_prompt_section()
    assert "Tone:" not in result


def test_non_neutral_tone_is_included():
    result = ResponseDirective(tone="cautious", primary_action="x").to_prompt_section()
    assert "Tone: cautious" in result


def test_must_avoid_items_emitted_as_avoid_lines():
    result = ResponseDirective(must_avoid=["medical advice", "legal advice"]).to_prompt_section()
    assert "Avoid: medical advice" in result
    assert "Avoid: legal advice" in result


def test_followup_question_takes_priority_over_primary_action():
    # When both are set, follow-up wins — the LLM must never receive two directions.
    result = ResponseDirective(
        ask_followup=True,
        followup_question="How long have you had this?",
        primary_action="Refer to a doctor",
    ).to_prompt_section()

    assert "How long have you had this?" in result
    assert "Refer to a doctor" not in result


def test_followup_question_emitted_with_correct_prefix():
    result = ResponseDirective(
        ask_followup=True,
        followup_question="What does a typical session look like?",
    ).to_prompt_section()
    assert "Your response should lead to: What does a typical session look like?" in result


def test_primary_action_emitted_when_no_followup():
    result = ResponseDirective(primary_action="Refer to a specialist").to_prompt_section()
    assert "Focus: Refer to a specialist" in result


def test_deliverable_signals_produce_acknowledgment_line():
    result = ResponseDirective(deliverable_signals=["user_name", "user_age"]).to_prompt_section()
    assert "user_name" in result
    assert "user_age" in result
    assert "Acknowledge" in result


# ---------------------------------------------------------------------------
# build_response_system_prompt()
# ---------------------------------------------------------------------------

def test_no_plan_no_persona_uses_default_persona():
    result = build_response_system_prompt({}, ResponseDirective())
    assert "STELLA" in result


def test_plan_system_prompt_replaces_default_persona():
    result = build_response_system_prompt({}, ResponseDirective(), plan_system_prompt="You are Max.")
    assert "You are Max." in result
    assert "STELLA" not in result


def test_custom_persona_replaces_default_when_no_plan():
    result = build_response_system_prompt({}, ResponseDirective(), custom_persona="You are a nurse.")
    assert "You are a nurse." in result
    assert "STELLA" not in result


def test_plan_and_custom_persona_both_included():
    result = build_response_system_prompt(
        {}, ResponseDirective(),
        plan_system_prompt="You are Max.",
        custom_persona="Extra rules here.",
    )
    assert "You are Max." in result
    assert "Extra rules here." in result


def test_custom_guidelines_replace_default_guidelines():
    result = build_response_system_prompt(
        {}, ResponseDirective(), custom_guidelines="Be very brief."
    )
    assert "Be very brief." in result
    # Default guidelines header should not be present
    assert "CONVERSATIONAL STYLE" not in result


def test_directive_section_included_when_directive_has_content():
    directive = ResponseDirective(primary_action="Ask about symptoms")
    result = build_response_system_prompt({}, directive)
    assert "GUIDANCE:" in result
    assert "Ask about symptoms" in result


# ---------------------------------------------------------------------------
# Context flows through the template (system prompt), the user message is bare
# ---------------------------------------------------------------------------

def test_user_message_is_the_bare_input():
    assert build_response_user_message("Hello there") == "Hello there"


def test_history_is_rendered_into_the_system_prompt():
    history = [
        {"role": "user", "content": "Hi"},
        {"role": "assistant", "content": "Hello"},
    ]
    result = build_response_system_prompt(
        {}, ResponseDirective(), conversation_history=history
    )
    # Context goes via {{conversationHistory}} in the (rendered) guidelines.
    assert "[USER]: Hi" in result
    assert "[ASSISTANT]: Hello" in result


def test_history_limit_truncates_older_messages():
    history = [
        {"role": "user", "content": "msg1"},
        {"role": "assistant", "content": "msg2"},
        {"role": "user", "content": "msg3"},
    ]
    result = build_response_system_prompt(
        {}, ResponseDirective(), conversation_history=history, history_limit=1
    )
    assert "msg3" in result
    assert "msg1" not in result


def test_state_context_is_rendered_into_the_system_prompt():
    sm = {"state": {"title": "Intro", "description": "Greet the user"}}
    result = build_response_system_prompt(sm, ResponseDirective())
    # State machine context reaches the prompt via {{stateContext}}.
    assert "Intro" in result


def test_bridge_is_rendered_into_the_system_prompt_with_continuation_guidance():
    # When a bridge was spoken, the final-stage prompt must carry it via {{bridge}}
    # plus the "continue from your opener" guidance so the reply extends it
    # seamlessly instead of restarting (#bridge-seam).
    result = build_response_system_prompt(
        {}, ResponseDirective(), bridge="Got it, being healthier is the goal."
    )
    assert "Got it, being healthier is the goal." in result
    assert "CONTINUE FROM" in result.upper()


def test_no_bridge_omits_continuation_block():
    # No bridge spoken -> the {{#if bridge}} block must not render (no dangling
    # "continue from your opener" instruction on a fresh turn).
    result = build_response_system_prompt({}, ResponseDirective(), bridge="")
    assert "CONTINUE FROM" not in result.upper()


# ---------------------------------------------------------------------------
# State-condition flags drive the behavioral NOTE prose from the template,
# not from hardcoded strings in _state_machine_section (#config-control).
# ---------------------------------------------------------------------------

def _sm_with_just_collected(*, all_pending_done: bool):
    # current_task has one deliverable key that was just collected; a second
    # pending deliverable exists unless all_pending_done.
    deliverables = [{"key": "user_name", "status": "pending", "description": "name"}]
    if not all_pending_done:
        deliverables.append({"key": "age", "status": "pending", "description": "age"})
    return {
        "state": {"title": "Intro", "description": "Greet"},
        "current_task": {"description": "Ask name", "deliverable_keys": ["user_name"]},
        "deliverables": deliverables,
        "_collected_keys": ["user_name"],
    }


def test_task_just_collected_renders_acknowledge_guidance():
    sm = _sm_with_just_collected(all_pending_done=False)
    result = build_response_system_prompt(sm, ResponseDirective())
    assert "just answered for this task" in result
    # The hardcoded "NOTE:" prose must no longer live in the structural section.
    assert "NOTE: The user just provided" not in result


def test_state_completing_renders_transition_guidance():
    sm = _sm_with_just_collected(all_pending_done=True)
    result = build_response_system_prompt(sm, ResponseDirective())
    assert "glide into the next topic" in result


def test_state_just_changed_renders_ease_in_guidance():
    sm = {"state": {"title": "Goals"}, "state_just_changed": True}
    result = build_response_system_prompt(sm, ResponseDirective())
    assert "just moved into a new phase" in result


def test_quiet_turn_renders_no_state_notes():
    # Nothing special happened — none of the conditional NOTE blocks should fire.
    sm = {"state": {"title": "Intro", "description": "Greet"}}
    result = build_response_system_prompt(sm, ResponseDirective())
    assert "just answered for this task" not in result
    assert "just moved into a new phase" not in result


# ---------------------------------------------------------------------------
# ResponseGenerator.apply_config()
# ---------------------------------------------------------------------------

def test_apply_config_overrides_model_tokens_temperature():
    gen = ResponseGenerator(llm_service=None)
    gen.apply_config({"model": "gpt-4o", "max_tokens": 300, "temperature": 0.3})
    assert gen.response_model == "gpt-4o"
    assert gen.response_max_tokens == 300
    assert gen.response_temperature == 0.3


def test_apply_config_overrides_persona_and_history_limit():
    gen = ResponseGenerator(llm_service=None)
    gen.apply_config({"persona": "You are a coach.", "history_limit": 5})
    assert gen.custom_persona == "You are a coach."
    assert gen.history_limit == 5


# ---------------------------------------------------------------------------
# ResponseGenerator.generate() message assembly — the bridge-continuation
# guidance is PROSE owned by the editable response prompt (rendered around the
# {{bridge}} injection in the system prompt), not hidden in code. The only
# auto-injected mechanism here is replaying the bridge as the assistant's
# in-progress turn so the model literally continues it (one seamless utterance).
# ---------------------------------------------------------------------------

import asyncio

from stella_agent_sdk.llm import LLMResponse


class _CapturingLLMService:
    """Captures the messages passed to generate() and drives the callback to
    completion so ResponseGenerator.generate() can be awaited without a real LLM."""

    def __init__(self):
        self.captured_messages = None

    async def generate(self, messages, config, callback, component_name="unknown"):
        self.captured_messages = messages
        resp = LLMResponse(content="continued reply", model="test", provider="test")
        await callback.on_complete(resp)
        return resp


def _run_generate(gen, **kwargs):
    async def _collect():
        return [o async for o in gen.generate(**kwargs)]

    return asyncio.run(_collect())


def _roles_and_contents(messages):
    return [(m.role, m.content) for m in messages]


def test_bridge_continuation_guidance_lives_in_the_system_prompt():
    # The "continue from the opener, don't re-greet" guidance is rendered into the
    # system prompt around {{bridge}} (editable, visible) — NOT a hidden code-only
    # system message. The bridge is also replayed as the assistant's in-progress turn.
    svc = _CapturingLLMService()
    gen = ResponseGenerator(llm_service=svc)
    _run_generate(
        gen,
        session_id="s1",
        user_input="I like bodyweight exercises",
        directive=ResponseDirective(),
        conversation_history=[],
        sm_context={},
        bridge="Bodyweight exercises are great!",
    )
    rc = _roles_and_contents(svc.captured_messages)
    # Exactly ONE system message (the rendered prompt) — no extra hidden injection.
    system_msgs = [c for r, c in rc if r == "system"]
    assert len(system_msgs) == 1
    # That single system prompt carries both the bridge text and the prose guidance.
    assert "Bodyweight exercises are great!" in system_msgs[0]
    assert "CONTINUE FROM" in system_msgs[0].upper()
    # The bridge is replayed as the assistant's own in-progress turn (the mechanism).
    assert ("assistant", "Bodyweight exercises are great!") in rc


def test_no_bridge_has_no_continuation_guidance_or_replay():
    # On a fresh turn (no spoken opener) the bridge block must not render and there
    # must be no assistant replay message.
    svc = _CapturingLLMService()
    gen = ResponseGenerator(llm_service=svc)
    _run_generate(
        gen,
        session_id="s1",
        user_input="Hello",
        directive=ResponseDirective(),
        conversation_history=[],
        sm_context={},
        bridge="",
    )
    rc = _roles_and_contents(svc.captured_messages)
    assert not any("CONTINUE FROM" in c.upper() for _, c in rc)
    assert not any(r == "assistant" for r, _ in rc)


# ---------------------------------------------------------------------------
# The state-machine section is orientation, not a form (#4 naturalness).
# It used to emit a labelled checklist every turn — every pending deliverable by
# snake_case key with acceptance criteria, plus "Overall progress: 40%". Models
# follow structure over instruction, so a checklist in the window beat the
# persona's "you are not a form" every time.
# ---------------------------------------------------------------------------

def _sm_with_backlog():
    return {
        "state": {"title": "Fitness baseline", "description": "Understand how they train"},
        "current_task": {
            "description": "Ask about frequency",
            "instruction": "Ask how often they train",
            "deliverable_keys": ["workout_freq"],
        },
        "deliverables": [
            {"key": "workout_freq", "status": "pending",
             "description": "how often they train", "acceptance_criteria": "a number per week"},
            {"key": "sleep_quality", "status": "pending", "description": "how well they sleep"},
            {"key": "goals", "status": "pending", "description": "what they want out of it"},
            {"key": "injuries", "status": "pending", "description": "any injuries"},
            {"key": "user_name", "status": "completed",
             "description": "their name", "value": "Felix"},
        ],
        "progress": {"percentage": 40},
    }


def test_progress_percentage_is_not_in_the_prompt():
    # A running completion meter is the most form-like thing in the window and
    # has no bearing on what to say next.
    result = build_response_system_prompt(_sm_with_backlog(), ResponseDirective())
    assert "Overall progress" not in result
    assert "40%" not in result


def test_deliverable_keys_are_not_exposed():
    # This stage only writes prose; key names are the extraction expert's
    # business and invited field-shaped turns.
    result = build_response_system_prompt(_sm_with_backlog(), ResponseDirective())
    for key in ("workout_freq", "sleep_quality", "user_name", "injuries"):
        assert key not in result


def test_pending_items_are_described_not_enumerated_as_fields():
    result = build_response_system_prompt(_sm_with_backlog(), ResponseDirective())
    assert "how often they train" in result
    assert "Still need to collect" not in result


def test_backlog_is_capped_and_counted_rather_than_listed():
    # Four pending items, three shown — the rest is a count so the agent stays
    # oriented without being handed the whole checklist.
    result = build_response_system_prompt(_sm_with_backlog(), ResponseDirective())
    assert "1 more" in result
    assert "any injuries" not in result


def test_the_current_task_item_comes_first():
    result = build_response_system_prompt(_sm_with_backlog(), ResponseDirective())
    section = result[result.index("still don't know"):]
    assert section.index("how often they train") < section.index("how well they sleep")


def test_criteria_shown_only_for_what_is_in_play():
    sm = _sm_with_backlog()
    sm["deliverables"][1]["acceptance_criteria"] = "hours per night"
    result = build_response_system_prompt(sm, ResponseDirective())
    assert "a number per week" in result      # current task — in play
    assert "hours per night" not in result    # backlog — noise this turn


def test_already_answered_items_are_still_carried():
    # The one thing this section must never lose: what NOT to ask again.
    result = build_response_system_prompt(_sm_with_backlog(), ResponseDirective())
    assert "their name" in result and "Felix" in result
    assert "never ask" in result.lower()


def test_just_collected_items_are_marked_as_answered():
    sm = _sm_with_backlog()
    sm["_collected_keys"] = ["workout_freq"]
    result = build_response_system_prompt(sm, ResponseDirective())
    assert "they just told you this" in result
    # …and must not still be listed as unknown. Slice only the unknown block:
    # the phrase legitimately reappears under "already told you".
    start = result.index("still don't know")
    end = result.index("They have already told you", start)
    assert "how often they train" not in result[start:end]


def test_task_instruction_survives():
    result = build_response_system_prompt(_sm_with_backlog(), ResponseDirective())
    assert "Ask how often they train" in result


def test_empty_context_renders_nothing():
    assert _state_machine_section({}) == ""
