"""faster-whisper STT provider with Silero VAD - Industry-standard implementation.

Follows industry best practices (LiveKit, OpenAI Realtime, Deepgram, Pipecat):
- Single VAD signal (Silero probability threshold)
- 3-state machine (IDLE/SPEAKING/MAYBE_ENDING) with continuation window
- Handles natural pauses (thinking, hesitation) without fragmenting utterances
- Configurable endpointing delays for conversational speech
"""

import difflib
import json
import os
import re
import time
import unicodedata
import uuid
from typing import List, Optional, Tuple
from concurrent.futures import ThreadPoolExecutor, Future
import numpy as np

from .base import STTProvider, STTSession
import stt_pb2

# ── Decode diagnostics (STT_DECODE_DIAGNOSTICS) ──────────────────────────────
# Logging-only instrumentation for the endpointing/hallucination investigation.
# Off by default; when on, each turn emits one `[Diag] {json}` line comparing
# the decodes we could have used against the one we actually shipped:
#
#   final    — what we ship today: the full buffer, INCLUDING the ~1.1s of
#              trailing silence accumulated through the silence + continuation
#              windows.
#   shadow   — the same utterance decoded at MAYBE_ENDING entry, i.e. ~600ms
#              earlier. Complete speech, less trailing silence.
#   partial  — the last in-flight partial, snapshotted while the user was still
#              speaking, so structurally missing the tail.
#   trimmed  — the final's audio with trailing silence removed, decoded after
#              the fact. Isolates silence padding as a hallucination cause.
#
# The point of the comparison is that all four run identical decode parameters,
# so any disagreement is attributable to the audio window, not to sampling.

_WORD_RE = re.compile(r"\w+", re.UNICODE)

# Bounded so a stuck shadow decode can never hold up a real turn. It is queued a
# continuation window before the final needs it, so this should never be hit.
_SHADOW_WAIT_TIMEOUT_S = 2.0


def _normalize_for_compare(text: str) -> str:
    r"""Casefold, drop punctuation, collapse whitespace.

    Deliberately script-agnostic: unicodedata + ``\w`` rather than any
    per-language table, so the comparison behaves identically in every language
    the model transcribes.

    NFKC, not NFKD. Decomposing splits a combining mark off its base character
    (Cyrillic й -> и + U+0306, German ä -> a + U+0308), and ``\w`` does not
    match combining marks — so NFKD silently tore words in half in every script
    that uses them, inflating the difference rate for exactly the non-English
    turns this investigation cares about.
    """
    if not text:
        return ""
    composed = unicodedata.normalize("NFKC", text)
    return " ".join(_WORD_RE.findall(composed.casefold()))


def _text_delta(candidate: str, reference: str) -> dict:
    """Compare a candidate decode against the reference (the shipped final).

    ``similarity`` is over normalized text so casing and punctuation don't count
    as differences — we care whether the words match, not the formatting.
    """
    c_norm, r_norm = _normalize_for_compare(candidate), _normalize_for_compare(reference)
    c_words, r_words = c_norm.split(), r_norm.split()
    return {
        "text": candidate,
        "identical": c_norm == r_norm,
        "similarity": round(difflib.SequenceMatcher(None, c_norm, r_norm).ratio(), 4),
        "words": len(c_words),
        "word_delta": len(c_words) - len(r_words),
        # A candidate that is a strict prefix of the reference is the truncation
        # signature (the tail was missing), as opposed to a differing decode.
        "is_prefix_of_reference": bool(c_norm) and r_norm.startswith(c_norm) and c_norm != r_norm,
    }


def _collect_segments(segments) -> Tuple[str, dict]:
    """Drain a faster-whisper segment generator into text + confidence metrics.

    ``avg_logprob`` and ``no_speech_prob`` are the signals that separate a real
    short utterance from a hallucinated one over near-silence. The live path
    reads only ``.text`` and drops both; this keeps them.

    Worst values (not means) are reported alongside the means, because a single
    bad segment is what a hallucination looks like in a multi-segment decode.
    """
    texts, logprobs, no_speech, compression = [], [], [], []
    for seg in segments:
        texts.append(seg.text)
        for attr, sink in (
            ("avg_logprob", logprobs),
            ("no_speech_prob", no_speech),
            ("compression_ratio", compression),
        ):
            value = getattr(seg, attr, None)
            if value is not None:
                sink.append(float(value))

    def _stats(values, worst):
        if not values:
            return None
        return {"mean": round(sum(values) / len(values), 4), "worst": round(worst(values), 4)}

    return "".join(texts).strip(), {
        "segments": len(texts),
        # Worst = lowest confidence / highest silence-likelihood / most repetitive.
        "avg_logprob": _stats(logprobs, min),
        "no_speech_prob": _stats(no_speech, max),
        "compression_ratio": _stats(compression, max),
    }


def _trailing_silence_samples(samples: np.ndarray, rms_threshold: float, frame: int = 512) -> int:
    """Count trailing samples that are below the RMS gate.

    Uses the same energy gate the VAD path already applies, so "silence" here
    means the same thing it means everywhere else in this file.
    """
    if samples.size == 0:
        return 0
    silent = 0
    for start in range(samples.size - frame, -1, -frame):
        window = samples[start:start + frame].astype(np.float32) / 32768.0
        if float(np.sqrt(np.mean(window ** 2))) >= rms_threshold:
            break
        silent += frame
    return min(silent, samples.size)

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
        self.max_endpointing_delay_ms = config.get('max_endpointing_delay_ms', 2000)
        self.min_speech_samples = config.get('min_speech_samples', 8000)  # 0.5s @ 16kHz
        self.max_speech_duration_ms = config.get('max_speech_duration_ms', 30000)
        self.partial_interval_ms = config.get('partial_interval_ms', 1000)
        self.audio_inactivity_timeout_ms = config.get('audio_inactivity_timeout_ms', 1500)
        # Barge-in: how much CONTINUOUS voiced audio makes an utterance an
        # interruption rather than a backchannel. This is the whole barge-in
        # decision — see _check_speech_activity. A backchannel ("mhm", "ja",
        # "aha") is acoustically short in every language, so duration separates
        # it from a real interruption without any text, model or word list.
        self.barge_in_min_speech_ms = config.get('barge_in_min_speech_ms', 600)

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

        # Barge-in signal state. `voiced_samples` counts only frames that passed
        # BOTH the RMS gate and VAD, so silence inside an utterance does not
        # inflate it — 600ms here means 600ms of actual voice.
        self.voiced_samples = 0
        self.barge_in_signalled = False

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

        # ── Decode diagnostics (logging only, see module header) ──
        self.diagnostics_enabled = bool(config.get('decode_diagnostics', False))
        # The shadow decode shares the partial executor on purpose. It is a
        # single worker, so every whisper call on this session stays serialized
        # — the same property _generate_final already relies on when it drains
        # pending_partial_future before decoding. A second executor would put
        # two decodes on the model at once, which nothing here establishes as
        # safe.
        self.pending_shadow_future: Optional[Future] = None
        self.shadow_result: Optional[dict] = None
        self.shadow_submitted_at = 0.0
        self.last_partial_snapshot = ""

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
            time_in_maybe_ending = (current_time - self.pending_final_time) * 1000
            if time_in_maybe_ending >= self.continuation_window_ms:
                total_silence = (current_time - self.silence_start_time) * 1000 if self.silence_start_time else time_in_maybe_ending
                print(f"[WhisperSession] Continuation window expired ({time_in_maybe_ending:.0f}ms in MAYBE_ENDING, {total_silence:.0f}ms total silence)")
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
                    if partial_text:
                        # Keep the newest partial regardless of whether it is
                        # emitted; the dedup below governs emission, not what the
                        # diagnostics compare against.
                        self.last_partial_snapshot = partial_text
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
        - MAYBE_ENDING -> IDLE: continuation_window_ms elapsed OR max_endpointing_delay_ms reached
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
                        self._submit_shadow_decode()
                elif self.state == "MAYBE_ENDING":
                    self._accumulate_speech(audio_int16)
                    time_in_maybe_ending = (current_time - self.pending_final_time) * 1000
                    if time_in_maybe_ending >= self.continuation_window_ms:
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

                # Barge-in trigger. Once the user has voiced enough audio, this
                # is an interruption and not a backchannel — say so immediately,
                # from VAD alone. Waiting for a partial would add a decode
                # (~400-550ms measured) before the agent could even react, and
                # the text would then have to be judged in a language we may not
                # have identified yet. Duration needs neither.
                self.voiced_samples += len(audio_int16)
                if not self.barge_in_signalled:
                    voiced_ms = self.voiced_samples / 16000 * 1000
                    if voiced_ms >= self.barge_in_min_speech_ms:
                        self.barge_in_signalled = True
                        print(f"[WhisperSession] Barge-in signal ({voiced_ms:.0f}ms voiced)")
                        events.append(stt_pb2.TranscriptEvent(
                            text="",
                            is_final=False,
                            transcript_id=self.transcript_id,
                            participant_id=self.participant_id,
                            confidence=0.0,
                            timestamp_ms=int(current_time * 1000),
                            speech_started=False,
                            speech_confirmed=True,
                        ))

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
                        # Speech buffer is complete here (the user has been quiet
                        # for silence_duration_ms), so this decode is a candidate
                        # final, not a partial. Diagnostics-gated; no-op when off.
                        self._submit_shadow_decode()
                        # Don't emit final yet - wait for continuation window

                elif self.state == "MAYBE_ENDING":
                    # Continue accumulating audio during MAYBE_ENDING (in case speech resumes)
                    self._accumulate_speech(audio_int16)

                    # Check if continuation window expired
                    # Only use time_in_maybe_ending - this ensures we always wait the full
                    # continuation window, even if silence accumulated during transcription blocking
                    time_in_maybe_ending = (current_time - self.pending_final_time) * 1000
                    total_silence = (current_time - self.silence_start_time) * 1000

                    if time_in_maybe_ending >= self.continuation_window_ms:
                        # Transition: MAYBE_ENDING -> IDLE, emit final
                        print(f"[WhisperSession] Continuation window expired ({time_in_maybe_ending:.0f}ms in MAYBE_ENDING, {total_silence:.0f}ms total silence)")
                        final_event = self._generate_final(current_time)
                        if final_event:
                            events.append(final_event)
                        self._reset()

        except Exception as e:
            print(f"[WhisperSession] VAD error: {e}")

        return events

    def _decode_with_metrics(self, audio_float: np.ndarray) -> Tuple[str, dict]:
        """Decode audio and return its text plus the confidence signals.

        Same parameters as the live final path, so results are comparable. The
        per-segment ``avg_logprob``/``no_speech_prob``/``compression_ratio`` are
        the standard hallucination discriminators — the model computes them
        either way, and reading them costs nothing.
        """
        segments, info = self.whisper_model.transcribe(
            audio_float,
            language=self._forced_language(),
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
        text, metrics = _collect_segments(segments)
        metrics["duration_sec"] = round(float(audio_float.size) / 16000, 3)
        metrics["language"] = getattr(info, 'language', None) or ""
        metrics["language_probability"] = round(float(getattr(info, 'language_probability', 0.0) or 0.0), 4)
        return text, metrics

    def _shadow_worker(self, audio_buffer: list) -> Optional[dict]:
        """Decode the complete utterance at MAYBE_ENDING entry (diagnostics only).

        By the time this runs the user has been silent for silence_duration_ms,
        so the speech buffer is complete — this is not a truncated partial. It
        exists to answer whether the continuation window could be overlapped
        with the decode instead of spent waiting.
        """
        started = time.time()
        try:
            audio_samples = np.array(audio_buffer, dtype=np.int16)
            audio_float = self._preprocess_audio(audio_samples.astype(np.float32) / 32768.0)
            text, metrics = self._decode_with_metrics(audio_float)
            metrics["decode_ms"] = round((time.time() - started) * 1000, 1)
            return {"text": text, "metrics": metrics}
        except Exception as e:
            print(f"[WhisperSession] Shadow decode error: {e}")
            return None

    def _submit_shadow_decode(self) -> None:
        """Queue the shadow decode on entering MAYBE_ENDING. Never blocks."""
        if not self.diagnostics_enabled:
            return
        if self.pending_shadow_future is not None or self.pending_partial_future is not None:
            # A decode is already queued on the single worker; adding another
            # would only measure queueing delay, not decode latency.
            return
        if len(self.speech_buffer) < self.min_speech_samples:
            return
        try:
            self.shadow_submitted_at = time.time()
            self.pending_shadow_future = self.transcription_executor.submit(
                self._shadow_worker, self.speech_buffer.copy()
            )
        except Exception as e:
            print(f"[WhisperSession] Shadow submit error: {e}")
            self.pending_shadow_future = None

    def _looks_hallucinated(self, metrics: dict) -> bool:
        """True when a decode's own confidence signals say it was not speech.

        Uses the thresholds already passed to whisper.transcribe() rather than
        new magic numbers: no_speech_threshold (0.6) and log_prob_threshold
        (-1.0) are the model's own conventions for "this segment is silence" and
        "this decode is low confidence". They were being computed on every call
        and discarded — only segment.text was ever read.

        Both must fire. Either alone is noisy: quiet-but-real speech can score a
        poor logprob, and a confident decode can sit above the no-speech
        threshold. Requiring both keeps this from eating genuine short turns.
        """
        no_speech = metrics.get("no_speech_prob") or {}
        logprob = metrics.get("avg_logprob") or {}
        worst_no_speech = no_speech.get("worst")
        worst_logprob = logprob.get("worst")
        if worst_no_speech is None or worst_logprob is None:
            return False
        return (
            worst_no_speech >= self.config.get("no_speech_threshold", 0.6)
            and worst_logprob <= self.config.get("log_prob_threshold", -1.0)
        )

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

            # Process segments, keeping the confidence signals the model already
            # computed instead of reading only .text.
            segment_list = list(segments)
            transcribed_text = ""
            for segment in segment_list:
                transcribed_text += segment.text + " "
            transcribed_text = transcribed_text.strip()
            _, metrics = _collect_segments(segment_list)

            transcription_time = (time.time() - start_time) * 1000

            if transcribed_text and self._looks_hallucinated(metrics):
                # Whisper invents filler over near-silence — "Thank you.", "You",
                # "Y'all." — and a partial is the one place that costs real
                # damage: a barge-in triggers on it, so the agent stops talking
                # because the model imagined a word. Judged against whisper's OWN
                # configured thresholds, not invented ones, and applied to
                # partials only: dropping a partial loses nothing (another
                # arrives, and the final is decoded separately), whereas dropping
                # a final would lose the user's turn.
                print(
                    f"[WhisperSession] Partial suppressed as hallucination "
                    f"({audio_duration_sec:.2f}s): '{transcribed_text[:40]}' "
                    f"no_speech={metrics.get('no_speech_prob')} logprob={metrics.get('avg_logprob')}"
                )
                return None

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
                partial_result = self.pending_partial_future.result(timeout=2.0)
                if partial_result:
                    # Previously dropped on the floor. Kept so diagnostics can
                    # compare the last partial against the shipped final.
                    self.last_partial_snapshot = partial_result
            except Exception:
                pass  # Ignore errors, we're generating final anyway
            finally:
                self.pending_partial_future = None
                self.pending_partial_transcript_id = None

        # Drain the shadow decode queued on entering MAYBE_ENDING. It shares the
        # single worker with partials and was submitted a continuation window
        # ago, so it is normally already done. The wait is bounded regardless:
        # instrumentation must not be able to stall a real turn.
        self.shadow_result, shadow_wait_ms = None, 0.0
        if self.pending_shadow_future is not None:
            waited_from = time.time()
            try:
                self.shadow_result = self.pending_shadow_future.result(timeout=_SHADOW_WAIT_TIMEOUT_S)
            except Exception as e:
                print(f"[WhisperSession] Shadow decode unavailable: {e}")
            finally:
                shadow_wait_ms = (time.time() - waited_from) * 1000
                self.pending_shadow_future = None

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

            # Materialize once: the shipped text is built exactly as before, and
            # the confidence metrics are read off the same segments rather than
            # from a second pass.
            segment_list = list(segments)
            final_text = ""
            for segment in segment_list:
                final_text += segment.text + " "
            final_text = final_text.strip()
            _, final_metrics = _collect_segments(segment_list)

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

            diagnostics_json = ""
            if self.diagnostics_enabled:
                diagnostics_json = self._log_decode_diagnostics(
                    final_text=final_text,
                    final_metrics=final_metrics,
                    final_decode_ms=transcription_time,
                    audio_samples=audio_samples,
                    shadow_wait_ms=shadow_wait_ms,
                )

            return stt_pb2.TranscriptEvent(
                text=final_text,
                is_final=True,
                transcript_id=self.transcript_id,
                participant_id=self.participant_id,
                confidence=0.95,
                timestamp_ms=int(current_time * 1000),
                detected_language=detected_language or "",
                language_confidence=language_confidence,
                decode_diagnostics=diagnostics_json,
            )

        except Exception as e:
            print(f"[WhisperSession] Final transcription error: {e}")
            import traceback
            traceback.print_exc()
            return None

        finally:
            self.is_transcribing = False
            self._clear_gpu_memory()

    def _log_decode_diagnostics(
        self,
        final_text: str,
        final_metrics: dict,
        final_decode_ms: float,
        audio_samples: np.ndarray,
        shadow_wait_ms: float,
    ) -> str:
        """Emit one `[Diag] {json}` line per turn, then queue the trimmed decode.

        Returns the same record as a JSON string so it can ride out on the
        transcript event and reach the session metrics UI; "" on any failure.

        Everything here is wrapped: a diagnostics failure must never take down a
        turn that already produced a good transcript.
        """
        try:
            trailing = _trailing_silence_samples(audio_samples, self.rms_threshold)
            total = int(audio_samples.size)
            speech = max(total - trailing, 0)

            record = {
                "session": self.session_id,
                "transcript_id": self.transcript_id,
                "audio": {
                    "total_sec": round(total / 16000, 3),
                    "speech_sec": round(speech / 16000, 3),
                    "trailing_silence_sec": round(trailing / 16000, 3),
                    # The hallucination suspect: how much of what whisper saw was
                    # silence. Expected to be worst on short acknowledgements.
                    "silence_fraction": round(trailing / total, 4) if total else None,
                },
                "final": {
                    "text": final_text,
                    "decode_ms": round(final_decode_ms, 1),
                    "words": len(_normalize_for_compare(final_text).split()),
                    **final_metrics,
                },
                "shadow_wait_ms": round(shadow_wait_ms, 1),
            }

            if self.shadow_result:
                record["shadow"] = {
                    **_text_delta(self.shadow_result.get("text", ""), final_text),
                    "metrics": self.shadow_result.get("metrics"),
                    # How much earlier the shadow was ready. This is the latency
                    # the continuation window could give back if shadow == final.
                    "available_earlier_ms": round(
                        max((time.time() - self.shadow_submitted_at) * 1000 - shadow_wait_ms, 0), 1
                    ),
                }

            if self.last_partial_snapshot:
                # Expected to be a strict prefix of the final — partials are
                # snapshotted mid-speech, so they miss the tail by construction.
                record["last_partial"] = _text_delta(self.last_partial_snapshot, final_text)

            print(f"[Diag] {json.dumps(record, ensure_ascii=False)}", flush=True)
            shipped = json.dumps(record, ensure_ascii=False)

            # Trimmed decode runs AFTER the final has been handed back, so it
            # costs the live turn nothing. Correlate by transcript_id.
            if trailing > 0 and speech >= self.min_speech_samples:
                self.transcription_executor.submit(
                    self._trimmed_worker,
                    audio_samples[:speech].copy(),
                    final_text,
                    self.transcript_id,
                    record["audio"],
                )
            return shipped
        except Exception as e:
            print(f"[WhisperSession] Diagnostics error (ignored): {e}")
            return ""

    def _trimmed_worker(
        self, samples: np.ndarray, reference: str, transcript_id: Optional[str], audio_info: dict
    ) -> None:
        """Re-decode the utterance with trailing silence removed (diagnostics).

        If this consistently agrees with the final on long turns but *disagrees*
        on short ones — where it kills a hallucination the padded decode
        produced — then trimming is the fix and no rerun is needed.
        """
        started = time.time()
        try:
            audio_float = self._preprocess_audio(samples.astype(np.float32) / 32768.0)
            text, metrics = self._decode_with_metrics(audio_float)
            metrics["decode_ms"] = round((time.time() - started) * 1000, 1)
            print(
                "[DiagTrim] "
                + json.dumps(
                    {
                        "session": self.session_id,
                        "transcript_id": transcript_id,
                        "audio": audio_info,
                        "trimmed": {**_text_delta(text, reference), "metrics": metrics},
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as e:
            print(f"[WhisperSession] Trimmed decode error (ignored): {e}")

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
        self.voiced_samples = 0
        self.barge_in_signalled = False

        # Clear async partial state
        self.pending_partial_future = None
        self.pending_partial_transcript_id = None
        self.last_partial_text = ""

        # Clear diagnostics state (the futures are fire-and-forget; dropping the
        # handle just stops the next turn from reading a stale result).
        self.pending_shadow_future = None
        self.shadow_result = None
        self.shadow_submitted_at = 0.0
        self.last_partial_snapshot = ""

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
        self.max_endpointing_delay_ms = int(os.getenv("VAD_MAX_ENDPOINTING_DELAY_MS", "2000"))
        self.min_speech_ms = int(os.getenv("VAD_MIN_SPEECH_MS", "500"))
        self.max_speech_duration_ms = int(os.getenv("VAD_MAX_SPEECH_DURATION_MS", "30000"))
        self.partial_interval_ms = int(os.getenv("PARTIAL_INTERVAL_MS", "1000"))
        self.audio_inactivity_timeout_ms = int(os.getenv("VAD_AUDIO_INACTIVITY_TIMEOUT_MS", "1500"))
        # RMS energy gate - filters quiet background noise before VAD
        # 0.008 = -42dB (permissive), 0.01 = -40dB (moderate), 0.02 = -34dB (strict)
        self.rms_threshold = float(os.getenv("VAD_RMS_THRESHOLD", "0.008"))
        # Barge-in sensitivity: milliseconds of voiced audio before an utterance
        # counts as an interruption. Lives here, next to the other VAD knobs,
        # because it IS a VAD knob — the agent only reacts to the signal.
        # Lower = the agent yields sooner but backchannels start cutting it off;
        # higher = it talks over the user for longer before noticing.
        self.barge_in_min_speech_ms = int(os.getenv("BARGE_IN_MIN_SPEECH_MS", "600"))

        # Decode diagnostics: logging only, OFF by default. When on, each turn
        # runs extra decodes (shadow + trimmed) on the same single worker, which
        # costs GPU time — so this is an investigation switch, not a default.
        self.decode_diagnostics = os.getenv("STT_DECODE_DIAGNOSTICS", "0").lower() in ("1", "true", "yes", "on")

        print(f"[WhisperProvider] Config: model={self.model_size}, device={self.device}, "
              f"compute_type={self.compute_type}, language={self.language or 'auto'}")
        print(f"[WhisperProvider] VAD (3-state): threshold={self.vad_threshold}, "
              f"silence_ms={self.silence_duration_ms}, continuation_window_ms={self.continuation_window_ms}, "
              f"max_endpointing_delay_ms={self.max_endpointing_delay_ms}")
        print(f"[WhisperProvider] VAD limits: min_speech_ms={self.min_speech_ms}, "
              f"max_duration_ms={self.max_speech_duration_ms}, inactivity_ms={self.audio_inactivity_timeout_ms}")
        print(f"[WhisperProvider] RMS energy gate: threshold={self.rms_threshold} (-{int(20*np.log10(self.rms_threshold))}dB)")
        print(f"[WhisperProvider] Barge-in: {self.barge_in_min_speech_ms}ms of voiced audio")
        if self.decode_diagnostics:
            print("[WhisperProvider] Decode diagnostics ENABLED — extra shadow/trimmed decodes per turn")

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
            'barge_in_min_speech_ms': self.barge_in_min_speech_ms,
            'decode_diagnostics': self.decode_diagnostics,
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
