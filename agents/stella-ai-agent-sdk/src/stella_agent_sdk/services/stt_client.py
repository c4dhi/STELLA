"""STT (Speech-to-Text) gRPC client for the STELLA Agent SDK."""

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import AsyncIterator, Callable, Optional

import grpc

logger = logging.getLogger(__name__)


@dataclass
class TranscriptEvent:
    """Transcript event from STT service."""

    text: str
    is_final: bool
    transcript_id: str
    participant_id: str
    confidence: float
    timestamp_ms: int
    speech_started: bool = False
    # VAD has heard enough CONTINUOUS speech to call this an interruption rather
    # than a backchannel. Emitted once per utterance, from VAD alone — no decode,
    # no text, so it does not carry transcription latency or language risk.
    speech_confirmed: bool = False
    # VAD has stopped hearing speech. Brackets speech_started, so the pair says
    # "the user is talking right now" — which is what the agent ducks against.
    speech_ended: bool = False
    # Independent per-utterance language detection (final events only).
    # ``detected_language`` is "" and confidence 0.0 when STT supplies no signal
    # (partials, short clips, typed text) — the agent then uses its text
    # classifier as the fallback signal (RFC §8.3).
    detected_language: str = ""
    language_confidence: float = 0.0
    # True when this transcript was produced by a committed barge-in and is
    # being injected as a new turn (set by the pipeline, not the STT service).
    is_barge_in: bool = False
    # Raw JSON from the STT decode-diagnostics pass; "" unless the STT service
    # has STT_DECODE_DIAGNOSTICS enabled. Forwarded verbatim — the SDK does not
    # interpret the schema, it only surfaces it for analytics.
    decode_diagnostics: str = ""

    @classmethod
    def from_proto(cls, proto) -> "TranscriptEvent":
        """Create TranscriptEvent from protobuf message."""
        return cls(
            text=proto.text,
            is_final=proto.is_final,
            transcript_id=proto.transcript_id,
            participant_id=proto.participant_id,
            confidence=proto.confidence,
            timestamp_ms=proto.timestamp_ms,
            speech_started=proto.speech_started,
            speech_confirmed=getattr(proto, "speech_confirmed", False),
            speech_ended=getattr(proto, "speech_ended", False),
            detected_language=getattr(proto, "detected_language", "") or "",
            language_confidence=getattr(proto, "language_confidence", 0.0) or 0.0,
            decode_diagnostics=getattr(proto, "decode_diagnostics", "") or "",
        )


class STTClient:
    """
    gRPC client for the STT (Speech-to-Text) service.

    This client handles bidirectional streaming: sending audio chunks
    and receiving transcript events in real-time.

    Example:
        ```python
        client = STTClient("stt-service:50051")
        await client.connect()

        async def audio_generator():
            while True:
                audio_chunk = get_audio_from_somewhere()
                yield audio_chunk

        async for event in client.stream_transcribe(
            audio_generator(),
            session_id="session-123",
            participant_id="user-456",
        ):
            if event.speech_started:
                print("User started speaking!")
            if event.is_final:
                print(f"Final transcript: {event.text}")
        ```
    """

    def __init__(self, stt_address: str):
        """
        Initialize the STT client.

        Args:
            stt_address: Address of the STT service (host:port)
        """
        self.stt_address = stt_address
        self._channel: Optional[grpc.aio.Channel] = None
        self._stub = None
        self._connected = False

    @property
    def is_connected(self) -> bool:
        """Whether connected to the STT service."""
        return self._connected

    async def connect(self, max_retries: int = 5, base_delay: float = 2.0) -> None:
        """
        Connect to the STT service with retry logic.

        Args:
            max_retries: Maximum number of connection attempts
            base_delay: Base delay between retries (exponential backoff)
        """
        if self._connected:
            return

        logger.info(f"Connecting to STT service at {self.stt_address}")

        last_error = None
        for attempt in range(max_retries):
            try:
                # Create gRPC channel
                if self._channel:
                    await self._channel.close()
                self._channel = grpc.aio.insecure_channel(self.stt_address)

                # Wait for channel to be ready
                await asyncio.wait_for(
                    self._channel.channel_ready(),
                    timeout=10.0,
                )
                # Success - exit retry loop
                break

            except asyncio.TimeoutError as e:
                last_error = e
                if attempt < max_retries - 1:
                    delay = base_delay * (2 ** attempt)
                    logger.warning(
                        f"STT connection attempt {attempt + 1}/{max_retries} timed out. "
                        f"Retrying in {delay:.1f}s..."
                    )
                    await asyncio.sleep(delay)
                else:
                    raise ConnectionError(
                        f"Timeout connecting to STT service at {self.stt_address} "
                        f"after {max_retries} attempts"
                    )
            except Exception as e:
                last_error = e
                if attempt < max_retries - 1:
                    delay = base_delay * (2 ** attempt)
                    logger.warning(
                        f"STT connection attempt {attempt + 1}/{max_retries} failed: {e}. "
                        f"Retrying in {delay:.1f}s..."
                    )
                    await asyncio.sleep(delay)
                else:
                    raise ConnectionError(
                        f"Failed to connect to STT service at {self.stt_address}: {last_error}"
                    )

        # Import and create stub dynamically (proto files may not be compiled yet)
        try:
            from stella_agent_sdk._grpc import stt_pb2, stt_pb2_grpc
            self._stub = stt_pb2_grpc.SpeechToTextStub(self._channel)
            self._pb2 = stt_pb2
        except ImportError:
            # Fall back to dynamic loading if compiled protos not available
            logger.warning("Compiled STT proto not found, using dynamic loading")
            self._stub = self._create_dynamic_stub()

        self._connected = True
        logger.info("Connected to STT service")

    def _create_dynamic_stub(self):
        """Create a dynamic gRPC stub from proto file."""
        # This is a fallback for when the proto isn't compiled
        # In production, protos should be pre-compiled
        raise NotImplementedError(
            "STT proto files not compiled. Run: "
            "python -m grpc_tools.protoc -I./proto --python_out=./src/stella_agent_sdk/_grpc "
            "--grpc_python_out=./src/stella_agent_sdk/_grpc ./proto/stt.proto"
        )

    async def disconnect(self) -> None:
        """Disconnect from the STT service."""
        if not self._connected:
            return

        if self._channel:
            await self._channel.close()
            self._channel = None

        self._stub = None
        self._connected = False
        logger.info("Disconnected from STT service")

    async def stream_transcribe(
        self,
        audio_stream: AsyncIterator[bytes],
        session_id: str,
        participant_id: str,
        sample_rate: int = 48000,
        language_provider: Optional["Callable[[], Optional[str]]"] = None,
    ) -> AsyncIterator[TranscriptEvent]:
        """
        Stream audio to STT and yield transcript events.

        Args:
            audio_stream: Async iterator yielding audio chunks (16-bit PCM)
            session_id: Session identifier for logging
            participant_id: Identity of the speaker
            sample_rate: Sample rate of the audio (default 48000 for LiveKit)
            language_provider: Optional callable returning the current resolved
                language hint (ISO 639-1) to stamp on each chunk. Read per chunk
                so the hint tracks the live conversation language. Returning
                None/"" leaves transcription on auto-detect.

        Yields:
            TranscriptEvent with:
            - text: Transcribed text
            - is_final: Whether utterance is complete
            - speech_started: VAD detected speech start (for barge-in)
            - detected_language / language_confidence: independent detection
        """
        if not self._connected:
            raise RuntimeError("Not connected to STT service")

        async def audio_chunk_generator():
            """Convert audio bytes to protobuf AudioChunk messages."""
            async for audio_data in audio_stream:
                language = (language_provider() or "") if language_provider else ""
                yield self._pb2.AudioChunk(
                    audio_data=audio_data,
                    session_id=session_id,
                    participant_id=participant_id,
                    timestamp_ms=int(time.time() * 1000),
                    sample_rate=sample_rate,
                    language=language,
                )

        try:
            # Start bidirectional stream
            response_stream = self._stub.StreamTranscribe(audio_chunk_generator())

            # Yield transcript events
            async for event in response_stream:
                yield TranscriptEvent.from_proto(event)

        except grpc.RpcError as e:
            logger.error(f"STT stream error: {e}")
            raise

    async def health_check(self) -> bool:
        """Check if the STT service is healthy."""
        if not self._connected:
            return False

        try:
            response = await self._stub.HealthCheck(self._pb2.Empty())
            return response.healthy
        except Exception as e:
            logger.error(f"STT health check failed: {e}")
            return False

    async def warmup(
        self,
        session_id: str = "",
        duration_ms: int = 1000,
        timeout: float = 30.0,
    ) -> dict:
        """
        Warm up the STT model to eliminate cold-start latency.

        This should be called when an agent connects, before any user speech.
        The STT service maintains warmup state with a TTL, so repeated calls
        within the TTL window are fast no-ops.

        Args:
            session_id: Optional session ID for logging
            duration_ms: Duration of dummy audio to process (default 1000ms)
            timeout: Maximum time to wait for warmup (default 30s)

        Returns:
            Dict with warmup result:
            - success: bool - whether warmup succeeded
            - warmup_time_ms: int - time taken in milliseconds
            - provider: str - which provider was warmed up
            - message: str - status or error message
        """
        if not self._connected:
            return {
                "success": False,
                "warmup_time_ms": 0,
                "provider": "unknown",
                "message": "Not connected to STT service",
            }

        try:
            request = self._pb2.WarmupRequest(
                session_id=session_id,
                duration_ms=duration_ms,
            )
            response = await asyncio.wait_for(
                self._stub.Warmup(request),
                timeout=timeout,
            )
            return {
                "success": response.success,
                "warmup_time_ms": response.warmup_time_ms,
                "provider": response.provider,
                "message": response.message,
            }
        except asyncio.TimeoutError:
            logger.warning(f"STT warmup timed out after {timeout}s")
            return {
                "success": False,
                "warmup_time_ms": int(timeout * 1000),
                "provider": "unknown",
                "message": f"Warmup timed out after {timeout}s",
            }
        except Exception as e:
            logger.error(f"STT warmup failed: {e}")
            return {
                "success": False,
                "warmup_time_ms": 0,
                "provider": "unknown",
                "message": f"Warmup error: {e}",
            }
