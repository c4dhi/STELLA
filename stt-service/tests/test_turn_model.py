"""An end-of-turn model can end the hold early, extend it, or stay out of it.

The gate never sees the model, so most of this is the (score x window x ceiling)
table with plain numbers. The session tests pin the failure modes that would hurt
a real person: speech arriving alongside a stale "finished", a quick "Ja" being
lost as too short, a broken model, and a decode that no longer covers the turn.
"""

import sys
import types
from concurrent.futures import Future
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

if "torch" not in sys.modules:
    _torch = types.ModuleType("torch")
    _torch.from_numpy = lambda a: a
    _torch.Tensor = type("Tensor", (), {})
    sys.modules["torch"] = _torch

from vad.speech_gate import GateConfig, GateSignal, SpeechGate, SpeechState  # noqa: E402
from vad.turn_model import TURN_MODEL_WINDOW_SAMPLES, TurnScorer, pad_start  # noqa: E402
from providers.whisper_provider import WhisperSession  # noqa: E402

STEP = 0.01


def _gate(finished_at=0.8):
    return SpeechGate(GateConfig(
        silence_duration_ms=250, continuation_window_ms=1550, max_endpointing_delay_ms=2750,
        turn_finished_at=finished_at, turn_unfinished_below=0.3, turn_recheck_ms=150,
    ))


def _into_hold(gate, t=0.0):
    for _ in range(100):
        gate.observe(voiced=True, samples=160, now=t)
        t += STEP
    while gate.state != SpeechState.MAYBE_ENDING:
        gate.observe(voiced=False, samples=160, now=t)
        t += STEP
    return t


def _ends_after_ms(gate, score):
    """Ms of hold before FINALIZE, with the model answering `score` whenever asked."""
    t = _into_hold(gate)
    entered = gate.pending_final_time
    for _ in range(1000):
        if gate.turn_check_due(t):
            gate.turn_check_started(t)
            if score is not None:
                gate.report_turn_score(score)
        if GateSignal.FINALIZE in gate.observe(voiced=False, samples=160, now=t):
            return (t - entered) * 1000.0
        t += STEP
    return None


def test_a_confident_finished_ends_the_turn_at_once():
    gate = _gate()
    assert _ends_after_ms(gate, 0.95) == pytest.approx(0, abs=15)
    assert gate.last_exit_reason == "model"


def test_a_confident_unfinished_holds_until_the_ceiling():
    gate = _gate()
    assert _ends_after_ms(gate, 0.1) == pytest.approx(2750, abs=15)
    assert gate.last_exit_reason == "ceiling"


@pytest.mark.parametrize("score", [0.5, None], ids=["unsure", "model never answers"])
def test_unsure_or_silent_leaves_it_to_the_window(score):
    gate = _gate()
    assert _ends_after_ms(gate, score) == pytest.approx(1550, abs=15)
    assert gate.last_exit_reason == "window"


def test_no_model_configured_never_asks():
    gate = SpeechGate(GateConfig(silence_duration_ms=800, continuation_window_ms=1000))
    _into_hold(gate)
    assert gate.turn_check_due(99.0) is False


def test_a_later_finished_overrules_an_earlier_unfinished():
    gate = _gate()
    t = _into_hold(gate)
    gate.report_turn_score(0.1)
    assert gate.hold_expired(t + 2.0) is None
    gate.report_turn_score(0.9)
    assert gate.hold_expired(t + 2.0) == "model"


def test_it_asks_again_only_after_the_recheck_interval():
    gate = _gate()
    t = _into_hold(gate)
    assert gate.turn_check_due(t)
    gate.turn_check_started(t)
    assert not gate.turn_check_due(t + 0.1)
    assert gate.turn_check_due(t + 0.2)


def test_speech_resuming_forgets_the_score_and_asks_afresh():
    gate = _gate()
    t = _into_hold(gate)
    gate.turn_check_started(t)
    gate.report_turn_score(0.9)
    gate.observe(voiced=True, samples=160, now=t)
    assert gate.turn_score is None
    assert gate.hold_expired(t + 5) is None
    t = _into_hold(gate, t + STEP)
    assert gate.turn_check_due(t)
    assert gate.hold_expired(t) is None


def test_a_score_for_a_finished_hold_is_ignored():
    gate = _gate()
    gate.report_turn_score(0.99)
    assert gate.turn_score is None


# ── pad_start ─────────────────────────────────────────────────────────────

def test_short_audio_is_padded_before_the_speech():
    out = pad_start(np.ones(100, dtype=np.float32))
    assert len(out) == TURN_MODEL_WINDOW_SAMPLES
    assert out[-1] == 1.0 and out[0] == 0.0


def test_long_audio_keeps_its_end():
    audio = np.arange(TURN_MODEL_WINDOW_SAMPLES + 5, dtype=np.float32)
    assert pad_start(audio)[-1] == audio[-1]
    assert len(pad_start(audio)) == TURN_MODEL_WINDOW_SAMPLES


# ── The session ───────────────────────────────────────────────────────────

class _Segment:
    def __init__(self, text):
        self.text, self.avg_logprob, self.no_speech_prob, self.compression_ratio = text, -0.1, 0.0, 1.0


class _Whisper:
    """Says how much audio it was given, so a test can see which decode shipped."""

    def __init__(self):
        self.calls = 0

    def transcribe(self, audio, **kwargs):
        self.calls += 1
        info = types.SimpleNamespace(language="de", language_probability=1.0)
        return iter([_Segment(f"decoded {len(audio)}")]), info


class _Scorer:
    """Answers by hand, so a test controls exactly when the score lands."""

    def __init__(self):
        self.futures = []

    def submit(self, audio):
        self.futures.append(Future())
        return self.futures[-1]


def _session(scorer, min_speech_samples=0):
    return WhisperSession(
        session_id="s", participant_id="human", whisper_model=_Whisper(), vad_model=None,
        config={
            "silence_duration_ms": 250, "continuation_window_ms": 1550, "max_endpointing_delay_ms": 2750,
            "partial_interval_ms": 10_000, "min_speech_samples": min_speech_samples,
            "turn_scorer": scorer, "turn_finished_at": 0.8, "turn_unfinished_below": 0.3, "turn_recheck_ms": 150,
        },
    )


def _speak_then_pause(session, samples=16000):
    t = 100.0
    session.gate.observe(voiced=True, samples=samples, now=t)
    session.transcript_id = "t1"
    session.speech_buffer.extend([100] * samples)
    session.gate.observe(voiced=False, samples=512, now=t + 0.01)
    session.gate.observe(voiced=False, samples=512, now=t + 0.3)
    assert session.state == SpeechState.MAYBE_ENDING
    return t + 0.3


def test_session_ends_the_turn_when_the_model_says_finished():
    scorer = _Scorer()
    session = _session(scorer)
    t = _speak_then_pause(session)
    assert session._advance_turn_model(t) == []
    scorer.futures[0].set_result(0.95)
    events = session._advance_turn_model(t + 0.05)
    assert [e.is_final for e in events] == [True]
    assert session.state == SpeechState.IDLE
    assert session.last_model_end_time == t + 0.05


def test_session_gives_the_model_the_end_of_the_turn_only():
    seen = []
    scorer = _Scorer()
    scorer.submit = lambda audio: (seen.append(audio), Future())[1]
    session = _session(scorer)
    t = _speak_then_pause(session, samples=TURN_MODEL_WINDOW_SAMPLES + 16000)
    session._advance_turn_model(t)
    assert len(seen[0]) == TURN_MODEL_WINDOW_SAMPLES


def test_a_score_from_before_a_rescued_pause_cannot_end_the_new_hold():
    scorer = _Scorer()
    session = _session(scorer)
    t = _speak_then_pause(session)
    session._advance_turn_model(t)

    session.gate.observe(voiced=True, samples=512, now=t + 0.1)
    session.gate.observe(voiced=False, samples=512, now=t + 0.2)
    session.gate.observe(voiced=False, samples=512, now=t + 0.5)
    assert session.state == SpeechState.MAYBE_ENDING

    scorer.futures[0].set_result(0.99)
    assert session._advance_turn_model(t + 0.55) == []
    assert session.state == SpeechState.MAYBE_ENDING


def test_a_short_answer_is_not_scored_until_it_would_survive_the_final():
    scorer = _Scorer()
    session = _session(scorer, min_speech_samples=8000)
    t = _speak_then_pause(session, samples=4000)
    assert session._advance_turn_model(t) == []
    assert scorer.futures == [], "ending this now would lose the turn as too short"

    session.speech_buffer.extend([0] * 4000)
    session._advance_turn_model(t + 0.25)
    assert len(scorer.futures) == 1


def test_a_broken_model_leaves_the_turn_to_the_timer():
    scorer = _Scorer()
    session = _session(scorer)
    t = _speak_then_pause(session)
    session._advance_turn_model(t)
    scorer.futures[0].set_exception(RuntimeError("boom"))
    assert session._advance_turn_model(t + 0.05) == []
    assert session.state == SpeechState.MAYBE_ENDING
    assert session.gate.turn_score is None


def test_the_final_reuses_the_early_decode():
    scorer = _Scorer()
    session = _session(scorer)
    t = _speak_then_pause(session)
    session._advance_turn_model(t)
    session.early_decode_future.result(timeout=5)
    session.speech_buffer.extend([0] * 800)  # more silence, nothing new to hear

    scorer.futures[0].set_result(0.95)
    events = session._advance_turn_model(t + 0.05)
    assert session.whisper_model.calls == 1, "decoded twice"
    assert events[0].text == "decoded 16000"


def test_an_early_decode_is_thrown_away_when_they_keep_talking():
    scorer = _Scorer()
    session = _session(scorer)
    t = _speak_then_pause(session)
    session._advance_turn_model(t)
    session.early_decode_future.result(timeout=5)

    session.early_decode_valid = False  # what PAUSE_RESCUED does
    session.speech_buffer.extend([100] * 8000)
    event = session._generate_final(t + 1)
    assert session.whisper_model.calls == 2
    assert event.text == "decoded 24000", "shipped a decode missing the end of the turn"


def test_scorer_runs_the_model_off_the_calling_thread():
    class Model:
        def score(self, audio):
            return 0.5

    scorer = TurnScorer(Model())
    scorer.warm_up()
    assert scorer.submit(np.zeros(10, dtype=np.float32)).result(timeout=5) == 0.5
