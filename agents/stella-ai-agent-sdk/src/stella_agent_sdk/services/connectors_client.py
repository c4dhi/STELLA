"""Connectors: outside MCP servers an agent may call through STELLA.

The user stores their connectors (URL + credential) in STELLA's Settings and
binds them to a deployment. The backend is the MCP client: it holds and
decrypts the credential, so the token never reaches this pod. The agent calls
by *handle* (the agent.yaml slot name, or the handle of an extra connector the
user offered) over the backend's gRPC ConnectorService::

    for c in await self.connectors.list():
        print(c.handle, [t.name for t in c.tools])

    guide = await self.connectors.call_tool(
        "interview", "get_interview_guide", {"project_id": "p1"}
    )

Failures raise :class:`ConnectorError`, whose ``retryable`` says whether the
same call may succeed later.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import grpc

from stella_agent_sdk._grpc import connectors_pb2, connectors_pb2_grpc

logger = logging.getLogger(__name__)

TOKEN_ENV = "STELLA_CONNECTOR_TOKEN"
TOKEN_METADATA = "x-stella-connector-token"
DEFAULT_TIMEOUT_S = 75.0  # above the backend's 60 s tools/call timeout


class ConnectorError(Exception):
    """A connector call that did not produce a result.

    Attributes:
        code: what went wrong. One of ``not_configured`` (no connectors on this
            deployment), ``unauthenticated``, ``not_bound`` (no such handle),
            ``unreachable``, ``unauthorized`` (the server refused the stored
            credential), ``timeout``, ``protocol``, ``redirect``,
            ``blocked_host``, ``tool_not_found``, ``invalid_arguments``,
            ``tool_error`` (the tool ran and reported failure) or ``internal``.
        retryable: whether the same call may succeed if tried again later.
        handle / tool: what was being called, when known.
        content: for ``tool_error``, the MCP content blocks the tool returned.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        handle: Optional[str] = None,
        tool: Optional[str] = None,
        content: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retryable = retryable
        self.handle = handle
        self.tool = tool
        self.content = content or []

    def __str__(self) -> str:
        where = f"{self.handle}.{self.tool}" if self.handle and self.tool else (self.handle or "")
        prefix = f"[{self.code}{' ' + where if where else ''}]"
        return f"{prefix} {self.message}"


@dataclass(frozen=True)
class ConnectorTool:
    """One tool a connector offers (from MCP tools/list)."""

    name: str
    description: str = ""
    input_schema: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ConnectorInfo:
    """A connector bound to this deployment."""

    handle: str
    name: str
    slot: Optional[str] = None  # the agent.yaml slot it fills; None for an extra
    status: str = "untested"  # from the user's last check in Settings
    tools: List[ConnectorTool] = field(default_factory=list)


def _tool(proto: Any) -> ConnectorTool:
    try:
        schema = json.loads(proto.input_schema_json) if proto.input_schema_json else {}
    except ValueError:
        schema = {}
    return ConnectorTool(name=proto.name, description=proto.description, input_schema=schema)


def parse_tool_result(structured_json: str, content_json: str) -> Any:
    """What ``call_tool`` returns: structuredContent when the server sent it;
    otherwise the text content, parsed as JSON when it is JSON. Non-text content
    (images, resources) comes back as the raw list of content blocks."""
    content = json.loads(content_json) if content_json else []
    texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
    text = "\n".join(texts) if texts and len(texts) == len(content) else None
    if structured_json and structured_json != "null":
        structured = json.loads(structured_json)
        # A tool that returns a string gets wrapped by its server (FastMCP and
        # others) as {"result": "<the same text>"}. That wrapper is not the tool's
        # data, so read it like unstructured text. A real object is left alone.
        if not (text is not None and structured == {"result": text}):
            return structured
    if text is not None:
        try:
            return json.loads(text)
        except ValueError:
            return text
    return content


class ConnectorsClient:
    """``self.connectors`` on a :class:`BaseAgent`.

    Created by ``run_agent`` from ``AGENT_ID``, ``STELLA_CONNECTOR_TOKEN`` and
    ``STATE_MACHINE_ADDRESS`` (the backend's gRPC port; override with
    ``CONNECTORS_ADDRESS``). On a deployment without connectors, ``list()``
    returns ``[]`` and calls raise ``ConnectorError("not_configured")``.
    """

    def __init__(
        self,
        agent_id: str,
        token: Optional[str],
        address: Optional[str],
        *,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        stub: Any = None,
    ) -> None:
        self._agent_id = agent_id
        self._token = token or ""
        self._address = address or ""
        self._timeout_s = timeout_s
        self._channel: Optional[grpc.aio.Channel] = None
        self._stub = stub

    @classmethod
    def from_env(cls, agent_id: str) -> "ConnectorsClient":
        address = (
            os.environ.get("CONNECTORS_ADDRESS")
            or os.environ.get("STATE_MACHINE_ADDRESS")
            or os.environ.get("GRPC_SERVER")
        )
        return cls(agent_id=agent_id, token=os.environ.get(TOKEN_ENV), address=address)

    @property
    def configured(self) -> bool:
        """Whether this deployment has connectors at all."""
        return bool(self._token and self._agent_id and (self._address or self._stub))

    async def close(self) -> None:
        if self._channel is not None:
            await self._channel.close()
            self._channel = None
            self._stub = None

    async def list(self) -> List[ConnectorInfo]:
        """The connectors bound to this deployment, with their last known tools."""
        if not self.configured:
            return []
        res = await self._rpc("ListConnectors", connectors_pb2.ListConnectorsRequest(agent_id=self._agent_id))
        self._raise_for(res)
        return [
            ConnectorInfo(
                handle=c.handle,
                name=c.name,
                slot=c.slot or None,
                status=c.status or "untested",
                tools=[_tool(t) for t in c.tools],
            )
            for c in res.connectors
        ]

    async def list_tools(self, handle: str) -> List[ConnectorTool]:
        """Ask the connector for its current tools (MCP tools/list)."""
        self._require_configured(handle)
        res = await self._rpc(
            "ListTools",
            connectors_pb2.ListToolsRequest(agent_id=self._agent_id, handle=handle),
            handle=handle,
        )
        self._raise_for(res, handle=handle)
        return [_tool(t) for t in res.tools]

    async def call_tool(self, handle: str, tool: str, args: Optional[Dict[str, Any]] = None) -> Any:
        """Call ``tool`` on the connector bound as ``handle`` and return its result.

        Returns the tool's structuredContent when the server sends it, otherwise
        its text content (parsed as JSON when possible). Raises
        :class:`ConnectorError`; ``code == "tool_error"`` means the tool ran and
        reported a failure, with the tool's message as the error message.
        """
        self._require_configured(handle, tool)
        try:
            arguments_json = json.dumps(args or {})
        except (TypeError, ValueError) as e:
            raise ConnectorError(
                "invalid_arguments", f"arguments are not JSON-serialisable: {e}", handle=handle, tool=tool
            ) from e
        res = await self._rpc(
            "CallTool",
            connectors_pb2.CallToolRequest(
                agent_id=self._agent_id, handle=handle, tool=tool, arguments_json=arguments_json
            ),
            handle=handle,
            tool=tool,
        )
        if not res.success:
            content: List[Dict[str, Any]] = []
            if res.is_error and res.content_json:
                try:
                    content = json.loads(res.content_json)
                except ValueError:
                    content = []
            self._raise_for(res, handle=handle, tool=tool, content=content)
        return parse_tool_result(res.structured_content_json, res.content_json)

    # -- internals ---------------------------------------------------------

    def _require_configured(self, handle: str, tool: Optional[str] = None) -> None:
        if not self.configured:
            raise ConnectorError(
                "not_configured",
                "No connectors are bound to this deployment",
                handle=handle,
                tool=tool,
            )

    def _ensure_stub(self) -> Any:
        if self._stub is None:
            self._channel = grpc.aio.insecure_channel(self._address)
            self._stub = connectors_pb2_grpc.ConnectorServiceStub(self._channel)
        return self._stub

    async def _rpc(self, method: str, request: Any, *, handle: Optional[str] = None, tool: Optional[str] = None) -> Any:
        stub = self._ensure_stub()
        try:
            return await getattr(stub, method)(
                request,
                metadata=((TOKEN_METADATA, self._token),),
                timeout=self._timeout_s,
            )
        except grpc.aio.AioRpcError as e:
            code = e.code()
            retryable = code in (
                grpc.StatusCode.UNAVAILABLE,
                grpc.StatusCode.DEADLINE_EXCEEDED,
                grpc.StatusCode.RESOURCE_EXHAUSTED,
            )
            kind = "timeout" if code == grpc.StatusCode.DEADLINE_EXCEEDED else ("unreachable" if retryable else "internal")
            logger.warning("Connector %s failed: %s %s", method, code, e.details())
            raise ConnectorError(
                kind,
                f"STELLA connector service: {e.details() or code.name}",
                retryable=retryable,
                handle=handle,
                tool=tool,
            ) from e

    @staticmethod
    def _raise_for(
        res: Any,
        *,
        handle: Optional[str] = None,
        tool: Optional[str] = None,
        content: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if res.success:
            return
        err = res.error
        code = err.code or "internal"
        raise ConnectorError(
            code,
            err.message or "Connector call failed",
            retryable=bool(err.retryable),
            handle=handle,
            tool=tool,
            content=content,
        )
