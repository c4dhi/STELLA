"""faster-whisper STT provider with Silero VAD - Industry-standard implementation.

Follows industry best practices (LiveKit, OpenAI Realtime, Deepgram, Pipecat):
- Single VAD signal (Silero probability threshold)
- 3-state machine (IDLE/SPEAKING/MAYBE_ENDING) with continuation window
- Handles natural pauses (thinking, hesitation) without fragmenting utterances
- Configurable endpointing delays for conversational speech
"""

import os
import time
import uuid
from typing import List, Optional
from concurrent.futures import ThreadPoolExecutor, Future
import numpy as np

from .base import STTProvider, STTSession
import stt_pb2

# Try to import faster-whisper
try:
    from faster_whisper import WhisperModel
    FASTER_WHISPER_AVAILABLE = True
except ImportError as e:
    print(f"[WhisperProvider] faster-whisper not available: {e}")
    WhisperModel = None
    FASTER_WHISPER_AVAILABLE = False

# Try to import torch for Silero VAD
try:
    import torch
    TORCH_AVAILABLE = True
except ImportError as e:
    print(f"[WhisperProvider] torch not available for Silero VAD: {e}")
    TORCH_AVAILABLE = False


def _clamp_endpointing_ceiling(max_endpointing_delay_ms: int, continuation_window_ms: int) -> int:
    """Keep the endpointing ceiling from being shorter than the continuation window.

    Both are measured from entry into MAYBE_ENDING, so a ceiling below the
    continuation window would fire first on every utterance and silently
    truncate all of them. A misconfigured value is clamped up (and logged)
    rather than honoured.
    """
    if max_endpointing_delay_ms < continuation_window_ms:
        print(f"[WhisperProvider] max_endpointing_delay_ms={max_endpointing_delay_ms} is below "
              f"continuation_window_ms={continuation_window_ms}; clamping ceiling to "
              f"{continuation_window_ms}ms")
        return continuation_window_ms
    return max_endpointing_delay_ms


class WhisperSession(STTSession):
    """faster-whisper session with industry-standard VAD-based streaming.

    Architecture:
    1. Buffer incoming audio in 512-sample VAD windows (32ms @ 16kHz)
    2. Check speech probability per window using Silero VAD (single signal)
    3. 3-state machine with continuation window:
       - IDLE: Waiting for speech
       - SPEAKING: Accumulating speech audio
       - MAYBE_ENDING: Silence detected, waiting for possible continuation
    4. Emit partials every N ms while speaking
    5. Emit final only after continuation window expires (handles natural pauses)
    """

    def __init__(
        self,
        session_id: str,
        participant_id: str,
        whisper_model: 'WhisperModel',
        vad_model,
        config: dict
    ):
        self.session_id = session_id
        self.participant_id = participant_id
        self.whisper_model = whisper_model
        self.vad_model = vad_model
        self.config = config

        # Core state (3-state machine: IDLE, SPEAKING, or MAYBE_ENDING)
        self.state = "IDLE"
        self.speech_buffer = []
        self.audio_buffer = []

        # VAD config (7 core parameters)
        self.vad_threshold = config.get('vad_threshold', 0.5)
        self.silence_duration_ms = config.get('silence_duration_ms', 500)
        self.continuation_window_ms = config.get('continuation_window_ms', 600)
        self.max_endpointing_delay_ms = _clamp_endpointing_ceiling(
            config.get('max_endpointing_delay_ms', 2000),
            self.continuation_window_ms,
        )
        self.min_speech_samples = config.get('min_speech_samples', 8000)  # 0.5s @ 16kHz
        self.max_speech_duration_ms = config.get('max_speech_duration_ms', 30000)
        self.partial_interval_ms = config.get('partial_interval_ms', 1000)
        self.audio_inactivity_timeout_ms = config.get('audio_inactivity_timeout_ms', 1500)

        # RMS energy gate (filters quiet background noise before VAD)
        # RMS threshold of 0.01 = -40dB, typical for speech vs ambient noise
        self.rms_threshold = config.get('rms_threshold', 0.01)

        # Tracking
        self.silence_start_time = None
        self.speech_start_time = None
        self.last_partial_time = 0
        self.last_audio_time = 0  # Track when we last received meaningful audio
        self.transcript_id = None
        self.last_final_text = ""
        self.last_final_time = 0

        # Continuation window state (for MAYBE_ENDING)
        self.pending_final_time = None  # When we entered MAYBE_ENDING state

        # Transcription state (prevent concurrent transcriptions)
        self.is_transcribing = False
        self.last_transcription_time = 0

        # Async partial transcription (non-blocking)
        self.transcription_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper_partial")
        self.pending_partial_future: Optional[Future] = None
        self.pending_partial_transcript_id = None
        self.last_partial_text = ""  # Cache to avoid duplicate partials

        # Buffer limits (prevent unbounded growth)
        self.max_speech_buffer_samples = 16 * 16000  # 16 seconds @ 16kHz

        # Pre-buffer for speech onset (captures audio before VAD triggers)
        self.pre_buffer_samples = config.get('pre_buffer_samples', 3200)  # 200ms
        self.pre_buffer = []

        # Optional language PIN. When set (env WHISPER_LANGUAGE or an explicit
        # per-session hint), transcription is forced to this language. Default is
        # None → auto-detect, which yields the detection signal for free from the
        # transcription pass (no extra model call, RFC §6). Pinning trades that
        # free per-utterance detection away, so a pinned session is reported as
        # that fixed language.
        self.language_hint = None

        # Precompute high-pass filter coefficients (80Hz cutoff for noise removal)
        from scipy import signal
        self.highpass_sos = signal.butter(5, 80, btype='highpass', fs=16000, output='sos')

        # Processing state
        self.chunk_count = 0

    def set_language_hint(self, language: Optional[str]) -> None:
        """Pin transcription to a language (opt-in; forwarded from ``AudioChunk.language``).

        Empty/``auto`` clears the pin back to auto-detection (the default). Note
        this FORCES transcription, which suppresses the free per-utterance
        detection — use only when a session must stay in one fixed language.
        """
        hint = (language or "").strip().lower()
        hint = hint if hint and hint != "auto" else None
        if hint != self.language_hint:
            print(f"[WhisperSession] Language pin set to '{hint}' (was '{self.language_hint}')")
            self.language_hint = hint

    def _forced_language(self) -> Optional[str]:
        """The pinned transcription language, or None to auto-detect (default).

        Only an explicit pin forces it: per-session hint > configured env pin >
        None. Auto-detect is the default so the detection signal comes free from
        the transcription pass — no second model call (RFC §6).
        """
        return self.language_hint or (self.config.get('language') or None)

    def _preprocess_audio(self, audio_float: np.ndarray) -> np.ndarray:
        """Simple preprocessing: high-pass filter + normalize."""
        from scipy import signal

        # High-pass filter to remove low-frequency noise/hum
        audio_float = signal.sosfilt(self.highpass_sos, audio_float)

        # Normalize audio to 0.95 peak
        peak = np.abs(audio_float).max()
        if peak > 0.01:
            audio_float = audio_float / peak * 0.95

        return audio_float

    def _clear_gpu_memory(self) -> None:
        """Clear GPU memory cache to prevent accumulation."""
        try:
            if TORCH_AVAILABLE and torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception as e:
            print(f"[WhisperSession] GPU cache clear error: {e}")

    def _accumulate_speech(self, audio_int16: np.ndarray) -> None:
        """Accumulate audio to speech buffer with size limits."""
        self.speech_buffer.extend(audio_int16.tolist())

        # Cap buffer to prevent unbounded growth
        if len(self.speech_buffer) > self.max_speech_buffer_samples:
            # Keep most recent audio, discard oldest
            overflow = len(self.speech_buffer) - self.max_speech_buffer_samples
            self.speech_buffer = self.speech_buffer[overflow:]

    def _endpointing_hold_expired(self, current_time: float) -> tuple:
        """Decide whether the MAYBE_ENDING hold is over.

        Two bounds, both measured from entry into MAYBE_ENDING
        (``pending_final_time``):
        - continuation_window_ms: the normal wait for speech to resume
        - max_endpointing_delay_ms: hard ceiling on the hold, so anything that
          extends the continuation window at runtime cannot keep a turn open
          indefinitely

        Returns (expired, reason, elapsed_ms).
        """
        if not self.pending_final_time:
            return False, "", 0.0

        elapsed_ms = (current_time - self.pending_final_time) * 1000
        if elapsed_ms >= self.continuation_window_ms:
            return True, "Continuation window expired", elapsed_ms
        if elapsed_ms >= self.max_endpointing_delay_ms:
            return True, "Max endpointing delay reached", elapsed_ms
        return False, "", elapsed_ms

    def process_audio(self, audio_data: bytes, sample_rate: int = 16000) -> List[stt_pb2.TranscriptEvent]:
        """Process audio chunk through VAD and return transcript events."""
        events = []
        current_time = time.time()
        self.chunk_count += 1

        # Safety timeout (applies to both SPEAKING and MAYBE_ENDING states)
        if self.state in ("SPEAKING", "MAYBE_ENDING") and self.speech_start_time:
            speech_duration_ms = (current_time - self.speech_start_time) * 1000
            if speech_duration_ms >= self.max_speech_duration_ms:
                print(f"[WhisperSession] TIMEOUT: Speech exceeded {self.max_speech_duration_ms}ms")
                final_event = self._generate_final(current_time)
                if final_event:
                    events.append(final_event)
                self._reset()
                return events

        # Audio inactivity timeout (no new audio while speaking/maybe_ending = endpoint)
        if self.state in ("SPEAKING", "MAYBE_ENDING") and self.last_audio_time > 0:
            inactivity_ms = (current_time - self.last_audio_time) * 1000
            if inactivity_ms >= self.audio_inactivity_timeout_ms:
                print(f"[WhisperSession] INACTIVITY: No audio for {inactivity_ms:.0f}ms, forcing endpoint")
                final_event = self._generate_final(current_time)
                if final_event:
                    events.append(final_event)
                self._reset()
                return events

        # MAYBE_ENDING timeout check (handles case where audio stream ends during MAYBE_ENDING)
        if self.state == "MAYBE_ENDING" and self.pending_final_time:
            expired, reason, time_in_maybe_ending = self._endpointing_hold_expired(current_time)
            if expired:
                total_silence = (current_time - self.silence_start_time) * 1000 if self.silence_start_time else time_in_maybe_ending
                print(f"[WhisperSession] {reason} ({time_in_maybe_ending:.0f}ms in MAYBE_ENDING, {total_silence:.0f}ms total silence)")
                final_event = self._generate_final(current_time)
                if final_event:
                    events.append(final_event)
                self._reset()
                return events

        try:
            # Convert bytes to numpy array (16-bit PCM)
            audio_int16 = np.frombuffer(audio_data, dtype=np.int16)
            if len(audio_int16) == 0:
                return events

            # Track when we received meaningful audio
            self.last_audio_time = current_time

            # Resample if needed (Whisper expects 16kHz)
            target_rate = 16000
            if sample_rate != target_rate and sample_rate > 0:
                if self.chunk_count == 1:
                    print(f"[WhisperSession] Resampling from {sample_rate}Hz to {target_rate}Hz")
                from scipy import signal
                num_samples = int(len(audio_int16) * target_rate / sample_rate)
                audio_int16 = signal.resample(audio_int16, num_samples).astype(np.int16)

            # Add to audio buffer
            self.audio_buffer.extend(audio_int16.tolist())

            # Process all available VAD windows (512 samples = 32ms)
            vad_window_samples = 512
            while len(self.audio_buffer) >= vad_window_samples:
                window = self.audio_buffer[:vad_window_samples]
                self.audio_buffer = self.audio_buffer[vad_window_samples:]

                window_float = np.array(window, dtype=np.float32) / 32768.0
                window_int16 = np.array(window, dtype=np.int16)

                vad_events = self._check_speech_activity(window_float, window_int16, current_time)
                events.extend(vad_events)

            # Check for completed async partial transcription (non-blocking)
            if self.pending_partial_future is not None and self.pending_partial_future.done():
                try:
                    partial_text = self.pending_partial_future.result()
                    if partial_text and partial_text != self.last_partial_text:
                        self.last_partial_text = partial_text
                        # Only emit if we're still in SPEAKING/MAYBE_ENDING and same transcript
                        if (self.state in ("SPEAKING", "MAYBE_ENDING") and
                            self.transcript_id == self.pending_partial_transcript_id):
                            events.append(stt_pb2.TranscriptEvent(
                                text=partial_text,
                                is_final=False,
                                transcript_id=self.transcript_id,
                                participant_id=self.participant_id,
                                confidence=0.8,
                                timestamp_ms=int(current_time * 1000)
                            ))
                except Exception as e:
                    print(f"[WhisperSession] Async partial error: {e}")
                finally:
                    self.pending_partial_future = None
                    self.pending_partial_transcript_id = None

            # Submit new async partial transcription (non-blocking)
            # Only during SPEAKING, not MAYBE_ENDING (need unblocked VAD for speech resumption)
            if (self.state == "SPEAKING" and
                len(self.speech_buffer) >= self.min_speech_samples and
                self.pending_partial_future is None):  # No pending future
                time_since_partial = (current_time - self.last_partial_time) * 1000
                if time_since_partial >= self.partial_interval_ms:
                    self._submit_async_partial()
                    self.last_partial_time = current_time

        except Exception as e:
            print(f"[WhisperSession] Audio processing error: {e}")
            import traceback
            traceback.print_exc()

        return events

    def _check_speech_activity(
        self,
        audio_float: np.ndarray,
        audio_int16: np.ndarray,
        current_time: float
    ) -> List[stt_pb2.TranscriptEvent]:
        """Check for speech activity using Silero VAD (3-state machine).

        State transitions:
        - IDLE -> SPEAKING: speech_prob > threshold
        - SPEAKING -> MAYBE_ENDING: silence >= silence_duration_ms
        - MAYBE_ENDING -> SPEAKING: speech resumes (cancel pending final)
        - MAYBE_ENDING -> IDLE: continuation_window_ms elapsed OR max_endpointing_delay_ms
          reached (both measured from entry into MAYBE_ENDING)
        """
        events = []

        try:
            # RMS energy gate - filter out quiet background noise before VAD
            # This prevents hallucinations from low-level ambient sounds
            rms = np.sqrt(np.mean(audio_float ** 2))

            # Debug logging every 100 windows to diagnose VAD issues
            if self.chunk_count % 100 == 0:
                print(f"[WhisperSession] DEBUG: chunk={self.chunk_count}, rms={rms:.6f}, threshold={self.rms_threshold}, state={self.state}")

            if rms < self.rms_threshold:
                # Audio too quiet to be speech - treat as silence
                # Still update pre-buffer but don't check VAD
                self.pre_buffer.extend(audio_int16.tolist())
                if len(self.pre_buffer) > self.pre_buffer_samples:
                    self.pre_buffer = self.pre_buffer[-self.pre_buffer_samples:]

                # Handle silence in SPEAKING/MAYBE_ENDING states
                if self.state == "SPEAKING":
                    if self.silence_start_time is None:
                        self.silence_start_time = current_time
                    self._accumulate_speech(audio_int16)
                    silence_ms = (current_time - self.silence_start_time) * 1000
                    if silence_ms >= self.silence_duration_ms:
                        self.state = "MAYBE_ENDING"
                        self.pending_final_time = current_time
                elif self.state == "MAYBE_ENDING":
                    self._accumulate_speech(audio_int16)
                    expired, reason, time_in_maybe_ending = self._endpointing_hold_expired(current_time)
                    if expired:
                        print(f"[WhisperSession] {reason} ({time_in_maybe_ending:.0f}ms in MAYBE_ENDING, below RMS gate)")
                        final_event = self._generate_final(current_time)
                        if final_event:
                            events.append(final_event)
                        self._reset()
                return events

            # Get VAD probability (single signal)
            audio_tensor = torch.from_numpy(audio_float)
            speech_prob = self.vad_model(audio_tensor, 16000).item()

            # Debug logging for VAD probability
            if self.chunk_count % 100 == 0:
                print(f"[WhisperSession] DEBUG: VAD prob={speech_prob:.3f}, threshold={self.vad_threshold}, state={self.state}")

            if speech_prob > self.vad_threshold:
                # Speech detected
                self.silence_start_time = None

                if self.state == "IDLE":
                    # Transition: IDLE -> SPEAKING
                    self.state = "SPEAKING"
                    self.speech_start_time = current_time
                    self.transcript_id = f"whisper_{uuid.uuid4().hex[:8]}"
                    self.speech_buffer = self.pre_buffer.copy()
                    self.pre_buffer = []
                    print(f"[WhisperSession] Speech started (prob={speech_prob:.2f})")

                    # Emit speech_started event for barge-in detection
                    events.append(stt_pb2.TranscriptEvent(
                        text="",
                        is_final=False,
                        transcript_id=self.transcript_id,
                        participant_id=self.participant_id,
                        confidence=0.0,
                        timestamp_ms=int(current_time * 1000),
                        speech_started=True
                    ))

                elif self.state == "MAYBE_ENDING":
                    # Transition: MAYBE_ENDING -> SPEAKING (speech resumed!)
                    print(f"[WhisperSession] Speech resumed, canceling pending final (prob={speech_prob:.2f})")
                    self.state = "SPEAKING"
                    self.pending_final_time = None
                    # Keep same transcript_id - this is a continuation

                # Accumulate audio (with buffer limits)
                self._accumulate_speech(audio_int16)

            else:
                # Silence detected
                self.pre_buffer.extend(audio_int16.tolist())
                if len(self.pre_buffer) > self.pre_buffer_samples:
                    self.pre_buffer = self.pre_buffer[-self.pre_buffer_samples:]

                if self.state == "SPEAKING":
                    # Track silence duration
                    if self.silence_start_time is None:
                        self.silence_start_time = current_time

                    # Continue accumulating during silence (might resume)
                    self._accumulate_speech(audio_int16)

                    # Check if silence threshold reached -> transition to MAYBE_ENDING
                    silence_ms = (current_time - self.silence_start_time) * 1000
                    if silence_ms >= self.silence_duration_ms:
                        # Transition: SPEAKING -> MAYBE_ENDING
                        print(f"[WhisperSession] Entering MAYBE_ENDING ({silence_ms:.0f}ms silence)")
                        self.state = "MAYBE_ENDING"
                        self.pending_final_time = current_time
                        # Don't emit final yet - wait for continuation window

                elif self.state == "MAYBE_ENDING":
                    # Continue accumulating audio during MAYBE_ENDING (in case speech resumes)
                    self._accumulate_speech(audio_int16)

                    # Check if the MAYBE_ENDING hold is over
                    # Only use time_in_maybe_ending - this ensures we always wait the full
                    # continuation window, even if silence accumulated during transcription blocking
                    expired, reason, time_in_maybe_ending = self._endpointing_hold_expired(current_time)
                    total_silence = (current_time - self.silence_start_time) * 1000

                    if expired:
                        # Transition: MAYBE_ENDING -> IDLE, emit final
                        print(f"[WhisperSession] {reason} ({time_in_maybe_ending:.0f}ms in MAYBE_ENDING, {total_silence:.0f}ms total silence)")
                        final_event = self._generate_final(current_time)
                        if final_event:
                            events.append(final_event)
                        self._reset()

        except Exception as e:
            print(f"[WhisperSession] VAD error: {e}")

        return events

    def _submit_async_partial(self) -> None:
        """Submit partial transcription to background thread (non-blocking)."""
        if len(self.speech_buffer) < self.min_speech_samples:
            return

        # Don't submit if there's already a pending future
        if self.pending_partial_future is not None:
            return

        # Snapshot the audio buffer for the background thread
        max_partial_samples = 10 * 16000
        audio_snapshot = self.speech_buffer[-max_partial_samples:] if len(self.speech_buffer) > max_partial_samples else self.speech_buffer.copy()

        # Remember which transcript this is for
        self.pending_partial_transcript_id = self.transcript_id

        # Submit to thread pool (non-blocking)
        self.pending_partial_future = self.transcription_executor.submit(
            self._transcribe_partial_worker,
            audio_snapshot
        )

    def _transcribe_partial_worker(self, audio_buffer: list) -> Optional[str]:
        """Worker function for partial transcription (runs in background thread)."""
        start_time = time.time()

        try:
            audio_samples = np.array(audio_buffer, dtype=np.int16)
            audio_float = audio_samples.astype(np.float32) / 32768.0
            audio_duration_sec = len(audio_samples) / 16000

            # Apply preprocessing
            audio_float = self._preprocess_audio(audio_float)

            # Force the agent-resolved / configured / cached language (stability)
            language = self._forced_language()

            # Transcribe with faster-whisper
            segments, info = self.whisper_model.transcribe(
                audio_float,
                language=language,
                beam_size=self.config.get('beam_size', 5),
                vad_filter=False,
                word_timestamps=False,
                condition_on_previous_text=False,
                initial_prompt=self.config.get('initial_prompt'),
                temperature=0.0,
                compression_ratio_threshold=2.4,
                log_prob_threshold=-1.0,
                no_speech_threshold=0.6,
            )

            # Don't cache language from partials - they're too short for reliable detection
            # Language will be cached from final transcription instead

            # Process segments
            transcribed_text = ""
            for segment in segments:
                transcribed_text += segment.text + " "
            transcribed_text = transcribed_text.strip()

            transcription_time = (time.time() - start_time) * 1000

            if transcribed_text:
                print(f"[WhisperSession] Partial ({audio_duration_sec:.2f}s, {transcription_time:.0f}ms): '{transcribed_text[:50]}...'")
                return transcribed_text

        except Exception as e:
            print(f"[WhisperSession] Partial transcription error: {e}")

        finally:
            self._clear_gpu_memory()

        return None

    def _generate_final(self, current_time: float) -> Optional[stt_pb2.TranscriptEvent]:
        """Generate final transcript event."""
        if len(self.speech_buffer) < self.min_speech_samples:
            print(f"[WhisperSession] Audio too short: {len(self.speech_buffer)} < {self.min_speech_samples}")
            return None

        # Wait for any pending async partial to complete (with timeout)
        if self.pending_partial_future is not None:
            try:
                self.pending_partial_future.result(timeout=2.0)
            except Exception:
                pass  # Ignore errors, we're generating final anyway
            finally:
                self.pending_partial_future = None
                self.pending_partial_transcript_id = None

        self.is_transcribing = True
        start_time = time.time()

        try:
            # Cap buffer size to prevent memory issues
            if len(self.speech_buffer) > self.max_speech_buffer_samples:
                print(f"[WhisperSession] Capping speech buffer from {len(self.speech_buffer)} to {self.max_speech_buffer_samples}")
                self.speech_buffer = self.speech_buffer[-self.max_speech_buffer_samples:]

            audio_samples = np.array(self.speech_buffer, dtype=np.int16)
            audio_float = audio_samples.astype(np.float32) / 32768.0
            audio_duration_sec = len(audio_samples) / 16000

            # Apply preprocessing
            audio_float = self._preprocess_audio(audio_float)

            # Force the agent-resolved / configured / cached language (stability)
            language = self._forced_language()

            # Final transcription
            segments, info = self.whisper_model.transcribe(
                audio_float,
                language=language,
                beam_size=self.config.get('beam_size', 5),
                vad_filter=False,
                word_timestamps=False,
                condition_on_previous_text=False,
                initial_prompt=self.config.get('initial_prompt'),
                temperature=0.0,
                compression_ratio_threshold=2.4,
                log_prob_threshold=-1.0,
                no_speech_threshold=0.6,
            )

            # Per-utterance language signal — taken FREE from the transcription
            # pass (RFC §6 #3), no second model call:
            #   - pinned: transcription was forced to `language`, so the pin is
            #     authoritative regardless of clip length — emit it even for
            #     sub-2s utterances (no detection uncertainty to guard against).
            #   - auto-detect (default): info carries the honest detection, but
            #     short clips detect unreliably, so below the floor we emit no
            #     signal and let the agent fall back to its text classifier
            #     (RFC §8.3).
            min_duration_for_lang = 2.0
            detected_language, language_confidence = "", 0.0
            if language is not None:
                detected_language, language_confidence = language, 1.0
            elif audio_duration_sec >= min_duration_for_lang:
                detected_language = getattr(info, 'language', None) or ""
                language_confidence = float(getattr(info, 'language_probability', 0.0) or 0.0)
            if detected_language:
                print(f"[WhisperSession] Language: {detected_language} "
                      f"(conf={language_confidence:.2f}, "
                      f"{'pinned' if language else 'auto'}, {audio_duration_sec:.1f}s)")

            final_text = ""
            for segment in segments:
                final_text += segment.text + " "
            final_text = final_text.strip()

            if not final_text or len(final_text) < 2:
                return None

            # Check for duplicate
            if (final_text == self.last_final_text and
                current_time - self.last_final_time < 5.0):
                print(f"[WhisperSession] Skipping duplicate")
                return None

            transcription_time = (time.time() - start_time) * 1000
            print(f"[WhisperSession] Final ({audio_duration_sec:.2f}s, {transcription_time:.0f}ms): '{final_text}'")

            self.last_final_text = final_text
            self.last_final_time = current_time

            return stt_pb2.TranscriptEvent(
                text=final_text,
                is_final=True,
                transcript_id=self.transcript_id,
                participant_id=self.participant_id,
                confidence=0.95,
                timestamp_ms=int(current_time * 1000),
                detected_language=detected_language or "",
                language_confidence=language_confidence,
            )

        except Exception as e:
            print(f"[WhisperSession] Final transcription error: {e}")
            import traceback
            traceback.print_exc()
            return None

        finally:
            self.is_transcribing = False
            self._clear_gpu_memory()

    def _reset(self) -> None:
        """Reset state for next utterance."""
        self.state = "IDLE"
        self.speech_buffer = []
        self.audio_buffer = []  # Also clear audio buffer
        self.pre_buffer = []  # Clear pre-buffer to prevent stale audio
        self.silence_start_time = None
        self.speech_start_time = None
        self.last_audio_time = 0
        self.transcript_id = None
        self.pending_final_time = None  # Clear continuation window state
        self.is_transcribing = False  # Clear transcription lock

        # Clear async partial state
        self.pending_partial_future = None
        self.pending_partial_transcript_id = None
        self.last_partial_text = ""

        # Reset Silero VAD internal state (critical for accurate detection)
        try:
            if hasattr(self.vad_model, 'reset_states'):
                self.vad_model.reset_states()
        except Exception as e:
            print(f"[WhisperSession] VAD reset error: {e}")

        # Clear GPU memory after reset
        self._clear_gpu_memory()

    def reset(self) -> None:
        """Public reset method."""
        self._reset()


class WhisperProvider(STTProvider):
    """faster-whisper STT provider with Silero VAD.

    GPU-accelerated production model (~3GB for large-v3).
    Simplified configuration with <10 parameters.
    """

    def __init__(self):
        self.whisper_model = None
        self.vad_model = None
        self.model_ready = False

        # Warmup state (shared across all sessions/agents)
        self._warmed_up = False
        self._last_warmup_time = 0
        self._warmup_ttl_seconds = int(os.getenv("WHISPER_WARMUP_TTL", "300"))  # 5 min default

        # Whisper model configuration (4 parameters)
        self.model_size = os.getenv("WHISPER_MODEL", "large-v3")
        self.device = os.getenv("WHISPER_DEVICE", "cuda")
        self.compute_type = os.getenv("WHISPER_COMPUTE_TYPE", "float16")
        self.language = os.getenv("WHISPER_LANGUAGE", None) or None

        # Beam size and initial prompt
        self.beam_size = int(os.getenv("WHISPER_BEAM_SIZE", "5"))
        self.initial_prompt = os.getenv("WHISPER_INITIAL_PROMPT", None) or None

        # VAD configuration (8 parameters - 3-state machine with continuation window)
        # Defaults match .env.example — change there, not here
        self.vad_threshold = float(os.getenv("VAD_THRESHOLD", "0.5"))
        self.silence_duration_ms = int(os.getenv("VAD_SILENCE_DURATION_MS", "800"))
        self.continuation_window_ms = int(os.getenv("VAD_CONTINUATION_WINDOW_MS", "1000"))
        self.max_endpointing_delay_ms = _clamp_endpointing_ceiling(
            int(os.getenv("VAD_MAX_ENDPOINTING_DELAY_MS", "2000")),
            self.continuation_window_ms,
        )
        self.min_speech_ms = int(os.getenv("VAD_MIN_SPEECH_MS", "500"))
        self.max_speech_duration_ms = int(os.getenv("VAD_MAX_SPEECH_DURATION_MS", "30000"))
        self.partial_interval_ms = int(os.getenv("PARTIAL_INTERVAL_MS", "1000"))
        self.audio_inactivity_timeout_ms = int(os.getenv("VAD_AUDIO_INACTIVITY_TIMEOUT_MS", "1500"))
        # RMS energy gate - filters quiet background noise before VAD
        # 0.008 = -42dB (permissive), 0.01 = -40dB (moderate), 0.02 = -34dB (strict)
        self.rms_threshold = float(os.getenv("VAD_RMS_THRESHOLD", "0.008"))

        print(f"[WhisperProvider] Config: model={self.model_size}, device={self.device}, "
              f"compute_type={self.compute_type}, language={self.language or 'auto'}")
        print(f"[WhisperProvider] VAD (3-state): threshold={self.vad_threshold}, "
              f"silence_ms={self.silence_duration_ms}, continuation_window_ms={self.continuation_window_ms}, "
              f"max_endpointing_delay_ms={self.max_endpointing_delay_ms}")
        print(f"[WhisperProvider] VAD limits: min_speech_ms={self.min_speech_ms}, "
              f"max_duration_ms={self.max_speech_duration_ms}, inactivity_ms={self.audio_inactivity_timeout_ms}")
        print(f"[WhisperProvider] RMS energy gate: threshold={self.rms_threshold} (-{int(20*np.log10(self.rms_threshold))}dB)")

    @property
    def name(self) -> str:
        return "whisper"

    @property
    def is_available(self) -> bool:
        return FASTER_WHISPER_AVAILABLE and TORCH_AVAILABLE

    async def initialize(self) -> bool:
        """Initialize faster-whisper model and Silero VAD."""
        if not self.is_available:
            print("[WhisperProvider] Dependencies not available")
            return False

        try:
            # Load faster-whisper model from cache
            print(f"[WhisperProvider] Loading Whisper model: {self.model_size} "
                  f"(device={self.device}, compute_type={self.compute_type})...")

            cache_dir = os.getenv("WHISPER_CACHE_DIR", "/root/.cache/whisper")

            self.whisper_model = WhisperModel(
                self.model_size,
                device=self.device,
                compute_type=self.compute_type,
                download_root=cache_dir,
                local_files_only=True,
            )
            print(f"[WhisperProvider] Whisper model loaded from cache: {cache_dir}")

            # Load Silero VAD model
            print(f"[WhisperProvider] Loading Silero VAD...")

            silero_cache_dir = os.getenv("SILERO_VAD_CACHE_DIR", "/root/.cache/silero-vad")
            silero_local_repo = os.path.join(silero_cache_dir, "snakers4_silero-vad")

            if os.path.exists(silero_local_repo):
                print(f"[WhisperProvider] Loading Silero VAD from local: {silero_local_repo}")
                self.vad_model, _ = torch.hub.load(
                    repo_or_dir=silero_local_repo,
                    model='silero_vad',
                    source='local',
                    onnx=True
                )
            else:
                print(f"[WhisperProvider] Loading Silero VAD from torch hub cache...")
                self.vad_model, _ = torch.hub.load(
                    repo_or_dir='snakers4/silero-vad',
                    model='silero_vad',
                    force_reload=False,
                    trust_repo=True,
                    onnx=True
                )
            print(f"[WhisperProvider] Silero VAD loaded (ONNX)")

            self.model_ready = True
            print(f"[WhisperProvider] Initialization complete")
            return True

        except Exception as e:
            print(f"[WhisperProvider] Initialization failed: {e}")
            import traceback
            traceback.print_exc()
            return False

    async def warmup(self, duration_ms: int = 1000) -> bool:
        """Warm up the Whisper model by running inference on dummy audio.

        This eliminates cold-start latency caused by:
        - CUDA kernel JIT compilation
        - cuDNN autotuning
        - Lazy GPU memory allocation

        The warmup has a TTL (default 5 min), so repeated calls are no-ops
        if the model is still warm from recent use.

        Args:
            duration_ms: Duration of dummy audio to process (default 1000ms)

        Returns:
            True if warmup ran successfully, False otherwise.
        """
        if not self.model_ready or not self.whisper_model:
            print("[WhisperProvider] Cannot warmup: model not ready")
            return False

        current_time = time.time()

        # Check TTL - skip if already warm
        if self._warmed_up and (current_time - self._last_warmup_time) < self._warmup_ttl_seconds:
            time_since_warmup = current_time - self._last_warmup_time
            print(f"[WhisperProvider] Model still warm ({time_since_warmup:.0f}s since last warmup, TTL={self._warmup_ttl_seconds}s)")
            return True

        print(f"[WhisperProvider] Warming up model (duration={duration_ms}ms)...")
        start_time = time.time()

        try:
            # Generate dummy audio: low-level noise (not silence, to ensure full inference path)
            # -60dB noise ensures we don't trigger no-speech shortcuts
            sample_rate = 16000
            num_samples = int(duration_ms * sample_rate / 1000)
            # Generate white noise at -60dB (amplitude ~0.001)
            dummy_audio = np.random.randn(num_samples).astype(np.float32) * 0.001

            # Run transcription on dummy audio
            # Use configured language or auto-detect - warmup doesn't affect session language
            # since each session has its own detected_language state
            segments, info = self.whisper_model.transcribe(
                dummy_audio,
                language=self.language,  # Use configured language (or None for auto)
                beam_size=self.beam_size,
                vad_filter=False,
                word_timestamps=False,
                condition_on_previous_text=False,
                temperature=0.0,
            )

            # Consume the generator to ensure inference actually runs
            for _ in segments:
                pass

            # Clear GPU cache after warmup to free any temporary allocations
            if TORCH_AVAILABLE and torch.cuda.is_available():
                torch.cuda.empty_cache()

            # Update warmup state
            self._warmed_up = True
            self._last_warmup_time = time.time()

            warmup_time_ms = (time.time() - start_time) * 1000
            print(f"[WhisperProvider] Warmup completed in {warmup_time_ms:.0f}ms")
            return True

        except Exception as e:
            print(f"[WhisperProvider] Warmup failed: {e}")
            import traceback
            traceback.print_exc()
            return False

    def create_session(self, session_id: str, participant_id: str) -> Optional[WhisperSession]:
        """Create a new transcription session."""
        if not self.model_ready:
            return None

        config = {
            'language': self.language,
            'beam_size': self.beam_size,
            'initial_prompt': self.initial_prompt,
            'vad_threshold': self.vad_threshold,
            'silence_duration_ms': self.silence_duration_ms,
            'continuation_window_ms': self.continuation_window_ms,
            'max_endpointing_delay_ms': self.max_endpointing_delay_ms,
            'min_speech_samples': int(self.min_speech_ms * 16),  # ms to samples @ 16kHz
            'max_speech_duration_ms': self.max_speech_duration_ms,
            'partial_interval_ms': self.partial_interval_ms,
            'audio_inactivity_timeout_ms': self.audio_inactivity_timeout_ms,
            'pre_buffer_samples': 3200,  # 200ms fixed
            'rms_threshold': self.rms_threshold,
        }

        return WhisperSession(
            session_id=session_id,
            participant_id=participant_id,
            whisper_model=self.whisper_model,
            vad_model=self.vad_model,
            config=config
        )

    async def cleanup(self) -> None:
        """Clean up resources."""
        self.whisper_model = None
        self.vad_model = None
        self.model_ready = False
        print("[WhisperProvider] Cleanup completed")

    def get_capabilities(self) -> dict:
        return {
            "supports_streaming": True,
            "supports_gpu": True,
            "supports_auto_detect": True,
            "model": f"faster-whisper-{self.model_size}",
            "device": self.device,
            "compute_type": self.compute_type,
            "language": self.language or "auto",
            "supported_languages": ["auto", "af", "am", "ar", "as", "az", "ba", "be", "bg", "bn", "bo", "br", "bs", "ca", "cs", "cy", "da", "de", "el", "en", "es", "et", "eu", "fa", "fi", "fo", "fr", "gl", "gu", "ha", "haw", "he", "hi", "hr", "ht", "hu", "hy", "id", "is", "it", "ja", "jw", "ka", "kk", "km", "kn", "ko", "la", "lb", "ln", "lo", "lt", "lv", "mg", "mi", "mk", "ml", "mn", "mr", "ms", "mt", "my", "ne", "nl", "nn", "no", "oc", "pa", "pl", "ps", "pt", "ro", "ru", "sa", "sd", "si", "sk", "sl", "sn", "so", "sq", "sr", "su", "sv", "sw", "ta", "te", "tg", "th", "tk", "tl", "tr", "tt", "uk", "ur", "uz", "vi", "yi", "yo", "zh", "yue"],
            "model_size_mb": 3000 if "large" in self.model_size else 1500,
            "latency_ms": "300-600 (VAD-chunked)",
        }
