"""The second opinion before a goal is closed as reached (#706)."""

import asyncio
import json
from types import SimpleNamespace

from stella_agent_sdk.llm.service import LLMToolCall
from stella_v2_agent.experts.goal_check import GoalCloseCheck, split_goal_close, split_goal_skip

GOAL_CONTEXT = {
    "processing_mode": "goal",
    "state": {
        "id": "step",
        "goal_objective": "Help the participant define a next step",
        "goal_success_description": "The participant states a concrete next step for this week",
    },
    "full_plan": [
        {
            "id": "step",
            "tasks": [
                {
                    "id": "__goal_deliverables__",
                    "deliverables": [
                        {"key": "next_step", "description": "the step", "required": True,
                         "acceptance_criteria": "A specific activity with a day."},
                    ],
                }
            ],
        }
    ],
}
HISTORY = [
    {"role": "assistant", "content": "What could you do this week?"},
]
SAID = "I will walk to the bakery on Tuesday morning."


class FakeLLM:
    def __init__(self, answer=None, error=None):
        self.answer, self.error, self.prompts = answer, error, []

    async def generate(self, messages, config, component_name=None):
        self.prompts.append(messages[0].content)
        if self.error:
            raise self.error
        content = self.answer if isinstance(self.answer, str) else json.dumps(self.answer)
        return SimpleNamespace(content=content)


def call(name, **arguments):
    return LLMToolCall(id="c1", name=name, arguments=arguments)


def batch(**arguments):
    return call("batch_update", **arguments)


CLOSE = {"task_id": "__goal__", "reasoning": "they named a step"}
STEP = {"key": "next_step", "value": "walk to the bakery on Tuesday", "reasoning": "said so"}


def run(llm, calls, context=GOAL_CONTEXT, said=SAID):
    """The calls that may run, and the single check made (None when there was none)."""
    kept, results = run_all(llm, calls, context, said)
    assert len(results) <= 1
    return kept, (results[0] if results else None)


def run_all(llm, calls, context=GOAL_CONTEXT, said=SAID):
    return asyncio.run(GoalCloseCheck(llm).filter(calls, said, HISTORY, context, "gpt-5.4-mini"))


# --- what counts as closing ----------------------------------------------------

def test_a_batch_loses_only_the_goal_completion():
    kept, closing = split_goal_close([batch(deliverables=[STEP], tasks=[CLOSE, {"task_id": "t1"}])])
    assert closing
    assert kept[0].arguments["tasks"] == [{"task_id": "t1"}]
    assert kept[0].arguments["deliverables"] == [STEP]


def test_a_batch_that_only_closed_the_goal_is_dropped():
    kept, closing = split_goal_close([batch(deliverables=[], tasks=[CLOSE])])
    assert closing and kept == []


def test_complete_task_and_the_old_marker_are_closes_too():
    assert split_goal_close([call("complete_task", task_id="__goal__")]) == ([], True)
    assert split_goal_close([call("complete_task", task_id="__goal_deliverables__")]) == ([], True)
    assert split_goal_close([call("set_deliverable", key="__goal_achieved__", value="true")]) == ([], True)


def test_skipping_a_goal_is_not_a_close():
    calls = [
        batch(deliverables=[STEP], tasks=[], skip_tasks=[{"task_id": "__goal__"}]),
        call("skip_task", task_id="__goal__"),
        call("complete_task", task_id="t1"),
    ]
    assert split_goal_close(calls) == (calls, False)


# --- what counts as giving the goal up -------------------------------------------

def test_a_batch_loses_only_the_goal_skip():
    kept, skipping = split_goal_skip([batch(deliverables=[STEP], tasks=[], skip_tasks=[{"task_id": "__goal__"}, {"task_id": "t2"}])])
    assert skipping
    assert kept[0].arguments["skip_tasks"] == [{"task_id": "t2"}]
    assert kept[0].arguments["deliverables"] == [STEP]


def test_skip_task_and_skip_state_give_the_goal_up():
    assert split_goal_skip([call("skip_task", task_id="__goal__")]) == ([], True)
    assert split_goal_skip([call("skip_state", reasoning="not relevant")]) == ([], True)
    assert split_goal_skip([batch(deliverables=[], tasks=[], skip_tasks=[{"task_id": "__goal__"}])]) == ([], True)


def test_skipping_another_task_is_left_alone():
    calls = [call("skip_task", task_id="t1"), batch(deliverables=[STEP], tasks=[CLOSE], skip_tasks=[{"task_id": "t2"}])]
    assert split_goal_skip(calls) == (calls, False)


# --- the check -------------------------------------------------------------------

def test_no_model_call_when_nothing_closes_a_goal():
    llm = FakeLLM()
    calls = [batch(deliverables=[STEP], tasks=[])]
    assert run(llm, calls) == (calls, None)
    assert llm.prompts == []


def test_no_model_call_outside_a_goal_state():
    llm = FakeLLM()
    calls = [call("complete_task", task_id="__goal__")]
    assert run(llm, calls, context={**GOAL_CONTEXT, "processing_mode": "loose"}) == (calls, None)
    assert llm.prompts == []


def test_reached_with_the_users_own_words_lets_the_close_through():
    llm = FakeLLM({"quote": "I will walk to the bakery on Tuesday morning", "reached": True, "reason": "a step with a day"})
    calls = [batch(deliverables=[STEP], tasks=[CLOSE])]
    kept, result = run(llm, calls)
    assert kept == calls
    assert result.allowed and result.as_dict()["attempted"]


def test_not_reached_holds_the_close_back_and_keeps_the_rest():
    llm = FakeLLM({"quote": "", "reached": False, "reason": "only a maybe"})
    kept, result = run(llm, [batch(deliverables=[STEP], tasks=[CLOSE])])
    assert not result.allowed
    assert kept[0].arguments["tasks"] == [] and kept[0].arguments["deliverables"] == [STEP]


def test_a_quote_the_user_never_said_does_not_count():
    llm = FakeLLM({"quote": "I will go swimming every day", "reached": True, "reason": "committed"})
    kept, result = run(llm, [call("complete_task", task_id="__goal__")])
    assert kept == [] and not result.allowed
    assert "not something the user said" in result.reason


def test_the_assistants_words_are_not_the_users():
    llm = FakeLLM({"quote": "What could you do this week?", "reached": True, "reason": "x"})
    _, result = run(llm, [call("complete_task", task_id="__goal__")])
    assert not result.allowed


def test_quote_matching_ignores_case_spacing_and_punctuation():
    llm = FakeLLM({"quote": "i will walk  to the bakery, on Tuesday morning!", "reached": True, "reason": "x"})
    _, result = run(llm, [call("complete_task", task_id="__goal__")])
    assert result.allowed


def test_a_failed_or_unreadable_check_holds_the_goal_open():
    for llm in (FakeLLM(error=RuntimeError("down")), FakeLLM("not json")):
        kept, result = run(llm, [call("complete_task", task_id="__goal__")])
        assert kept == [] and not result.allowed


def test_the_check_sees_the_criteria_and_what_this_turn_records():
    llm = FakeLLM({"quote": "", "reached": False, "reason": "x"})
    run(llm, [batch(deliverables=[STEP], tasks=[CLOSE])])
    prompt = llm.prompts[0]
    assert "The participant states a concrete next step for this week" in prompt
    assert "Must look like: A specific activity with a day." in prompt
    assert 'Recorded: "walk to the bakery on Tuesday"' in prompt
    assert f"USER: {SAID}" in prompt


# --- giving a goal up ---------------------------------------------------------------

def test_a_skip_goes_through_when_the_user_said_they_want_to_move_on():
    llm = FakeLLM({"quote": "can we move on", "refused": True, "reason": "asked to move on"})
    calls = [call("skip_task", task_id="__goal__")]
    kept, result = run(llm, calls, said="I'd rather not get into that, can we move on?")
    assert kept == calls and result.allowed and result.kind == "skip"


def test_a_skip_is_held_back_when_the_user_only_left_one_question_open():
    llm = FakeLLM({"quote": "", "refused": False, "reason": "only declined to give a name"})
    step_and_skip = batch(deliverables=[STEP], tasks=[], skip_tasks=[{"task_id": "__goal__"}])
    kept, result = run(llm, [step_and_skip], said="I'd rather keep my name private, but happy to chat.")
    assert not result.allowed and result.kind == "skip"
    assert kept[0].arguments["skip_tasks"] == [] and kept[0].arguments["deliverables"] == [STEP]


def test_a_skip_needs_the_users_own_words_too():
    llm = FakeLLM({"quote": "please stop asking me", "refused": True, "reason": "x"})
    kept, result = run(llm, [call("skip_state", reasoning="x")])
    assert kept == [] and not result.allowed


def test_the_skip_question_is_about_refusing_not_about_reaching():
    llm = FakeLLM({"quote": "", "refused": False, "reason": "x"})
    run(llm, [call("skip_task", task_id="__goal__")])
    assert "has the user turned this part of the conversation down?" in llm.prompts[0]
    assert "Help the participant define a next step" in llm.prompts[0]


def test_a_close_and_a_skip_in_one_turn_are_each_checked():
    llm = FakeLLM({"quote": "", "reached": False, "refused": False, "reason": "x"})
    kept, results = run_all(llm, [call("complete_task", task_id="__goal__"), call("skip_task", task_id="__goal__")])
    assert kept == [] and [r.kind for r in results] == ["close", "skip"]
    assert len(llm.prompts) == 2


# --- telling the expert what became of its last attempt -----------------------------

def test_a_held_back_close_is_remembered_for_the_experts_next_prompt():
    check = GoalCloseCheck(FakeLLM({"quote": "", "reached": False, "reason": "Only a maybe so far."}))
    assert check.note_for(GOAL_CONTEXT) == ""
    asyncio.run(check.filter([call("complete_task", task_id="__goal__")], SAID, HISTORY, GOAL_CONTEXT, "m"))
    note = check.note_for(GOAL_CONTEXT)
    assert "tried to complete `__goal__`" in note and "Only a maybe so far." in note
    # It belongs to that goal state only.
    other = {**GOAL_CONTEXT, "state": {**GOAL_CONTEXT["state"], "id": "another"}}
    assert check.note_for(other) == ""
    assert check.note_for({**GOAL_CONTEXT, "processing_mode": "loose"}) == ""


def test_the_note_goes_once_an_attempt_is_allowed():
    llm = FakeLLM({"quote": "", "reached": False, "reason": "no"})
    check = GoalCloseCheck(llm)
    asyncio.run(check.filter([call("complete_task", task_id="__goal__")], SAID, HISTORY, GOAL_CONTEXT, "m"))
    llm.answer = {"quote": "I will walk to the bakery on Tuesday morning", "reached": True, "reason": "yes"}
    asyncio.run(check.filter([call("complete_task", task_id="__goal__")], SAID, HISTORY, GOAL_CONTEXT, "m"))
    assert check.note_for(GOAL_CONTEXT) == ""


def test_a_held_back_skip_is_remembered_as_a_skip():
    check = GoalCloseCheck(FakeLLM({"quote": "", "refused": False, "reason": "They only left one question open."}))
    asyncio.run(check.filter([call("skip_task", task_id="__goal__")], SAID, HISTORY, GOAL_CONTEXT, "m"))
    assert "tried to skip `__goal__`" in check.note_for(GOAL_CONTEXT)
