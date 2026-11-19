"""StateMachineClient: what the agent can do, from GetCapabilities and GetFullState (#992)."""

import asyncio

from stella_agent_sdk._grpc import state_machine_pb2 as pb
from stella_agent_sdk.services.state_machine_client import StateMachineClient


def _caps(mode="companion"):
    return pb.SessionCapabilities(
        mode=mode,
        capabilities=[
            pb.Capability(id="activity.quiz", kind="activity", title="Memory quiz", description="Ten questions"),
            pb.Capability(id="go_to_sleep", kind="action", title="Go to sleep", description="Say goodbye"),
        ],
    )


EXPECTED = {
    "mode": "companion",
    "capabilities": [
        {"id": "activity.quiz", "kind": "activity", "title": "Memory quiz", "description": "Ten questions"},
        {"id": "go_to_sleep", "kind": "action", "title": "Go to sleep", "description": "Say goodbye"},
    ],
}


class FakeStub:
    def __init__(self, full_state):
        self.full_state = full_state
        self.requests = []

    async def GetCapabilities(self, request):
        self.requests.append(request)
        return pb.GetCapabilitiesResponse(success=True, capabilities=_caps())

    async def GetFullState(self, request):
        self.requests.append(request)
        return self.full_state


def _client(stub):
    client = StateMachineClient(session_id="s1", address="unused", agent_id="a1")
    client._stub = stub
    return client


def test_get_capabilities_sends_the_agent_and_returns_a_plain_dict():
    stub = FakeStub(None)
    client = _client(stub)

    result = asyncio.run(client.get_capabilities())

    assert result == EXPECTED
    assert client.capabilities == EXPECTED
    assert (stub.requests[0].session_id, stub.requests[0].agent_id) == ("s1", "a1")


def test_full_state_brings_capabilities_even_without_a_plan():
    # A companion between activities: no plan row, so success is false, yet it
    # still has a list of what it can do.
    stub = FakeStub(pb.GetFullStateResponse(success=False, error="not initialized", capabilities=_caps()))
    client = _client(stub)

    assert asyncio.run(client.get_full_state(include_capabilities=True)) is None
    assert client.capabilities == EXPECTED
    assert stub.requests[0].include_capabilities is True


def test_full_state_adds_capabilities_to_the_dict_when_asked():
    stub = FakeStub(pb.GetFullStateResponse(success=True, plan_id="p", current_state_id="s", capabilities=_caps()))
    client = _client(stub)

    state = asyncio.run(client.get_full_state(include_capabilities=True))

    assert state["capabilities"] == EXPECTED


def test_full_state_without_the_flag_is_unchanged():
    stub = FakeStub(pb.GetFullStateResponse(success=True, plan_id="p", current_state_id="s"))
    client = _client(stub)

    state = asyncio.run(client.get_full_state())

    assert "capabilities" not in state
    assert client.capabilities is None
    assert stub.requests[0].include_capabilities is False
