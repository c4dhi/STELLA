"""The second opinion before a goal is closed as reached (#706)."""

import asyncio
import json
from types import SimpleNamespace

from stella_agent_sdk.llm.service import LLMToolCall
from stella_v2_agent.experts.goal_check import GoalCloseCheck, split_goal_close

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
    return asyncio.run(GoalCloseCheck(llm).filter(calls, said, HISTORY, context, "gpt-4o"))


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


def test_skipping_a_goal_and_ordinary_calls_are_left_alone():
    calls = [
        batch(deliverables=[STEP], tasks=[], skip_tasks=[{"task_id": "__goal__"}]),
        call("skip_task", task_id="__goal__"),
        call("complete_task", task_id="t1"),
    ]
    assert split_goal_close(calls) == (calls, False)


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
