"""Client for communicating with the session-management-server's AgentService gRPC."""

import logging
from typing import Dict, Optional

import grpc

from stella_agent_sdk._grpc import agent_pb2, agent_pb2_grpc
from stella_agent_sdk._version import SDK_VERSION

logger = logging.getLogger(__name__)


class AgentServerClient:
    """
    gRPC client for registering with the session-management-server.

    This client is used to notify the backend that the agent is ready
    to process requests after completing initialization.
    """

    def __init__(self, address: str):
        """
        Initialize the client.

        Args:
            address: gRPC server address (e.g., "session-management-server:50051")
        """
        self._address = address
        self._channel: Optional[grpc.aio.Channel] = None
        self._stub: Optional[agent_pb2_grpc.AgentServiceStub] = None

    async def connect(self) -> None:
        """Connect to the gRPC server."""
        logger.info(f"Connecting to agent server at {self._address}")
        self._channel = grpc.aio.insecure_channel(self._address)
        self._stub = agent_pb2_grpc.AgentServiceStub(self._channel)
        logger.info("Agent server client connected")

    async def disconnect(self) -> None:
        """Disconnect from the gRPC server."""
        if self._channel:
            await self._channel.close()
            self._channel = None
            self._stub = None
            logger.info("Agent server client disconnected")

    async def register_agent(
        self,
        agent_type: str,
        agent_version: str,
        capabilities: Optional[Dict[str, str]] = None,
        sdk_version: Optional[str] = None,
    ) -> Dict[str, any]:
        """
        Register the agent with the session-management-server.

        This call notifies the backend that the agent is ready to process requests.
        The backend will update the agent status to RUNNING.

        Args:
            agent_type: Agent type identifier (e.g., "stella-light-agent")
            agent_version: Agent version string
            capabilities: Optional dictionary of agent capabilities
            sdk_version: stella-ai-agent-sdk version the agent runs (defaults to
                the installed one). STELLA refuses SDKs older than it supports.

        Returns:
            Dictionary with:
                - success: Whether registration succeeded
                - session_id: The assigned session ID
                - message: Error message if failed
                - config: Session configuration
        """
        if not self._stub:
            raise RuntimeError("Client not connected. Call connect() first.")

        logger.info(f"Creating RegisterAgentRequest with agent_type='{agent_type}', agent_version='{agent_version}'")
        request = agent_pb2.RegisterAgentRequest(
            agent_type=agent_type,
            agent_version=agent_version,
            capabilities=capabilities or {},
            sdk_version=sdk_version or SDK_VERSION,
        )
        logger.info(f"Request created: {request}")

        try:
            response = await self._stub.RegisterAgent(request)

            result = {
                "success": response.success,
                "session_id": response.session_id,
                "message": response.message,
                "config": dict(response.config) if response.config else {},
            }

            if response.success:
                logger.info(f"Agent registered successfully for session {response.session_id}")
            else:
                logger.warning(f"Agent registration failed: {response.message}")

            return result

        except grpc.aio.AioRpcError as e:
            logger.error(f"gRPC error during registration: {e.code()} - {e.details()}")
            return {
                "success": False,
                "session_id": "",
                "message": f"gRPC error: {e.details()}",
                "config": {},
            }
