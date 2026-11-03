"""The reply starts before extraction: where the plan goes, and what happens if it was wrong."""

import asyncio
from types import SimpleNamespace

import pytest
from stella_agent_sdk import AgentOutput
from stella_v2_agent.agent import StellaV2Agent
from stella_v2_agent.experts.registry import ExpertRegistry
from stella_v2_agent.models.expert_verdict import ExpertVerdict

from stella_v2_agent.prompts.response_prompt import _state_machine_section

from stella_jev_agent.agent import _OWN_EXPERTS_DIR, StellaJevAgent
from stella_jev_agent.ask_back import AskBack
from stella_jev_agent.next_step import END, OTHERWISE, context_after, context_within, predict, route, task_question
from stella_jev_agent.pool import ANSWERED_TASK, NEXT_STEP, JevExpertPool


def _answer(**probabilities):
    return SimpleNamespace(choice=max(probabilities, key=probabilities.get), probabilities=probabilities)


def _task(task_id, *keys, status="pending"):
    return {
        "id": task_id, "description": task_id, "instruction": f"do {task_id}", "status": status,
        "deliverables": [{"key": k, "description": k, "required": True, "status": "pending"} for k in keys],
    }


def _plan(*states):
    return {"states": [dict({"tasks": [], "transitions": []}, **s) for s in states]}


LINEAR = _plan(
    {"id": "a", "type": "flexible", "tasks": [{"id": "t1"}, {"id": "t2"}],
     "transitions": [{"target_state_id": "b", "condition_type": "all_tasks_complete", "priority": 0}]},
    {"id": "b", "type": "flexible", "description": "second", "tasks": [{"id": "t3"}],
     "transitions": [{"target_state_id": END, "condition_type": "all_tasks_complete", "priority": 0}]},
)
BRANCHING = _plan(
    {"id": "a", "tasks": [{"id": "t1", "deliverables": [{"key": "water", "description": "Litres of water a day"}]}],
     "transitions": [
         {"target_state_id": "more", "condition_type": "deliverable_value_numeric", "priority": 0,
          "condition_config": {"key": "water", "operator": "lt", "value": 1}},
         {"target_state_id": "kind", "condition_type": "deliverable_value_in", "priority": 1,
          "condition_config": {"key": "water", "values": ["viel", "genug"]}},
         {"target_state_id": "b", "condition_type": "all_tasks_complete", "priority": 2},
     ]},
    {"id": "more"}, {"id": "kind"}, {"id": "b"},
)


def test_a_fixed_plan_has_one_way_out():
    branches = route(LINEAR, "a")
    assert [(b.target, b.when) for b in branches] == [("b", "")]


def test_a_plan_without_transitions_follows_its_order_like_the_backend():
    plan = _plan({"id": "a"}, {"id": "b"})
    assert route(plan, "a")[0].target == "b"
    assert route(plan, "b")[0].target == END


def test_value_conditions_are_written_out_in_order_of_priority():
    branches = route(BRANCHING, "a")
    assert [b.target for b in branches] == ["more", "kind", "b"]
    assert branches[0].when == "Litres of water a day: less than 1"
    assert branches[1].when == "Litres of water a day: one of viel, genug"


@pytest.mark.parametrize("kind", ["compound", "all_of", "any_of", "goal_achieved"])
def test_only_the_state_machine_can_tell_on_other_conditions(kind):
    plan = _plan({"id": "a", "transitions": [{"target_state_id": "b", "condition_type": kind}]}, {"id": "b"})
    assert route(plan, "a") is None


def test_a_goal_state_cannot_be_forecast():
    assert route(_plan({"id": "a", "type": "goal"}, {"id": "b"}), "a") is None
    assert route(_plan({"id": "a"}, {"id": "b", "type": "goal"}), "a") is None


def test_the_plan_moves_only_when_this_was_the_last_open_task():
    branches = route(LINEAR, "a")
    first, second = _task("t1", "name"), _task("t2", "mood")
    assert predict(branches, [first, second], first) is None
    assert predict(branches, [second], second) == "b"


def test_an_optional_task_left_open_does_not_hold_the_plan():
    branches = route(LINEAR, "a")
    first, optional = _task("t1", "name"), _task("t2", "mood")
    assert predict(branches, [first, optional], first, OTHERWISE, {"t1"}) == "b"


def test_a_task_with_more_values_still_open_stays():
    assert predict(route(LINEAR, "a"), [_task("t1", "x", "y")], _task("t1", "x", "y")) is None


def test_a_task_with_no_value_can_finish_a_state():
    assert predict(route(LINEAR, "b"), [_task("t3")], _task("t3")) == END


def test_a_value_branch_follows_the_way_jev_picked():
    branches = route(BRANCHING, "a")
    task = _task("t1", "water")
    assert predict(branches, [task], task, "way_0") == "more"
    assert predict(branches, [task], task, "way_1") == "kind"
    assert predict(branches, [task], task, OTHERWISE) == "b"


def test_a_value_branch_on_another_tasks_value_does_not_fire():
    branches = route(BRANCHING, "a")
    other = _task("t9", "name")
    assert predict(branches, [other, _task("t1", "water")], other, "way_0") is None


FULL_PLAN = [
    {"id": "a", "title": "A", "is_current": True, "tasks": [_task("t1", "name")]},
    {"id": "b", "title": "B", "is_current": False, "tasks": [_task("t3", "week"), _task("t4", "nice")]},
]


def test_the_reply_gets_the_context_of_the_state_it_is_moving_to():
    context = {
        "language": "de", "full_plan": FULL_PLAN, "state": {"id": "a"}, "collected_deliverables": {"old": 1},
        "deliverables": [{"key": "name", "status": "pending"}, {"key": "old", "status": "completed", "value": 1}],
    }
    after = context_after(context, LINEAR, "b")
    assert after["state"]["id"] == "b" and after["state"]["description"] == "second"
    assert after["state_just_changed"] is True
    assert after["current_task"]["id"] == "t3"
    assert after["current_task"]["deliverable_keys"] == ["week"]
    assert after["language"] == "de"
    assert [d["key"] for d in after["deliverables"]] == ["week", "nice", "old"]
    assert [s["is_current"] for s in after["full_plan"]] == [False, True]
    assert context["state"]["id"] == "a", "the turn's own snapshot stays as it was"


class FakeJev:
    def __init__(self, answers):
        self.answers = answers
        self.asked = []
        self.timeout_s = 1.5

    async def ask(self, state, questions, timeout_s=0):
        self.asked.append(set(questions))
        return SimpleNamespace(answers=self.answers, latency_ms=100.0)


QUIET = {
    "common_sense": _answer(fits=0.97, slight_doubt=0.02, doesnt_fit=0.01),
    "recogniser_artifact": _answer(speech=0.99, artifact=0.01),
    "medical": _answer(none=0.97, low=0.01, high=0.01, critical=0.01),
    "legal": _answer(none=0.97, low=0.01, high=0.01, critical=0.01),
    "probing": _answer(no_probe=0.9, needs_clarification=0.05, gentle_redirect=0.05),
    "timekeeper": _answer(on_track=0.9, slowing=0.05, wrap_up=0.05),
    "has_answer": _answer(no=0.1, yes=0.9),
    "activity_intent": _answer(none=0.99, transition=0.01),
}


class Pool(JevExpertPool):
    def __init__(self, answers, plan):
        super().__init__(
            None, ExpertRegistry(experts_dir=str(_OWN_EXPERTS_DIR)), compiler_version="1.0.0",
            jev=FakeJev(answers), ask_back=AskBack(), plan=lambda: plan,
        )
        self.calls = []
        self.release = None

    async def _run_experts(self, names, *args, **kwargs):
        self.calls.append(list(names))
        if self.release is not None:
            await self.release.wait()
        return [ExpertVerdict(expert_name=n, verdict="x", priority=1, latency_ms=500.0,
                              raw_output={"transitioned": True, "new_state_id": "b"}) for n in names]


NAMES = ["common_sense", "medical", "legal", "probing", "task_extraction"]
CONTEXT = {"state": {"id": "a"}, "full_plan": FULL_PLAN}


def test_the_turn_holds_extraction_back_until_arbitration_and_says_where_the_plan_goes():
    pool = Pool({**QUIET, ANSWERED_TASK: _answer(task_0=0.95, nothing=0.05)}, LINEAR)

    async def turn():
        verdicts = await pool.run(NAMES, "Ich heiße Anna", [], CONTEXT)
        assert pool.calls == [], "nothing runs before arbitration"
        assert "task_extraction" not in [v.expert_name for v in verdicts]
        pool.start_held_extraction()
        return await pool.finish_extraction()

    late = asyncio.run(turn())
    assert pool.calls == [["task_extraction"]]
    assert [v.expert_name for v in late] == ["task_extraction"]
    assert pool.forecast.next_state == "b"
    assert pool.forecast.keys == ["name"]


def test_needs_clarification_saves_nothing_and_forecasts_nothing():
    answers = {
        **QUIET,
        "probing": _answer(no_probe=0.05, needs_clarification=0.9, gentle_redirect=0.05),
        ANSWERED_TASK: _answer(task_0=0.95, nothing=0.05),
    }
    pool = Pool(answers, LINEAR)
    asyncio.run(pool.run(NAMES, "weiß nicht", [], CONTEXT))
    pool._held is None or pytest.fail("held an extraction")
    assert pool.forecast.next_state is None and pool.forecast.keys == []


def test_an_unsure_task_pick_makes_no_forecast_but_extraction_still_runs():
    pool = Pool({**QUIET, ANSWERED_TASK: _answer(task_0=0.5, nothing=0.5)}, LINEAR)
    asyncio.run(pool.run(NAMES, "hm", [], CONTEXT))
    assert pool._held is not None
    assert pool.forecast.next_state is None


def test_a_value_branch_asks_jev_which_way_and_follows_it():
    context = {"state": {"id": "a"}, "full_plan": [
        {"id": "a", "is_current": True, "tasks": [_task("t1", "water")]},
    ]}
    answers = {
        **QUIET,
        ANSWERED_TASK: _answer(task_0=0.95, nothing=0.05),
        NEXT_STEP: _answer(way_0=0.9, way_1=0.05, otherwise=0.05),
    }
    pool = Pool(answers, BRANCHING)
    asyncio.run(pool.run(NAMES, "Nur ein halber Liter", [], context))
    assert NEXT_STEP in pool._jev.asked[0]
    assert pool.forecast.next_state == "more"


def test_an_unsure_branch_pick_keeps_the_keys_but_does_not_move():
    context = {"state": {"id": "a"}, "full_plan": [
        {"id": "a", "is_current": True, "tasks": [_task("t1", "water")]},
    ]}
    answers = {
        **QUIET,
        ANSWERED_TASK: _answer(task_0=0.95, nothing=0.05),
        NEXT_STEP: _answer(way_0=0.5, way_1=0.3, otherwise=0.2),
    }
    pool = Pool(answers, BRANCHING)
    asyncio.run(pool.run(NAMES, "so ein bisschen", [], context))
    assert pool.forecast.keys == ["water"]
    assert pool.forecast.next_state is None


def test_a_plan_with_no_forecast_runs_extraction_before_the_reply_as_v2_does():
    plan = _plan({"id": "a", "transitions": [{"target_state_id": "b", "condition_type": "compound"}]}, {"id": "b"})
    pool = Pool(QUIET, plan)
    verdicts = asyncio.run(pool.run(NAMES, "x", [], {"state": {"id": "a"}, "full_plan": FULL_PLAN}))
    assert "task_extraction" in [v.expert_name for v in verdicts]


def test_a_stalled_plan_runs_extraction_before_the_reply_as_v2_does():
    context = {**CONTEXT, "progress": {"turns_without_deliverable": 3}}
    pool = Pool(QUIET, LINEAR)
    verdicts = asyncio.run(pool.run(NAMES, "x", [], context))
    assert "task_extraction" in [v.expert_name for v in verdicts]


def test_an_activity_starting_this_turn_runs_extraction_before_the_plan_is_swapped():
    pool = Pool(QUIET, None)

    async def router_and_extraction(names, *args, **kwargs):
        pool.calls.append(list(names))
        return [ExpertVerdict(
            expert_name=n, verdict="x", priority=1,
            raw_output={"tool_results": [{"success": True, "data": {"command": "start"}}]} if n == "companion_router" else {},
        ) for n in names]

    pool._run_experts = router_and_extraction
    answers = {**QUIET, "activity_intent": _answer(none=0.1, transition=0.9)}
    pool._jev.answers = answers
    asyncio.run(pool.run(NAMES + ["companion_router"], "Lass uns das machen", [], {}))
    assert pool.calls == [["companion_router"], ["task_extraction"]]


def test_an_interruption_does_not_lose_the_extraction_and_the_next_turn_reports_it():
    pool = Pool({**QUIET, ANSWERED_TASK: _answer(task_0=0.95, nothing=0.05)}, LINEAR)

    async def turns():
        pool.release = asyncio.Event()
        await pool.run(NAMES, "Anna", [], CONTEXT)
        pool.start_held_extraction()
        waiting = asyncio.create_task(pool.finish_extraction())
        await asyncio.sleep(0)
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        assert pool._running is not None and not pool._running.cancelled()
        pool.release.set()
        await pool.settle_extraction()
        return await pool.finish_extraction()

    assert [v.expert_name for v in asyncio.run(turns())] == ["task_extraction"]


def _agent(monkeypatch, forecast, late, plan=LINEAR):
    order = []

    async def v2_turn(self, _input):
        yield AgentOutput.analytics_event("s", "expert_pool_start", "t", 10.0)
        yield AgentOutput.analytics_event("s", "arbitration_done", "t", 200.0)
        order.append("reply")
        async for output in self._process_post_response("s", []):
            yield output

    async def v2_post(self, _session, verdicts):
        order.append(("post", [v.expert_name for v in verdicts]))
        return
        yield

    async def settle():
        order.append("settle")

    async def finish():
        order.append("finish")
        return late

    monkeypatch.setattr(StellaV2Agent, "process", v2_turn)
    monkeypatch.setattr(StellaV2Agent, "_process_post_response", v2_post)
    agent = StellaJevAgent.__new__(StellaJevAgent)
    agent.expert_pool = SimpleNamespace(
        forecast=forecast, last_jev={"answered": True, "latency_ms": 1.0}, settle_extraction=settle,
        start_held_extraction=lambda: order.append("extraction"), finish_extraction=finish,
    )
    agent._extraction_events = []
    agent._plan_config = plan
    return agent, order


async def _stages(agent):
    return [o.metadata for o in [o async for o in agent.process(SimpleNamespace(session_id="s"))]]


def test_extraction_starts_after_arbitration_and_its_result_reaches_v2s_bookkeeping(monkeypatch):
    verdict = ExpertVerdict(expert_name="task_extraction", verdict="x", priority=1, latency_ms=1100.0,
                            raw_output={"transitioned": True, "new_state_id": "b"})
    agent, order = _agent(monkeypatch, SimpleNamespace(next_state="b", keys=["name"]), [verdict])
    events = asyncio.run(_stages(agent))
    assert order == ["settle", "extraction", "reply", "finish", ("post", ["task_extraction"])]
    done = next(e for e in events if e["stage"] == "extraction_done")
    assert done["elapsed_ms"] == 1300.0
    assert done["turn_id"] == "t"
    assert "next_step_miss" not in [e["stage"] for e in events]


@pytest.mark.parametrize("forecast,raw", [
    ("b", {}),
    (None, {"transitioned": True, "new_state_id": "b"}),
    ("more", {"transitioned": True, "new_state_id": "kind"}),
])
def test_a_wrong_forecast_is_recorded(monkeypatch, forecast, raw):
    verdict = ExpertVerdict(expert_name="task_extraction", verdict="x", priority=1, raw_output=raw)
    agent, _ = _agent(monkeypatch, SimpleNamespace(next_state=forecast, keys=[]), [verdict])
    events = asyncio.run(_stages(agent))
    miss = next(e for e in events if e["stage"] == "next_step_miss")
    assert miss["forecast"] == forecast
    assert miss["reached"] == raw.get("new_state_id")


def test_the_next_turn_does_not_ease_into_a_state_the_reply_already_opened(monkeypatch):
    agent, _ = _agent(monkeypatch, SimpleNamespace(next_state="b", keys=[]), [])
    agent._last_state_id = "a"
    context = {"state": {"id": "a"}, "full_plan": FULL_PLAN}
    resolved = asyncio.run(agent._resolve_response_context(context, "de", transitioned=False, new_state_id=None, session_completed=False))
    assert resolved["state"]["id"] == "b"
    assert agent._last_state_id == "b"


def test_the_last_state_keeps_the_context_it_has_for_the_goodbye(monkeypatch):
    agent, _ = _agent(monkeypatch, SimpleNamespace(next_state=END, keys=[]), [])
    context = {"state": {"id": "b"}, "full_plan": FULL_PLAN}
    resolved = asyncio.run(agent._resolve_response_context(context, "de", transitioned=False, new_state_id=None, session_completed=False))
    assert resolved["state"]["id"] == "b"


THREE_TASKS = [
    {"id": "a", "title": "A", "is_current": True,
     "tasks": [_task("t1", "name"), _task("t2", "mood")]},
]


def test_after_a_finished_task_the_reply_heads_for_the_next_one():
    context = {"state": {"id": "a"}, "processing_mode": "flexible", "full_plan": THREE_TASKS,
               "current_task": {"id": "t1"}, "available_tasks": [{"id": "t1"}, {"id": "t2"}]}
    moved = context_within(context, LINEAR, "t1", ["name"])
    assert moved["current_task"]["id"] == "t2"
    assert moved["current_task"]["instruction"] == "do t2"
    assert moved["current_task"]["deliverable_keys"] == ["mood"]
    assert [t["id"] for t in moved["available_tasks"]] == ["t2"]
    assert "state_just_changed" not in moved, "same phase, nothing to ease into"
    assert context["current_task"] == {"id": "t1"}, "the turn's own snapshot stays as it was"


def test_the_last_task_leaves_nothing_to_head_for():
    full_plan = [{"id": "a", "is_current": True, "tasks": [_task("t1", "name")]}]
    assert context_within({"state": {"id": "a"}, "full_plan": full_plan}, LINEAR, "t1", ["name"]) is None


def test_the_reply_context_moves_on_within_the_state(monkeypatch):
    forecast = SimpleNamespace(next_state=None, keys=["name"], done_task="t1")
    agent, _ = _agent(monkeypatch, forecast, [])
    context = {"state": {"id": "a"}, "full_plan": THREE_TASKS, "current_task": {"id": "t1"}}
    resolved = asyncio.run(agent._resolve_response_context(context, "de", transitioned=False, new_state_id=None, session_completed=False))
    assert resolved["current_task"]["id"] == "t2"


def test_a_task_with_more_values_still_open_is_not_done():
    pool = Pool({**QUIET, ANSWERED_TASK: _answer(task_0=0.95, nothing=0.05)}, LINEAR)
    context = {"state": {"id": "a"}, "full_plan": [
        {"id": "a", "is_current": True, "tasks": [_task("t1", "x", "y"), _task("t2", "z")]},
    ]}
    asyncio.run(pool.run(NAMES, "x ist eins", [], context))
    assert pool.forecast.done_task is None
    assert pool.forecast.keys == [], "it cannot say which of the two was given"


def test_a_later_task_answered_first_leaves_the_earlier_one_current():
    """In a flexible state the conversation can get ahead of the order of the plan."""
    tasks = [_task("t1", "name"), _task("t2", "mood"), _task("t3", "week")]
    context = {"state": {"id": "a"}, "processing_mode": "flexible", "current_task": {"id": "t1"},
               "full_plan": [{"id": "a", "is_current": True, "tasks": tasks}],
               "deliverables": [d for t in tasks for d in t["deliverables"]]}
    moved = context_within(context, LINEAR, "t3", ["week"])
    assert moved["current_task"]["id"] == "t1"
    assert [t["id"] for t in moved["available_tasks"]] == ["t1", "t2"]
    assert {d["key"] for d in moved["deliverables"] if d["status"] == "pending"} == {"name", "mood"}, (
        "the earlier ones stay open"
    )
    assert all(d["status"] == "pending" for d in context["deliverables"]), "extraction reads the turn's own snapshot"
    assert predict(route(LINEAR, "a"), tasks, tasks[2]) is None, "and the plan does not move past the open ones"


def test_a_thin_label_is_helped_by_the_instruction():
    task = _task("t1", "deliverable_name")
    assert "do t1" in task_question([task]).criteria["task_0"]


def test_the_prompt_treats_a_confirmed_value_as_told_and_asks_for_the_next():
    tasks = [
        {**_task("t1", "name"), "deliverables": [{"key": "name", "description": "Their name", "status": "pending"}]},
        {**_task("t2", "mood"), "deliverables": [{"key": "mood", "description": "Their mood", "status": "pending"}]},
    ]
    context = {"state": {"id": "a"}, "processing_mode": "loose", "full_plan": [{"id": "a", "is_current": True, "tasks": tasks}],
               "current_task": {"id": "t1"}, "deliverables": [d for t in tasks for d in t["deliverables"]]}
    moved = {**context_within(context, LINEAR, "t1", ["name"]), "_collected_keys": ["name"]}
    section = _state_machine_section(moved)
    assert "Their name: (they just told you this)" in section
    assert "do t2" in section and "do t1" not in section
    assert section.index("Their mood") < section.index("They have already told you")


def test_a_confirmed_value_stays_known_across_a_change_of_state():
    context = {"full_plan": FULL_PLAN, "state": {"id": "a"},
               "deliverables": [{"key": "name", "description": "Their name", "status": "pending"}]}
    after = context_after(context, LINEAR, "b", ["name"])
    assert {"key": "name", "description": "Their name", "status": "confirmed"} in after["deliverables"]
