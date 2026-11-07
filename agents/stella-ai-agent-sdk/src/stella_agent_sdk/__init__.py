"""
STELLA Agent SDK

A communication SDK for building voice agents that integrate with the STELLA platform.
Agents connect directly to LiveKit rooms and communicate with external STT/TTS services.

Architecture:
    ┌─────────────────────────────────────────────────────────────┐
    │                    LiveKit Room                              │
    │  ┌──────────┐                        ┌──────────────────┐   │
    │  │  User    │ ◄─── audio/data ─────► │  Agent (SDK)     │   │
    │  └──────────┘                        └────────┬─────────┘   │
    └────────────────────────────────────────────────┼────────────┘
                                                     │ gRPC
                          ┌──────────────────────────┼──────────┐
                          │   Kubernetes Cluster     │          │
                          │  ┌───────────┐    ┌──────▼──────┐   │
                          │  │ STT Svc   │    │  TTS Svc    │   │
                          │  └───────────┘    └─────────────┘   │
                          └─────────────────────────────────────┘

Example Usage:
    ```python
    import asyncio
    from stella_agent_sdk import BaseAgent, run_agent_from_env

    class MyAgent(BaseAgent):
        async def on_session_start(self, session_id, config):
            # Register barge-in handler
            self.audio.on_speech_started(self._handle_barge_in)

        async def run_audio_loop(self):
            async for event in self.audio.audio_in():
                # event.is_final is always True (partials sent to LiveKit)
                await self.audio.audio_out(f"You said: {event.text}")

        async def _handle_barge_in(self):
            await self.audio.stop_speaking()

        async def process(self, input):
            yield AgentOutput.text_final(input.session_id, "Hello!")

        async def on_interrupt(self, session_id):
            await self.audio.stop_speaking()

    if __name__ == "__main__":
        asyncio.run(run_agent_from_env(MyAgent()))
    ```

Environment Variables (set by session-management-server):
    LIVEKIT_URL: LiveKit server URL
    ROOM_NAME: Room to join
    AGENT_IDENTITY: Agent participant identity
    LIVEKIT_API_KEY: API key for JWT
    LIVEKIT_API_SECRET: API secret for JWT
    STT_SERVICE_ADDRESS: External STT service address (gRPC)
    TTS_SERVICE_ADDRESS: External TTS service address (gRPC)
"""

from stella_agent_sdk._version import SDK_VERSION
from stella_agent_sdk.messages.types import (
    InputType,
    OutputType,
    StatusSubtype,
    MetadataSubtype,
    AgentState,
    BargeInDecision,
    ChatMessage,
)
from stella_agent_sdk.messages.input import AgentInput
from stella_agent_sdk.messages.output import AgentOutput
from stella_agent_sdk.agent.base import BaseAgent
from stella_agent_sdk.run import run_agent_from_env
from stella_agent_sdk.services.history_client import HistoryClient, HistoryClientError
from stella_agent_sdk.services.connectors_client import (
    ConnectorError,
    ConnectorInfo,
    ConnectorsClient,
    ConnectorTool,
)
from stella_agent_sdk.session_config import (
    ActivityConfig,
    PersonaConfig,
    SessionConfig,
)
from stella_agent_sdk.participants import (
    NON_HUMAN_PREFIXES,
    SESSION_PARTICIPANT_PREFIX,
    is_human_participant,
    is_session_participant,
)
from stella_agent_sdk.plan.runtime import PlanRuntime
from stella_agent_sdk.platform_env import PLATFORM_ENV, PlatformEnvVar
from stella_agent_sdk.progress import (
    ExecutionMode,
    ItemStatus,
    GroupStatus,
    ProgressItem,
    ProgressGroup,
    ProgressState,
)
from stella_agent_sdk.plan import (
    # Enums
    StateType,
    DeliverableType,
    # Plan structure types
    Plan,
    PlanState,
    PlanTask,
    PlanDeliverable,
    StateTransition,
    # Session context types
    SessionContext,
    SessionContextField,
    # Migration utilities
    normalize_plan,
)
from stella_agent_sdk.tools import (
    BaseTool,
    ToolResult,
    ToolCall,
    ToolRegistry,
    ToolExecutor,
)

__version__ = SDK_VERSION

__all__ = [
    "__version__",
    # Session config (AGENT_CONFIG, typed)
    "SessionConfig",
    "PersonaConfig",
    "ActivityConfig",
    # Participants
    "NON_HUMAN_PREFIXES",
    "is_human_participant",
    "SESSION_PARTICIPANT_PREFIX",
    "is_session_participant",
    # Plan runtime (state machine + its tools)
    "PlanRuntime",
    # SDK-owned environment variables
    "PLATFORM_ENV",
    "PlatformEnvVar",
    # Connectors (outside MCP servers via the backend)
    "ConnectorError",
    "ConnectorInfo",
    "ConnectorsClient",
    "ConnectorTool",
    # Message types
    "InputType",
    "OutputType",
    "StatusSubtype",
    "MetadataSubtype",
    "AgentState",
    "BargeInDecision",
    "AgentInput",
    "AgentOutput",
    "ChatMessage",
    # Progress tracking types
    "ExecutionMode",
    "ItemStatus",
    "GroupStatus",
    "ProgressItem",
    "ProgressGroup",
    "ProgressState",
    # Plan types (canonical definitions)
    "StateType",
    "DeliverableType",
    "Plan",
    "PlanState",
    "PlanTask",
    "PlanDeliverable",
    "StateTransition",
    "SessionContext",
    "SessionContextField",
    "normalize_plan",
    # Agent interface
    "BaseAgent",
    # Entry point (config from environment)
    "run_agent_from_env",
    # History client (for advanced use cases)
    "HistoryClient",
    "HistoryClientError",
    # Tool infrastructure
    "BaseTool",
    "ToolResult",
    "ToolCall",
    "ToolRegistry",
    "ToolExecutor",
]
