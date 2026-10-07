"""Sherpa-ONNX STT provider - lightweight streaming model."""

import glob
import os
import time
import uuid
from typing import List, Optional
import numpy as np

from .base import STTProvider, STTSession
from vad.speech_gate import GateConfig, GateSignal, SpeechGate
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

    def __init__(self, session_id: str, participant_id: str, recognizer, create_stream_fn,
                 config: dict = None, vad_model=None):
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

        # Configurable thresholds (from config or defaults)
        self.silence_threshold = self.config.get('silence_threshold', 1.5)  # seconds
        self.speech_timeout = self.config.get('speech_timeout', 10.0)  # force endpoint after 10s
        # Energy gate, now only a PRE-FILTER in front of the VAD (and the
        # fallback when no VAD model loaded). Deliberately wide open at 0.001:
        # on 169s of reference speech, 0.001 agrees with Silero on 93% of
        # windows while 0.008 calls 17 points of real speech "silence" — which
        # is what made raising it cost transcription accuracy. Noise rejection
        # is the VAD's job now, and it is far better at it: Silero rejects a
        # loud tone and white noise that any energy threshold this low accepts.
        self.rms_threshold = self.config.get('rms_threshold', 0.001)

        # Turn boundaries. Shared with the whisper provider — see
        # vad/speech_gate.py for why this does not live in the provider.
        self.vad_model = vad_model
        self.vad_window = vad_model.window_size() if vad_model else 512
        self.vad_buffer = np.empty(0, dtype=np.float32)
        # The gate's clock is AUDIO time, not wall time: seconds of audio seen.
        # Chunk arrival is bursty and every window inside one chunk would
        # otherwise share a timestamp, so endpointing would depend on how the
        # network happened to slice the stream. Audio time is also monotonic
        # and reproducible, which is what makes the gate testable. Wall time is
        # still used for the "audio stopped arriving entirely" timeout below —
        # a frozen audio clock cannot detect its own silence.
        self.audio_position = 0.0
        self.gate = SpeechGate(GateConfig(
            silence_duration_ms=self.config.get('silence_duration_ms', 500.0),
            continuation_window_ms=self.config.get('continuation_window_ms', 1000.0),
            barge_in_min_speech_ms=self.config.get('barge_in_min_speech_ms', 600.0),
            sample_rate=16000,
        ))
        if vad_model is None:
            print("[SherpaSession] No VAD model — falling back to the energy gate. "
                  "speech_confirmed/speech_ended will be approximate.")

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

            audio_rms = float(np.sqrt(np.mean(audio_float**2)))

            # Turn boundaries first, so an utterance that begins in this chunk
            # has its transcript id before anything is stamped with it.
            # FINALIZE is deferred: the recogniser has not seen this chunk yet,
            # and finalising ahead of it would drop the tail of the utterance.
            vad_events, voiced, finalize = self._observe_speech(audio_float, current_time)
            events.extend(vad_events)

            # Debug logging every 50 chunks
            if self.chunk_count % 50 == 1:
                print(f"[SherpaSession] Chunk {self.chunk_count}: samples={len(audio_float)}, "
                      f"rms={audio_rms:.6f}, voiced={voiced}, state={self.gate.state}")

            # Apply gain normalization for quiet speech
            if voiced and audio_rms > 0.005 and audio_rms < 0.05:
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

            # The gate said the utterance is over, and the recogniser has now
            # consumed the audio, so it is safe to close the turn.
            if finalize and self.accumulated_text.strip():
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

    def _observe_speech(self, audio_float, current_time):
        """Run the audio through the VAD and translate gate signals to events.

        Returns (events, voiced, finalize). `finalize` is handed back rather
        than acted on here because the caller has not fed this chunk to the
        recogniser yet.

        The windowing is not optional: Silero carries state between calls and
        is only defined on its own window size, which sherpa-onnx reports as
        576 samples rather than the 512 the whisper path uses — hence asking
        the model instead of hardcoding it. Audio that does not fill a window
        is held over to the next chunk.
        """
        events = []
        voiced_any = False
        finalize = False

        self.vad_buffer = np.concatenate((self.vad_buffer, audio_float))

        while len(self.vad_buffer) >= self.vad_window:
            window = self.vad_buffer[:self.vad_window]
            self.vad_buffer = self.vad_buffer[self.vad_window:]

            if self.vad_model is not None:
                # The energy gate stays in front of the VAD, but only as a
                # cheap skip for digital silence — it no longer decides
                # anything on its own.
                window_rms = float(np.sqrt(np.mean(window**2)))
                voiced = (
                    window_rms > self.rms_threshold
                    and self.vad_model.is_speech(window)
                )
            else:
                voiced = float(np.sqrt(np.mean(window**2))) > self.rms_threshold

            voiced_any = voiced_any or voiced
            if voiced:
                self.last_speech_activity = current_time
            self.audio_position += self.vad_window / 16000.0

            for signal in self.gate.observe(
                voiced=voiced, samples=self.vad_window, now=self.audio_position
            ):
                if signal == GateSignal.UTTERANCE_BEGAN:
                    # A new turn gets a new id here rather than at reset(), so
                    # the speech_started below already carries the right one.
                    self.transcript_id = f"transcript_{uuid.uuid4().hex[:8]}"
                elif signal == GateSignal.SPEECH_STARTED:
                    events.append(self._boundary_event(current_time, started=True))
                elif signal == GateSignal.SPEECH_CONFIRMED:
                    print(f"[SherpaSession] Barge-in signal ({self.gate.voiced_ms:.0f}ms voiced)")
                    events.append(self._boundary_event(current_time, confirmed=True))
                elif signal == GateSignal.SPEECH_ENDED:
                    events.append(self._boundary_event(current_time, ended=True))
                elif signal == GateSignal.FINALIZE:
                    finalize = True

        return events, voiced_any, finalize

    def _boundary_event(self, current_time, *, started=False, confirmed=False, ended=False):
        """A textless VAD event. Rides the same channel as real transcripts."""
        return stt_pb2.TranscriptEvent(
            text="",
            is_final=False,
            transcript_id=self.transcript_id,
            participant_id=self.participant_id,
            confidence=0.0,
            timestamp_ms=int(current_time * 1000),
            speech_started=started,
            speech_confirmed=confirmed,
            speech_ended=ended,
        )

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
        self.gate.reset()
        # audio_position deliberately survives: it is a clock for the stream,
        # not a counter for the utterance, and rewinding it would make the next
        # silence measurement negative.
        self.vad_buffer = np.empty(0, dtype=np.float32)
        if self.vad_model is not None:
            # Silero is stateful; carrying the previous utterance's hidden
            # state into the next one degrades its first few windows.
            self.vad_model.reset()

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
        self.rms_threshold = float(os.getenv("SHERPA_RMS_THRESHOLD", "0.001"))
        self.pre_buffer_samples = int(os.getenv("SHERPA_PRE_BUFFER_SAMPLES", "8000"))
        self.min_transcript_chars = int(os.getenv("SHERPA_MIN_TRANSCRIPT_CHARS", "3"))

        # Turn-boundary timings, shared with the whisper provider.
        #
        # These default so that silence + continuation == SHERPA_SILENCE_THRESHOLD,
        # i.e. the point at which a transcript is finalised does not move. What
        # is new is that the FIRST half of that wait now emits speech_ended, so
        # the agent stops ducking after ~500ms instead of holding its breath for
        # the full 1.5s. Endpointing unchanged, un-ducking 1s faster.
        # `or default` rather than a getenv default: an env var present but
        # EMPTY (which is what copying .env.example gives you) would otherwise
        # reach float() and take the service down on startup.
        self.silence_duration_ms = float(os.getenv("SHERPA_SILENCE_DURATION_MS") or 500)
        self.continuation_window_ms = float(
            os.getenv("SHERPA_CONTINUATION_WINDOW_MS")
            or max(0.0, self.silence_threshold * 1000 - self.silence_duration_ms)
        )
        self.barge_in_min_speech_ms = float(os.getenv("BARGE_IN_MIN_SPEECH_MS") or 600)
        self.vad_model = None

        print(f"[SherpaProvider] VAD config: silence_threshold={self.silence_threshold}s, "
              f"speech_timeout={self.speech_timeout}s, rms_threshold={self.rms_threshold}, "
              f"speech_ended after {self.silence_duration_ms}ms, "
              f"final after +{self.continuation_window_ms}ms, "
              f"barge-in at {self.barge_in_min_speech_ms}ms voiced")

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
        self.vad_model = self._create_vad_model()

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

    def _create_vad_model(self):
        """Load Silero through sherpa-onnx's own binding.

        Not through torch.hub the way the whisper provider does it: torch is a
        GPU-image dependency and this image deliberately ships without it. The
        binding is already installed here, runs the same model on the
        onnxruntime that is already present, and costs nothing extra.

        A missing model is not fatal — the session falls back to the energy
        gate, which is what this provider did for its whole life until now.
        The log line is loud because the fallback silently costs the agent its
        ability to tell a voice from a noise.
        """
        cache_dir = os.getenv("SILERO_VAD_CACHE_DIR", os.path.expanduser("~/.cache/silero-vad"))
        model_path = os.getenv("SILERO_VAD_MODEL_PATH") or os.path.join(
            cache_dir, "snakers4_silero-vad", "src", "silero_vad", "data", "silero_vad.onnx",
        )
        if not os.path.exists(model_path):
            # The known path first, then a search: the file's location inside
            # the pinned repo is upstream's business and has moved before, and
            # a silent fall back to the energy gate is exactly the failure this
            # whole change exists to remove.
            found = glob.glob(os.path.join(cache_dir, "**", "silero_vad.onnx"), recursive=True)
            if not found:
                print(f"[SherpaProvider] Silero VAD model not found under {cache_dir} — "
                      f"falling back to the RMS energy gate (no voice/noise discrimination)")
                return None
            model_path = found[0]
            print(f"[SherpaProvider] Silero VAD found at {model_path}")

        try:
            config = sherpa_onnx.VadModelConfig()
            config.silero_vad.model = model_path
            config.silero_vad.threshold = float(os.getenv("VAD_THRESHOLD") or 0.5)
            config.sample_rate = 16000
            config.num_threads = 1
            model = sherpa_onnx.VadModel.create(config)
            print(f"[SherpaProvider] Silero VAD loaded (window={model.window_size()} samples)")
            return model
        except Exception as e:
            print(f"[SherpaProvider] Silero VAD load failed: {e} — falling back to the RMS gate")
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
            'silence_duration_ms': self.silence_duration_ms,
            'continuation_window_ms': self.continuation_window_ms,
            'barge_in_min_speech_ms': self.barge_in_min_speech_ms,
        }

        return SherpaSession(
            session_id=session_id,
            participant_id=participant_id,
            recognizer=self.recognizer,
            create_stream_fn=lambda: self.recognizer.create_stream(),
            config=config,
            vad_model=self.vad_model,
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
