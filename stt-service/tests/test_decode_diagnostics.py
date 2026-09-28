"""Unit tests for the decode-diagnostics helpers in whisper_provider.

These are the pure functions the STT investigation's conclusions rest on — if
the similarity metric or the silence measurement is wrong, every number in the
`[Diag]` logs is wrong, and we would tune endpointing against noise.

The module imports stt_pb2 (generated) at top level and torch/faster-whisper
behind try/except. Only the generated stub needs stubbing to import it here;
none of these helpers touch a model.
"""

import sys
import types
from pathlib import Path

import numpy as np
import pytest

# providers/base.py evaluates stt_pb2.TranscriptEvent in a type annotation at
# class-definition time, so the stub needs the attribute to exist — the value is
# never used by anything under test.
_stub = types.ModuleType("stt_pb2")
_stub.TranscriptEvent = object
sys.modules.setdefault("stt_pb2", _stub)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from providers.whisper_provider import (  # noqa: E402
    _collect_segments,
    _normalize_for_compare,
    _text_delta,
    _trailing_silence_samples,
)


# ── _normalize_for_compare ───────────────────────────────────────────────────

def test_normalize_ignores_case_and_punctuation():
    """Formatting differences must not register as transcript differences."""
    assert _normalize_for_compare("Ja, also — ich gehe!") == _normalize_for_compare("ja also ich gehe")


def test_normalize_is_not_language_specific():
    """Non-latin scripts survive normalization rather than being emptied.

    The comparison runs on whatever the model transcribes, so a metric that
    silently returns "" for CJK would report every such turn as identical.
    """
    assert _normalize_for_compare("今日はいい天気ですね") != ""
    # Combining marks must stay attached to their base character. Decomposing
    # splits them off and \w drops them, tearing one word into two — which in
    # German (the main production language here) would report a perfect match
    # as a difference on any word with an umlaut.
    assert _normalize_for_compare("Здравствуйте") == "здравствуйте"
    assert _normalize_for_compare("Hitze im Präsenzbüro") == "hitze im präsenzbüro"
    assert len(_normalize_for_compare("Grüße").split()) == 1


def test_normalize_empty_is_safe():
    assert _normalize_for_compare("") == ""
    assert _normalize_for_compare(None) == ""


# ── _text_delta ──────────────────────────────────────────────────────────────

def test_identical_text_is_flagged_identical():
    d = _text_delta("Mein Name ist Felix.", "mein name ist felix")
    assert d["identical"] is True
    assert d["similarity"] == 1.0
    assert d["word_delta"] == 0


def test_truncated_partial_is_detected_as_a_prefix():
    """The signature of a partial snapshotted mid-speech: right words, missing tail."""
    final = "Ja, also ich gehe schon oft spazieren, aber nicht bei dieser aktuellen Hitze."
    partial = "Ja, also ich gehe schon oft spazieren, aber nicht bei dieser aktuellen"
    d = _text_delta(partial, final)
    assert d["is_prefix_of_reference"] is True
    assert d["identical"] is False
    assert d["word_delta"] == -1


def test_different_decode_is_not_a_prefix():
    """A hallucination is a different decode, not a truncation — the two must
    not be confused, because they imply different fixes."""
    d = _text_delta("Thank you.", "Ja, genau das meine ich.")
    assert d["is_prefix_of_reference"] is False
    assert d["identical"] is False
    assert d["similarity"] < 0.5


def test_prefix_flag_excludes_exact_match():
    """An identical string is trivially its own prefix; reporting that as
    truncation would inflate the truncation rate to 100%."""
    assert _text_delta("same words", "same words")["is_prefix_of_reference"] is False


# ── _trailing_silence_samples ────────────────────────────────────────────────

def _tone(n, amplitude=8000):
    return (np.sin(np.arange(n) / 4.0) * amplitude).astype(np.int16)


def test_trailing_silence_measured_from_the_end():
    speech, silence = _tone(16000), np.zeros(8000, dtype=np.int16)
    samples = np.concatenate([speech, silence])
    measured = _trailing_silence_samples(samples, rms_threshold=0.01)
    # Frame-quantized to 512, so allow one frame of slack in either direction.
    assert abs(measured - 8000) <= 512


def test_leading_silence_is_not_counted():
    """Only the tail matters — trimming the front would cut speech onset."""
    samples = np.concatenate([np.zeros(8000, dtype=np.int16), _tone(16000)])
    assert _trailing_silence_samples(samples, rms_threshold=0.01) <= 512


def test_all_silence_never_exceeds_the_buffer():
    samples = np.zeros(4096, dtype=np.int16)
    assert _trailing_silence_samples(samples, rms_threshold=0.01) <= samples.size


def test_empty_buffer_is_safe():
    assert _trailing_silence_samples(np.array([], dtype=np.int16), rms_threshold=0.01) == 0


# ── _collect_segments ────────────────────────────────────────────────────────

class _Seg:
    def __init__(self, text, avg_logprob=None, no_speech_prob=None, compression_ratio=None):
        self.text = text
        if avg_logprob is not None:
            self.avg_logprob = avg_logprob
        if no_speech_prob is not None:
            self.no_speech_prob = no_speech_prob
        if compression_ratio is not None:
            self.compression_ratio = compression_ratio


def test_collect_segments_reports_worst_not_just_mean():
    """One bad segment is what a hallucination looks like in a multi-segment
    decode; a mean would dilute it away."""
    text, metrics = _collect_segments([
        _Seg(" Good segment.", avg_logprob=-0.2, no_speech_prob=0.01, compression_ratio=1.2),
        _Seg(" Thank you.", avg_logprob=-1.8, no_speech_prob=0.92, compression_ratio=3.1),
    ])
    assert text == "Good segment. Thank you."
    assert metrics["segments"] == 2
    assert metrics["avg_logprob"]["worst"] == -1.8      # lowest confidence
    assert metrics["no_speech_prob"]["worst"] == 0.92   # most silence-like
    assert metrics["compression_ratio"]["worst"] == 3.1  # most repetitive


def test_collect_segments_tolerates_missing_attributes():
    """Never assume the model populated every field — a missing metric must not
    take down a turn that transcribed fine."""
    text, metrics = _collect_segments([_Seg(" Bare segment.")])
    assert text == "Bare segment."
    assert metrics["avg_logprob"] is None


def test_collect_segments_handles_no_segments():
    text, metrics = _collect_segments([])
    assert text == ""
    assert metrics["segments"] == 0


# ── hallucination suppression ────────────────────────────────────────────────

class _Session:
    """Just enough of WhisperSession to exercise the predicate."""

    def __init__(self, **config):
        self.config = config


def _session(**config):
    from providers.whisper_provider import WhisperSession
    s = _Session(**config)
    s._looks_hallucinated = WhisperSession._looks_hallucinated.__get__(s)
    return s


def _metrics(no_speech, logprob):
    return {
        "no_speech_prob": {"mean": no_speech, "worst": no_speech},
        "avg_logprob": {"mean": logprob, "worst": logprob},
    }


def test_silence_filler_is_flagged():
    """The production failure: whisper inventing "Thank you." / "You" over
    near-silence, which then triggered a barge-in and stopped the agent."""
    assert _session()._looks_hallucinated(_metrics(0.92, -1.8)) is True


def test_confident_speech_is_not_flagged():
    assert _session()._looks_hallucinated(_metrics(0.02, -0.3)) is False


def test_both_signals_must_fire():
    """Either alone is noisy — quiet-but-real speech can score a poor logprob,
    and a confident decode can sit above the no-speech threshold. Requiring
    both is what stops this eating genuine short turns like "ja"."""
    assert _session()._looks_hallucinated(_metrics(0.92, -0.3)) is False   # silent-ish but confident
    assert _session()._looks_hallucinated(_metrics(0.02, -1.8)) is False   # unsure but is speech


def test_missing_metrics_never_suppress():
    """No signal is not evidence of hallucination — a decode whose metrics the
    model did not populate must pass through untouched."""
    assert _session()._looks_hallucinated({}) is False
    assert _session()._looks_hallucinated({"no_speech_prob": None, "avg_logprob": None}) is False


def test_thresholds_follow_the_configured_ones():
    """The predicate must track whisper's own configured thresholds rather than
    carrying its own copies, or tuning one would silently desync the other."""
    strict = _session(no_speech_threshold=0.99, log_prob_threshold=-5.0)
    assert strict._looks_hallucinated(_metrics(0.92, -1.8)) is False
    loose = _session(no_speech_threshold=0.1, log_prob_threshold=-0.1)
    assert loose._looks_hallucinated(_metrics(0.92, -1.8)) is True
