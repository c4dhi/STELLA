"""The speech buffer must be able to hold everything the VAD lets a user say.

This is one invariant with one failure mode. The VAD forces a final at
`max_speech_duration_ms`; the buffer keeps the most recent
`max_speech_buffer_samples` and DISCARDS THE OLDEST. So if the buffer is
smaller than the endpointing limit, any utterance in the gap loses its opening —
the clause that says what the sentence is about — and says nothing about it.

Observed on prod: endpointing allowed 30s, the buffer held 16s, and a 21s
answer was transcribed as "die wir da gegangen sind nach den Vorlesungen, das
ist mir so in Erinnerung geblieben." The first five seconds, naming what "die"
referred to, were gone. `Final (16.00s, ...)` in the log is the buffer cap
exactly.
"""

import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import stt_pb2  # noqa: E402

if "torch" not in sys.modules:
    _torch = types.ModuleType("torch")
    _torch.from_numpy = lambda a: a
    _torch.Tensor = type("Tensor", (), {})
    sys.modules["torch"] = _torch

from providers.whisper_provider import WhisperSession  # noqa: E402


def _session(**overrides):
    config = {
        "vad_threshold": 0.35,
        "rms_threshold": 0.01,
        "max_speech_duration_ms": 30000,
        "partial_interval_ms": 10_000,
        **overrides,
    }
    return WhisperSession(
        session_id="s", participant_id="human",
        whisper_model=None, vad_model=None, config=config,
    )


def test_buffer_holds_a_full_length_utterance():
    """THE invariant. If this fails, users silently lose the start of long
    answers — which is what happened."""
    s = _session(max_speech_duration_ms=30000)
    endpointing_samples = 30000 / 1000 * 16000
    assert s.max_speech_buffer_samples >= endpointing_samples


def test_the_cap_follows_the_endpointing_limit():
    """Raising how long someone may speak must raise what we can keep. Two
    independent constants is exactly how these drifted apart."""
    short = _session(max_speech_duration_ms=10000)
    long_ = _session(max_speech_duration_ms=60000)
    assert long_.max_speech_buffer_samples > short.max_speech_buffer_samples
    assert short.max_speech_buffer_samples >= 10000 / 1000 * 16000
    assert long_.max_speech_buffer_samples >= 60000 / 1000 * 16000


def test_a_long_utterance_keeps_its_opening():
    """Accumulate a full endpointing-limit utterance and check the first
    sample is still the first sample."""
    s = _session(max_speech_duration_ms=30000)
    marker = 12345
    s._accumulate_speech(np.array([marker], dtype=np.int16))
    # 29 more seconds of audio, in 1s blocks.
    for _ in range(29):
        s._accumulate_speech(np.zeros(16000, dtype=np.int16))
    assert s.speech_buffer[0] == marker, "the start of the utterance was discarded"


def test_the_buffer_is_a_typed_array_not_a_list_of_boxed_ints(capsys):
    """A Python list boxes every sample (~36 bytes). At the new cap that is
    20MB per active session against 1.1MB for array('h') — and the cap had to
    grow to fix the truncation, so the representation had to stop being
    wasteful at the same time."""
    from array import array
    s = _session()
    assert isinstance(s.speech_buffer, array)
    assert isinstance(s.pre_buffer, array)
    assert s.speech_buffer.itemsize == 2
    # len() must still count SAMPLES, not bytes — every call site assumes it.
    s._accumulate_speech(np.zeros(1000, dtype=np.int16))
    assert len(s.speech_buffer) == 1000


def test_overflow_is_reported_rather_than_silent(capsys):
    """If the backstop ever does fire, it must not do so quietly — a silent
    drop here reads as 'the user only said the second half'."""
    s = _session(max_speech_duration_ms=1000)
    s._accumulate_speech(np.zeros(s.max_speech_buffer_samples + 16000, dtype=np.int16))
    assert "BUFFER OVERFLOW" in capsys.readouterr().out


def test_partials_see_the_whole_utterance():
    """Partials used to carry a second, tighter cap, so a long utterance
    displayed a sliding window that dropped its own beginning while the user
    was still speaking."""
    s = _session(max_speech_duration_ms=30000)
    s.min_speech_samples = 1
    marker = 999
    s._accumulate_speech(np.array([marker], dtype=np.int16))
    for _ in range(20):
        s._accumulate_speech(np.zeros(16000, dtype=np.int16))

    captured = {}
    s.transcription_executor = types.SimpleNamespace(
        submit=lambda fn, audio: captured.setdefault("audio", audio)
    )
    s._submit_async_partial()
    assert captured["audio"][0] == marker
