"""Companion mode's wording and limits are settings, shipped in agent.yaml."""

import json

from stella_v2_agent.companion import (
    Change,
    Companion,
    Transition,
    _INSTRUCTION_KEYS,
    _exit_prompt,
    directive,
)
from stella_v2_agent.companion_settings import load_settings

ACTIVITY = {"id": "a", "title": "Memory Game", "description": "three words", "plan": {"id": "p"}}


def test_the_defaults_come_from_the_configurator_file():
    settings = load_settings()

    assert settings.judge_model
    assert settings.max_exit_asks >= 1 and settings.max_start_asks >= 1
    assert settings.idle_sleep_seconds > 0
    assert 0 < settings.min_confidence < 1
    assert "{{directive}}" in settings.free_conversation_guidelines


def test_every_situation_has_an_instruction():
    settings = load_settings()
    keys = set(_INSTRUCTION_KEYS.values()) | {"free", "offered", "offered_unasked", "offered_none"}

    assert keys == set(settings.reply_instructions)
    assert all(settings.instruction(key) for key in keys)


def test_instructions_are_filled_in_with_the_activity():
    asked = directive(Transition(Change.START_ASKED, activity=ACTIVITY))
    assert '"Memory Game" (three words)' in asked
    assert "{{" not in asked

    offered = directive(Transition(Change.OFFERED, offered=[ACTIVITY]))
    assert "Memory Game (three words)" in offered


def test_a_saved_configuration_changes_single_values_and_keeps_the_rest():
    settings = load_settings()
    shipped = dict(settings.reply_instructions)

    settings.apply({
        "judge_model": "gpt-other",
        "max_exit_asks": 3,
        "idle_sleep_seconds": 0,
        "reply_instructions": {"dismissed": "Say bye."},
        "free_conversation_guidelines": "",        # empty text keeps the default
        "not_a_setting": 1,
    })

    assert (settings.judge_model, settings.max_exit_asks, settings.idle_sleep_seconds) == ("gpt-other", 3, 0)
    assert settings.instruction("dismissed") == "Say bye."
    assert settings.instruction("exited") == shipped["exited"]
    assert settings.free_conversation_guidelines == load_settings().free_conversation_guidelines


def test_one_agents_changes_do_not_leak_into_another():
    first, second = Companion(), Companion()
    first.settings.apply({"reply_instructions": {"dismissed": "Say bye."}, "max_exit_asks": 5})

    assert second.settings.instruction("dismissed") != "Say bye."
    assert second.settings.max_exit_asks == load_settings().max_exit_asks


def test_the_configured_limit_on_stop_questions_is_the_one_used():
    from stella_v2_agent.companion import ASK, ExitStep

    companion = Companion(activities=[ACTIVITY])
    companion.enter(ACTIVITY)
    companion.settings.apply({"max_exit_asks": 1})
    companion.ask_exit()

    step = ExitStep(ASK, say="Shall we stop?")
    assert companion.decide([], step).change is Change.EXIT_DECLINED


def test_the_exit_judge_reads_the_configured_instructions_and_a_fixed_answer_format():
    settings = load_settings()

    open_question = _exit_prompt("Memory Game", True, "de", "", None, settings.exit_instructions)
    mid_activity = _exit_prompt("Memory Game", False, None, "Okay.", "You are Grace.", settings.exit_instructions)

    assert "you asked whether they want to stop" in open_question
    assert "'de'" in open_question and "{{" not in open_question
    assert mid_activity.startswith("You are Grace.")
    assert "in the middle of the activity" in mid_activity and '"Okay."' in mid_activity
    # The format is the parser's contract: it survives any edit of the wording.
    edited = _exit_prompt("Memory Game", False, None, "", None, "Decide.")
    assert edited.startswith("Decide.") and edited.endswith('"say": "..."}')
    json.loads(edited[edited.index("{"):].replace(' | "stay" | "ask"', ""))
