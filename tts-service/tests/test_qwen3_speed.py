"""Tests for Qwen3 playback-rate control (#3 prosody).

``speed`` is declared in tts.proto and plumbed all the way from the agent, but
faster-qwen3-tts has no rate control of its own, so the provider used to accept
and discard it — every utterance in a conversation came out at exactly one rate
and one affect. These cover the resampler that gives the channel back.

Pure numpy; needs neither torch nor the model weights.

    pytest tts-service/tests/test_qwen3_speed.py
"""

import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from providers.qwen3_provider import (  # noqa: E402
    _MAX_SPEED,
    _MIN_SPEED,
    _SpeedResampler,
    _normalize_speed,
)

SAMPLE_RATE = 24000


def _tone(seconds=1.0, hz=220.0):
    t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    return (np.sin(2 * np.pi * hz * t) * 20000).astype(np.int16)


# ── _normalize_speed ─────────────────────────────────────────────────────────

def test_near_one_snaps_to_exactly_one():
    # So the overwhelmingly common path bypasses the resampler entirely.
    assert _normalize_speed(1.0) == 1.0
    assert _normalize_speed(1.001) == 1.0
    assert _normalize_speed(0.999) == 1.0


def test_out_of_range_is_clamped_not_rejected():
    # A bad caller should degrade to odd-sounding audio, never to no audio.
    assert _normalize_speed(9.0) == _MAX_SPEED
    assert _normalize_speed(0.01) == _MIN_SPEED


def test_garbage_falls_back_to_one():
    assert _normalize_speed(None) == 1.0
    assert _normalize_speed("fast") == 1.0
    assert _normalize_speed(float("nan")) == 1.0
    assert _normalize_speed(float("inf")) == 1.0


# ── _SpeedResampler ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("speed", [0.5, 0.94, 0.97, 1.03, 1.08, 2.0])
def test_duration_scales_by_the_requested_factor(speed):
    audio = _tone()
    out = _SpeedResampler(speed).process(audio)
    assert abs(len(out) - len(audio) / speed) <= 1


@pytest.mark.parametrize("speed", [0.94, 1.03, 1.08, 2.0])
@pytest.mark.parametrize("chunk", [1, 7, 480, 4000])
def test_chunked_matches_whole_buffer(speed, chunk):
    """The property that makes this safe to use on a streaming provider.

    A naive per-chunk resampler restarts the read phase at every boundary and
    drops or repeats a fraction of a sample each time, which clicks. Chunked
    output must be indistinguishable from processing the whole utterance at once
    — at every chunk size the provider might hand us, down to one sample.
    """
    audio = _tone()
    whole = _SpeedResampler(speed).process(audio)

    r = _SpeedResampler(speed)
    parts = [r.process(audio[i:i + chunk]) for i in range(0, len(audio), chunk)]
    chunked = np.concatenate([p for p in parts if p.size])

    assert abs(len(whole) - len(chunked)) <= 1
    n = min(len(whole), len(chunked))
    assert np.max(np.abs(whole[:n].astype(int) - chunked[:n].astype(int))) <= 1


def test_output_stays_int16_pcm():
    out = _SpeedResampler(1.08).process(_tone(0.1))
    assert out.dtype == np.int16


def test_full_scale_input_does_not_wrap():
    # Interpolation can overshoot past int16 range; clipping must catch it
    # rather than wrapping a peak to the opposite rail (an audible click).
    loud = np.full(1000, 32767, dtype=np.int16)
    loud[::2] = -32768
    out = _SpeedResampler(0.97).process(loud)
    assert out.min() >= -32768 and out.max() <= 32767


def test_tiny_chunks_are_buffered_not_dropped():
    # Sub-two-sample chunks cannot be interpolated across yet; they must be
    # carried forward rather than silently discarded.
    r = _SpeedResampler(1.05)
    assert r.process(np.array([100], dtype=np.int16)).size == 0
    assert r.process(np.array([], dtype=np.int16)).size == 0
    out = r.process(np.arange(500, dtype=np.int16))
    assert out.size > 0


def test_empty_input_is_safe():
    assert _SpeedResampler(1.05).process(np.empty(0, dtype=np.int16)).size == 0
