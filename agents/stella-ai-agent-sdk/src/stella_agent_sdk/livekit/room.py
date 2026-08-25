"""LiveKit Room Manager for direct room connections."""

import asyncio
from collections import deque
import json
import logging
import os
import time
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

import jwt
import numpy as np

from stella_agent_sdk.env import env_bool

logger = logging.getLogger(__name__)

# Try to import livekit - it's optional for agents that don't use direct audio
try:
    from livekit import rtc
    LIVEKIT_AVAILABLE = True
    # Try to import AudioProcessingModule for AEC
    try:
        from livekit.rtc import AudioProcessingModule
        AEC_AVAILABLE = True
    except ImportError:
        AudioProcessingModule = None
        AEC_AVAILABLE = False
        logger.warning("AudioProcessingModule not available. Echo cancellation disabled.")
except ImportError:
    rtc = None
    LIVEKIT_AVAILABLE = False
    AEC_AVAILABLE = False
    AudioProcessingModule = None
    logger.warning("livekit-rtc not installed. Direct room connections unavailable.")


class RoomManager:
    """
    Manages LiveKit room connection and audio tracks.

    This class handles:
    - Connecting to LiveKit rooms with JWT authentication
    - Subscribing to remote audio tracks (user audio)
    - Publishing local audio tracks (TTS output)
    - Data channel communication

    Audio is streamed as raw PCM bytes:
    - Input: 16kHz, 16-bit, mono (from user via STT)
    - Output: 24kHz, 16-bit, mono (to user via TTS)
    """

    def __init__(
        self,
        livekit_url: str,
        api_key: str,
        api_secret: str,
    ):
        """
        Initialize the RoomManager.

        Args:
            livekit_url: WebSocket URL for LiveKit server (e.g., ws://localhost:7880)
            api_key: LiveKit API key for JWT signing
            api_secret: LiveKit API secret for JWT signing
        """
        if not LIVEKIT_AVAILABLE:
            raise RuntimeError(
                "livekit-rtc is not installed. "
                "Install with: pip install livekit"
            )

        self.livekit_url = livekit_url
        self.api_key = api_key
        self.api_secret = api_secret

        self._room: Optional[rtc.Room] = None
        self._audio_source: Optional[rtc.AudioSource] = None
        # FIFO for publish_data_ordered — see the note there on why ordering
        # cannot be left to asyncio task scheduling.
        self._outbound: deque = deque()
        self._outbound_task: Optional[asyncio.Task] = None
        self._audio_track: Optional[rtc.LocalAudioTrack] = None
        self._connected = False

        # Audio stream management
        self._audio_queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._subscribed_tracks: Dict[str, rtc.RemoteAudioTrack] = {}
        self._audio_streams: Dict[str, rtc.AudioStream] = {}
        self._stream_tasks: Dict[str, asyncio.Task] = {}

        # Audio sample rate tracking (updated from first frame received from LiveKit)
        self._audio_sample_rate: int = 48000  # Default to 48kHz (WebRTC standard)

        # Participant name tracking (identity -> display name)
        self._participant_names: Dict[str, str] = {}

        # Track the current audio source (identity of participant whose audio we're processing)
        # Updated whenever audio is received from a participant
        self._current_audio_speaker: Optional[str] = None

        # Callbacks
        self._on_participant_joined: Optional[Callable[[str], None]] = None
        self._on_participant_left: Optional[Callable[[str], None]] = None
        self._on_data_received: Optional[Callable[[str, bytes], None]] = None

        # Acoustic Echo Cancellation (AEC)
        # Can be disabled via environment variable for debugging
        aec_disabled_by_env = env_bool("DISABLE_AEC", False)
        if aec_disabled_by_env:
            logger.info("[AEC] Disabled via DISABLE_AEC environment variable")
            print("[AEC] Disabled via DISABLE_AEC environment variable")
            self._aec_enabled = False
        else:
            self._aec_enabled = AEC_AVAILABLE
        self._apm: Optional["AudioProcessingModule"] = None
        if self._aec_enabled and AudioProcessingModule:
            try:
                self._apm = AudioProcessingModule(
                    echo_cancellation=True,
                    noise_suppression=True,
                    high_pass_filter=True,
                    auto_gain_control=True,
                )
                # Set stream delay (estimated round-trip through speakers/mic)
                # Typical values: 50-150ms depending on hardware
                self._apm.set_stream_delay_ms(100)
                logger.info("[AEC] AudioProcessingModule initialized with echo cancellation")
                print("[AEC] AudioProcessingModule initialized with echo cancellation")
            except Exception as e:
                logger.error(f"[AEC] Failed to initialize AudioProcessingModule: {e}")
                print(f"[AEC] Failed to initialize: {e}")
                self._aec_enabled = False
                self._apm = None

        # AEC frame buffers (APM requires 10ms frames)
        # At 48kHz (input), 10ms = 480 samples
        # At 24kHz (TTS), 10ms = 240 samples
        self._aec_input_buffer: List[np.ndarray] = []
        self._aec_tts_buffer: List[np.ndarray] = []
        self._aec_10ms_samples_48k = 480  # 10ms at 48kHz
        self._aec_10ms_samples_24k = 240  # 10ms at 24kHz

    @property
    def is_connected(self) -> bool:
        """Whether connected to a LiveKit room."""
        return self._connected

    @property
    def room(self) -> Optional[rtc.Room]:
        """The underlying LiveKit Room instance."""
        return self._room

    @property
    def audio_sample_rate(self) -> int:
        """Sample rate of incoming audio from LiveKit (updated on first frame)."""
        return self._audio_sample_rate

    @property
    def current_audio_speaker(self) -> Optional[str]:
        """Identity of the participant whose audio was most recently received."""
        return self._current_audio_speaker

    def get_participant_name(self, identity: str) -> Optional[str]:
        """
        Get the display name for a participant by their identity.

        Args:
            identity: The LiveKit participant identity (e.g., 'human')

        Returns:
            The participant's display name, or None if not found
        """
        return self._participant_names.get(identity)

    def _generate_token(self, room_name: str, identity: str, name: Optional[str] = None) -> str:
        """Generate a JWT token for LiveKit authentication."""
        now = int(time.time())
        claims = {
            "iss": self.api_key,
            "sub": identity,
            "iat": now,
            "exp": now + 3600,  # 1 hour expiry
            "nbf": now,
            "video": {
                "roomJoin": True,
                "room": room_name,
                "canPublish": True,
                "canSubscribe": True,
                "canPublishData": True,
            },
        }
        # Add display name if provided
        if name:
            claims["name"] = name
        return jwt.encode(claims, self.api_secret, algorithm="HS256")

    async def connect(self, room_name: str, identity: str, name: Optional[str] = None) -> None:
        """
        Join a LiveKit room.

        Args:
            room_name: Name of the room to join
            identity: Participant identity (e.g., "agent-abc123")
            name: Display name for the participant (shown in UI)
        """
        if self._connected:
            logger.warning("Already connected to a room")
            return

        logger.info(f"Connecting to LiveKit room: {room_name} as {identity} (name: {name})")

        # Generate JWT token with display name
        token = self._generate_token(room_name, identity, name)

        # Create room instance
        self._room = rtc.Room()

        # Set up event handlers
        self._room.on("track_subscribed", self._on_track_subscribed)
        self._room.on("track_unsubscribed", self._on_track_unsubscribed)
        self._room.on("participant_connected", self._on_participant_connected)
        self._room.on("participant_disconnected", self._on_participant_disconnected)
        self._room.on("data_received", self._on_data_received_handler)

        # Connect to room
        await self._room.connect(self.livekit_url, token)
        print(f"[ROOM] Connected to LiveKit room: {room_name}")

        # Capture existing participants and their tracks
        # (they won't trigger participant_connected or track_subscribed events)
        print(f"[ROOM] Scanning {len(self._room.remote_participants)} existing participants...")
        for identity, participant in self._room.remote_participants.items():
            print(f"[ROOM] Found participant: {identity} (name={participant.name})")
            if participant.name:
                self._participant_names[identity] = participant.name
                logger.debug(f"Captured existing participant: {identity} -> {participant.name}")

            # Process any existing subscribed audio tracks
            print(f"[ROOM]   Track publications: {len(participant.track_publications)}")
            for pub_sid, publication in participant.track_publications.items():
                print(f"[ROOM]   - Publication {pub_sid}: track={publication.track}, kind={publication.kind}, subscribed={publication.subscribed}")
                if (publication.track and
                    publication.track.kind == rtc.TrackKind.KIND_AUDIO and
                    publication.subscribed):
                    print(f"[ROOM]   -> Found existing subscribed audio track from {identity}")
                    logger.info(f"Found existing subscribed audio track from {identity}")
                    self._handle_existing_audio_track(identity, publication.track)

        # Set up audio publishing
        await self._setup_audio_publishing()

        self._connected = True
        logger.info(f"Connected to room: {room_name}")

    async def disconnect(self) -> None:
        """Leave the room and cleanup resources."""
        if not self._connected:
            return

        logger.info("Disconnecting from LiveKit room")

        # Stop the ordered-publish drain and drop anything still queued —
        # the room is going away, so those envelopes have nowhere to land.
        if self._outbound_task is not None and not self._outbound_task.done():
            self._outbound_task.cancel()
        self._outbound_task = None
        self._outbound.clear()

        # Cancel all stream reading tasks
        for task in self._stream_tasks.values():
            task.cancel()
        self._stream_tasks.clear()

        # Close audio streams
        for stream in self._audio_streams.values():
            await stream.aclose()
        self._audio_streams.clear()
        self._subscribed_tracks.clear()

        # Disconnect from room
        if self._room:
            await self._room.disconnect()
            self._room = None

        self._audio_source = None
        self._audio_track = None
        self._connected = False

        logger.info("Disconnected from room")

    async def _setup_audio_publishing(self) -> None:
        """Set up local audio track for publishing TTS output."""
        if not self._room:
            return

        # Create audio source (24kHz, mono, 16-bit - matches TTS output).
        #
        # queue_size_ms bounds how far ahead of real-time playout the agent may
        # push audio. LiveKit's default is 1000ms. For barge-in we want a small
        # buffer so "last frame pushed" stays close to "currently heard" — that
        # bounds both the position error and how much audible audio survives a
        # clear_queue() on interruption. Tunable via TTS_PLAYOUT_BUFFER_MS;
        # defaults to LiveKit's 1000ms so non-barge-in deployments are unchanged.
        try:
            queue_size_ms = int(os.getenv("TTS_PLAYOUT_BUFFER_MS", "1000"))
        except ValueError:
            queue_size_ms = 1000
        queue_size_ms = max(10, queue_size_ms)
        self._playout_buffer_ms = queue_size_ms
        self._audio_source = rtc.AudioSource(
            sample_rate=24000,
            num_channels=1,
            queue_size_ms=queue_size_ms,
        )
        logger.info(f"Audio source created with queue_size_ms={queue_size_ms}")

        # Create local audio track
        self._audio_track = rtc.LocalAudioTrack.create_audio_track(
            "agent-audio",
            self._audio_source,
        )

        # Publish track
        options = rtc.TrackPublishOptions(
            source=rtc.TrackSource.SOURCE_MICROPHONE,
            dtx=False,  # Disable DTX for continuous audio
        )
        await self._room.local_participant.publish_track(self._audio_track, options)

        logger.info("Published agent audio track")

    def _handle_existing_audio_track(self, identity: str, track: rtc.Track) -> None:
        """
        Handle an existing audio track that was already subscribed when we joined.

        This is called during connect() for tracks that existed before our event
        handlers were set up.
        """
        if identity in self._subscribed_tracks:
            logger.debug(f"Already tracking audio from {identity}, skipping")
            return

        logger.info(f"Setting up audio stream for existing track from {identity}")
        self._subscribed_tracks[identity] = track

        # Create audio stream for this track
        audio_stream = rtc.AudioStream(track)
        self._audio_streams[identity] = audio_stream

        # Start a task to read from this stream and put frames into the queue
        task = asyncio.create_task(
            self._read_audio_stream(identity, audio_stream)
        )
        self._stream_tasks[identity] = task

    def _on_track_subscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        """Handle track subscription."""
        print(f"[ROOM] track_subscribed event: kind={track.kind}, participant={participant.identity}")
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            # Skip if we already set this up (e.g., from existing track handling)
            if participant.identity in self._subscribed_tracks:
                print(f"[ROOM] WARNING: Already tracking audio from {participant.identity}, skipping duplicate")
                logger.debug(f"Track subscription event for {participant.identity}, but already tracking")
                return

            print(f"[ROOM] Subscribing to NEW audio track from {participant.identity}")
            logger.info(f"Subscribed to audio track from {participant.identity}")
            self._subscribed_tracks[participant.identity] = track

            # Create audio stream for this track
            audio_stream = rtc.AudioStream(track)
            self._audio_streams[participant.identity] = audio_stream

            # Start a task to read from this stream and put frames into the queue
            task = asyncio.create_task(
                self._read_audio_stream(participant.identity, audio_stream)
            )
            self._stream_tasks[participant.identity] = task

    async def _read_audio_stream(self, identity: str, stream: rtc.AudioStream) -> None:
        """Read audio frames from a stream and put them in the queue."""
        frame_count = 0
        aec_frame_count = 0
        try:
            print(f"[ROOM] Starting audio stream reader for {identity}")
            logger.info(f"Starting audio stream reader for {identity}")
            async for frame_event in stream:
                if not self._connected:
                    print(f"[ROOM] Room disconnected, stopping audio stream for {identity}")
                    logger.info(f"Room disconnected, stopping audio stream for {identity}")
                    break
                frame = frame_event.frame
                frame_count += 1

                # Track who is speaking (for attribution in transcripts)
                self._current_audio_speaker = identity

                if frame_count == 1:
                    # Track sample rate from first frame received
                    self._audio_sample_rate = frame.sample_rate
                    print(f"[ROOM] FIRST audio frame from {identity}: {len(frame.data.tobytes())} bytes, {frame.sample_rate}Hz")
                    print(f"[ROOM] AEC enabled: {self._aec_enabled}")
                    logger.info(f"First audio frame from {identity}: sample_rate={frame.sample_rate}Hz, channels={frame.num_channels}")
                    logger.info(f"Audio sample rate set to {self._audio_sample_rate}Hz")
                elif frame_count % 500 == 0:
                    print(f"[ROOM] Received {frame_count} audio frames from {identity} (AEC processed: {aec_frame_count})")

                # Apply AEC to remove TTS echo from microphone input
                if self._aec_enabled and self._apm:
                    processed_frames = self._process_stream_aec(frame)
                    aec_frame_count += len(processed_frames)
                    for processed_frame in processed_frames:
                        await self._audio_queue.put(processed_frame.data.tobytes())
                else:
                    # No AEC - pass through directly
                    await self._audio_queue.put(frame.data.tobytes())

        except asyncio.CancelledError:
            print(f"[ROOM] Audio stream task cancelled for {identity}")
            logger.debug(f"Audio stream task cancelled for {identity}")
        except Exception as e:
            print(f"[ROOM] ERROR reading audio stream from {identity}: {e}")
            logger.error(f"Error reading audio stream from {identity}: {e}", exc_info=True)
        finally:
            print(f"[ROOM] Audio stream reader ended for {identity} after {frame_count} frames")
            logger.info(f"Audio stream reader ended for {identity} after {frame_count} frames")

    def _process_stream_aec(self, frame: "rtc.AudioFrame") -> List["rtc.AudioFrame"]:
        """
        Process incoming microphone audio through AEC to remove TTS echo.
        Buffers audio and processes in 10ms chunks as required by APM.

        Args:
            frame: Incoming audio frame from microphone (typically 48kHz)

        Returns:
            List of processed 10ms AudioFrames with echo removed
        """
        if not self._apm:
            return [frame]

        processed_frames = []
        try:
            # Get audio data as numpy array
            audio_int16 = np.frombuffer(frame.data, dtype=np.int16)
            sample_rate = frame.sample_rate

            # Calculate 10ms chunk size for this sample rate
            samples_10ms = sample_rate // 100  # 10ms = 1/100 second

            # Add to buffer
            self._aec_input_buffer.append(audio_int16)
            total_samples = sum(len(chunk) for chunk in self._aec_input_buffer)

            # Process in 10ms chunks
            while total_samples >= samples_10ms:
                # Concatenate and extract 10ms chunk
                combined = np.concatenate(self._aec_input_buffer)
                chunk_10ms = combined[:samples_10ms].copy()  # Copy to ensure contiguous
                remainder = combined[samples_10ms:]

                # Create AudioFrame for APM processing (10ms)
                aec_frame = rtc.AudioFrame(
                    data=chunk_10ms.tobytes(),
                    sample_rate=sample_rate,
                    num_channels=1,
                    samples_per_channel=samples_10ms,
                )

                # Process stream - removes echo based on reverse stream reference
                # Frame is modified in-place
                self._apm.process_stream(aec_frame)

                processed_frames.append(aec_frame)

                # Update buffer with remainder
                if len(remainder) > 0:
                    self._aec_input_buffer = [remainder]
                else:
                    self._aec_input_buffer = []
                total_samples = len(remainder)

        except Exception as e:
            logger.error(f"[AEC] Error processing stream: {e}")
            # On error, return original frame
            return [frame]

        return processed_frames

    def _on_track_unsubscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        """Handle track unsubscription."""
        if participant.identity in self._subscribed_tracks:
            del self._subscribed_tracks[participant.identity]
        if participant.identity in self._audio_streams:
            del self._audio_streams[participant.identity]
        if participant.identity in self._stream_tasks:
            self._stream_tasks[participant.identity].cancel()
            del self._stream_tasks[participant.identity]
            logger.info(f"Unsubscribed from audio track from {participant.identity}")

        # If no audio sources remain, signal end-of-audio to consumers so the
        # in-flight STT utterance finalizes instead of stalling on the unmute
        # that never comes (issue #165).
        if not self._audio_streams:
            try:
                self._audio_queue.put_nowait(b"")
            except asyncio.QueueFull:
                # Drop the oldest frame to make room — the sentinel matters
                # more than any single buffered chunk.
                try:
                    self._audio_queue.get_nowait()
                    self._audio_queue.put_nowait(b"")
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    pass

    def _on_participant_connected(self, participant: rtc.RemoteParticipant) -> None:
        """Handle participant joining."""
        logger.info(f"Participant joined: {participant.identity} (name: {participant.name})")
        # Store participant name for speaker attribution
        if participant.name:
            self._participant_names[participant.identity] = participant.name
        if self._on_participant_joined:
            self._on_participant_joined(participant.identity)

    def _on_participant_disconnected(self, participant: rtc.RemoteParticipant) -> None:
        """Handle participant leaving."""
        logger.info(f"Participant left: {participant.identity}")
        if self._on_participant_left:
            self._on_participant_left(participant.identity)

    def _on_data_received_handler(self, packet: rtc.DataPacket) -> None:
        """Handle data channel message."""
        identity = packet.participant.identity if packet.participant else "unknown"
        if self._on_data_received:
            self._on_data_received(identity, packet.data)

    @property
    def queued_playout_ms(self) -> float:
        """Milliseconds of TTS audio buffered in the output source but not yet
        played out to the client. Used to estimate the true playout position
        (frames pushed minus this) for barge-in. Zero if no source exists."""
        if not self._audio_source:
            return 0.0
        try:
            # livekit AudioSource exposes queued_duration in seconds.
            return float(self._audio_source.queued_duration) * 1000.0
        except Exception:
            return 0.0

    def clear_playout(self) -> None:
        """Drop all TTS audio buffered in the output source that has not yet
        played out.

        This is the server-side half of a hard barge-in: it discards the
        up-to-``queue_size_ms`` of already-captured-but-unplayed audio sitting
        in the AudioSource so playback stops promptly instead of draining the
        whole buffer. The client must also silence locally to drop its own
        jitter buffer; together those stop audio without it resuming later.
        """
        if not self._audio_source:
            return
        try:
            self._audio_source.clear_queue()
            logger.info("[ROOM] Cleared TTS playout queue (barge-in)")
        except Exception as e:
            logger.error(f"[ROOM] Failed to clear playout queue: {e}")

    def flush_audio_queue(self) -> None:
        """Flush all buffered audio frames from the queue.

        Called by AudioPipeline when opening the transcript gate to discard
        any echo frames that were queued during the gate period.
        """
        flushed = 0
        while not self._audio_queue.empty():
            try:
                self._audio_queue.get_nowait()
                flushed += 1
            except asyncio.QueueEmpty:
                break
        if flushed > 0:
            logger.info(f"[ROOM] Flushed {flushed} buffered audio frames")

    async def subscribe_to_audio(self) -> AsyncIterator[bytes]:
        """
        Yield audio chunks from subscribed remote tracks.

        Yields:
            Audio chunks as raw bytes (16kHz, 16-bit PCM, mono)
        """
        if not self._connected:
            raise RuntimeError("Not connected to a room")

        while self._connected:
            try:
                # Get audio data from queue with timeout
                audio_data = await asyncio.wait_for(
                    self._audio_queue.get(),
                    timeout=0.5,
                )
                if audio_data == b"":
                    # End-of-audio sentinel from _on_track_unsubscribed: stop
                    # the iterator so the STT bidi stream finalizes the current
                    # utterance. The pipeline will start a new stream when audio
                    # resumes.
                    return
                yield audio_data
            except asyncio.TimeoutError:
                # No audio available, continue waiting
                continue
            except asyncio.CancelledError:
                break

    async def publish_audio(self, audio_data: bytes) -> None:
        """
        Publish audio chunk to the room.

        Args:
            audio_data: Raw PCM audio bytes (24kHz, 16-bit, mono expected)
        """
        if not self._audio_source:
            logger.warning("Audio source not initialized")
            return

        try:
            # Convert bytes to numpy array
            audio_int16 = np.frombuffer(audio_data, dtype=np.int16)

            # Feed TTS audio to AEC as reverse stream (far-end reference)
            # This allows AEC to learn what echo to cancel from microphone input
            if self._aec_enabled and self._apm:
                self._process_reverse_stream_24k(audio_int16)

            # Create AudioFrame (LiveKit requires bytes, not numpy array)
            frame = rtc.AudioFrame(
                data=audio_int16.tobytes(),
                sample_rate=24000,
                num_channels=1,
                samples_per_channel=len(audio_int16),
            )

            # Capture frame to source
            await self._audio_source.capture_frame(frame)

        except Exception as e:
            logger.error(f"Error publishing audio: {e}")

    def _process_reverse_stream_24k(self, audio_int16: np.ndarray) -> None:
        """
        Process TTS audio through AEC reverse stream (far-end reference).
        Buffers audio and processes in 10ms chunks as required by APM.

        Args:
            audio_int16: TTS audio samples at 24kHz
        """
        if not self._apm:
            return

        try:
            # Add to buffer
            self._aec_tts_buffer.append(audio_int16)
            total_samples = sum(len(chunk) for chunk in self._aec_tts_buffer)

            # Process in 10ms chunks (240 samples at 24kHz)
            while total_samples >= self._aec_10ms_samples_24k:
                # Concatenate and extract 10ms chunk
                combined = np.concatenate(self._aec_tts_buffer)
                chunk_10ms = combined[:self._aec_10ms_samples_24k]
                remainder = combined[self._aec_10ms_samples_24k:]

                # Create AudioFrame for APM (10ms at 24kHz)
                frame = rtc.AudioFrame(
                    data=chunk_10ms.tobytes(),
                    sample_rate=24000,
                    num_channels=1,
                    samples_per_channel=self._aec_10ms_samples_24k,
                )

                # Process reverse stream (far-end TTS audio)
                self._apm.process_reverse_stream(frame)

                # Update buffer with remainder
                if len(remainder) > 0:
                    self._aec_tts_buffer = [remainder]
                else:
                    self._aec_tts_buffer = []
                total_samples = len(remainder)

        except Exception as e:
            logger.error(f"[AEC] Error processing reverse stream: {e}")

    async def publish_data(
        self,
        data: Dict[str, Any],
        topic: str = "",
        reliable: bool = True,
    ) -> None:
        """
        Publish data message to the room.

        Args:
            data: Dictionary to send (will be JSON-encoded)
            topic: Optional topic for the message
            reliable: Whether to use reliable delivery (default True)
        """
        if not self._room:
            logger.warning("Not connected to a room")
            return

        try:
            payload = json.dumps(data).encode("utf-8")
            logger.info(f"[ROOM] Publishing data: type={data.get('type', 'unknown')}, topic={topic}, reliable={reliable}")
            await self._room.local_participant.publish_data(
                payload,
                reliable=reliable,
                topic=topic,
            )
            logger.info(f"[ROOM] Data published successfully")

        except Exception as e:
            logger.error(f"Error publishing data: {e}")

    def publish_data_ordered(
        self,
        data: Dict[str, Any],
        topic: str = "",
        reliable: bool = True,
    ) -> None:
        """Queue a data message, preserving CALL order on the wire.

        The obvious way to publish without blocking the caller is
        ``asyncio.create_task(publish_data(...))``, but that hands ordering to
        the scheduler: two envelopes emitted back to back become two
        independent tasks, and whichever wins the race reaches the wire first.
        Reliable delivery preserves the order of SENDS, not the order of calls,
        so it cannot save this.

        That is a real defect for anything stateful. Speech progress is the
        clear case — ``spoken`` for one sentence overtaking ``speaking`` for the
        next makes the teleprompter jump backwards, and the client's barge-in
        silencing reads the same channel. It stayed hidden while sentences were
        seconds apart and surfaced once streaming playback started emitting them
        microseconds apart.

        This keeps the non-blocking property (the caller still returns at once)
        and adds the guarantee the caller actually assumed: FIFO.
        """
        self._outbound.append((data, topic, reliable))
        if self._outbound_task is None or self._outbound_task.done():
            self._outbound_task = asyncio.create_task(self._drain_outbound())

    async def _drain_outbound(self) -> None:
        """Publish queued data messages one at a time, in order."""
        while self._outbound:
            data, topic, reliable = self._outbound.popleft()
            try:
                await self.publish_data(data, topic=topic, reliable=reliable)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # One bad envelope must not strand the ones behind it.
                logger.error(f"Error publishing queued data: {e}")

    def on_participant_joined(self, callback: Callable[[str], None]) -> None:
        """Register callback for participant join events."""
        self._on_participant_joined = callback

    def on_participant_left(self, callback: Callable[[str], None]) -> None:
        """Register callback for participant leave events."""
        self._on_participant_left = callback

    def on_data_received(self, callback: Callable[[str, bytes], None]) -> None:
        """Register callback for data channel messages."""
        self._on_data_received = callback
