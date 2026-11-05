"""ConnectorsClient (self.connectors) against a real in-process gRPC server.

The fake ConnectorService checks the per-pod token header and the agent id the
way the backend does, so these cover the wire contract, not just the parsing.
"""

import json

import grpc
import pytest

from stella_agent_sdk import BaseAgent, ConnectorError
from stella_agent_sdk._grpc import connectors_pb2, connectors_pb2_grpc
from stella_agent_sdk.services.connectors_client import (
    ConnectorsClient,
    parse_tool_result,
)

TOKEN = "pod-token"
AGENT = "agent-1"


def _err(code, message, retryable=False):
    return connectors_pb2.ConnectorError(code=code, message=message, retryable=retryable)


class FakeConnectorService(connectors_pb2_grpc.ConnectorServiceServicer):
    def __init__(self):
        self.calls = []

    def _authed(self, request, context):
        token = dict(context.invocation_metadata()).get("x-stella-connector-token")
        return token == TOKEN and request.agent_id == AGENT

    async def ListConnectors(self, request, context):
        if not self._authed(request, context):
            return connectors_pb2.ListConnectorsResponse(success=False, error=_err("unauthenticated", "no"))
        return connectors_pb2.ListConnectorsResponse(
            success=True,
            connectors=[
                connectors_pb2.ConnectorInfo(
                    handle="interview",
                    slot="interview",
                    name="ELIAS",
                    status="ok",
                    tools=[
                        connectors_pb2.ConnectorTool(
                            name="start_interview",
                            description="Start",
                            input_schema_json='{"type":"object"}',
                        )
                    ],
                ),
                connectors_pb2.ConnectorInfo(handle="notes", name="Notes", status="untested"),
            ],
        )

    async def ListTools(self, request, context):
        if not self._authed(request, context):
            return connectors_pb2.ListToolsResponse(success=False, error=_err("unauthenticated", "no"))
        if request.handle != "interview":
            return connectors_pb2.ListToolsResponse(success=False, error=_err("not_bound", "no such handle"))
        return connectors_pb2.ListToolsResponse(
            success=True, tools=[connectors_pb2.ConnectorTool(name="start_interview")]
        )

    async def CallTool(self, request, context):
        self.calls.append((request.handle, request.tool, json.loads(request.arguments_json or "{}")))
        if not self._authed(request, context):
            return connectors_pb2.CallToolResponse(success=False, error=_err("unauthenticated", "no"))
        if request.tool == "start_interview":
            args = json.loads(request.arguments_json)
            return connectors_pb2.CallToolResponse(
                success=True,
                structured_content_json=json.dumps({"interviewId": f"iv-{args['project']}"}),
                content_json="[]",
            )
        if request.tool == "text_only":
            return connectors_pb2.CallToolResponse(
                success=True,
                structured_content_json="null",
                content_json=json.dumps([{"type": "text", "text": '{"questions": [1, 2]}'}]),
            )
        if request.tool == "fails":
            return connectors_pb2.CallToolResponse(
                success=False,
                is_error=True,
                error=_err("tool_error", "project closed"),
                content_json=json.dumps([{"type": "text", "text": "project closed"}]),
            )
        if request.tool == "slow":
            return connectors_pb2.CallToolResponse(
                success=False, error=_err("timeout", "did not answer", retryable=True)
            )
        return connectors_pb2.CallToolResponse(success=False, error=_err("tool_not_found", "unknown tool"))


@pytest.fixture
async def server():
    srv = grpc.aio.server()
    service = FakeConnectorService()
    connectors_pb2_grpc.add_ConnectorServiceServicer_to_server(service, srv)
    port = srv.add_insecure_port("127.0.0.1:0")
    await srv.start()
    yield f"127.0.0.1:{port}", service
    await srv.stop(None)


@pytest.fixture
async def client(server):
    address, _ = server
    c = ConnectorsClient(agent_id=AGENT, token=TOKEN, address=address, timeout_s=5)
    yield c
    await c.close()


async def test_list_returns_bound_connectors_with_tools(client):
    connectors = await client.list()
    assert [c.handle for c in connectors] == ["interview", "notes"]
    interview = connectors[0]
    assert interview.slot == "interview"
    assert interview.status == "ok"
    assert interview.tools[0].name == "start_interview"
    assert interview.tools[0].input_schema == {"type": "object"}
    assert connectors[1].slot is None  # an extra connector, not a declared slot


async def test_call_tool_returns_structured_content(client, server):
    _, service = server
    result = await client.call_tool("interview", "start_interview", {"project": "p1"})
    assert result == {"interviewId": "iv-p1"}
    assert service.calls[-1] == ("interview", "start_interview", {"project": "p1"})


async def test_call_tool_parses_json_text_content(client):
    assert await client.call_tool("interview", "text_only") == {"questions": [1, 2]}


async def test_tool_error_raises_typed_not_retryable(client):
    with pytest.raises(ConnectorError) as info:
        await client.call_tool("interview", "fails", {})
    err = info.value
    assert err.code == "tool_error"
    assert err.retryable is False
    assert err.message == "project closed"
    assert err.content == [{"type": "text", "text": "project closed"}]
    assert (err.handle, err.tool) == ("interview", "fails")


async def test_timeout_is_retryable(client):
    with pytest.raises(ConnectorError) as info:
        await client.call_tool("interview", "slow", {})
    assert info.value.code == "timeout"
    assert info.value.retryable is True


async def test_list_tools_and_unbound_handle(client):
    tools = await client.list_tools("interview")
    assert [t.name for t in tools] == ["start_interview"]
    with pytest.raises(ConnectorError) as info:
        await client.list_tools("elias")
    assert info.value.code == "not_bound"


async def test_wrong_token_is_unauthenticated(server):
    address, _ = server
    c = ConnectorsClient(agent_id=AGENT, token="stolen", address=address, timeout_s=5)
    try:
        with pytest.raises(ConnectorError) as info:
            await c.call_tool("interview", "start_interview", {"project": "p"})
        assert info.value.code == "unauthenticated"
    finally:
        await c.close()


async def test_backend_down_is_retryable():
    c = ConnectorsClient(agent_id=AGENT, token=TOKEN, address="127.0.0.1:1", timeout_s=2)
    try:
        with pytest.raises(ConnectorError) as info:
            await c.list()
        assert info.value.code in ("unreachable", "timeout")
        assert info.value.retryable is True
    finally:
        await c.close()


async def test_unserialisable_args_fail_before_the_call(client, server):
    _, service = server
    with pytest.raises(ConnectorError) as info:
        await client.call_tool("interview", "start_interview", {"when": object()})
    assert info.value.code == "invalid_arguments"
    assert service.calls == []


async def test_unconfigured_client_is_inert():
    c = ConnectorsClient(agent_id=AGENT, token=None, address="127.0.0.1:1")
    assert c.configured is False
    assert await c.list() == []
    with pytest.raises(ConnectorError) as info:
        await c.call_tool("interview", "start_interview")
    assert info.value.code == "not_configured"
    assert info.value.retryable is False


def test_from_env_reads_token_and_address(monkeypatch):
    monkeypatch.setenv("STELLA_CONNECTOR_TOKEN", "t")
    monkeypatch.setenv("STATE_MACHINE_ADDRESS", "backend:50051")
    monkeypatch.delenv("CONNECTORS_ADDRESS", raising=False)
    c = ConnectorsClient.from_env("a1")
    assert c.configured
    assert c._address == "backend:50051"
    monkeypatch.setenv("CONNECTORS_ADDRESS", "override:1")
    assert ConnectorsClient.from_env("a1")._address == "override:1"


def test_parse_tool_result_shapes():
    assert parse_tool_result('{"a": 1}', "[]") == {"a": 1}
    assert parse_tool_result("null", '[{"type": "text", "text": "plain"}]') == "plain"
    image = [{"type": "image", "data": "..", "mimeType": "image/png"}]
    assert parse_tool_result("", json.dumps(image)) == image


class _Agent(BaseAgent):
    async def process(self, input):  # pragma: no cover - not exercised
        if False:
            yield None

    async def on_interrupt(self, session_id):  # pragma: no cover
        pass


async def test_base_agent_exposes_connectors_even_before_run_agent():
    agent = _Agent()
    assert await agent.connectors.list() == []
    with pytest.raises(ConnectorError):
        await agent.connectors.call_tool("interview", "start_interview")


def test_string_result_wrapped_by_the_server_is_read_as_text():
    # FastMCP wraps a tool that returns a str as {"result": "<text>"} and also
    # sends that text as content; ELIAS does this for every tool.
    text = '{"questions": [{"question": "Q1", "order": 1}]}'
    structured = json.dumps({"result": text})
    content = json.dumps([{"type": "text", "text": text}])
    assert parse_tool_result(structured, content) == {"questions": [{"question": "Q1", "order": 1}]}


def test_real_object_with_a_result_key_is_kept():
    structured = json.dumps({"result": "ok"})
    content = json.dumps([{"type": "text", "text": "done"}])
    assert parse_tool_result(structured, content) == {"result": "ok"}
