"""The STT decode-diagnostics flattener.

This runs inside the live turn path on a JSON blob produced by another service,
so its contract is: extract what it recognises, and never raise. A parse error
here would take down a turn that transcribed perfectly well.
"""

import json

from stella_agent_sdk.audio.pipeline import _decode_diagnostic_fields


def _record(**overrides):
    base = {
        "session": "s1",
        "transcript_id": "t1",
        "audio": {"total_sec": 3.2, "speech_sec": 2.1, "trailing_silence_sec": 1.1, "silence_fraction": 0.34},
        "final": {
            "text": "Ja, genau.",
            "decode_ms": 512.0,
            "words": 2,
            "segments": 1,
            "avg_logprob": {"mean": -0.4, "worst": -0.9},
            "no_speech_prob": {"mean": 0.05, "worst": 0.11},
            "compression_ratio": {"mean": 1.4, "worst": 1.4},
        },
        "shadow": {"identical": True, "similarity": 1.0, "word_delta": 0, "available_earlier_ms": 604.0},
        "last_partial": {"identical": False, "similarity": 0.8, "word_delta": -1, "is_prefix_of_reference": True},
    }
    base.update(overrides)
    return json.dumps(base)


# ── the empty / malformed contract ───────────────────────────────────────────

def test_absent_diagnostics_yield_nothing():
    """The overwhelmingly common case: diagnostics are off, field is empty."""
    assert _decode_diagnostic_fields("") == {}


def test_malformed_json_is_swallowed():
    assert _decode_diagnostic_fields("{not json") == {}
    assert _decode_diagnostic_fields("null") == {}
    assert _decode_diagnostic_fields("[1, 2, 3]") == {}


def test_unexpected_shapes_do_not_raise():
    """Wrong types where objects are expected must degrade, not explode."""
    assert _decode_diagnostic_fields(json.dumps({"audio": "nope", "final": 3, "shadow": []})) == {}


# ── extraction ───────────────────────────────────────────────────────────────

def test_audio_and_final_metrics_are_flattened():
    f = _decode_diagnostic_fields(_record())
    assert f["silence_fraction"] == 0.34
    assert f["speech_sec"] == 2.1
    assert f["final_decode_ms"] == 512.0
    assert f["final_words"] == 2
    assert f["avg_logprob_worst"] == -0.9
    assert f["no_speech_prob_mean"] == 0.05


def test_comparison_flags_survive_as_booleans():
    """These drive the agreement rates; coercing them to numbers would make
    every turn count as agreeing."""
    f = _decode_diagnostic_fields(_record())
    assert f["shadow_identical"] is True
    assert f["partial_identical"] is False
    assert f["partial_is_prefix"] is True
    assert f["shadow_available_earlier_ms"] == 604.0


def test_booleans_are_not_accepted_as_numbers():
    """bool is a subclass of int in Python — without an explicit guard,
    `"similarity": true` would land as 1.0 and silently skew the averages."""
    f = _decode_diagnostic_fields(_record(audio={"silence_fraction": True}))
    assert "silence_fraction" not in f


def test_partial_block_may_be_absent():
    """Short turns produce no partial at all; the shadow fields must still come
    through rather than the whole record being dropped."""
    payload = json.loads(_record())
    del payload["last_partial"]
    f = _decode_diagnostic_fields(json.dumps(payload))
    assert f["shadow_identical"] is True
    assert not any(k.startswith("partial_") for k in f)


def test_missing_metric_blocks_are_skipped_not_defaulted():
    """A metric the model did not report must be absent, not zero — zero is a
    real value for no_speech_prob and would read as high confidence."""
    payload = json.loads(_record())
    payload["final"] = {"decode_ms": 100.0}
    f = _decode_diagnostic_fields(json.dumps(payload))
    assert f["final_decode_ms"] == 100.0
    assert "no_speech_prob_worst" not in f
    assert "avg_logprob_worst" not in f
