"""Abstract base class for STT providers."""

from abc import ABC, abstractmethod
from typing import List, Optional
import stt_pb2


class STTSession(ABC):
    """Abstract base for session state management.

    Each session handles audio streaming for a single participant.
    The session maintains state across audio chunks and emits
    TranscriptEvent messages (partial and final).
    """

    @abstractmethod
    def process_audio(self, audio_data: bytes, sample_rate: int = 16000) -> List[stt_pb2.TranscriptEvent]:
        """Process an audio chunk and return transcript events.

        Args:
            audio_data: Raw PCM audio (16-bit, mono)
            sample_rate: Sample rate of the input audio (default 16000).
                         Provider will resample to model's required rate if needed.

        Returns:
            List of TranscriptEvent (may be empty, partial, or final)
        """
        pass

    @abstractmethod
    def reset(self) -> None:
        """Reset session state for a new utterance."""
        pass

    def set_language_hint(self, language: Optional[str]) -> None:
        """Apply an optional language hint from the agent (no-op by default).

        Providers that support language steering (e.g. Whisper) override this.
        Others ignore the hint — language detection stays independent either way.
        """
        return None


class STTProvider(ABC):
    """Abstract base class for STT providers.

    All STT providers must implement this interface to ensure consistent
    behavior across different engines (Sherpa-ONNX, faster-whisper, etc.).
    """

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the provider name (e.g., 'sherpa', 'whisper')."""
        pass

    @property
    @abstractmethod
    def is_available(self) -> bool:
        """Check if this provider's dependencies are installed."""
        pass

    @abstractmethod
    async def initialize(self) -> bool:
        """Initialize the STT provider (load models, etc.).

        Returns:
            True if initialization was successful, False otherwise.
        """
        pass

    @abstractmethod
    def create_session(self, session_id: str, participant_id: str) -> Optional[STTSession]:
        """Create a new transcription session.

        Args:
            session_id: Unique session identifier
            participant_id: Identity of the speaker

        Returns:
            STTSession instance or None if provider not ready.
        """
        pass

    @abstractmethod
    async def cleanup(self) -> None:
        """Clean up any resources held by the provider."""
        pass

    async def warmup(self, duration_ms: int = 1000) -> bool:
        """Warm up provider to eliminate cold-start latency.

        Default implementation is a no-op. Subclasses (like WhisperProvider)
        should override this to run dummy inference and prime GPU caches.

        Args:
            duration_ms: Duration of dummy audio to process (default 1000ms)

        Returns:
            True if warmup was successful, False otherwise.
        """
        return True

    def start_keepalive(self) -> None:
        """Start background work that keeps the model warm. No-op by default."""

    def note_language(self, language: Optional[str]) -> None:
        """A session declared this language; providers may use it to warm up. No-op by default."""

    def get_capabilities(self) -> dict:
        """Return provider capabilities.

        Returns:
            Dict with capabilities like:
            {
                "supports_streaming": True,
                "supports_gpu": True,
                "supported_languages": ["en", "de"],
                "model_size_mb": 180,
            }
        """
        return {
            "supports_streaming": True,
            "supports_gpu": False,
        }
