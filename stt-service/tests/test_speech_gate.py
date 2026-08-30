"""The shared turn machine (vad/speech_gate.py).

These tests exist because the bug they guard against was NOT findable before.
The agent ducks its own voice on speech_started and comes back up on
speech_ended; on the sherpa provider only the first of those was ever emitted,
so one moment of room noise made the agent quiet for the rest of the sentence.
Nothing was wrong with either signal in isolation — the fault was in the
(state x event) table, which no test could reach while the machine was 300
lines deep inside a provider.

The gate is pure, so that table is now enumerable, and the last test in this
file states the invariant directly: every start has a release.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from vad.speech_gate import GateConfig, GateSignal, SpeechGate, SpeechState  # noqa: E402

RATE = 16000
WINDOW = 576                    # sherpa-onnx's Silero window; 36ms @ 16kHz
WINDOW_MS = WINDOW / RATE * 1000


def _gate(**overrides):
    defaults = dict(
        silence_duration_ms=500,
        continuation_window_ms=600,
        barge_in_min_speech_ms=600,
        sample_rate=RATE,
    )
    defaults.update(overrides)
    gate = SpeechGate(GateConfig(**defaults))
    # Successive _feed() calls have to continue the same timeline — a gate whose
    # clock restarts at zero sees negative silence and never ends anything.
    gate._test_clock = 0.0
    return gate


def _feed(gate, pattern, *, step_ms=WINDOW_MS):
    """Drive the gate over a string of v(oiced)/s(ilent) windows.

    Returns the flat list of signals, which is what every assertion here is
    about — the caller only ever sees signals and state.
    """
    signals = []
    for mark in pattern:
        signals.extend(
            gate.observe(voiced=(mark == "v"), samples=WINDOW, now=gate._test_clock)
        )
        gate._test_clock += step_ms / 1000.0
    return signals


def _windows_for(ms):
    """Windows needed for `ms` to have ELAPSED since the first of them.

    The +2 is not slack. The gate starts its silence clock on the first silent
    window and measures from there, so covering `ms` takes one window to start
    the clock plus enough to run it out.
    """
    return int(ms / WINDOW_MS) + 2


# -- starting ------------------------------------------------------------


def test_first_voiced_window_begins_an_utterance():
    gate = _gate()
    signals = _feed(gate, "v")
    assert signals[:2] == [GateSignal.UTTERANCE_BEGAN, GateSignal.SPEECH_STARTED]
    assert gate.state == SpeechState.SPEAKING


def test_silence_on_an_idle_gate_says_nothing():
    gate = _gate()
    assert _feed(gate, "ssssssssss") == []
    assert gate.state == SpeechState.IDLE


# -- confirming (the interruption signal) --------------------------------


def test_confirmation_waits_for_the_full_voiced_duration():
    gate = _gate(barge_in_min_speech_ms=600)
    # Just under 600ms of voiced audio must NOT confirm.
    short = int(600 / WINDOW_MS)
    signals = _feed(gate, "v" * short)
    assert GateSignal.SPEECH_CONFIRMED not in signals
    # One more window crosses it.
    assert GateSignal.SPEECH_CONFIRMED in _feed(gate, "v")


def test_confirmation_fires_exactly_once_per_utterance():
    gate = _gate()
    signals = _feed(gate, "v" * 60)
    assert signals.count(GateSignal.SPEECH_CONFIRMED) == 1


def test_pauses_do_not_accumulate_toward_confirmation():
    """Voiced audio is counted, not wall-clock.

    Otherwise a hesitant "uh... yeah" would take the floor while a brisk
    "mhm" would not, which is backwards.
    """
    gate = _gate(barge_in_min_speech_ms=600)
    # Alternating voiced/silent for well over 600ms of wall-clock, but only
    # about half that in voiced audio.
    signals = _feed(gate, "vs" * int(600 / WINDOW_MS))
    assert GateSignal.SPEECH_CONFIRMED not in signals
    assert gate.voiced_ms < 600


def test_a_new_utterance_starts_its_confirmation_count_from_zero():
    """A dismissed backchannel must not shorten the next interruption."""
    gate = _gate()
    _feed(gate, "v" * 5)                       # some voiced audio, no confirm
    _feed(gate, "s" * _windows_for(500 + 600))  # ...ends the utterance
    assert gate.state == SpeechState.IDLE
    signals = _feed(gate, "v" * 5)
    assert GateSignal.SPEECH_CONFIRMED not in signals


# -- ending --------------------------------------------------------------


def test_speech_ends_after_the_silence_threshold():
    gate = _gate(silence_duration_ms=500)
    _feed(gate, "v" * 3)
    signals = _feed(gate, "s" * _windows_for(500))
    assert GateSignal.SPEECH_ENDED in signals
    assert gate.state == SpeechState.MAYBE_ENDING


def test_a_short_pause_does_not_end_speech():
    gate = _gate(silence_duration_ms=500)
    _feed(gate, "v" * 3)
    signals = _feed(gate, "s" * 3)             # ~108ms
    assert signals == []
    assert gate.state == SpeechState.SPEAKING


def test_resuming_keeps_the_same_utterance():
    """A breath mid-sentence is one turn, not two."""
    gate = _gate()
    _feed(gate, "v" * 3)
    _feed(gate, "s" * _windows_for(500))        # -> MAYBE_ENDING
    signals = _feed(gate, "v")
    assert GateSignal.SPEECH_STARTED in signals
    assert GateSignal.UTTERANCE_BEGAN not in signals, "resumption minted a new turn"
    assert gate.state == SpeechState.SPEAKING


def test_finalize_only_after_the_continuation_window():
    gate = _gate(silence_duration_ms=500, continuation_window_ms=600)
    _feed(gate, "v" * 3)
    ended = _feed(gate, "s" * _windows_for(500))
    assert GateSignal.FINALIZE not in ended
    later = _feed(gate, "s" * _windows_for(600))
    assert GateSignal.FINALIZE in later
    assert gate.state == SpeechState.IDLE


def test_resumption_cancels_a_pending_finalize():
    gate = _gate()
    _feed(gate, "v" * 3)
    _feed(gate, "s" * _windows_for(500))        # -> MAYBE_ENDING
    _feed(gate, "v")                            # resumed before the window ran out
    signals = _feed(gate, "s" * 3)              # brief silence again
    assert GateSignal.FINALIZE not in signals
    assert gate.state == SpeechState.SPEAKING


# -- the invariant the old design could not state ------------------------


@pytest.mark.parametrize(
    "pattern",
    [
        "v",                                     # started and still going
        "vs",
        "v" * 40,
        "v" * 40 + "s" * 40,
        ("v" * 5 + "s" * 30) * 4,                # stop/start/stop/start
        ("vs" * 20) + ("s" * 40),                # choppy, then gone
        "s" * 20 + "v" * 3 + "s" * 20 + "v" * 3,
        "vsvsvsvssssssssssssssssssssvvvvvvvvvv",
    ],
)
def test_every_start_is_eventually_released(pattern):
    """The bug that started all of this, as an assertion.

    speech_started makes the agent duck. speech_ended and FINALIZE are the only
    two things that bring it back up. So a run that ends inside SPEAKING is the
    only acceptable way to finish with an unreleased start — the user really is
    still talking. Anything else means the agent has been left quiet with
    nothing coming to fix it.
    """
    gate = _gate()
    signals = _feed(gate, pattern)
    # Drain: enough silence that any in-flight utterance must resolve.
    signals += _feed(gate, "s" * _windows_for(500 + 600))

    starts = signals.count(GateSignal.SPEECH_STARTED)
    releases = signals.count(GateSignal.SPEECH_ENDED)
    assert starts > 0 or "v" not in pattern
    assert releases == starts, (
        f"{starts} start(s) but {releases} release(s) — the agent would still "
        f"be ducked with nothing left to un-duck it"
    )
    assert gate.state == SpeechState.IDLE


def test_reset_returns_a_mid_utterance_gate_to_idle():
    gate = _gate()
    _feed(gate, "v" * 40)
    assert gate.is_active
    gate.reset()
    assert gate.state == SpeechState.IDLE
    assert gate.voiced_ms == 0
    assert not gate.barge_in_signalled
