"""VAD_MAX_ENDPOINTING_DELAY_MS is a real ceiling on the "maybe done" hold (#469).

The value was read, logged and handed to the turn machine, and then nothing
consulted it: MAYBE_ENDING ended on the continuation window alone. That is
harmless while the window is fixed, because the window always ends the hold
first. Anything that extends the hold (gaze-gated endpointing, a faster
endpointing change) would leave it unbounded, so the ceiling is enforced at
both exits, measured from entry into MAYBE_ENDING, and clamped so it can never
be shorter than the window. A hold is "extended" here by raising the window
after construction, past the clamp, which is what such a change would do.
"""

import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

if "torch" not in sys.modules:
    _torch = types.ModuleType("torch")
    _torch.from_numpy = lambda a: a
    _torch.Tensor = type("Tensor", (), {})
    sys.modules["torch"] = _torch

from vad.speech_gate import GateConfig, GateSignal, SpeechGate, SpeechState  # noqa: E402
from providers import whisper_provider  # noqa: E402
from providers.whisper_provider import WhisperSession  # noqa: E402

STEP = 0.01  # 10 ms windows


def _gate(window=600, ceiling=2000):
    return SpeechGate(GateConfig(
        silence_duration_ms=500, continuation_window_ms=window,
        barge_in_min_speech_ms=600, max_endpointing_delay_ms=ceiling,
    ))


def _finalize_after_ms(gate):
    """Speak 1s, then stay silent; ms from entering MAYBE_ENDING to FINALIZE."""
    t = 0.0
    for _ in range(100):
        gate.observe(voiced=True, samples=160, now=t)
        t += STEP
    while gate.state != SpeechState.MAYBE_ENDING:
        gate.observe(voiced=False, samples=160, now=t)
        t += STEP
    entered = gate.pending_final_time
    for _ in range(2000):
        if GateSignal.FINALIZE in gate.observe(voiced=False, samples=160, now=t):
            return (t - entered) * 1000.0
        t += STEP
    return None


def test_a_normal_utterance_still_ends_on_the_continuation_window():
    gate = _gate(window=600, ceiling=2000)
    waited = _finalize_after_ms(gate)
    assert waited == pytest.approx(600, abs=15)
    assert gate.last_exit_reason == "window"


def test_an_extended_hold_ends_at_the_ceiling():
    gate = _gate(window=600, ceiling=2000)
    gate.config.continuation_window_ms = 10_000  # something holds the turn open
    waited = _finalize_after_ms(gate)
    assert waited == pytest.approx(2000, abs=15), "the hold had no ceiling"
    assert gate.last_exit_reason == "ceiling"


def test_a_ceiling_shorter_than_the_window_is_clamped_up_to_it():
    config = GateConfig(continuation_window_ms=1000, max_endpointing_delay_ms=500)
    assert config.max_endpointing_delay_ms == 1000
    waited = _finalize_after_ms(SpeechGate(config))
    assert waited == pytest.approx(1000, abs=15), "a short ceiling truncated the utterance"


def test_no_ceiling_configured_leaves_the_window_alone():
    gate = _gate(window=600, ceiling=None)
    assert _finalize_after_ms(gate) == pytest.approx(600, abs=15)


def _whisper_session(**overrides):
    config = {
        "vad_threshold": 0.35, "rms_threshold": 0.01, "silence_duration_ms": 500,
        "continuation_window_ms": 600, "max_endpointing_delay_ms": 2000,
        "partial_interval_ms": 10_000, **overrides,
    }
    return WhisperSession(session_id="s", participant_id="human",
                          whisper_model=None, vad_model=None, config=config)


def _hold_open(session, entered):
    """Put the session in MAYBE_ENDING since `entered`, with no inactivity."""
    session.gate.state = SpeechState.MAYBE_ENDING
    session.gate.speech_start_time = entered - 1.0
    session.gate.pending_final_time = entered
    session.gate.silence_start_time = entered - 0.5
    session.last_audio_time = 0


def test_the_stream_end_path_ends_an_extended_hold_at_the_ceiling(monkeypatch):
    session = _whisper_session()
    session.continuation_window_ms = 10_000
    session.gate.config.continuation_window_ms = 10_000
    _hold_open(session, entered=100.0)
    monkeypatch.setattr(session, "_generate_final", lambda t: None)

    monkeypatch.setattr(whisper_provider.time, "time", lambda: 100.0 + 2.01)
    session.process_audio(b"")
    assert session.gate.state == SpeechState.IDLE, "the stream-end path ignored the ceiling"


def test_the_whisper_session_clamps_a_short_ceiling():
    session = _whisper_session(continuation_window_ms=1000, max_endpointing_delay_ms=300)
    assert session.gate.config.max_endpointing_delay_ms == 1000
