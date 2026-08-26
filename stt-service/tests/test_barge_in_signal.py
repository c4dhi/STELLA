"""The VAD barge-in signal — the whole voice-interruption decision.

The agent does not classify interruptions. It reacts to one event from here:
"the user has now voiced more than BARGE_IN_MIN_SPEECH_MS, this is not a
backchannel". Everything that makes that trustworthy is in this file:

  * it counts VOICED audio only, so a thinking pause inside an utterance does
    not accumulate toward the threshold;
  * it fires exactly once per utterance, so the agent is not told to interrupt
    thirty times a second;
  * it resets between utterances, so one interruption cannot affect the next.

The last one is a regression guard: the previous, text-based design kept
per-utterance state that only one exit path cleared, and a single dismissed
backchannel then swallowed every later interruption in the session.
"""

import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

# The real generated stub — these tests assert on the emitted event, so a
# placeholder would make them vacuous.
import stt_pb2  # noqa: E402

# torch is only used for the Silero VAD call, which the fake model replaces.
# `Tensor` is here because scipy introspects sys.modules["torch"].Tensor for
# array-API dispatch and raises on a stub without it.
if "torch" not in sys.modules:
    _torch = types.ModuleType("torch")
    _torch.from_numpy = lambda a: a
    _torch.Tensor = type("Tensor", (), {})
    sys.modules["torch"] = _torch

from providers.whisper_provider import WhisperSession  # noqa: E402


class _AlwaysSpeech:
    """Silero stand-in: every frame is speech."""

    def __call__(self, audio, sample_rate):
        return types.SimpleNamespace(item=lambda: 0.99)


class _NeverSpeech:
    def __call__(self, audio, sample_rate):
        return types.SimpleNamespace(item=lambda: 0.0)


FRAME_SAMPLES = 512                      # 32ms @ 16kHz, Silero's window
LOUD = 0.5                               # well above the RMS gate


def _session(vad, **overrides):
    config = {
        "vad_threshold": 0.35,
        "rms_threshold": 0.01,
        "barge_in_min_speech_ms": 600,
        "partial_interval_ms": 10_000,   # keep partial decoding out of the way
        "silence_duration_ms": 500,
        "continuation_window_ms": 600,
        **overrides,
    }
    return WhisperSession(
        session_id="s", participant_id="human",
        whisper_model=None, vad_model=vad, config=config,
    )


def _frame(amplitude):
    return (np.full(FRAME_SAMPLES, amplitude, dtype=np.float32),
            np.full(FRAME_SAMPLES, int(amplitude * 32767), dtype=np.int16))


def _feed(session, frames, amplitude=LOUD, t0=0.0):
    """Push `frames` frames of audio and return every event emitted."""
    events = []
    for i in range(frames):
        audio_float, audio_int16 = _frame(amplitude)
        events += session._check_speech_activity(
            audio_float, audio_int16, current_time=t0 + i * (FRAME_SAMPLES / 16000)
        )
    return events


def _confirmations(events):
    return [e for e in events if getattr(e, "speech_confirmed", False)]


def test_fires_once_the_threshold_of_voiced_audio_is_reached():
    session = _session(_AlwaysSpeech())
    # 600ms at 32ms/frame ≈ 19 frames. Feed well past it.
    events = _feed(session, 40)
    assert len(_confirmations(events)) == 1


def test_does_not_fire_before_the_threshold():
    session = _session(_AlwaysSpeech())
    # 10 frames = 320ms — a backchannel. The agent must never hear about it.
    events = _feed(session, 10)
    assert _confirmations(events) == []


def test_threshold_is_configurable():
    """A deployment that wants a hair trigger sets one number, not a prompt."""
    session = _session(_AlwaysSpeech(), barge_in_min_speech_ms=100)
    events = _feed(session, 10)
    assert len(_confirmations(events)) == 1


def test_silence_does_not_count_toward_the_threshold():
    """A quiet frame is not voice. Without this, an open mic in a noisy room
    would accumulate its way to an interruption with nobody speaking."""
    session = _session(_NeverSpeech())
    events = _feed(session, 60)
    assert _confirmations(events) == []


def test_the_signal_carries_no_text():
    """It is emitted from VAD, before any decode — that is what makes it fast
    and what makes it language-agnostic."""
    session = _session(_AlwaysSpeech())
    signal = _confirmations(_feed(session, 40))[0]
    assert signal.text == ""
    assert signal.is_final is False
    assert signal.speech_started is False


def test_state_resets_between_utterances():
    """Regression: one utterance must not be able to mute the next."""
    session = _session(_AlwaysSpeech())
    assert len(_confirmations(_feed(session, 40))) == 1
    session._reset()
    assert session.voiced_samples == 0
    assert session.barge_in_signalled is False
    assert len(_confirmations(_feed(session, 40))) == 1
