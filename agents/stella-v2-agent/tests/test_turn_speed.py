"""Per-turn speaking rate policy (#3 prosody).

The bridge type already classifies the turn's character, so it also picks the
speaking rate — for the WHOLE turn, bridge and reply alike, since a rate change
inside one utterance reads as a glitch rather than as expression.
"""

import pytest

from stella_v2_agent.agent import _TURN_SPEED_BY_BRIDGE_MODE, _turn_speed
from stella_v2_agent.pipeline.bridge_generator import (
    BRIDGE_MODE_BRIEF,
    BRIDGE_MODE_FULL,
    BRIDGE_MODE_THINKING,
)


def test_ordinary_turn_is_the_reference_rate():
    assert _turn_speed(BRIDGE_MODE_FULL) == 1.0


def test_a_heavier_turn_is_taken_slower():
    assert _turn_speed(BRIDGE_MODE_THINKING) < 1.0


def test_a_bare_beat_is_brisker():
    assert _turn_speed(BRIDGE_MODE_BRIEF) > 1.0


def test_variation_stays_within_a_few_percent():
    """Rate is implemented by resampling, which shifts pitch along with it.

    A few percent reads as natural variation; a large factor reads as a
    different speaker, which is worse than no variation at all.
    """
    for rate in _TURN_SPEED_BY_BRIDGE_MODE.values():
        assert 0.90 <= rate <= 1.10, rate


def test_the_range_is_actually_used():
    # A table that collapsed to a single value would silently disable the
    # feature while still looking configured.
    assert len(set(_TURN_SPEED_BY_BRIDGE_MODE.values())) > 1


@pytest.mark.parametrize("unknown", [None, "not-a-mode", ""])
def test_unknown_modes_fall_back_to_the_reference_rate(unknown):
    # Includes a stubbed/substituted bridge generator that exposes no type at
    # all — it must degrade to today's behaviour, never break the turn.
    assert _turn_speed(unknown) == 1.0


def test_kill_switch_disables_variation(monkeypatch):
    monkeypatch.setenv("STELLA_TTS_RATE_VARIATION", "false")
    for bridge_mode in _TURN_SPEED_BY_BRIDGE_MODE:
        assert _turn_speed(bridge_mode) == 1.0


def test_rates_are_inside_the_range_the_proto_declares():
    for rate in _TURN_SPEED_BY_BRIDGE_MODE.values():
        assert 0.5 <= rate <= 2.0
