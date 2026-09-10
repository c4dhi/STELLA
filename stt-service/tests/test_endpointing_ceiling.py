"""Tests for the MAYBE_ENDING endpointing ceiling (max_endpointing_delay_ms).

`max_endpointing_delay_ms` is the hard ceiling on how long a session may sit in
MAYBE_ENDING, measured from `pending_final_time` (entry into the state). It is
enforced in all three places the continuation window is checked:

    1. process_audio          - stream-end / inactivity path
    2. _check_speech_activity - RMS-gate silence branch
    3. _check_speech_activity - VAD silence branch

Under static config the ceiling is never the deciding bound (it is clamped to be
>= continuation_window_ms, so the window always fires first). It becomes
load-bearing as soon as something extends the hold at runtime - e.g. gaze-gated
endpointing (#372) - which is what these tests simulate by widening
`continuation_window_ms` on a live session.

Neither torch nor faster-whisper is needed (both are import-guarded in the
provider); the VAD and Whisper models are stubbed. Runnable two ways:

    pytest stt-service/tests/test_endpointing_ceiling.py
    python stt-service/tests/test_endpointing_ceiling.py     # no pytest needed
"""

import os
import sys
import time

import numpy as np

# Make `providers` / `stt_pb2` importable (mirrors how the service runs from src/).
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from providers import whisper_provider  # noqa: E402
from providers.whisper_provider import (  # noqa: E402
    WhisperProvider,
    WhisperSession,
    _clamp_endpointing_ceiling,
)

SAMPLE_RATE = 16000
CONTINUATION_WINDOW_MS = 600
CEILING_MS = 2000


class _FakeSegment:
    def __init__(self, text):
        self.text = text


class _FakeInfo:
    language = "en"
    language_probability = 0.99


class _FakeWhisperModel:
    """Returns one fixed segment, so _generate_final always yields an event."""

    def transcribe(self, audio, **kwargs):
        return [_FakeSegment("hello world")], _FakeInfo()


class _FakeVadModel:
    """Silero stand-in: returns a fixed speech probability."""

    def __init__(self, speech_prob=0.0):
        self.speech_prob = speech_prob

    def __call__(self, audio, sample_rate):
        class _Prob:
            def __init__(self, value):
                self.value = value

            def item(self):
                return self.value

        return _Prob(self.speech_prob)

    def reset_states(self):
        pass


class _FakeTorch:
    """`torch.from_numpy` is the only torch call on the VAD path."""

    @staticmethod
    def from_numpy(array):
        return array


def _make_session(speech_prob=0.0, **overrides):
    config = {
        'vad_threshold': 0.5,
        'silence_duration_ms': 800,
        'continuation_window_ms': CONTINUATION_WINDOW_MS,
        'max_endpointing_delay_ms': CEILING_MS,
        'min_speech_samples': 8000,
        'max_speech_duration_ms': 30000,
        'partial_interval_ms': 1000,
        'audio_inactivity_timeout_ms': 1500,
        'rms_threshold': 0.01,
        'pre_buffer_samples': 3200,
    }
    config.update(overrides)
    return WhisperSession(
        session_id="s1",
        participant_id="p1",
        whisper_model=_FakeWhisperModel(),
        vad_model=_FakeVadModel(speech_prob),
        config=config,
    )


def _enter_maybe_ending(session, entered_at):
    """Put a session in MAYBE_ENDING with enough buffered audio for a final.

    speech_start_time / last_audio_time are set so that neither the
    max_speech_duration nor the audio-inactivity timeout can fire first and mask
    what is being tested.
    """
    session.state = "MAYBE_ENDING"
    session.transcript_id = "whisper_test"
    session.pending_final_time = entered_at
    session.silence_start_time = entered_at
    session.speech_start_time = entered_at - 1.0
    session.last_audio_time = time.time()
    session.speech_buffer = [0] * (session.min_speech_samples + 1)
    session.last_final_text = ""


def _extend_hold(session, hold_ms):
    """Simulate a runtime extension of the continuation window (cf. #372)."""
    session.continuation_window_ms = hold_ms


def _silence_bytes(num_samples=512, amplitude=0):
    return np.full(num_samples, amplitude, dtype=np.int16).tobytes()


# --------------------------------------------------------------------------
# Ceiling enforcement, one test per call site
# --------------------------------------------------------------------------

def test_ceiling_fires_in_process_audio_inactivity_path():
    # process_audio reads the wall clock itself, so anchor this test to time.time().
    session = _make_session()
    _enter_maybe_ending(session, entered_at=time.time() - 1.0)  # 1000ms in, ceiling is 2000ms
    _extend_hold(session, 60000)

    # Just under the ceiling: the extended hold keeps the turn open.
    events = session.process_audio(_silence_bytes(), SAMPLE_RATE)
    assert session.state == "MAYBE_ENDING", "hold ended before the ceiling"
    assert events == []

    # Past the ceiling: forced endpoint even though the hold is far from over.
    _enter_maybe_ending(session, entered_at=time.time() - (CEILING_MS / 1000.0) - 0.1)
    events = session.process_audio(_silence_bytes(), SAMPLE_RATE)
    assert session.state == "IDLE", "ceiling did not force an endpoint"
    assert len(events) == 1 and events[0].is_final


def test_ceiling_fires_in_rms_gate_silence_branch():
    session = _make_session()
    now = 2000.0
    _enter_maybe_ending(session, entered_at=now - (CEILING_MS / 1000.0) - 0.1)
    _extend_hold(session, 60000)

    # Audio below the RMS gate never reaches the VAD - the ceiling must still fire.
    quiet = np.zeros(512, dtype=np.float32)
    quiet_int16 = np.zeros(512, dtype=np.int16)
    events = session._check_speech_activity(quiet, quiet_int16, now)

    assert session.state == "IDLE", "ceiling not enforced in the RMS-gate branch"
    assert len(events) == 1 and events[0].is_final


def test_ceiling_fires_in_vad_silence_branch():
    saved_torch = getattr(whisper_provider, "torch", None)
    whisper_provider.torch = _FakeTorch()
    try:
        # speech_prob below threshold -> VAD silence branch
        session = _make_session(speech_prob=0.1)
        now = 3000.0
        _enter_maybe_ending(session, entered_at=now - (CEILING_MS / 1000.0) - 0.1)
        _extend_hold(session, 60000)

        # Loud enough to pass the RMS gate so the VAD branch is the one exercised.
        loud = np.full(512, 0.2, dtype=np.float32)
        loud_int16 = np.full(512, 6553, dtype=np.int16)
        events = session._check_speech_activity(loud, loud_int16, now)

        assert session.state == "IDLE", "ceiling not enforced in the VAD branch"
        assert len(events) == 1 and events[0].is_final
    finally:
        if saved_torch is None:
            delattr(whisper_provider, "torch")
        else:
            whisper_provider.torch = saved_torch


def test_hold_survives_until_the_ceiling():
    """An extended hold is honoured right up to the ceiling, not cut short."""
    session = _make_session()
    now = 4000.0
    entered_at = now - 1.5  # 1500ms in MAYBE_ENDING, ceiling is 2000ms
    _enter_maybe_ending(session, entered_at=entered_at)
    _extend_hold(session, 60000)

    quiet = np.zeros(512, dtype=np.float32)
    quiet_int16 = np.zeros(512, dtype=np.int16)
    events = session._check_speech_activity(quiet, quiet_int16, now)

    assert session.state == "MAYBE_ENDING"
    assert events == []


def test_normal_utterance_ends_on_the_continuation_window():
    """With default config the window is the deciding bound, not the ceiling."""
    session = _make_session()
    now = 5000.0
    entered_at = now - (CONTINUATION_WINDOW_MS / 1000.0) - 0.01
    _enter_maybe_ending(session, entered_at=entered_at)

    expired, reason, elapsed_ms = session._endpointing_hold_expired(now)
    assert expired
    assert reason == "Continuation window expired"
    assert elapsed_ms < CEILING_MS


# --------------------------------------------------------------------------
# Clamping: the ceiling must never be shorter than the continuation window
# --------------------------------------------------------------------------

def test_clamp_raises_a_too_short_ceiling():
    assert _clamp_endpointing_ceiling(300, 600) == 600


def test_clamp_leaves_a_valid_ceiling_alone():
    assert _clamp_endpointing_ceiling(2000, 600) == 2000
    assert _clamp_endpointing_ceiling(600, 600) == 600


def test_session_clamps_a_misconfigured_ceiling():
    session = _make_session(continuation_window_ms=1000, max_endpointing_delay_ms=400)
    assert session.max_endpointing_delay_ms == 1000

    # ...and so a misconfiguration cannot truncate an utterance early.
    now = 6000.0
    _enter_maybe_ending(session, entered_at=now - 0.5)  # 500ms in MAYBE_ENDING
    expired, _, _ = session._endpointing_hold_expired(now)
    assert not expired, "clamped ceiling still truncated the utterance"


def test_provider_clamps_a_misconfigured_ceiling():
    saved = {k: os.environ.get(k) for k in
             ("VAD_CONTINUATION_WINDOW_MS", "VAD_MAX_ENDPOINTING_DELAY_MS")}
    os.environ["VAD_CONTINUATION_WINDOW_MS"] = "1200"
    os.environ["VAD_MAX_ENDPOINTING_DELAY_MS"] = "500"
    try:
        provider = WhisperProvider()
        assert provider.max_endpointing_delay_ms == 1200
    finally:
        for key, value in saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def _run_standalone():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failures = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failures += 1
            print(f"FAIL {fn.__name__}: {e}")
    print(f"\n{len(fns) - failures}/{len(fns)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(_run_standalone())
