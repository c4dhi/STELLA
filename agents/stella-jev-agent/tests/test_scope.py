"""Extraction saves only the task Jev picked, and a picked correction overwrites."""

import asyncio
from types import SimpleNamespace

from stella_agent_sdk.tools.state_machine import create_state_machine_tools

from stella_jev_agent.next_step import NOTHING, collected_tasks, read_pick, task_question
from stella_jev_agent.scope import Scope, scoped

WATER = {"id": "t1", "description": "Wasser trinken", "status": "pending", "deliverables": [
    {"key": "water", "description": "Wie viel", "acceptance_criteria": "Menge oder Einschätzung", "status": "pending"},
]}
WALK = {"id": "t2", "description": "Spaziergänge", "status": "pending", "deliverables": [
    {"key": "walk", "description": "Wie oft", "status": "pending"},
]}
NAME = {"id": "t0", "description": "Vorstellung", "status": "completed", "deliverables": [
    {"key": "name", "description": "Name", "status": "completed", "value": "Felix"},
]}


class Machine:
    def __init__(self):
        self.writes = []

    async def set_deliverable(self, key, value, reasoning="", unconfirmed=False, correction=False):
        self.writes.append(("set", key, correction))
        return {"success": True}

    async def complete_task(self, task_id, reasoning=""):
        self.writes.append(("complete", task_id, False))
        return {"success": True}

    async def skip_task(self, task_id, reasoning=""):
        self.writes.append(("skip", task_id, False))
        return {"success": True}

    async def skip_state(self, reasoning=""):
        self.writes.append(("skip_state", None, False))
        return {"success": True}

    async def get_pending_tasks(self):
        return [{"id": "t1", "description": "Wasser trinken"}, {"id": "t2", "description": "Spaziergänge"}]


def _tools(scope):
    machine = Machine()
    return machine, {t.name: t for t in scoped(create_state_machine_tools(machine), scope)}


def _answer(**p):
    choice = max(p, key=p.get)
    return SimpleNamespace(choice=choice, probabilities=p)


def test_a_batch_keeps_only_the_picked_task():
    scope = Scope.of({"task": WATER, "correction": False})
    machine, tools = _tools(scope)
    result = asyncio.run(tools["batch_update"].execute(
        deliverables=[{"key": "water", "value": "1.5 l", "reasoning": ""}, {"key": "walk", "value": "nie", "reasoning": ""}],
        tasks=[{"task_id": "t1", "reasoning": ""}, {"task_id": "t2", "reasoning": ""}],
    ))
    assert machine.writes == [("set", "water", False), ("complete", "t1", False)]
    assert scope.written == ["water", "t1"] and scope.refused == ["walk", "t2"]
    assert result.data["refused"]["items"] == ["walk", "t2"]


def test_a_picked_correction_is_saved_as_one_and_completes_nothing():
    scope = Scope.of({"task": NAME, "correction": True})
    machine, tools = _tools(scope)
    asyncio.run(tools["batch_update"].execute(
        deliverables=[{"key": "name", "value": "Fritz", "reasoning": ""}], tasks=[{"task_id": "t0", "reasoning": ""}],
    ))
    assert machine.writes == [("set", "name", True)]


def test_single_writes_outside_the_pick_are_refused():
    scope = Scope.of({"task": WATER, "correction": False})
    machine, tools = _tools(scope)
    assert not asyncio.run(tools["set_deliverable"].execute(key="walk", value="x", reasoning="")).success
    assert not asyncio.run(tools["skip_task"].execute(task_id="t2", reasoning="")).success
    assert not asyncio.run(tools["skip_state"].execute(reasoning="")).success
    assert asyncio.run(tools["complete_task"].execute(task_id="Wasser trinken", reasoning="")).success
    assert machine.writes == [("complete", "t1", False)]


def test_jev_reads_the_acceptance_criteria_and_can_pick_a_correction():
    context = {"collected_deliverables": {}, "full_plan": [{"is_current": True, "tasks": [NAME, WATER, WALK]}]}
    fixes = collected_tasks(context)
    question = task_question([WATER, WALK], fixes, {})
    assert "Menge oder Einschätzung" in question.criteria["task_0"]
    assert "Vorstellung" in question.criteria["fix_0"] and "Felix" in question.criteria["fix_0"]
    pick = read_pick(_answer(task_0=0.1, task_1=0.05, fix_0=0.8, nothing=0.05), [WATER, WALK], fixes, 0.7)
    assert pick["task_id"] == "t0" and pick["correction"] is True


def test_nothing_or_an_unsure_pick_is_no_pick():
    assert read_pick(_answer(task_0=0.2, nothing=0.8), [WATER], [], 0.7) is None
    assert read_pick(_answer(task_0=0.6, nothing=0.4), [WATER], [], 0.7) is None
    assert NOTHING in task_question([WATER]).criteria


def test_a_mention_is_saved_unconfirmed_and_a_correction_as_one():
    scope = Scope.of([
        {"task": WATER, "correction": False},
        {"task": WALK, "correction": False, "also": True},
        {"task": NAME, "correction": True, "also": True},
    ])
    machine, tools = _tools(scope)
    items = [{"key": k, "value": "x", "reasoning": ""} for k in ("water", "walk", "name")]
    asyncio.run(tools["batch_update"].execute(deliverables=items, tasks=[]))
    assert [i.get("unconfirmed", False) for i in items] == [False, True, False]
    assert machine.writes == [("set", "water", False), ("set", "walk", False), ("set", "name", True)]


def test_the_reply_is_told_about_mentions_and_corrections():
    from stella_jev_agent.stages import also_instruction
    text = also_instruction(SimpleNamespace(mentioned=["Wetter"], corrected=["Letzte Woche"]))
    assert "don't ask about it again" in text and "Acknowledge the correction" in text
    assert also_instruction(SimpleNamespace(mentioned=[], corrected=[])) == ""


def test_a_picked_task_left_unsaved_is_named():
    scope = Scope.of([{"task": WATER, "correction": False}, {"task": NAME, "correction": True, "also": True}])
    machine, tools = _tools(scope)
    asyncio.run(tools["batch_update"].execute(deliverables=[{"key": "water", "value": "2 l", "reasoning": ""}], tasks=[]))
    assert scope.unsaved() == ["Vorstellung"]


def test_a_refused_write_is_logged_even_when_the_pick_was_saved():
    from stella_jev_agent.agent import StellaJevAgent
    scope = Scope.of({"task": WATER, "correction": False})
    machine, tools = _tools(scope)
    asyncio.run(tools["batch_update"].execute(
        deliverables=[{"key": "water", "value": "2 l", "reasoning": ""}, {"key": "walk", "value": "nie", "reasoning": ""}],
        tasks=[],
    ))
    agent = StellaJevAgent.__new__(StellaJevAgent)
    agent.expert_pool = SimpleNamespace(last_scope=scope)
    agent._extraction_events = []
    agent._elapsed_ms = lambda: 0.0
    output = agent._extraction_followed("s")
    assert "refused walk" in output.content
    assert [(name, data["tasks"], data["refused"]) for name, data in agent._extraction_events] == [
        ("extraction_declined_pick", [], ["walk"]),
    ]
