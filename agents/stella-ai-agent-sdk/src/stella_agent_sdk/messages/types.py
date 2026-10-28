"""Message type enumerations for the STELLA Agent SDK."""

from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Optional


class AgentState(str, Enum):
    """States an agent can be in for health monitoring."""

    UNKNOWN = "unknown"
    """State is unknown or not set."""

    INITIALIZING = "initializing"
    """Agent is starting up and not yet ready."""

    READY = "ready"
    """Agent is ready to process inputs."""

    PROCESSING = "processing"
    """Agent is actively processing a request."""

    INTERRUPTED = "interrupted"
    """Agent was interrupted (e.g., by user barge-in)."""

    ERROR = "error"
    """Agent encountered an error."""

    SHUTTING_DOWN = "shutting_down"
    """Agent is shutting down gracefully."""


class InputType(str, Enum):
    """Types of input messages the agent can receive from session-management."""

    TEXT = "text"
    """Final transcribed text from user speech or typed input."""

    INTERRUPT = "interrupt"
    """User interrupted (barge-in) - agent should stop current generation."""

    SESSION_START = "session_start"
    """New session started - agent receives configuration."""

    SESSION_END = "session_end"
    """Session ending - agent should cleanup."""

    CONFIG = "config"
    """Configuration update during session."""

    HEALTH_CHECK = "health_check"
    """Health check request from session-management."""


class BargeInDecision(str, Enum):
    """Outcome of an agent's evaluation of a user barge-in.

    When barge-in is enabled and the user interrupts mid-speech, the system
    suspends playback (reversibly), transcribes the user, and hands the final
    transcript to the agent's ``on_barge_in()`` hook. The hook returns one of
    these values to decide what happens next.
    """

    COMMIT = "commit"
    """The interruption is legitimate. Discard the rest of the current message,
    truncate it to what was actually spoken, and process the new transcript as
    a fresh turn."""

    RESUME = "resume"
    """The interruption was not worth addressing (backchannel, noise, filler).
    Resume playback from exactly where it was suspended; the new transcript is
    discarded."""


class OutputType(str, Enum):
    """Types of output messages the agent can send to session-management."""

    TEXT_CHUNK = "text_chunk"
    """Streaming text chunk - displayed immediately, buffered for TTS."""

    TEXT_FINAL = "text_final"
    """Final/complete text - triggers TTS synthesis."""

    STATUS = "status"
    """Processing status update - displayed to user, no TTS."""

    METADATA = "metadata"
    """Metadata update (plan state, deliverables) - no TTS."""

    ERROR = "error"
    """Error message - displayed to user."""

    HEALTH_STATUS = "health_status"
    """Health status response to session-management."""

    DEBUG = "debug"
    """Debug/log message - for transparency, not spoken via TTS."""

    PROGRESS_UPDATE = "progress_update"
    """Progress/task tracking update - displayed in task panel UI."""

    ANALYTICS = "analytics"
    """Analytics timing measurement — stored for aggregation, not displayed or spoken."""

    CLIENT_COMMAND = "client_command"
    """A command to the user's device (e.g. "sleep") — delivered once this turn's speech has played."""


class StatusSubtype(str, Enum):
    """Subtypes for STATUS output messages."""

    PROCESSING = "processing"
    """General processing status."""

    THINKING = "thinking"
    """Agent is thinking/reasoning."""

    AGGREGATING = "aggregating"
    """Aggregating multiple findings."""


class MetadataSubtype(str, Enum):
    """Subtypes for METADATA output messages."""

    PLAN_UPDATE = "plan_update"
    """Plan state changed (started, progress, completed)."""

    TASK_UPDATE = "task_update"
    """Individual task status changed."""

    DELIVERABLE = "deliverable"
    """Deliverable value detected/updated."""

    PROGRESS = "progress"
    """Overall progress percentage update."""

    STATE_TRANSITION = "state_transition"
    """State machine transition occurred."""


@dataclass
class ChatMessage:
    """
    A message from chat history.

    Returned by BaseAgent.get_chat_history() with the same envelope format
    as live messages for consistency.

    Attributes:
        id: Unique message identifier
        timestamp: ISO 8601 timestamp when message was recorded
        envelope: Full message envelope matching live message format
        role: Message sender role ('user', 'assistant', 'system')
        content: Extracted text content for convenience
        message_type: Type of message ('user_text', 'transcript', 'agent_text', 'debug')
    """

    id: str
    timestamp: str
    envelope: Dict[str, Any]
    role: str
    content: str
    message_type: str

    @classmethod
    def from_api_response(cls, data: Dict[str, Any]) -> "ChatMessage":
        """Create a ChatMessage from API response data."""
        return cls(
            id=data.get("id", ""),
            timestamp=data.get("timestamp", ""),
            envelope=data.get("envelope", {}),
            role=data.get("role", "system"),
            content=data.get("content", ""),
            message_type=data.get("messageType", "unknown"),
        )
