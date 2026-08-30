"""Sherpa-ONNX STT provider - lightweight streaming model."""

import os
import time
import uuid
from typing import List, Optional
import numpy as np

from .base import STTProvider, STTSession
import stt_pb2

# Try to import sherpa-onnx
try:
    import sherpa_onnx
    SHERPA_AVAILABLE = True
except ImportError as e:
    print(f"[SherpaProvider] sherpa-onnx not available: {e}")
    sherpa_onnx = None
    SHERPA_AVAILABLE = False


class SherpaSession(STTSession):
    """Sherpa-ONNX session state management."""

    def __init__(self, session_id: str, participant_id: str, recognizer, create_stream_fn, config: dict = None):
        self.session_id = session_id
        self.participant_id = participant_id
        self.recognizer = recognizer
        self.create_stream_fn = create_stream_fn
        self.stream = create_stream_fn() if recognizer else None
        self.config = config or {}

        # Transcript tracking
        self.accumulated_text = ''
        self.transcript_id = f"transcript_{uuid.uuid4().hex[:8]}"
        self.chunk_count = 0

        # Timing
        self.last_activity = time.time()
        self.last_speech_activity = time.time()
        self.silence_start_time = None

        # Speech detection state
        self.speech_active = False  # Track if we're currently in a speech segment

        # Configurable thresholds (from config or defaults)
        self.silence_threshold = self.config.get('silence_threshold', 1.5)  # seconds
        self.speech_timeout = self.config.get('speech_timeout', 10.0)  # force endpoint after 10s
        # Energy gate, and on this provider the ONLY thing separating speech
        # from noise — there is no Silero pass here the way there is in the
        # whisper provider. At the old 0.001 (-60 dB) that made any audible
        # sound "speech": traffic through a window, a fan, a TV in the next
        # room. Every one of those emitted speech_started, which ducks the
        # agent mid-sentence. 0.008 is the level the whisper provider already
        # uses for the same job (-42 dB, ambient noise below, speech above).
        self.rms_threshold = self.config.get('rms_threshold', 0.008)

        # Pre-buffer for initial speech (same as Whisper)
        self.pre_buffer = []
        self.pre_buffer_samples = self.config.get('pre_buffer_samples', 8000)  # 0.5s

        # Minimum transcript length filter
        self.min_transcript_chars = self.config.get('min_transcript_chars', 3)

        # Processing state
        self.processing_endpoint = False
        self.last_final_text = ""
        self.last_final_time = 0

    def process_audio(self, audio_data: bytes, sample_rate: int = 16000) -> List[stt_pb2.TranscriptEvent]:
        """Process audio chunk and return any transcript events.

        Args:
            audio_data: Raw PCM audio bytes (16-bit signed)
            sample_rate: Sample rate of the input audio (default 16000)
        """
        events = []

        if not self.stream or not self.recognizer:
            return events

        current_time = time.time()
        self.last_activity = current_time
        self.chunk_count += 1

        try:
            # Convert bytes to numpy array (16-bit PCM)
            audio_int16 = np.frombuffer(audio_data, dtype=np.int16)

            if len(audio_int16) == 0:
                return events

            # Resample if needed (STT model expects 16kHz)
            target_rate = 16000
            if sample_rate != target_rate and sample_rate > 0:
                # Log resampling on first chunk
                if self.chunk_count == 1:
                    print(f"[SherpaSession] Resampling from {sample_rate}Hz to {target_rate}Hz")
                # Use scipy for high-quality resampling
                from scipy import signal
                num_samples = int(len(audio_int16) * target_rate / sample_rate)
                audio_int16 = signal.resample(audio_int16, num_samples).astype(np.int16)

            # Convert to float32 normalized
            audio_float = audio_int16.astype(np.float32) / 32768.0

            # Calculate RMS for speech detection (using configurable threshold)
            audio_rms = np.sqrt(np.mean(audio_float**2))
            is_speech = audio_rms > self.rms_threshold

            # Debug logging every 50 chunks
            if self.chunk_count % 50 == 1:
                print(f"[SherpaSession] Chunk {self.chunk_count}: samples={len(audio_float)}, rms={audio_rms:.6f}, is_speech={is_speech}")

            # Apply gain normalization for quiet speech
            if is_speech and audio_rms > 0.005 and audio_rms < 0.05:
                gain = min(3.0, 0.15 / audio_rms)
                audio_float *= gain

            # Feed to recognizer
            self.stream.accept_waveform(sample_rate=16000, waveform=audio_float)

            # Decode when ready
            if self.recognizer.is_ready(self.stream):
                self.recognizer.decode_stream(self.stream)

            # Get current result
            result = self.recognizer.get_result(self.stream)

            # Debug: log when we get text
            if result and result.strip() and self.chunk_count % 10 == 0:
                print(f"[SherpaSession] Got result: '{result.strip()}'")

            if result and result.strip():
                current_text = result.strip().capitalize()
                if current_text != self.accumulated_text:
                    self.accumulated_text = current_text
                    print(f"[SherpaSession] Partial transcript: '{current_text}'")

                    # Yield partial transcript
                    events.append(stt_pb2.TranscriptEvent(
                        text=current_text,
                        is_final=False,
                        transcript_id=self.transcript_id,
                        participant_id=self.participant_id,
                        confidence=0.8,
                        timestamp_ms=int(current_time * 1000)
                    ))

            # Track speech/silence
            if is_speech:
                # Emit speech_started event on speech onset
                if not self.speech_active:
                    self.speech_active = True
                    events.append(stt_pb2.TranscriptEvent(
                        text="",
                        is_final=False,
                        transcript_id=self.transcript_id,
                        participant_id=self.participant_id,
                        confidence=0.0,
                        timestamp_ms=int(current_time * 1000),
                        speech_started=True
                    ))

                self.silence_start_time = None
                self.last_speech_activity = current_time
            else:
                if self.silence_start_time is None:
                    self.silence_start_time = current_time

                silence_duration = current_time - self.silence_start_time

                # Check for silence threshold
                if silence_duration > self.silence_threshold and self.accumulated_text.strip():
                    final_event = self._handle_endpoint("silence_threshold")
                    if final_event:
                        events.append(final_event)

            # Check for VAD endpoint
            if self.recognizer.is_endpoint(self.stream) and self.accumulated_text.strip():
                final_event = self._handle_endpoint("VAD_endpoint")
                if final_event:
                    events.append(final_event)

            # Check for timeout
            if current_time - self.last_speech_activity > self.speech_timeout:
                if self.accumulated_text.strip():
                    final_event = self._handle_endpoint("timeout")
                    if final_event:
                        events.append(final_event)

        except Exception as e:
            print(f"[SherpaSession] Audio processing error: {e}")

        return events

    def _handle_endpoint(self, reason: str) -> Optional[stt_pb2.TranscriptEvent]:
        """Handle speech endpoint - return final transcript event."""
        if self.processing_endpoint:
            return None

        final_text = self.accumulated_text.strip()
        current_time = time.time()

        # Check for duplicate
        if (final_text == self.last_final_text and
            current_time - self.last_final_time < 5.0):
            return None

        # Filter short transcripts (using configurable minimum)
        if not final_text or len(final_text) < self.min_transcript_chars:
            if final_text:
                print(f"[SherpaSession] Filtered short transcript: '{final_text}'")
            return None

        self.processing_endpoint = True

        try:
            # Flush any remaining content
            self._flush_buffers()
            final_text = self.accumulated_text.strip()

            print(f"[SherpaSession] Final transcript ({reason}): '{final_text}'")

            # Update tracking
            self.last_final_text = final_text
            self.last_final_time = current_time

            event = stt_pb2.TranscriptEvent(
                text=final_text,
                is_final=True,
                transcript_id=self.transcript_id,
                participant_id=self.participant_id,
                confidence=0.9,
                timestamp_ms=int(current_time * 1000)
            )

            # Reset for next utterance
            self.reset()

            return event

        finally:
            self.processing_endpoint = False

    def _flush_buffers(self):
        """Flush recognizer buffers to get final content."""
        if not self.recognizer or not self.stream:
            return

        try:
            for _ in range(3):
                if self.recognizer.is_ready(self.stream):
                    self.recognizer.decode_stream(self.stream)

                result = self.recognizer.get_result(self.stream)
                if result and result.strip():
                    current_text = result.strip().capitalize()
                    if len(current_text) > len(self.accumulated_text):
                        self.accumulated_text = current_text
        except Exception as e:
            print(f"[SherpaSession] Buffer flush error: {e}")

    def reset(self) -> None:
        """Reset state for next utterance."""
        self.accumulated_text = ''
        self.transcript_id = f"transcript_{uuid.uuid4().hex[:8]}"
        self.silence_start_time = None
        self.speech_active = False

        # Create fresh stream
        if self.recognizer and self.create_stream_fn:
            self.stream = self.create_stream_fn()


class SherpaProvider(STTProvider):
    """Sherpa-ONNX based STT provider.

    Lightweight streaming model (~180MB) optimized for CPU.
    Good for development and low-latency scenarios.
    """

    def __init__(self):
        self.recognizer = None
        self.model_ready = False
        self.model_path = None

        # Sherpa-specific VAD configuration (from environment)
        self.silence_threshold = float(os.getenv("SHERPA_SILENCE_THRESHOLD", "1.5"))
        self.speech_timeout = float(os.getenv("SHERPA_SPEECH_TIMEOUT", "10.0"))
        self.rms_threshold = float(os.getenv("SHERPA_RMS_THRESHOLD", "0.008"))
        self.pre_buffer_samples = int(os.getenv("SHERPA_PRE_BUFFER_SAMPLES", "8000"))
        self.min_transcript_chars = int(os.getenv("SHERPA_MIN_TRANSCRIPT_CHARS", "3"))

        print(f"[SherpaProvider] VAD config: silence_threshold={self.silence_threshold}s, "
              f"speech_timeout={self.speech_timeout}s, rms_threshold={self.rms_threshold}")

    @property
    def name(self) -> str:
        return "sherpa"

    @property
    def is_available(self) -> bool:
        return SHERPA_AVAILABLE

    async def initialize(self) -> bool:
        """Initialize sherpa-onnx with pre-downloaded model."""
        if not SHERPA_AVAILABLE:
            print("[SherpaProvider] sherpa-onnx not installed")
            return False

        print("[SherpaProvider] Initializing sherpa-onnx model...")

        # Model should already be downloaded during Docker build
        model_name = "sherpa-onnx-streaming-zipformer-en-2023-06-21"
        cache_dir = os.path.expanduser("~/.cache/sherpa-onnx")
        model_dir = os.path.join(cache_dir, model_name)

        if not os.path.exists(model_dir):
            print(f"[SherpaProvider] Model not found at {model_dir}")
            print("[SherpaProvider] Attempting to download model...")
            try:
                # Try importing the download script
                import sys
                sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
                from download_sherpa_model import download_sherpa_model
                model_dir = download_sherpa_model()
            except Exception as e:
                print(f"[SherpaProvider] Model download failed: {e}")
                return False

        self.model_path = model_dir
        self.recognizer = self._create_recognizer()

        if self.recognizer:
            self.model_ready = True
            print(f"[SherpaProvider] Model ready at: {model_dir}")
            return True
        else:
            print("[SherpaProvider] Failed to create recognizer")
            return False

    def _create_recognizer(self):
        """Create a new sherpa-onnx recognizer instance."""
        if not self.model_path:
            return None

        try:
            encoder_path = os.path.join(self.model_path, "encoder-epoch-99-avg-1.onnx")
            decoder_path = os.path.join(self.model_path, "decoder-epoch-99-avg-1.onnx")
            joiner_path = os.path.join(self.model_path, "joiner-epoch-99-avg-1.onnx")
            tokens_path = os.path.join(self.model_path, "tokens.txt")

            # Verify all files exist
            for path in [encoder_path, decoder_path, joiner_path, tokens_path]:
                if not os.path.exists(path):
                    print(f"[SherpaProvider] Missing model file: {path}")
                    return None

            # Determine ONNX provider from environment
            onnx_provider_str = os.getenv('ONNX_PROVIDER', 'CPUExecutionProvider')
            provider_map = {
                'CUDAExecutionProvider': 'cuda',
                'CPUExecutionProvider': 'cpu',
                'cuda': 'cuda',
                'cpu': 'cpu',
            }
            sherpa_provider = provider_map.get(onnx_provider_str.split(',')[0].strip(), 'cpu')
            print(f"[SherpaProvider] Using ONNX provider: {sherpa_provider}")

            # Create streaming recognizer with VAD settings for natural speech
            recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
                encoder=encoder_path,
                decoder=decoder_path,
                joiner=joiner_path,
                tokens=tokens_path,
                sample_rate=16000,
                num_threads=2,
                enable_endpoint_detection=True,
                rule1_min_trailing_silence=2.5,   # Allow longer natural pauses
                rule2_min_trailing_silence=2.0,   # Allow longer breathing pauses
                rule3_min_utterance_length=300,   # Detect shorter utterances
                decoding_method="greedy_search",
                max_active_paths=4,
                provider=sherpa_provider,
            )

            print(f"[SherpaProvider] Created recognizer (provider={sherpa_provider})")
            return recognizer

        except Exception as e:
            print(f"[SherpaProvider] Failed to create recognizer: {e}")
            return None

    def create_session(self, session_id: str, participant_id: str) -> Optional[SherpaSession]:
        """Create a new transcription session."""
        if not self.model_ready or not self.recognizer:
            return None

        # Pass VAD configuration to session
        config = {
            'silence_threshold': self.silence_threshold,
            'speech_timeout': self.speech_timeout,
            'rms_threshold': self.rms_threshold,
            'pre_buffer_samples': self.pre_buffer_samples,
            'min_transcript_chars': self.min_transcript_chars,
        }

        return SherpaSession(
            session_id=session_id,
            participant_id=participant_id,
            recognizer=self.recognizer,
            create_stream_fn=lambda: self.recognizer.create_stream(),
            config=config
        )

    async def cleanup(self) -> None:
        """Clean up resources."""
        self.recognizer = None
        self.model_ready = False
        print("[SherpaProvider] Cleanup completed")

    def get_capabilities(self) -> dict:
        return {
            "supports_streaming": True,
            "supports_gpu": False,  # Sherpa uses CPU (ONNX)
            "supports_auto_detect": False,  # Sherpa uses fixed language model
            "supported_languages": ["de"],  # German zipformer model
            "model": "sherpa-onnx-zipformer-de",
            "model_size_mb": 180,
            "latency_ms": "real-time",
        }
