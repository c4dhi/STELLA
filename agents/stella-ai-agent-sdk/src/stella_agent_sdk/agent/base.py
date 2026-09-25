"""BaseAgent abstract class - the interface agents must implement."""

from abc import ABC, abstractmethod
import asyncio
import logging
import re
import time
import uuid
from typing import Any, AsyncIterator, Awaitable, Dict, List, Optional, TYPE_CHECKING

from stella_agent_sdk.messages.input import AgentInput
from stella_agent_sdk.messages.output import AgentOutput
from stella_agent_sdk.messages.types import (
    AgentState,
    BargeInDecision,
    ChatMessage,
    MetadataSubtype,
    OutputType,
)

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from stella_agent_sdk.audio.pipeline import AudioPipeline
    from stella_agent_sdk.services.history_client import HistoryClient


class BaseAgent(ABC):
    """
    Abstract base class for STELLA agents.

    Implement this class to create your own agent. The SDK only cares about
    the communication interface - your internal implementation (LLM choice,
    RAG, multi-agent systems, etc.) is entirely up to you.

    Example:
        ```python
        from stella_agent_sdk import BaseAgent, AgentInput, AgentOutput

        class MyAgent(BaseAgent):
            async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
                # Initialize your agent with the session configuration
                self.model = config.get("model", "gpt-4")

            async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
                # Process the input and yield responses
                response = await self.call_your_llm(input.text)
                yield AgentOutput.text_final(input.session_id, response)

            async def on_interrupt(self, session_id: str) -> None:
                # Stop any ongoing generation
                self.cancel_current_task()

            async def on_session_end(self, session_id: str) -> Dict[str, Any]:
                # Cleanup and return any final data
                return {"messages_processed": self.message_count}
        ```

    The session lifecycle:
        1. on_session_start() - Agent receives configuration, initializes state
        2. process() - Called for each user input, yields streaming responses
        3. on_interrupt() - Called if user interrupts (barge-in)
        4. on_session_end() - Called when session ends, cleanup
    """

    #: Whether this agent supports user barge-in (interrupting mid-speech).
    #: When True *and* barge-in is enabled at the deployment level (env), the
    #: pipeline arms the reflex: detecting user speech while the agent is
    #: talking suspends playback, transcribes the user, and routes the final
    #: transcript to ``on_barge_in()`` to decide whether to commit or resume.
    #: When False the agent never gets interrupted (current default behaviour).
    supports_barge_in: bool = False

    #: Teleprompter (#241): when True, the pipeline emits agent_speech_progress
    #: envelopes so the frontend can light up the reply word-by-word as it is
    #: spoken. On by default (the pipeline also defaults on); an explicit
    #: STELLA_TELEPROMPTER_ENABLED=false env value forces it off.
    supports_teleprompter: bool = True

    #: Backchannel / filler tokens treated as "not a real interruption" by the
    #: default ``on_barge_in()`` heuristic. Subclasses may override this set or
    #: override ``on_barge_in()`` entirely for semantic evaluation.
    _BARGE_IN_BACKCHANNELS = frozenset({
        "mhm", "mm", "mmhm", "uh huh", "uh-huh", "uhuh", "yeah", "yep", "yup",
        "ok", "okay", "right", "sure", "got it", "i see", "go on", "continue",
        "hmm", "ah", "oh", "huh", "aha", "ja", "genau", "okay", "verstehe",
    })

    def __init__(self) -> None:
        """Initialize the agent. Override to add your own initialization."""
        self._session_id: Optional[str] = None
        self._is_processing: bool = False
        # State tracking for health checks
        self._state: AgentState = AgentState.INITIALIZING
        self._start_time: float = time.time()
        self._messages_processed: int = 0
        self._last_error: Optional[str] = None
        self._agent_type: str = self.__class__.__name__
        self._agent_version: str = "1.0.0"
        # Audio pipeline (set by run_agent when using direct LiveKit mode)
        self._audio_pipeline: Optional["AudioPipeline"] = None
        # History client (set by run_agent for chat history access)
        self._history_client: Optional["HistoryClient"] = None
        # Last progress payload (for re-sending to new participants)
        self._last_progress_payload: Optional[Dict[str, Any]] = None
        # Sentence buffer for TTS dispatch (accumulates text between sentence boundaries)
        self._sentence_buffer: str = ""
        # Teleprompter (#241): to light the published agent_text up as it is
        # spoken, each enqueued sentence is tagged with its character span in
        # that text. _tp_text is the latest accumulated agent_text, _tp_cursor
        # the search offset so repeated sentences resolve in order.
        self._tp_transcript_id: Optional[str] = None
        self._tp_text: str = ""
        self._tp_cursor: int = 0
        # Set to True by the agent when the plan reaches __end__.
        # run_audio_loop checks this after each turn and exits cleanly.
        self._session_completed: bool = False
        # Current sentence source for analytics ("bridge" or "response")
        self._current_sentence_source: str = "response"
        # Agent identity (set by run_agent from environment variables)
        self._agent_name: str = "Agent"
        self._agent_id: str = ""
        self._agent_icon: str = "🤖"
        # In-flight long-running ("deferred") tool calls, keyed by name (#198/#303).
        # Drained when the session ends so a slow tool can't speak after lockdown.
        self._pending_tools: Dict[str, "asyncio.Task[Any]"] = {}

    def defer_tool(self, name: str, coro: Awaitable[Any]) -> "asyncio.Task[Any]":
        """Register a long-running tool call so it can be reconciled if the session
        ends before it finishes (#303). Schedules ``coro`` as a task, tracks it under
        ``name``, and auto-removes it from the registry once it completes.

        Returns the scheduled task so callers can await its result in the normal flow.
        """
        task = asyncio.ensure_future(coro)
        self._pending_tools[name] = task

        def _cleanup(t: "asyncio.Task[Any]", n: str = name) -> None:
            if self._pending_tools.get(n) is t:
                self._pending_tools.pop(n, None)

        task.add_done_callback(_cleanup)
        return task

    async def drain_pending_tools(self, deadline_ms: int) -> Dict[str, List[str]]:
        """Reconcile in-flight deferred tools when the session is winding down
        (#198/#303): give them a bounded window to finish (``delivered``), then cancel
        whatever is still running (``cancelled``). Errored tasks count as cancelled.

        Never blocks longer than ``deadline_ms``, so it cannot push the session past
        its hard lockdown. After it returns the registry is empty, so no late tool
        result can be processed/spoken after teardown.
        """
        pending = dict(self._pending_tools)
        self._pending_tools.clear()
        if not pending:
            return {"delivered": [], "cancelled": []}

        timeout = max(0.0, deadline_ms / 1000.0)
        if timeout > 0:
            await asyncio.wait(list(pending.values()), timeout=timeout)

        delivered: List[str] = []
        cancelled: List[str] = []
        to_cancel: List["asyncio.Task[Any]"] = []
        for name, task in pending.items():
            if not task.done():
                task.cancel()
                to_cancel.append(task)
                cancelled.append(name)
            elif task.cancelled() or task.exception() is not None:
                cancelled.append(name)
            else:
                delivered.append(name)

        # Let cancellations settle so the tasks are fully torn down (no lingering
        # "Task was destroyed but it is pending" / late callbacks after lockdown).
        if to_cancel:
            await asyncio.gather(*to_cancel, return_exceptions=True)

        return {"delivered": sorted(delivered), "cancelled": sorted(cancelled)}

    @property
    def session_id(self) -> Optional[str]:
        """The current session ID, if in a session."""
        return self._session_id

    @property
    def is_processing(self) -> bool:
        """Whether the agent is currently processing input."""
        return self._is_processing

    @property
    def state(self) -> AgentState:
        """The current agent state for health monitoring."""
        return self._state

    @property
    def agent_type(self) -> str:
        """The type of agent (class name by default)."""
        return self._agent_type

    @property
    def agent_version(self) -> str:
        """The agent version string."""
        return self._agent_version

    @agent_version.setter
    def agent_version(self, value: str) -> None:
        """Set the agent version."""
        self._agent_version = value

    @property
    def agent_name(self) -> str:
        """The deployed agent name (from AGENT_NAME env var)."""
        return self._agent_name

    @property
    def agent_id(self) -> str:
        """The deployed agent ID (from AGENT_ID env var)."""
        return self._agent_id

    @property
    def uptime_seconds(self) -> int:
        """How long the agent has been running in seconds."""
        return int(time.time() - self._start_time)

    @property
    def messages_processed(self) -> int:
        """Number of messages processed by this agent."""
        return self._messages_processed

    @property
    def audio(self) -> "AudioPipeline":
        """
        Access the audio pipeline for direct audio I/O.

        This property is available when the agent is running in direct LiveKit
        mode (via run_agent). It provides high-level audio abstractions:

        INPUT:
        - audio.audio_in() - Async iterator yielding final transcripts

        OUTPUT (decoupled):
        - audio.publish_text(text, is_final, transcript_id) - Stream text to frontend
        - audio.speak(text) - Send text to TTS for audio synthesis

        CONTROL:
        - audio.on_speech_started(callback) - Register barge-in handler
        - audio.stop_speaking() - Interrupt current TTS
        - audio.has_tts - Check if TTS is available

        Raises:
            RuntimeError: If not running in direct LiveKit mode.

        Example:
            ```python
            async def run_audio_loop(self) -> None:
                async for event in self.audio.audio_in():
                    if event.is_final:
                        transcript_id = f"response_{uuid.uuid4().hex[:8]}"
                        response = await self.get_response(event.text)
                        await self.audio.publish_text(response, is_final=True, transcript_id=transcript_id)
                        await self.audio.speak(response)
            ```
        """
        if self._audio_pipeline is None:
            raise RuntimeError(
                "Audio pipeline not available. "
                "Are you running the agent with run_agent()? "
                "The audio pipeline is only available in direct LiveKit mode."
            )
        return self._audio_pipeline

    @property
    def has_audio(self) -> bool:
        """Whether the audio pipeline is available."""
        return self._audio_pipeline is not None

    @property
    def has_history(self) -> bool:
        """Whether the chat history client is available."""
        return self._history_client is not None

    async def get_chat_history(
        self,
        include_debug: bool = False,
        limit: int = 100,
    ) -> List[ChatMessage]:
        """
        Fetch chat history for the current session.

        This method retrieves recorded messages from the session's conversation
        history. It's useful for:
        - Building context for LLM prompts
        - Resuming conversations after agent restart
        - Analyzing conversation patterns

        The messages are returned in chronological order (oldest first) and
        use the same envelope format as live messages for consistency.

        Args:
            include_debug: Whether to include debug/processing messages.
                          Default is False (only chat messages: user_text,
                          transcript, agent_text).
            limit: Maximum number of messages to return (default: 100, max: 500).

        Returns:
            List of ChatMessage objects in chronological order.

        Raises:
            RuntimeError: If not in an active session or history client not available.

        Example:
            ```python
            async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
                # Get recent conversation history for context
                history = await self.get_chat_history(limit=20)

                # Build context string
                context = "\\n".join([
                    f"{msg.role}: {msg.content}"
                    for msg in history
                ])

                # Use in LLM prompt
                response = await self.llm.chat([
                    {"role": "system", "content": f"Previous conversation:\\n{context}"},
                    {"role": "user", "content": input.text}
                ])

                yield AgentOutput.text_final(input.session_id, response)
            ```
        """
        if self._history_client is None:
            raise RuntimeError(
                "Chat history not available. "
                "Are you running the agent with run_agent()? "
                "The history client is only available in direct LiveKit mode."
            )

        return await self._history_client.get_chat_history(
            include_debug=include_debug,
            limit=limit,
        )

    def set_state(self, state: AgentState) -> None:
        """
        Set the agent state.

        Call this to update the agent state for health monitoring.
        The SDK will call this automatically for common transitions,
        but you can also call it manually for custom states.

        Args:
            state: The new agent state.
        """
        self._state = state

    def record_error(self, error: str) -> None:
        """
        Record an error for health reporting.

        Args:
            error: The error message.
        """
        self._last_error = error
        self._state = AgentState.ERROR

    def get_health_status(self) -> Dict[str, Any]:
        """
        Get the current health status of the agent.

        This is called by the SDK when session-management sends a health check request.
        Override this method to add custom health metrics.

        Returns:
            Dictionary with health status information.
        """
        return {
            "state": self._state.value,
            "session_id": self._session_id,
            "agent_type": self._agent_type,
            "agent_version": self._agent_version,
            "uptime_seconds": self.uptime_seconds,
            "messages_processed": self._messages_processed,
            "last_error": self._last_error,
        }

    def _agent_identity(self) -> Dict[str, Any]:
        """Identity metadata used to attribute outgoing messages to this agent.

        Passed to :meth:`AgentOutput.to_data_payload` so progress updates carry the
        agent's id/name/icon for frontend attribution.
        """
        return {
            "agent_id": self._agent_id,
            "agent_name": self._agent_name,
            "agent_icon": self._agent_icon,
        }

    @abstractmethod
    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        """
        Process user input and yield agent outputs.

        This is the main entry point for your agent logic. You receive
        transcribed text (or other input types) and yield response messages.

        For streaming responses, yield multiple TEXT_CHUNK outputs followed
        by a final TEXT_CHUNK with is_final=True (or use TEXT_FINAL).

        Args:
            input: The input message from session-management.

        Yields:
            AgentOutput messages (text chunks, status updates, etc.).

        Example (streaming):
            ```python
            async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
                transcript_id = str(uuid.uuid4())

                # Show thinking status
                yield AgentOutput.thinking(input.session_id)

                # Stream the response
                async for chunk in self.stream_from_llm(input.text):
                    yield AgentOutput.text_chunk(
                        input.session_id,
                        chunk,
                        transcript_id=transcript_id,
                    )

                # Mark stream as complete
                yield AgentOutput.text_chunk(
                    input.session_id,
                    "",
                    transcript_id=transcript_id,
                    is_final=True,
                )
            ```

        Example (non-streaming):
            ```python
            async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
                response = await self.get_response(input.text)
                yield AgentOutput.text_final(input.session_id, response)
            ```
        """
        # This is abstract, implementations must override
        yield  # type: ignore

    @abstractmethod
    async def on_interrupt(self, session_id: str) -> None:
        """
        Handle interrupt signal (user barge-in).

        Called when the user starts speaking while the agent is responding.
        You should stop any ongoing generation immediately.

        This is called BEFORE the INTERRUPT input type arrives in process().

        Args:
            session_id: The session being interrupted.

        Example:
            ```python
            async def on_interrupt(self, session_id: str) -> None:
                # Cancel any ongoing async tasks
                if self._current_task:
                    self._current_task.cancel()
                # Reset streaming state
                self._is_streaming = False
            ```
        """
        pass

    async def on_barge_in(self, session_id: str, transcript: str) -> BargeInDecision:
        """Evaluate a user barge-in and decide whether to act on it.

        Called only when ``supports_barge_in`` is True and barge-in is enabled
        at the deployment level. By the time this fires, the system has already
        suspended playback (reversibly) and transcribed the user's full
        utterance — nothing has been discarded yet. Your return value decides:

        - ``BargeInDecision.COMMIT``: the interruption is worth addressing. The
          system discards the remainder of the current message, truncates it to
          what was actually spoken, and processes ``transcript`` as a new turn.
        - ``BargeInDecision.RESUME``: the interruption was not meaningful
          (backchannel, noise, filler). Playback resumes from exactly where it
          was suspended and ``transcript`` is discarded.

        The default implementation is a fast, synchronous heuristic: short
        utterances consisting only of backchannel/filler tokens resume;
        anything else commits. Override for semantic evaluation (e.g. an LLM
        classifier) — but keep it fast, since the user hears silence while this
        runs on the resume path.

        Args:
            session_id: The session being interrupted.
            transcript: The user's transcribed barge-in utterance.

        Returns:
            A ``BargeInDecision`` (COMMIT or RESUME).

        Example:
            ```python
            async def on_barge_in(self, session_id: str, transcript: str) -> BargeInDecision:
                if await self.is_real_instruction(transcript):
                    return BargeInDecision.COMMIT
                return BargeInDecision.RESUME
            ```
        """
        normalized = transcript.strip().lower().strip(".,!?…")
        if not normalized:
            # Pure noise / no words recognized — not a real interruption.
            return BargeInDecision.RESUME
        # Whole utterance is a known (possibly multi-word) backchannel phrase,
        # e.g. "go on", "uh huh", "got it".
        if normalized in self._BARGE_IN_BACKCHANNELS:
            return BargeInDecision.RESUME
        # ...or a short utterance made up entirely of single-token backchannels
        # ("mhm", "okay yeah"). Anything substantive commits — when in doubt we
        # commit, since ignoring a real interruption is worse than over-stopping.
        words = normalized.split()
        if len(words) <= 3 and all(
            w in self._BARGE_IN_BACKCHANNELS for w in words
        ):
            return BargeInDecision.RESUME
        return BargeInDecision.COMMIT

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        """
        Called when a new session starts.

        Override this to initialize your agent with session-specific configuration.
        The config contains plan information, user preferences, LLM settings, etc.

        Args:
            session_id: Unique identifier for this session.
            config: Configuration dictionary from session-management.
                   May include: plan_id, plan_data, user_preferences,
                   llm_model, temperature, etc.

        Example:
            ```python
            async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
                self._session_id = session_id
                self.plan_data = config.get("plan_data")
                self.model = config.get("llm_model", "gpt-4")
                self.temperature = config.get("temperature", 0.7)
                self.conversation_history = []
            ```
        """
        self._session_id = session_id
        self._state = AgentState.READY

    async def on_session_end(self, session_id: str) -> Dict[str, Any]:
        """
        Called when a session ends.

        Override this to cleanup resources and return any final data
        (collected deliverables, conversation summary, etc.).

        Args:
            session_id: The session that is ending.

        Returns:
            Dictionary with any final data to send back to session-management.
            This might include collected deliverables, conversation metrics, etc.

        Example:
            ```python
            async def on_session_end(self, session_id: str) -> Dict[str, Any]:
                # Cleanup
                await self.cleanup_resources()

                # Return collected data
                return {
                    "deliverables": self.collected_deliverables,
                    "messages_processed": len(self.conversation_history),
                    "session_duration_seconds": self.get_duration(),
                }
            ```
        """
        self._state = AgentState.SHUTTING_DOWN
        self._session_id = None
        return {}

    async def on_session_ending(
        self, session_id: str, reason: str, deadline_ms: int
    ) -> AsyncIterator[AgentOutput]:
        """
        Called when the session is being wound down *while the turn/audio loop is
        still live* — the pre-teardown wrap-up window (issue #198).

        This is distinct from the other two lifecycle hooks:
        - ``on_interrupt`` is a barge-in: the user spoke over the agent and the
          current turn should stop. ``on_session_ending`` is the system ending the
          session (a timeout / max-duration cap), not the user.
        - ``on_session_end`` runs in the teardown ``finally`` *after* the loop has
          exited — too late to speak. ``on_session_ending`` runs *before* teardown,
          so anything you yield here is still synthesized and heard.

        Use it to emit a final spoken turn — a brief goodbye, a summary, a handback
        of an identifier — before the session locks down. Once this fires, no new
        user turns are accepted; your yielded output is the last thing the agent says.

        You have a bounded budget: the backend force-closes the session at
        ``deadline_ms``. Keep the wrap-up short; anything still in flight when the
        deadline hits is cut off.

        The default implementation yields nothing — the backend then falls back to
        the plan's ``EndNodeConfig.farewell_message`` if one is set. Override to
        generate a custom wrap-up (see the author-configurable interrupt handler).

        Args:
            session_id: The session being wound down.
            reason: Why the session is ending (e.g. ``"session_end"`` for a
                timeout / max-duration cap). Branch on this to tailor the wrap-up.
            deadline_ms: Wall-clock budget in milliseconds for the wrap-up before
                the backend force-closes.

        Yields:
            AgentOutput messages — the final spoken turn — before lockdown.

        Example:
            ```python
            async def on_session_ending(self, session_id, reason, deadline_ms):
                if reason == "session_end":
                    async for out in self.generate_reply(
                        session_id, "We're out of time — wrap up warmly in one sentence."
                    ):
                        yield out
            ```
        """
        # Default implementation yields nothing (backend falls back to farewell_message).
        return
        yield  # Make this a generator

    async def on_config_update(self, session_id: str, config: Dict[str, Any]) -> None:
        """
        Called when configuration is updated during a session.

        Override this to handle runtime configuration changes.

        Args:
            session_id: The session being updated.
            config: The new/updated configuration values.
        """
        pass

    async def on_ready(self, session_id: str) -> AsyncIterator[AgentOutput]:
        """
        Called after session start, before the audio loop begins.

        Override this to send initial outputs to the frontend, such as:
        - Initial progress/todo list state
        - Welcome messages
        - Configuration confirmations

        This is the right place to send the initial state of any progress
        tracking or todo lists that the frontend should display immediately
        when the agent joins the room.

        Args:
            session_id: The session that just started.

        Yields:
            AgentOutput messages to send before the audio loop starts.

        Example:
            ```python
            async def on_ready(self, session_id: str) -> AsyncIterator[AgentOutput]:
                # Send initial progress state
                if self.has_todo_list:
                    progress = self.build_progress_state()
                    yield AgentOutput.progress_update(
                        session_id,
                        progress,
                        update_trigger="session_start"
                    )
            ```
        """
        # Default implementation yields nothing
        return
        yield  # Make this a generator

    async def run_audio_loop(self) -> None:
        """
        Main audio processing loop for direct LiveKit mode.

        Override this method for custom audio handling. The default
        implementation routes transcripts through process() for
        backwards compatibility.

        This method is called by run_agent() after:
        1. LiveKit room connection established
        2. STT/TTS services connected
        3. AudioPipeline initialized
        4. on_session_start() called

        The default implementation:
        - Receives final transcripts from audio.audio_in()
        - Routes through process() for agent handling
        - Streams TEXT_CHUNKs to frontend via audio.publish_text()
        - Sends final text to TTS via audio.speak()

        Example (custom implementation):
            ```python
            async def run_audio_loop(self) -> None:
                # Register barge-in handler
                self.audio.on_speech_started(self._handle_barge_in)

                async for event in self.audio.audio_in():
                    if event.is_final:
                        transcript_id = f"response_{uuid.uuid4().hex[:8]}"
                        accumulated = ""

                        async for chunk in self.llm.stream(event.text):
                            accumulated += chunk
                            await self.audio.publish_text(accumulated, is_final=False, transcript_id=transcript_id)

                        await self.audio.publish_text(accumulated, is_final=True, transcript_id=transcript_id)
                        await self.audio.speak(accumulated)

            async def _handle_barge_in(self) -> None:
                await self.audio.stop_speaking()
            ```

        Example (using process() for compatibility):
            The default implementation below routes through process(),
            allowing existing agents to work with minimal changes.
        """
        if not self.has_audio:
            raise RuntimeError(
                "run_audio_loop requires audio pipeline. "
                "Use run_agent() to start the agent in direct LiveKit mode."
            )

        async for event in self.audio.audio_in():
            if event.is_final and event.text.strip():
                # Terminal close (issue #198): once the session is winding down we
                # stop taking new turns. The closing farewell is spoken out-of-band
                # by the session-end handler; processing another user turn here would
                # race it and "continue the conversation" past the cap.
                if self.audio.is_closing:
                    logger.info("[SESSION END] ignoring user turn while closing")
                    continue

                # Drain any stacked transcripts — only process the latest one.
                # This prevents message pileup when the user speaks while the
                # agent is still responding (transcripts queued during gate-open window).
                latest_event = event
                while not self.audio._transcript_queue.empty():
                    try:
                        next_event = self.audio._transcript_queue.get_nowait()
                        if next_event.is_final and next_event.text.strip():
                            logger.info(f"[DRAIN] Discarding stacked transcript: '{latest_event.text[:50]}'")
                            latest_event = next_event
                    except asyncio.QueueEmpty:
                        break
                event = latest_event

                # Create AgentInput and route through process(). Forward the STT
                # transcript_id as turn_id so audio-stage and agent-stage analytics
                # events share a single key for downstream joins. Forward the
                # independent language detection so the agent's resolver can use
                # the acoustic signal (falls back to text when absent, RFC §8.3).
                input_msg = AgentInput.text_input(
                    self._session_id or "",
                    event.text,
                    turn_id=getattr(event, "transcript_id", None),
                    detected_language=getattr(event, "detected_language", "") or "",
                    language_confidence=getattr(event, "language_confidence", 0.0) or 0.0,
                    is_barge_in=getattr(event, "is_barge_in", False),
                )

                # Process and stream response
                self._is_processing = True
                self._messages_processed += 1
                # Mark the turn active so a typed message (text barge-in, #278)
                # can pause or supersede it. Cleared in the finally below.
                self.audio.begin_turn()

                try:
                    current_transcript_id = None
                    tts_buffer = ""  # Tracks last accumulated text for diffing

                    async for output in self.process(input_msg):
                        # Generation-interrupt checkpoint (text barge-in, #278).
                        # This is a tool-safe boundary: process() just yielded, so
                        # any tool call awaiting between yields has already run to
                        # completion (and its result is preserved). A typed message
                        # arriving mid-turn may pause us here (suspend → resume from
                        # exactly this point) or supersede the turn (abort → stop
                        # emitting). With TTS disabled this is the ONLY thing that
                        # halts the superseded turn, so the interruption blocks only
                        # until the answer is generated, not until audio finishes.
                        if self.audio.is_turn_suspended:
                            if not await self.audio.await_turn_release():
                                logger.info("[TEXT BARGE-IN] Turn superseded while suspended — halting generation")
                                break
                        if self.audio.is_turn_aborted:
                            logger.info("[TEXT BARGE-IN] Turn aborted — halting generation")
                            break

                        logger.info(f"[AGENT OUTPUT] type={output.type}, content={output.content[:50] if output.content else 'None'}...")
                        if output.type == OutputType.TEXT_CHUNK:
                            # Get or create transcript_id for this response stream
                            if current_transcript_id is None:
                                current_transcript_id = output.transcript_id or f"response_{uuid.uuid4().hex[:8]}"
                                # Detect bridge vs response from transcript_id prefix (legacy)
                                tid = current_transcript_id
                                self._current_sentence_source = "bridge" if (tid.startswith("gate_ack_") or tid.startswith("gate_fallback_") or tid.startswith("bridge_")) else "response"
                                # New teleprompter transcript — reset the span cursor.
                                self._tp_transcript_id = current_transcript_id
                                self._tp_cursor = 0

                            # Explicit tts_source metadata overrides prefix detection
                            if output.metadata.get("tts_source"):
                                self._current_sentence_source = output.metadata["tts_source"]

                            # Resolved conversation language → drive the TTS voice
                            # so bridge and response are spoken coherently (RFC §8.2.1).
                            if output.metadata.get("language"):
                                self.audio.set_tts_language(output.metadata["language"])

                            # Per-stream voice selection (same contract as
                            # language): voice-selecting providers honor it,
                            # others disregard it inside the provider.
                            if output.metadata.get("voice"):
                                self.audio.set_tts_voice(output.metadata["voice"])

                            # Per-turn speaking rate (same contract again), so a
                            # conversation is not synthesised at one fixed rate
                            # and one fixed affect from start to finish.
                            if output.metadata.get("speed") is not None:
                                self.audio.set_tts_speed(output.metadata["speed"])

                            # Stream text to frontend (agent sends accumulated text)
                            await self.audio.publish_text(
                                output.content,
                                is_final=output.is_final,
                                transcript_id=current_transcript_id
                            )
                            # Teleprompter: the accumulated text just published
                            # is what sentence spans are measured against.
                            self._tp_text = output.content

                            # Sentence-level TTS: extract new text from accumulated content.
                            # output.content is the full accumulated text so far.
                            # Safety: if content doesn't extend tts_buffer (e.g. new
                            # transcript), reset and treat full content as new.
                            if output.content.startswith(tts_buffer):
                                new_text = output.content[len(tts_buffer):]
                            else:
                                new_text = output.content
                                self._sentence_buffer = ""
                            tts_buffer = output.content

                            # Check for sentence boundaries in the new text and dispatch
                            self._dispatch_sentences(new_text)

                            # If the buffer is a complete sentence (ends with
                            # punctuation) and this is NOT the final chunk,
                            # dispatch immediately. This handles the bridge:
                            # "Good question." is a complete sentence that
                            # should be synthesized right away, without
                            # waiting for the next output event.
                            if (
                                not output.is_final
                                and self._sentence_buffer
                                and self._sentence_buffer.rstrip()[-1:] in ".!?"
                                and not self._is_false_boundary(self._sentence_buffer)
                            ):
                                remaining = self._flush_sentence_buffer()
                                if remaining:
                                    self._enqueue_sentence(remaining, source=self._current_sentence_source)
                                    # After bridge sentence dispatched, revert to "response" for subsequent text
                                    if self._current_sentence_source == "bridge":
                                        self._current_sentence_source = "response"

                            if output.is_final:
                                # Flush any remaining partial sentence to TTS
                                remaining = self._flush_sentence_buffer()
                                if remaining:
                                    self._enqueue_sentence(remaining, source=self._current_sentence_source)
                                tts_buffer = ""
                                current_transcript_id = None
                                self._current_sentence_source = "response"

                        elif output.type == OutputType.TEXT_FINAL:
                            # Direct final response - publish and speak
                            if output.content.strip():
                                transcript_id = f"final_{uuid.uuid4().hex[:8]}"

                                # Publish to frontend as final
                                await self.audio.publish_text(
                                    output.content,
                                    is_final=True,
                                    transcript_id=transcript_id
                                )

                                # Send to TTS via sentence queue, tagged so the
                                # teleprompter can light up this final message.
                                self._tp_transcript_id = transcript_id
                                self._tp_text = output.content
                                self._tp_cursor = 0
                                self._enqueue_sentence(output.content)

                        else:
                            # All non-text side-channel outputs (DEBUG, STATUS,
                            # ERROR, METADATA, PROGRESS_UPDATE, ANALYTICS) share one
                            # payload mapping — see AgentOutput.to_data_payload.
                            payload = output.to_data_payload(self._agent_identity())
                            if payload is not None:
                                if output.type == OutputType.PROGRESS_UPDATE:
                                    # Store for re-sending to new participants.
                                    self._last_progress_payload = payload
                                logger.info(f"[{output.type.value}] Publishing: {payload}")
                                await self.audio._room.publish_data(payload)

                finally:
                    # Ensure all queued TTS sentences finish before accepting next
                    # input. On an aborted turn (text barge-in COMMIT) the speech
                    # queue was already drained by commit_interrupt(), so this
                    # returns promptly and nothing from the superseded turn plays.
                    await self.audio.flush_speech_queue()
                    self._sentence_buffer = ""
                    self._is_processing = False
                    # Turn fully done (generation halted/finished and TTS flushed):
                    # clear the active/suspend/abort state so the next turn starts
                    # clean and a committed barge-in turn isn't itself aborted.
                    self.audio.end_turn()

                # If the plan reached __end__ during this turn, stop accepting new input.
                # The farewell has already been spoken; exit the loop cleanly.
                if self._session_completed:
                    # Wait for any remaining TTS audio to finish playing on the
                    # client before sending the completion signal and disconnecting.
                    # flush_speech_queue (in the finally block above) ensures all
                    # sentences are synthesized, but the client needs extra time
                    # to play the audio through speakers.
                    await asyncio.sleep(3)

                    # Notify frontend that session is complete (triggers completion overlay).
                    await self.audio._room.publish_data({
                        "type": "session_completed",
                        "data": {}
                    })
                    # Brief delay to ensure the data message is delivered before disconnect.
                    await asyncio.sleep(1)
                    logger.info("Session completed — exiting audio loop")
                    break

    # ─────────────────────────────────────────────────────────────────────
    # Sentence-level TTS dispatch helpers
    # ─────────────────────────────────────────────────────────────────────

    # Sentence-ending pattern: ". " or "! " or "? " or "..." followed by
    # whitespace. We split on these boundaries so each TTS call gets a
    # natural sentence.
    _SENTENCE_END = re.compile(r'(?<=[.!?])\s+|(?<=\.\.\.)\s+')

    # Abbreviations whose trailing period is NOT a sentence end. Splitting after
    # these clips a tiny fragment ("Dr.", "etc.") into its own TTS call, which the
    # synthesizer renders as an unnatural standalone utterance (#304 B7).
    #
    # This list is deliberately CONSERVATIVE. The two failure modes are not
    # symmetric: a FALSE positive merges two legitimate sentences into one run-on
    # utterance (e.g. "The answer is no. Let me explain.") — the exact run-on this
    # feature exists to prevent — whereas a MISSED abbreviation only clips a rare
    # fragment. So we include ONLY tokens that are essentially never a standalone
    # sentence-final word, and exclude common words / units / names that can end a
    # sentence ("no", "min", "max", "al"/Al, "fig", "ca"/CA, "ms", "st", "nr").
    # German entries are the no-space forms ("d.h.", "z.B."); the spaced form
    # ("z. B.") is intentionally not special-cased — see _is_false_boundary.
    _ABBREVIATIONS = frozenset({
        # English titles / abbreviations
        "dr", "mr", "mrs", "prof", "sr", "jr", "vs", "etc", "e.g", "i.e",
        # German (no-space forms)
        "z.b", "u.a", "d.h", "u.s.w", "usw", "bzw", "evtl", "inkl", "z.t",
        "sog", "ggf", "geb", "bspw",
    })

    @classmethod
    def _is_false_boundary(cls, text: str) -> bool:
        """True if ``text`` ends on punctuation that does NOT end a sentence.

        Guards against splitting after a known abbreviation ("Dr.", "etc.",
        "d.h."). We do NOT treat a trailing single letter as an initial: that
        merged legitimate sentences ending in a letter ("vitamin D.", "plan B.",
        "grade A."), which is worse than the rare clipped initials sequence it
        would protect. Spaced German abbreviations ("z. B.") are likewise not
        special-cased — the agent speaks "zum Beispiel", and a clip there is a
        minor artifact, while mis-merging a real sentence is not.
        """
        stripped = text.rstrip()
        if not stripped or stripped[-1] not in ".!?":
            return False
        tokens = stripped.split()
        if not tokens:
            return False
        token = tokens[-1].rstrip(".!?").lower()
        return bool(token) and token in cls._ABBREVIATIONS

    def _enqueue_sentence(self, sentence: str, source: str = "response") -> None:
        """Enqueue a sentence for TTS, tagged with its character span in the
        published agent_text so the teleprompter can light it up as spoken.

        The span is located in the latest accumulated agent_text (``_tp_text``)
        starting at ``_tp_cursor``, which is then advanced — so a sentence that
        repeats later in the text still resolves to the correct occurrence.
        Falls back to a plain enqueue (no offsets) if the sentence can't be
        located, so TTS never depends on the lookup succeeding.
        """
        start = self._tp_text.find(sentence, self._tp_cursor) if sentence else -1
        if start >= 0 and self._tp_transcript_id is not None:
            end = start + len(sentence)
            self._tp_cursor = end
            self.audio.enqueue_sentence(
                sentence,
                source=source,
                transcript_id=self._tp_transcript_id,
                char_start=start,
                char_end=end,
            )
        else:
            # Sentence not located in the published agent_text (or no transcript
            # id yet) — speak it without offsets; it just won't be highlighted.
            # Log it so a silently-degraded teleprompter (e.g. TTS text drifting
            # from the published text) is diagnosable rather than invisible.
            if sentence:
                logger.debug(
                    "Teleprompter: sentence not located in agent_text "
                    "(tid=%s, cursor=%d) — speaking without highlight: %r",
                    self._tp_transcript_id, self._tp_cursor, sentence[:60],
                )
            self.audio.enqueue_sentence(sentence, source=source)

    def _dispatch_sentences(self, new_text: str) -> None:
        """Detect sentence boundaries in new_text and enqueue complete sentences.

        Accumulates text in self._sentence_buffer. When a sentence boundary
        is found (punctuation followed by whitespace), the complete sentence
        is dispatched to the TTS queue immediately.
        """
        self._sentence_buffer += new_text
        buf = self._sentence_buffer

        # Walk the boundaries in order. A boundary whose preceding token is an
        # abbreviation or initial (e.g. "Dr.", "z. B.") is a false positive —
        # we skip it WITHOUT advancing ``last_end`` so the fragment keeps
        # accumulating into the next candidate instead of being dispatched as a
        # clipped standalone utterance (#304 B7). finditer (not split) preserves
        # the original text and inter-sentence whitespace exactly.
        last_end = 0
        for m in self._SENTENCE_END.finditer(buf):
            candidate = buf[last_end:m.start()].strip()
            if not candidate:
                last_end = m.end()
                continue
            if self._is_false_boundary(candidate):
                continue
            self._enqueue_sentence(candidate, source=self._current_sentence_source)
            last_end = m.end()

        # Keep the remaining (incomplete) text in the buffer
        self._sentence_buffer = buf[last_end:]

    def _flush_sentence_buffer(self) -> str:
        """Flush and return any remaining text in the sentence buffer."""
        remaining = self._sentence_buffer.strip()
        self._sentence_buffer = ""
        return remaining
