"""PlanRuntime: the state machine and its tools, wired once for every agent.

Every plan-following agent needs the same three things: a ``StateMachineClient``
for this session, the plan loaded into it, and a ``ToolRegistry`` holding the
SDK's state machine tools for the LLM. ``BaseAgent.plan_runtime`` hands out one
of these per session; nothing connects until ``start()`` is called.

    async def on_session_start(self, session_id, config):
        await super().on_session_start(session_id, config)
        if self.plan or self.session.is_companion:
            await self.plan_runtime.start(self.plan)
            self.tools = self.plan_runtime.tools      # SM tools, add your own

The tools and the client are agent policy-free: which other tools an agent adds
(companion tools, experts) stays with the agent.
"""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Any, Dict, Optional

if TYPE_CHECKING:
    from stella_agent_sdk.services.state_machine_client import StateMachineClient
    from stella_agent_sdk.tools.registry import ToolRegistry

logger = logging.getLogger(__name__)

#: Where the state machine lives when STATE_MACHINE_ADDRESS is unset. The
#: platform always sets it on agent pods; this is the in-cluster service.
DEFAULT_STATE_MACHINE_ADDRESS = "session-management-server:50051"


def state_machine_address_from_env(env: Optional[Dict[str, str]] = None) -> Optional[str]:
    """``STATE_MACHINE_ADDRESS`` if set (and not blank), else ``None``."""
    env = os.environ if env is None else env
    value = (env.get("STATE_MACHINE_ADDRESS") or "").strip()
    return value or None


class PlanRuntime:
    """One session's state machine connection, plan and state machine tools."""

    def __init__(
        self,
        session_id: str,
        address: Optional[str] = None,
        *,
        client: Optional["StateMachineClient"] = None,
    ) -> None:
        self._session_id = session_id
        explicit = address or state_machine_address_from_env()
        self._configured = bool(explicit) or client is not None
        self._address = explicit or DEFAULT_STATE_MACHINE_ADDRESS
        self._client = client
        self._connected = False
        self._tools: Optional["ToolRegistry"] = None
        self._plan: Optional[Dict[str, Any]] = None

    # ── state ────────────────────────────────────────────────────────────

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def address(self) -> str:
        return self._address

    @property
    def configured(self) -> bool:
        """Whether an address was given (argument or ``STATE_MACHINE_ADDRESS``)
        or a client injected. When False, ``address`` is only the default."""
        return self._configured

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def plan(self) -> Optional[Dict[str, Any]]:
        """The plan last loaded with ``start()``/``load()``."""
        return self._plan

    @property
    def client(self) -> "StateMachineClient":
        """The session's ``StateMachineClient`` (created on first use)."""
        if self._client is None:
            from stella_agent_sdk.services.state_machine_client import StateMachineClient

            self._client = StateMachineClient(session_id=self._session_id, address=self._address)
        return self._client

    @property
    def tools(self) -> "ToolRegistry":
        """A ``ToolRegistry`` holding the SDK's state machine tools. Agents may
        register their own tools on it."""
        if self._tools is None:
            from stella_agent_sdk.tools.registry import ToolRegistry
            from stella_agent_sdk.tools.state_machine import create_state_machine_tools

            self._tools = ToolRegistry()
            for tool in create_state_machine_tools(self.client):
                self._tools.register(tool)
        return self._tools

    # ── lifecycle ────────────────────────────────────────────────────────

    async def connect(self) -> "StateMachineClient":
        """Open the connection (idempotent)."""
        if not self._connected:
            await self.client.connect()
            self._connected = True
            logger.info("[PLAN] state machine connected at %s", self._address)
        return self.client

    async def load(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        """Initialize the state machine with ``plan``. Never raises: a failure
        comes back as ``{"success": False, "error": ...}`` and is logged."""
        await self.connect()
        try:
            result = await self.client.initialize(plan)
        except Exception as e:
            logger.error("[PLAN] could not initialize the state machine: %s", e)
            return {"success": False, "error": str(e)}
        if result and result.get("success"):
            self._plan = plan
            logger.info("[PLAN] state machine initialized: %s", plan.get("title", plan.get("id", "untitled")))
        else:
            error = result.get("error", "unknown") if result else "no response"
            logger.error("[PLAN] failed to initialize the state machine: %s", error)
        return result or {"success": False, "error": "no response"}

    async def start(self, plan: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        """Connect, load ``plan`` if there is one, and build the tools.

        Returns ``load()``'s result, or ``None`` when no plan was given (a
        companion connects first and loads an activity's plan later).
        """
        await self.connect()
        result = await self.load(plan) if plan else None
        _ = self.tools
        return result

    async def close(self) -> None:
        """Close the connection. Safe to call more than once."""
        if self._client is not None and self._connected:
            try:
                await self._client.disconnect()
            except Exception as e:
                logger.warning("[PLAN] error closing the state machine connection: %s", e)
        self._connected = False
