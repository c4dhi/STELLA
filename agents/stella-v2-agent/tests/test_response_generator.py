"""Tests for the Response Generator stage (Stage 4 of the stella-v2 pipeline).

All testable logic here is pure Python — no LLM calls, no I/O.
We test:
- ResponseDirective.to_prompt_section(): directive → prompt text
- build_response_system_prompt(): persona/guideline/context composition
- build_response_user_message(): history + user input formatting
- ResponseGenerator.apply_config(): runtime config overrides
"""

import pytest

from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.pipeline.response_generator import (
    ResponseGenerator,
    _strip_repeated_opener,
)
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


def test_deployed_persona_replaces_default_persona():
    # Identity now has one source: the deployed Persona (#467). A plan cannot
    # supply one — see test_a_plans_system_prompt_is_ignored below.
    result = build_response_system_prompt({}, ResponseDirective(), persona="You are Max.")
    assert "You are Max." in result
    assert "STELLA" not in result


def test_persona_replaces_the_default():
    result = build_response_system_prompt({}, ResponseDirective(), persona="You are a nurse.")
    assert "You are a nurse." in result
    assert "STELLA" not in result


def test_only_the_persona_can_supply_identity():
    # The Configurator's persona slot was removed with the schema (#467), so a
    # configuration cannot describe who the agent is — many personas share one
    # configuration, which is the whole point of separating them.
    import inspect
    params = inspect.signature(build_response_system_prompt).parameters
    assert "custom_persona" not in params
    assert "plan_system_prompt" not in params


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


def test_apply_config_overrides_history_limit_but_never_identity():
    gen = ResponseGenerator(llm_service=None)
    # "persona" is a key old saved configurations still carry. It is ignored
    # rather than pruned (#467), so no stored data has to be rewritten.
    gen.apply_config({"persona": "You are a coach.", "history_limit": 5})
    assert gen.history_limit == 5
    assert gen.persona is None


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
    # system prompt around {{bridge}} (editable, visible), AND a hardcoded rule is
    # always inserted on top (#627 follow-up: an operator's custom guidelines can
    # under-specify this, and prose alone didn't stop a paraphrased
    # re-acknowledgment Felix hit in practice). The bridge is also replayed as the
    # assistant's in-progress turn.
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
    # The rendered prompt PLUS the hardcoded rule — never fewer, never a
    # replacement of the editable prose.
    system_msgs = [c for r, c in rc if r == "system"]
    assert len(system_msgs) == 2
    # The rendered prompt carries the bridge text and the prose guidance.
    assert "Bodyweight exercises are great!" in system_msgs[0]
    assert "CONTINUE FROM" in system_msgs[0].upper()
    # The hardcoded rule explicitly forbids a re-acknowledgment in OTHER words,
    # not just a literal repeat.
    assert "not even in different words" in system_msgs[1]
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


def test_prepend_and_bridge_together_get_the_hardcoded_rule_and_are_both_replayed():
    svc = _CapturingLLMService()
    gen = ResponseGenerator(llm_service=svc)
    _run_generate(
        gen,
        session_id="s1",
        user_input="I ran 5k",
        directive=ResponseDirective(),
        conversation_history=[],
        sm_context={},
        bridge="Nice one!",
        prepend="If this ever feels unsafe, please stop and consult a doctor.",
    )
    rc = _roles_and_contents(svc.captured_messages)
    system_msgs = [c for r, c in rc if r == "system"]
    assert len(system_msgs) == 2
    assert 'you said "Nice one!"' in system_msgs[1]
    assert 'the user was told, verbatim: "If this ever feels unsafe, please stop and consult a doctor."' in system_msgs[1]
    # Both pieces replayed together as one assistant turn.
    assert (
        "assistant",
        "Nice one! If this ever feels unsafe, please stop and consult a doctor.",
    ) in rc


def test_prepend_alone_still_gets_the_hardcoded_rule():
    svc = _CapturingLLMService()
    gen = ResponseGenerator(llm_service=svc)
    _run_generate(
        gen,
        session_id="s1",
        user_input="I ran 5k",
        directive=ResponseDirective(),
        conversation_history=[],
        sm_context={},
        bridge="",
        prepend="Safety note.",
    )
    rc = _roles_and_contents(svc.captured_messages)
    system_msgs = [c for r, c in rc if r == "system"]
    assert len(system_msgs) == 2
    assert 'the user was told, verbatim: "Safety note."' in system_msgs[1]
    assert "you said" not in system_msgs[1]
    assert ("assistant", "Safety note.") in rc


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


def test_only_the_next_gap_is_named_and_the_rest_counted():
    # Four pending items, ONE shown. A list of gaps is a list of things to ask,
    # and models follow structure over instruction — three visible gaps produced
    # turns that closed two of them at once, which is the multi-question reply
    # the guidelines forbid in prose. The count keeps the agent oriented.
    result = build_response_system_prompt(_sm_with_backlog(), ResponseDirective())
    assert "3 more" in result
    assert "how well they sleep" not in result
    assert "what they want out of it" not in result
    assert "any injuries" not in result


def test_the_one_named_gap_is_the_current_task_s():
    # With a single visible item, ordering IS the selection: the live task's
    # deliverable must be the one that survives, never a backlog item.
    result = build_response_system_prompt(_sm_with_backlog(), ResponseDirective())
    section = result[result.index("The one thing to find out next"):]
    assert "how often they train" in section


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
    start = result.index("The one thing to find out next")
    end = result.index("They have already told you", start)
    assert "how often they train" not in result[start:end]


def test_task_instruction_survives():
    result = build_response_system_prompt(_sm_with_backlog(), ResponseDirective())
    assert "Ask how often they train" in result


def test_empty_context_renders_nothing():
    assert _state_machine_section({}) == ""


# ---------------------------------------------------------------------------
# Mentioned-but-unconfirmed deliverables (status 'partial').
#
# There used to be only two states — unknown or settled — so something the user
# volunteered came back later as a cold question ("do you go for walks?" after
# they had already said they walk most days). A real interviewer brings it back
# and checks instead.
# ---------------------------------------------------------------------------

def _sm_with_unconfirmed():
    return {
        "state": {"title": "Alltag"},
        "current_task": {"description": "Bewegung", "deliverable_keys": ["movement"]},
        "deliverables": [
            {"key": "movement", "status": "pending",
             "description": "how they move day to day"},
            {"key": "walks", "status": "partial",
             "description": "whether they walk regularly",
             "value": "walks most days, not in this heat"},
            {"key": "water", "status": "completed",
             "description": "hydration", "value": "tries to drink enough"},
        ],
    }


def test_unconfirmed_is_surfaced_as_something_to_check():
    result = build_response_system_prompt(_sm_with_unconfirmed(), ResponseDirective())
    assert "MENTIONED these but have not confirmed" in result
    assert "walks most days, not in this heat" in result


def test_unconfirmed_is_not_listed_as_unknown():
    # Asking cold is the bug being fixed — it must not appear as a gap.
    result = build_response_system_prompt(_sm_with_unconfirmed(), ResponseDirective())
    start = result.index("The one thing to find out next")
    end = result.index("They MENTIONED", start)
    assert "walk" not in result[start:end]


def test_unconfirmed_is_not_treated_as_settled():
    # Nor may it be filed under "never ask this again" — that is the other
    # failure: asserting something the user never actually agreed to.
    result = build_response_system_prompt(_sm_with_unconfirmed(), ResponseDirective())
    # Slice on the section HEADER — the bare phrase "already told you" also
    # occurs in the conversation guidelines further up.
    settled = result[result.index("They have already told you (never ask"):]
    assert "walk" not in settled
    assert "hydration" in settled


def test_confirmed_and_unconfirmed_coexist():
    result = build_response_system_prompt(_sm_with_unconfirmed(), ResponseDirective())
    assert "how they move day to day" in result   # still unknown
    assert "whether they walk regularly" in result  # to be checked
    assert "tries to drink enough" in result        # settled


def test_no_unconfirmed_block_when_there_are_none():
    sm = {"state": {"title": "X"},
          "deliverables": [{"key": "a", "status": "completed",
                            "description": "a thing", "value": "v"}]}
    assert "MENTIONED" not in build_response_system_prompt(sm, ResponseDirective())


# ---------------------------------------------------------------------------
# _strip_repeated_opener() — the model sometimes restarts a continuation with
# the bridge it just spoke, usually tagged (#627: "Nice to meet you, Sam!"
# spoken, then "[happy] Nice to meet you, Sam! [curious] What type...").
# ---------------------------------------------------------------------------

def test_tagged_repeat_of_the_opener_is_dropped():
    result = _strip_repeated_opener(
        "Nice to meet you, Sam!",
        "[happy] Nice to meet you, Sam! [curious] What type of exercise do you enjoy?",
    )
    assert result == "[curious] What type of exercise do you enjoy?"


def test_untagged_repeat_of_the_opener_is_dropped():
    result = _strip_repeated_opener(
        "Got it, being healthier is the goal.",
        "Got it, being healthier is the goal. What does a typical week look like?",
    )
    assert result == "What does a typical week look like?"


def test_repeat_is_matched_ignoring_case_and_punctuation():
    result = _strip_repeated_opener(
        "Got it, being healthier is the goal.",
        "[happy] got it being healthier is the goal! So where do we start?",
    )
    assert result == "So where do we start?"


def test_genuine_continuation_is_left_untouched():
    # No repeat here — the guard must not eat real content that happens to
    # share an early word or two with the opener.
    continuation = "[curious] What type of exercise do you enjoy the most?"
    assert _strip_repeated_opener("Nice to meet you, Sam!", continuation) == continuation


def test_partial_overlap_is_not_treated_as_a_repeat():
    # A finished reply that only starts like the opener is real content.
    continuation = "[happy] Nice to meet"
    assert _strip_repeated_opener("Nice to meet you, Sam!", continuation) == continuation


def test_a_repeat_in_the_making_is_held_while_the_stream_is_open():
    # Mid-stream the same text could still become a repeat; passing it on now
    # and stripping it later would shorten what was already sent.
    opener = "Nice to meet you, Sam!"
    assert _strip_repeated_opener(opener, "[happy] Nice to meet", is_final=False) is None
    assert _strip_repeated_opener(opener, "[hap", is_final=False) is None
    assert _strip_repeated_opener(opener, "Nice to meet you, Sam", is_final=False) is None
    assert _strip_repeated_opener(opener, "Nice to see", is_final=False) == "Nice to see"


def test_a_longer_word_is_not_a_repeat_of_a_short_opener():
    assert _strip_repeated_opener("Oh", "Ohio is lovely.") == "Ohio is lovely."


def test_empty_opener_or_continuation_is_a_no_op():
    assert _strip_repeated_opener("", "[happy] hello") == "[happy] hello"
    assert _strip_repeated_opener("hello", "") == ""


# ---------------------------------------------------------------------------
# generate() end to end — the guard must apply to what actually reaches TTS.
# ---------------------------------------------------------------------------

class _RespondingLLMService:
    """Like _CapturingLLMService, but returns a configurable final response."""

    def __init__(self, content: str):
        self._content = content
        self.captured_messages = None

    async def generate(self, messages, config, callback, component_name="unknown"):
        self.captured_messages = messages
        resp = LLMResponse(content=self._content, model="test", provider="test")
        await callback.on_complete(resp)
        return resp


def test_generate_drops_a_repeated_bridge_before_it_reaches_tts():
    svc = _RespondingLLMService(
        "[happy] Nice to meet you, Sam! [curious] What type of exercise do you enjoy?"
    )
    gen = ResponseGenerator(llm_service=svc)
    outputs = _run_generate(
        gen,
        session_id="s1",
        user_input="Hi, my name is Sam.",
        directive=ResponseDirective(),
        conversation_history=[],
        sm_context={},
        bridge="Nice to meet you, Sam!",
    )
    final_text = outputs[-1].content
    assert final_text.count("Nice to meet you, Sam!") == 1
    assert final_text == "Nice to meet you, Sam! [curious] What type of exercise do you enjoy?"


class _StreamingLLMService:
    """Streams a reply a few characters at a time, as a provider does."""

    def __init__(self, content: str, step: int = 3):
        self._content = content
        self._step = step

    async def generate(self, messages, config, callback, component_name="unknown"):
        for end in range(self._step, len(self._content), self._step):
            await callback.on_token(self._content[end - self._step:end], self._content[:end])
        resp = LLMResponse(content=self._content, model="test", provider="test")
        await callback.on_complete(resp)
        return resp


def _sent_to_tts(outputs):
    """What the SDK loop hands to TTS: each chunk's new text, or — when a
    chunk does not extend the last one — the whole chunk again."""
    sent, last = "", ""
    for output in outputs:
        sent += output.content[len(last):] if output.content.startswith(last) else output.content
        last = output.content
    return sent


@pytest.mark.parametrize("bridge, reply, heard", [
    ("Nice to meet you, Sam!", "[happy] Nice to meet you, Sam! [curious] What do you enjoy?",
     "Nice to meet you, Sam! [curious] What do you enjoy?"),
    ("Glad to hear that. It sounds like a good day.", "Glad to hear that. It sounds like a good day. What made it good?",
     "Glad to hear that. It sounds like a good day. What made it good?"),
    ("Nice to meet you, Sam!", "[curious] What type of exercise do you enjoy?",
     "Nice to meet you, Sam! [curious] What type of exercise do you enjoy?"),
    ("Nice to meet you, Sam!", "Nice to see the sun out today.",
     "Nice to meet you, Sam! Nice to see the sun out today."),
    ("Oh", "Ohio is lovely this time of year.", "Oh Ohio is lovely this time of year."),
])
@pytest.mark.parametrize("step", [1, 3, 7])
def test_streamed_text_only_ever_grows(bridge, reply, heard, step):
    # A chunk that is not an extension of the last one makes the SDK speak the
    # reply again from its start — the bridge was heard two and three times.
    gen = ResponseGenerator(llm_service=_StreamingLLMService(reply, step))
    outputs = _run_generate(
        gen, session_id="s1", user_input="Hi.", directive=ResponseDirective(),
        conversation_history=[], sm_context={}, bridge=bridge,
    )
    for earlier, later in zip(outputs, outputs[1:]):
        assert later.content.startswith(earlier.content)
    assert _sent_to_tts(outputs) == heard
    assert outputs[-1].is_final


def test_generate_leaves_a_genuine_continuation_untouched():
    svc = _RespondingLLMService("[curious] What type of exercise do you enjoy?")
    gen = ResponseGenerator(llm_service=svc)
    outputs = _run_generate(
        gen,
        session_id="s1",
        user_input="Hi, my name is Sam.",
        directive=ResponseDirective(),
        conversation_history=[],
        sm_context={},
        bridge="Nice to meet you, Sam!",
    )
    final_text = outputs[-1].content
    assert final_text == "Nice to meet you, Sam! [curious] What type of exercise do you enjoy?"


def test_paraphrased_reacknowledgment_is_explicitly_forbidden_in_the_request():
    # Felix's dev example (#627 follow-up): bridge "Glad to hear that! It sounds
    # like it's been a pretty good day for you." was followed by a continuation
    # that opened with "That's great to hear!" — a re-acknowledgment in DIFFERENT
    # words, not a literal repeat, so _strip_repeated_opener() can't catch it (no
    # matching substring exists to strip). The hardcoded rule is what has to stop
    # this at the source, on every deployment regardless of custom guidelines:
    # assert it is actually sent and names this exact class of violation.
    svc = _CapturingLLMService()
    gen = ResponseGenerator(llm_service=svc)
    _run_generate(
        gen,
        session_id="s1",
        user_input="My day is fine",
        directive=ResponseDirective(),
        conversation_history=[],
        sm_context={},
        bridge="Glad to hear that! It sounds like it's been a pretty good day for you.",
    )
    rc = _roles_and_contents(svc.captured_messages)
    system_msgs = [c for r, c in rc if r == "system"]
    assert len(system_msgs) == 2
    rule = system_msgs[1]
    assert "add another acknowledgment or reaction to your own words" in rule
    assert "not even in different words" in rule


# ---------------------------------------------------------------------------
# A routing directive is the last instruction the model reads
# ---------------------------------------------------------------------------

async def _messages_sent(monkeypatch, directive, bridge=""):
    from stella_v2_agent.pipeline import response_generator as module

    sent = {}

    async def fake_stream(_service, messages, _config, component_name=""):
        sent["messages"] = messages
        yield "Sleep well.", True

    monkeypatch.setattr(module, "stream_completion", fake_stream)
    generator = ResponseGenerator(llm_service=None)
    async for _ in generator.generate("s", "nothing", directive, [], {}, bridge=bridge):
        pass
    return sent["messages"]




@pytest.mark.asyncio
async def test_a_routing_directive_is_repeated_after_the_user_message(monkeypatch):
    # Session ba70e570: told inside the system prompt to say goodbye and sleep,
    # the reply asked a follow-up question instead, every time.
    directive = ResponseDirective(routing_directive="Say goodbye in one sentence.")
    messages = await _messages_sent(monkeypatch, directive)

    assert messages[-2].role == "user"
    assert messages[-1].role == "system"
    assert "Say goodbye in one sentence." in messages[-1].content


@pytest.mark.asyncio
async def test_the_spoken_opener_still_comes_last_so_the_reply_continues_it(monkeypatch):
    directive = ResponseDirective(routing_directive="Say goodbye in one sentence.")
    messages = await _messages_sent(monkeypatch, directive, bridge="Got it.")

    assert (messages[-1].role, messages[-1].content) == ("assistant", "Got it.")
    assert "Say goodbye in one sentence." in messages[-2].content


@pytest.mark.asyncio
async def test_an_ordinary_turn_gets_no_extra_instruction(monkeypatch):
    messages = await _messages_sent(monkeypatch, ResponseDirective(primary_action="x"))

    assert [m.role for m in messages] == ["system", "user"]
