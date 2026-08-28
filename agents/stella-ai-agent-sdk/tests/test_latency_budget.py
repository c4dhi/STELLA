"""Tests for the first-audible-token latency budget (#304 A1).

Pins the literature-grounded classification: a bridge ack must land inside the
~500 ms gap window; the substantive response is comfortable ≤1 s; both are
"unnatural" past 2 s and a "breakdown" past 4 s.
"""

from stella_agent_sdk.audio.pipeline import (
    _first_byte_target_ms,
    _latency_status,
    _BRIDGE_FIRST_BYTE_TARGET_MS,
    _RESPONSE_FIRST_BYTE_TARGET_MS,
)


def test_targets_per_source():
    assert _first_byte_target_ms("bridge") == _BRIDGE_FIRST_BYTE_TARGET_MS
    assert _first_byte_target_ms("response") == _RESPONSE_FIRST_BYTE_TARGET_MS


def test_the_bridge_target_is_reachable_by_the_bridge():
    """The bridge target used to be 500ms, taken from the ~200ms natural turn
    gap. An LLM-backed bridge cannot get near that — measured on prod the floor
    is ~1185ms (TTFT ~420 + tokens ~100 + Qwen3 first audio ~150 + pre-roll
    ~490 + dispatch ~25) — so every single turn logged over_target, which
    carries the same information as logging nothing.

    A target has to be reachable to mean anything. This one is deliberately
    LOOSER than the response target: the bridge pays the same TTFT and the same
    synthesis, plus a pre-roll, and has no head start to make up for it."""
    floor_ms = 25 + 420 + 100 + 150 + 490
    assert _BRIDGE_FIRST_BYTE_TARGET_MS >= floor_ms
    assert _latency_status("bridge", floor_ms) == "ok"
    # Still well inside the "unnatural" ceiling, which is what actually flags a
    # user-visible problem.
    assert _BRIDGE_FIRST_BYTE_TARGET_MS < 2000


def test_bridge_status_bands():
    assert _latency_status("bridge", 200) == "ok"        # inside gap window
    assert _latency_status("bridge", 800) == "ok"        # a good turn, pre-roll included
    assert _latency_status("bridge", 1500) == "over_target"  # past target, under warn
    assert _latency_status("bridge", 2500) == "warn"     # unnatural
    assert _latency_status("bridge", 5000) == "alarm"    # perceived breakdown


def test_response_status_bands():
    assert _latency_status("response", 800) == "ok"          # ≤1 s comfortable
    assert _latency_status("response", 1500) == "over_target"
    assert _latency_status("response", 3000) == "warn"
    assert _latency_status("response", 4500) == "alarm"
