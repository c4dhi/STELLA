"""Unit tests for the state-machine tools (#291 tools-only model).

These exercise the new skip tools and batch_update's skip support against a fake
StateMachineClient, verifying the tools call the right client method and surface
results — no gRPC server needed.
"""

import pytest

from stella_agent_sdk.tools.state_machine import (
    create_state_machine_tools,
    SkipTaskTool,
    SkipStateTool,
)
from stella_agent_sdk.tools.state_machine.batch_update import BatchUpdateTool


class FakeClient:
    """Records calls and returns canned successful responses."""

    def __init__(self, pending=None):
        self.calls = []
        self._pending = pending if pending is not None else [
            {"id": "task-1", "description": "Task One"},
            {"id": "task-2", "description": "Task Two"},
        ]

    async def get_pending_tasks(self):
        return self._pending

    async def complete_task(self, task_id, reasoning=""):
        self.calls.append(("complete_task", task_id, reasoning))
        return {"success": True, "task_completed": task_id, "transitioned": False}

    async def skip_task(self, task_id, reasoning=""):
        self.calls.append(("skip_task", task_id, reasoning))
        return {"success": True, "task_skipped": task_id, "transitioned": False}

    async def skip_state(self, state_id="", reasoning=""):
        self.calls.append(("skip_state", state_id, reasoning))
        return {
            "success": True,
            "state_skipped": "state-x",
            "tasks_skipped": ["task-1", "task-2"],
            "transitioned": True,
            "new_state_id": "state-y",
        }

    async def set_deliverable(
        self, key, value, reasoning="", unconfirmed=False, correction=False
    ):
        self.calls.append(("set_deliverable", key, value, reasoning, unconfirmed))
        if correction:
            self.calls.append(("correction", key))
        return {"success": True, "transitioned": False, "task_completed": None}


def test_toolbox_exposes_skip_tools():
    names = [t.name for t in create_state_machine_tools(FakeClient())]
    assert "skip_task" in names
    assert "skip_state" in names
    # No state mutation tool is missing the new explicit-skip surface.
    assert names.count("skip_task") == 1


@pytest.mark.asyncio
async def test_skip_task_tool_calls_client():
    client = FakeClient()
    tool = SkipTaskTool(client)
    result = await tool.execute(task_id="task-1", reasoning="not needed")
    assert result.success is True
    assert result.data["task_skipped"] == "task-1"
    assert ("skip_task", "task-1", "not needed") in client.calls


@pytest.mark.asyncio
async def test_skip_task_tool_resolves_description_to_id():
    client = FakeClient()
    tool = SkipTaskTool(client)
    # Pass a description instead of an ID — it resolves to the unique match.
    result = await tool.execute(task_id="Task Two", reasoning="x")
    assert result.success is True
    assert ("skip_task", "task-2", "x") in client.calls


@pytest.mark.asyncio
async def test_skip_task_tool_rejects_unknown_id():
    client = FakeClient()
    tool = SkipTaskTool(client)
    result = await tool.execute(task_id="does-not-exist", reasoning="x")
    assert result.success is False
    assert not any(c[0] == "skip_task" for c in client.calls)


@pytest.mark.asyncio
async def test_skip_state_tool_calls_client_for_current_state():
    client = FakeClient()
    tool = SkipStateTool(client)
    result = await tool.execute(reasoning="phase irrelevant")
    assert result.success is True
    assert result.data["tasks_skipped"] == ["task-1", "task-2"]
    assert result.data["transitioned"] is True
    # Always targets the current state (empty state_id).
    assert ("skip_state", "", "phase irrelevant") in client.calls


@pytest.mark.asyncio
async def test_batch_update_completes_and_skips_explicitly():
    client = FakeClient()
    tool = BatchUpdateTool(client)
    result = await tool.execute(
        deliverables=[{"key": "k", "value": "v", "reasoning": "r"}],
        tasks=[{"task_id": "task-1", "reasoning": "done"}],
        skip_tasks=[{"task_id": "task-2", "reasoning": "skip"}],
    )
    assert result.success is True
    assert result.data["tasks_completed"][0]["task_id"] == "task-1"
    assert result.data["tasks_skipped"][0]["task_id"] == "task-2"
    # Verify the tool drove explicit complete + skip via the client.
    assert ("complete_task", "task-1", "done") in client.calls
    assert ("skip_task", "task-2", "skip") in client.calls


# ---------------------------------------------------------------------------
# `unconfirmed` reaches the wire (mentioned-but-not-confirmed deliverables).
# ---------------------------------------------------------------------------

def test_set_deliverable_request_carries_unconfirmed():
    from stella_agent_sdk._grpc import state_machine_pb2 as pb
    req = pb.SetDeliverableRequest(
        session_id="s", key="walks", value='"most days"',
        reasoning="mentioned in passing", unconfirmed=True,
    )
    assert req.unconfirmed is True


def test_unconfirmed_defaults_to_false_on_the_wire():
    # Existing callers, and every deliverable recorded before this existed,
    # must keep meaning "settled".
    from stella_agent_sdk._grpc import state_machine_pb2 as pb
    assert pb.SetDeliverableRequest(session_id="s", key="k", value="1").unconfirmed is False


def test_batch_update_schema_exposes_unconfirmed():
    # batch_update is the tool the extraction expert actually calls, so the flag
    # is inert unless it is offered here.
    from stella_agent_sdk.tools.state_machine.batch_update import BatchUpdateTool
    schema = BatchUpdateTool(client=None).parameters_schema
    props = schema["properties"]["deliverables"]["items"]["properties"]
    assert "unconfirmed" in props
    assert props["unconfirmed"]["type"] == "boolean"


def test_set_deliverable_schema_exposes_unconfirmed():
    from stella_agent_sdk.tools.state_machine.set_deliverable import SetDeliverableTool
    props = SetDeliverableTool(client=None).parameters_schema["properties"]
    assert "unconfirmed" in props


# `correction` reaches the wire and the tools (protected required deliverables, #406).

def test_set_deliverable_request_carries_correction():
    from stella_agent_sdk._grpc import state_machine_pb2 as pb

    req = pb.SetDeliverableRequest(
        session_id="s", key="k", value="1", reasoning="they said actually 2", correction=True,
    )
    assert req.correction is True


def test_correction_defaults_to_false_on_the_wire():
    from stella_agent_sdk._grpc import state_machine_pb2 as pb

    assert pb.SetDeliverableRequest(session_id="s", key="k", value="1").correction is False


def test_set_deliverable_and_batch_schemas_expose_correction():
    tools = {t.name: t for t in create_state_machine_tools(FakeClient())}
    assert "correction" in tools["set_deliverable"].parameters_schema["properties"]
    item = tools["batch_update"].parameters_schema["properties"]["deliverables"]["items"]
    assert "correction" in item["properties"]
    # Optional: a first answer never has to mention it.
    assert "correction" not in item["required"]


@pytest.mark.asyncio
async def test_set_deliverable_tool_forwards_correction():
    client = FakeClient()
    tool = {t.name: t for t in create_state_machine_tools(client)}["set_deliverable"]
    result = await tool.execute("user_name", "Sarah", "they said actually Sarah", correction=True)
    assert result.success
    assert ("correction", "user_name") in client.calls


@pytest.mark.asyncio
async def test_batch_update_forwards_correction_per_deliverable():
    client = FakeClient()
    tool = {t.name: t for t in create_state_machine_tools(client)}["batch_update"]
    await tool.execute(
        deliverables=[
            {"key": "a", "value": "1", "reasoning": "first"},
            {"key": "b", "value": "2", "reasoning": "they corrected", "correction": True},
        ],
        tasks=[],
    )
    assert ("correction", "b") in client.calls
    assert ("correction", "a") not in client.calls
