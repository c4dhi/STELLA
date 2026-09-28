"""AgentOutput dataclass for messages from agent to session-management."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, Optional
import uuid

from stella_agent_sdk.messages.types import OutputType, StatusSubtype, MetadataSubtype, AgentState


@dataclass
class AgentOutput:
    """
    Output message from the agent to session-management.

    This is what your agent sends back. Session-management will:
    - TEXT_CHUNK: Stream to frontend display + buffer for TTS
    - TEXT_FINAL: Final text, trigger TTS synthesis
    - STATUS: Display processing status to user (no TTS)
    - METADATA: Update plan/deliverable state (no TTS)
    - ERROR: Display error to user

    Attributes:
        session_id: The session this output belongs to.
        type: The type of output (TEXT_CHUNK, TEXT_FINAL, STATUS, etc.).
        content: The text content (response text, status message, or JSON).
        is_final: For TEXT_CHUNK, whether this is the last chunk in the stream.
        transcript_id: Groups streaming chunks into one logical message.
        status_subtype: For STATUS type, the specific status category.
        metadata_subtype: For METADATA type, the specific metadata category.
        metadata: Additional data (progress percentage, error details, etc.).
        timestamp: When this output was created.
    """

    session_id: str
    type: OutputType
    content: str = ""
    is_final: bool = False
    transcript_id: Optional[str] = None
    status_subtype: Optional[StatusSubtype] = None
    metadata_subtype: Optional[MetadataSubtype] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    timestamp: datetime = field(default_factory=datetime.utcnow)

    # --- Factory methods for TEXT outputs ---

    @classmethod
    def text_chunk(
        cls,
        session_id: str,
        text: str,
        transcript_id: Optional[str] = None,
        is_final: bool = False,
    ) -> "AgentOutput":
        """
        Create a streaming text chunk.

        Use this to stream response text token-by-token or chunk-by-chunk.
        Session-management will display immediately and buffer for TTS.

        Args:
            session_id: The session ID.
            text: The text chunk to send.
            transcript_id: ID to group chunks (auto-generated if not provided).
            is_final: Whether this is the last chunk in the stream.
        """
        return cls(
            session_id=session_id,
            type=OutputType.TEXT_CHUNK,
            content=text,
            transcript_id=transcript_id or str(uuid.uuid4()),
            is_final=is_final,
        )

    @classmethod
    def text_final(
        cls,
        session_id: str,
        text: str,
        transcript_id: Optional[str] = None,
    ) -> "AgentOutput":
        """
        Create a final/complete text message.

        Use this when you have the complete response (not streaming).
        Session-management will display and immediately synthesize TTS.

        Args:
            session_id: The session ID.
            text: The complete response text.
            transcript_id: Optional ID for this message.
        """
        return cls(
            session_id=session_id,
            type=OutputType.TEXT_FINAL,
            content=text,
            transcript_id=transcript_id or str(uuid.uuid4()),
            is_final=True,
        )

    # --- Factory methods for STATUS outputs ---

    @classmethod
    def status(
        cls,
        session_id: str,
        message: str,
        subtype: StatusSubtype = StatusSubtype.PROCESSING,
        progress: Optional[float] = None,
        **extra_metadata: Any,
    ) -> "AgentOutput":
        """
        Create a status update message.

        Use this to inform the user about processing status.
        No TTS will be triggered for status messages.

        Args:
            session_id: The session ID.
            message: Status message to display.
            subtype: The status category.
            progress: Optional progress percentage (0.0 to 1.0).
            **extra_metadata: Additional metadata to include.
        """
        metadata = {**extra_metadata}
        if progress is not None:
            metadata["progress"] = progress
        return cls(
            session_id=session_id,
            type=OutputType.STATUS,
            content=message,
            status_subtype=subtype,
            metadata=metadata,
        )

    @classmethod
    def thinking(cls, session_id: str, message: str = "Thinking...") -> "AgentOutput":
        """Create a 'thinking' status message."""
        return cls.status(session_id, message, StatusSubtype.THINKING)

    @classmethod
    def processing(cls, session_id: str, message: str = "Processing...") -> "AgentOutput":
        """Create a 'processing' status message."""
        return cls.status(session_id, message, StatusSubtype.PROCESSING)

    # --- Factory methods for METADATA outputs ---

    @classmethod
    def metadata_update(
        cls,
        session_id: str,
        subtype: MetadataSubtype,
        data: Dict[str, Any],
    ) -> "AgentOutput":
        """
        Create a metadata update message.

        Use this to update plan state, deliverables, etc.
        No TTS will be triggered for metadata messages.

        Args:
            session_id: The session ID.
            subtype: The metadata category.
            data: The metadata payload.
        """
        import json
        return cls(
            session_id=session_id,
            type=OutputType.METADATA,
            content=json.dumps(data),
            metadata_subtype=subtype,
            metadata=data,
        )

    @classmethod
    def deliverable(
        cls,
        session_id: str,
        key: str,
        value: Any,
        **extra_metadata: Any,
    ) -> "AgentOutput":
        """Create a deliverable update message."""
        return cls.metadata_update(
            session_id,
            MetadataSubtype.DELIVERABLE,
            {"key": key, "value": value, **extra_metadata},
        )

    @classmethod
    def progress(cls, session_id: str, percentage: float, message: str = "") -> "AgentOutput":
        """Create a progress update message (0.0 to 1.0 or 0 to 100)."""
        # Normalize to 0.0-1.0
        if percentage > 1.0:
            percentage = percentage / 100.0
        return cls.metadata_update(
            session_id,
            MetadataSubtype.PROGRESS,
            {"percentage": percentage, "message": message},
        )

    # --- Factory methods for ERROR outputs ---

    @classmethod
    def error(
        cls,
        session_id: str,
        message: str,
        error_type: str = "processing_error",
        recoverable: bool = True,
        **extra_metadata: Any,
    ) -> "AgentOutput":
        """
        Create an error message.

        Use this to report errors to the user.

        Args:
            session_id: The session ID.
            message: Error message to display.
            error_type: Category of error.
            recoverable: Whether the session can continue.
            **extra_metadata: Additional error details.
        """
        return cls(
            session_id=session_id,
            type=OutputType.ERROR,
            content=message,
            metadata={
                "error_type": error_type,
                "recoverable": recoverable,
                **extra_metadata,
            },
        )

    # --- Factory methods for PROGRESS_UPDATE outputs ---

    @classmethod
    def progress_update(
        cls,
        session_id: str,
        progress_state: "ProgressState",
        update_trigger: str = "turn_completion",
        **extra_metadata: Any,
    ) -> "AgentOutput":
        """
        Create a progress/task tracking update message.

        Use this to send task panel updates to the frontend. The progress state
        contains groups of items that can be displayed in a todo-list style UI.

        Args:
            session_id: The session ID.
            progress_state: The complete progress state (from stella_agent_sdk.progress)
                           or a dict in the same format.
            update_trigger: What triggered this update (e.g., "turn_completion",
                           "state_change", "item_collected").
            **extra_metadata: Additional metadata to include.

        Example:
            from stella_agent_sdk.progress import ProgressState, ProgressGroup, ProgressItem

            state = ProgressState(
                groups=[
                    ProgressGroup(
                        id="intake",
                        label="Patient Intake",
                        execution_mode=ExecutionMode.FLEXIBLE,
                        items=[
                            ProgressItem(id="name", label="Name", status=ItemStatus.COMPLETED, value="John"),
                            ProgressItem(id="dob", label="DOB", status=ItemStatus.PENDING),
                        ]
                    )
                ],
                current_group_id="intake",
            )
            yield AgentOutput.progress_update(session_id, state)
        """
        import json
        from datetime import datetime

        # Support both ProgressState objects and plain dicts
        if hasattr(progress_state, 'to_dict'):
            data = progress_state.to_dict()
        elif isinstance(progress_state, dict):
            data = progress_state.copy()
        else:
            raise TypeError(f"progress_state must be ProgressState or dict, got {type(progress_state)}")

        data["update_trigger"] = update_trigger
        data["timestamp"] = datetime.utcnow().isoformat() + "Z"

        return cls(
            session_id=session_id,
            type=OutputType.PROGRESS_UPDATE,
            content=json.dumps(data),
            metadata={
                "progress_state": data,
                "update_trigger": update_trigger,
                **extra_metadata,
            },
        )

    # --- Factory methods for DEBUG outputs ---

    @classmethod
    def debug(
        cls,
        session_id: str,
        message: str,
        component: str = "agent",
        level: str = "info",
        **extra_metadata: Any,
    ) -> "AgentOutput":
        """
        Create a debug/log message.

        Use this to communicate internal processing steps for transparency.
        These are displayed in debug UI but not spoken via TTS.

        Args:
            session_id: The session ID.
            message: Debug message to display.
            component: Which component is logging (e.g., "input_gate", "expert_pool").
            level: Log level ("info", "warn", "error").
            **extra_metadata: Additional debug data.
        """
        return cls(
            session_id=session_id,
            type=OutputType.DEBUG,
            content=message,
            metadata={
                "component": component,
                "level": level,
                **extra_metadata,
            },
        )

    @classmethod
    def tool_call(
        cls,
        session_id: str,
        tool: str,
        *,
        caller: str = "agent",
        arguments: Optional[Dict[str, Any]] = None,
        success: bool = True,
        data: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> "AgentOutput":
        """Report one executed function call on the debug channel.

        Tool calls are the actions an agent actually took, and until now they
        were visible only in pod logs — an expert's debug line reports its
        verdict, not what it did. Shaping them here keeps the envelope
        identical across agents so the UI has one thing to render.

        Args:
            session_id: The session ID.
            tool: Name of the function that was called.
            caller: What invoked it (usually the expert name).
            arguments: Arguments the model passed.
            success: Whether the call succeeded.
            data: The tool's returned data payload.
            error: Failure reason, when ``success`` is False.
        """
        arg_preview = ", ".join(f"{k}={v!r}" for k, v in (arguments or {}).items())
        if len(arg_preview) > 200:
            arg_preview = arg_preview[:197] + "..."
        return cls.debug(
            session_id,
            f"{caller} called {tool}({arg_preview})"
            + ("" if success else f" — failed: {error}"),
            component=f"tool:{tool}",
            level="info" if success else "warn",
            tool=tool,
            caller=caller,
            arguments=arguments or {},
            success=success,
            data=data or {},
            **({"error": error} if error else {}),
        )

    @classmethod
    def decision(
        cls,
        session_id: str,
        kind: str,
        label: str,
        *,
        detail: Optional[str] = None,
        options: Optional[list] = None,
        component: str = "agent",
        **extra_metadata: Any,
    ) -> "AgentOutput":
        """Report a routing decision the user should be able to see.

        Decisions ride the DEBUG channel deliberately: they persist, replay and
        transport exactly like every other debug output, so this needs no new
        envelope type and no backend change. The ``decision`` block is the only
        thing that distinguishes them — the frontend renders a tag when it is
        present and a diagnostic line when it is not. Keep it display-ready;
        anything diagnostic belongs in ``**extra_metadata``.

        Args:
            session_id: The session ID.
            kind: Machine-readable decision type (e.g. "activity_started").
            label: Short human-readable summary of what was decided.
            detail: Optional secondary line (e.g. the activity's description).
            options: Choices offered to the user, when the decision was an offer.
            component: Which component decided (e.g. "companion_router").
            **extra_metadata: Additional debug data.
        """
        return cls.debug(
            session_id,
            f"{label} — {detail}" if detail else label,
            component=component,
            decision={
                "kind": kind,
                "label": label,
                **({"detail": detail} if detail else {}),
                **({"options": options} if options is not None else {}),
            },
            **extra_metadata,
        )

    # --- Factory methods for ANALYTICS outputs ---

    @classmethod
    def analytics(
        cls,
        session_id: str,
        stage: str,
        timing_ms: float,
        **extra_metadata: Any,
    ) -> "AgentOutput":
        """
        Create an analytics timing measurement.

        Stored for aggregation, not displayed to users, not spoken via TTS.

        Args:
            session_id: The session ID.
            stage: Pipeline stage name (e.g., "input_gate", "expert_pool", "aggregator").
            timing_ms: Duration of this stage in milliseconds.
            **extra_metadata: Additional context (e.g., expert_count, model).
        """
        return cls(
            session_id=session_id,
            type=OutputType.ANALYTICS,
            content="",
            metadata={
                "stage": stage,
                "timing_ms": timing_ms,
                **extra_metadata,
            },
        )

    @classmethod
    def analytics_event(
        cls,
        session_id: str,
        stage: str,
        turn_id: str,
        elapsed_ms: float,
        **extra_metadata: Any,
    ) -> "AgentOutput":
        """
        Create a raw timestamped analytics event (elapsed_ms relative to stt_end).

        Unlike analytics(), this does not carry a pre-computed timing delta.
        Instead it records the elapsed time since stt_end for a specific event,
        allowing the dashboard to compute intervals between any pair of events.

        Args:
            session_id: The session ID.
            stage: Event name (e.g., "bridge_start", "response_first_token").
            turn_id: Groups events into conversational turns.
            elapsed_ms: Milliseconds since stt_end (ground zero). Negative for pre-stt events.
            **extra_metadata: Additional context.
        """
        return cls(
            session_id=session_id,
            type=OutputType.ANALYTICS,
            content="",
            metadata={
                "stage": stage,
                "turn_id": turn_id,
                "elapsed_ms": elapsed_ms,
                **extra_metadata,
            },
        )

    # --- Side-channel dispatch ---

    def to_data_payload(
        self, agent_identity: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        """Map a side-channel output to a LiveKit ``publish_data`` payload.

        This is the single source of truth for how non-text outputs (DEBUG,
        STATUS, ERROR, METADATA, PROGRESS_UPDATE, ANALYTICS) are shaped into the
        ``{"type": ..., "data": ...}`` envelope the frontend consumes. Both the
        runtime's audio loop and the on-ready hook use it so the shaping never
        drifts between the two call sites.

        Returns ``None`` for outputs that are NOT forwarded as data messages —
        TEXT_CHUNK / TEXT_FINAL (streamed + synthesized by the audio loop) and
        HEALTH_STATUS (answered over the gRPC stream). Callers handle those.

        Args:
            agent_identity: ``{"agent_id", "agent_name", "agent_icon"}`` used to
                attribute PROGRESS_UPDATE messages to the emitting agent.
        """
        md = self.metadata or {}

        if self.type == OutputType.DEBUG:
            return {"type": "debug", "data": {
                "content": self.content,
                "component": md.get("component", "agent"),
                "level": md.get("level", "info"),
                "metadata": md,
            }}

        if self.type == OutputType.STATUS:
            return {"type": "debug", "data": {
                "content": self.content,
                "component": md.get("component", "status"),
                "level": "info",
                "metadata": md,
            }}

        if self.type == OutputType.ERROR:
            return {"type": "debug", "data": {
                "content": self.content,
                "component": md.get("component", "error"),
                "level": "error",
                "metadata": md,
            }}

        if self.type == OutputType.METADATA:
            if self.metadata_subtype == MetadataSubtype.DELIVERABLE:
                return {"type": "plan_deliverable_update", "data": {
                    "deliverable_key": md.get("key"),
                    "deliverable_value": md.get("value"),
                    "confidence": md.get("confidence", 1.0),
                    "reasoning": md.get("reasoning"),
                    "state_id": md.get("state_id"),
                    "task_id": md.get("task_id"),
                }}
            subtype_value = self.metadata_subtype.value if self.metadata_subtype else "metadata"
            return {"type": "debug", "data": {
                "content": f"[{subtype_value}] {self.content}",
                "component": "metadata",
                "level": "info",
                "metadata": md,
            }}

        if self.type == OutputType.PROGRESS_UPDATE:
            # Copy so we never mutate this output's metadata when injecting identity.
            progress_data = dict(md.get("progress_state", {}) or {})
            identity_meta = dict(progress_data.get("metadata") or {})
            if agent_identity:
                identity_meta.update(agent_identity)
            progress_data["metadata"] = identity_meta
            return {"type": "progress_update", "data": progress_data}

        if self.type == OutputType.ANALYTICS:
            return {"type": "analytics", "data": {
                "stage": md.get("stage", "unknown"),
                "timing_ms": md.get("timing_ms", 0),
                **{k: v for k, v in md.items() if k not in ("stage", "timing_ms")},
            }}

        # TEXT_CHUNK / TEXT_FINAL / HEALTH_STATUS — handled by the caller.
        return None

    # --- Factory methods for HEALTH_STATUS outputs ---

    @classmethod
    def health_status(
        cls,
        session_id: str,
        request_id: str,
        state: AgentState,
        agent_type: str,
        agent_version: str,
        uptime_seconds: int,
        messages_processed: int,
        last_error: Optional[str] = None,
        **extra_metadata: Any,
    ) -> "AgentOutput":
        """
        Create a health status response.

        Use this to respond to health check requests from session-management.
        This is sent via the bidirectional stream when the server requests
        health status.

        Args:
            session_id: The session ID.
            request_id: The correlation ID from the health check request.
            state: The current agent state.
            agent_type: Type of agent (e.g., "StellaAgent").
            agent_version: Agent version string.
            uptime_seconds: How long the agent has been running.
            messages_processed: Number of messages processed.
            last_error: Last error message (if any).
            **extra_metadata: Additional health metadata.
        """
        return cls(
            session_id=session_id,
            type=OutputType.HEALTH_STATUS,
            content="",
            metadata={
                "request_id": request_id,
                "state": state.value,
                "agent_type": agent_type,
                "agent_version": agent_version,
                "uptime_seconds": uptime_seconds,
                "messages_processed": messages_processed,
                "last_error": last_error,
                **extra_metadata,
            },
        )
