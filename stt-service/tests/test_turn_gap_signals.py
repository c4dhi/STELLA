"""The end-of-speech gap and the rescued pause, measured where they happen (#92).

Logging only. Nothing here changes when a turn ends; it records what the turn
machine already decided, so that the pause tolerance can be tuned on data:

- a final carries the silence the gate waited through before ending the turn
  (``trailing_silence_ms``), how long the final step took (``decode_ms``) and
  how long the user spoke (``speech_ms``). End of speech to first audio is then
  ``trailing_silence_ms + decode_ms`` plus the agent's own stages;
- a pause that entered MAYBE_ENDING but was broken by speech inside the
  continuation window is a "rescued" pause. Each one rides on the final of the
  utterance it belongs to, with its length and how far into the window it got.
  A pause that ends the turn is not one.
"""

import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

if "torch" not in sys.modules:
    _torch = types.ModuleType("torch")
    _torch.from_numpy = lambda a: a
    _torch.Tensor = type("Tensor", (), {})
    sys.modules["torch"] = _torch

import stt_pb2  # noqa: E402
from vad.speech_gate import GateConfig, GateSignal, SpeechGate  # noqa: E402
from providers import whisper_provider  # noqa: E402
from providers.whisper_provider import WhisperSession  # noqa: E402
from providers.sherpa_provider import SherpaSession  # noqa: E402

STEP = 0.01  # 10 ms windows


def _gate(silence=500, window=600):
    return SpeechGate(GateConfig(
        silence_duration_ms=silence, continuation_window_ms=window,
        barge_in_min_speech_ms=600, max_endpointing_delay_ms=2000,
    ))


def _run(gate, t, *, voiced, ms):
    """Feed `ms` of voiced or silent 10 ms windows; return (t, signals)."""
    signals = []
    for _ in range(int(round(ms / 10))):
        signals += gate.observe(voiced=voiced, samples=160, now=t)
        t += STEP
    return t, signals


# -- the gate ------------------------------------------------------------


def test_a_pause_broken_inside_the_window_is_rescued():
    gate = _gate()
    t, _ = _run(gate, 0.0, voiced=True, ms=1000)
    t, _ = _run(gate, t, voiced=False, ms=800)  # 500 to MAYBE_ENDING, 300 into the window
    t, signals = _run(gate, t, voiced=True, ms=10)

    assert GateSignal.PAUSE_RESCUED in signals
    assert len(gate.rescued_pauses) == 1
    pause = gate.rescued_pauses[0]
    assert pause["pause_ms"] == pytest.approx(800, abs=15)
    assert pause["into_window_ms"] == pytest.approx(300, abs=15)
    assert pause["silence_threshold_ms"] == 500
    assert pause["continuation_window_ms"] == 600


def test_a_pause_that_ends_the_turn_is_not_rescued():
    gate = _gate()
    t, _ = _run(gate, 0.0, voiced=True, ms=1000)
    t, signals = _run(gate, t, voiced=False, ms=1200)

    assert GateSignal.FINALIZE in signals
    assert GateSignal.PAUSE_RESCUED not in signals
    assert gate.rescued_pauses == []


def test_a_short_pause_that_never_reached_maybe_ending_is_not_counted():
    gate = _gate()
    t, _ = _run(gate, 0.0, voiced=True, ms=1000)
    t, _ = _run(gate, t, voiced=False, ms=300)
    t, signals = _run(gate, t, voiced=True, ms=10)

    assert GateSignal.PAUSE_RESCUED not in signals
    assert gate.rescued_pauses == []


def test_several_rescued_pauses_belong_to_one_utterance_and_reset_with_the_next():
    gate = _gate()
    t, _ = _run(gate, 0.0, voiced=True, ms=500)
    for _ in range(2):
        t, _ = _run(gate, t, voiced=False, ms=700)
        t, _ = _run(gate, t, voiced=True, ms=500)
    assert len(gate.rescued_pauses) == 2

    t, _ = _run(gate, t, voiced=False, ms=1200)  # ends the turn
    assert len(gate.rescued_pauses) == 2, "still readable when the final is built"
    _run(gate, t, voiced=True, ms=10)  # a new utterance
    assert gate.rescued_pauses == []


def test_the_endpoint_records_the_silence_waited_and_the_speech_length():
    gate = _gate()
    t, _ = _run(gate, 0.0, voiced=True, ms=1500)
    t, signals = _run(gate, t, voiced=False, ms=1200)

    assert GateSignal.FINALIZE in signals
    timing = gate.endpoint_timing(now=t)
    # 500 ms to MAYBE_ENDING + the 600 ms window, give or take a window step.
    assert timing["trailing_silence_ms"] == pytest.approx(1100, abs=15)
    assert timing["speech_ms"] == pytest.approx(1500, abs=15)


def test_endpoint_timing_while_still_active_is_measured_live():
    # The provider's own timeouts end a turn without the gate's FINALIZE.
    gate = _gate()
    t, _ = _run(gate, 0.0, voiced=True, ms=1000)
    t, _ = _run(gate, t, voiced=False, ms=700)
    timing = gate.endpoint_timing(now=t)
    assert timing["trailing_silence_ms"] == pytest.approx(700, abs=15)
    assert timing["speech_ms"] == pytest.approx(1000, abs=15)


def test_no_endpoint_timing_before_any_utterance():
    assert _gate().endpoint_timing(now=5.0) is None


# -- whisper: the final carries them ---------------------------------------


class _Segment:
    def __init__(self, text):
        self.text = text
        self.avg_logprob = -0.2
        self.no_speech_prob = 0.01
        self.compression_ratio = 1.2


class _FakeWhisper:
    def transcribe(self, audio, **kwargs):
        info = types.SimpleNamespace(language="de", language_probability=0.9)
        return iter([_Segment("Ich gehe heute spazieren")]), info


def _whisper_session():
    config = {
        "vad_threshold": 0.35, "rms_threshold": 0.01, "silence_duration_ms": 500,
        "continuation_window_ms": 600, "max_endpointing_delay_ms": 2000,
        "partial_interval_ms": 10_000,
    }
    session = WhisperSession(session_id="s", participant_id="human",
                             whisper_model=_FakeWhisper(), vad_model=None, config=config)
    session.transcript_id = "whisper_test"
    session.speech_buffer.frombytes(np.zeros(16000, dtype=np.int16).tobytes())
    return session


def test_the_whisper_final_carries_the_gap_and_its_rescued_pauses(monkeypatch):
    session = _whisper_session()
    t, _ = _run(session.gate, 0.0, voiced=True, ms=1000)
    t, _ = _run(session.gate, t, voiced=False, ms=700)
    t, _ = _run(session.gate, t, voiced=True, ms=500)
    t, signals = _run(session.gate, t, voiced=False, ms=1200)
    assert GateSignal.FINALIZE in signals

    clock = iter([50.0, 50.0, 50.25, 50.25, 50.25, 50.25])
    monkeypatch.setattr(whisper_provider.time, "time", lambda: next(clock, 50.25))
    event = session._generate_final(t)

    assert event is not None and event.is_final
    assert event.HasField("trailing_silence_ms")
    assert event.trailing_silence_ms == pytest.approx(1100, abs=15)
    assert event.decode_ms == pytest.approx(250, abs=1)
    assert event.speech_ms == pytest.approx(2200, abs=15)
    assert len(event.rescued_pauses) == 1
    assert event.rescued_pauses[0].pause_ms == pytest.approx(700, abs=15)
    assert event.rescued_pauses[0].into_window_ms == pytest.approx(200, abs=15)
    assert event.rescued_pauses[0].continuation_window_ms == 600


def test_textless_events_carry_none_of_it():
    event = _whisper_session()._speech_boundary_event(1.0, started=True)
    assert not event.HasField("trailing_silence_ms")
    assert not event.HasField("decode_ms")
    assert not event.HasField("speech_ms")
    assert len(event.rescued_pauses) == 0


# -- sherpa: the same, from the same gate ---------------------------------

WINDOW = 576
RATE = 16000


class _Vad:
    def window_size(self):
        return WINDOW

    def reset(self):
        pass

    def is_speech(self, samples):
        return True


class _Stream:
    def accept_waveform(self, sample_rate, waveform):
        pass


class _Recognizer:
    def is_ready(self, stream):
        return False

    def decode_stream(self, stream):
        pass

    def get_result(self, stream):
        return "hallo zusammen"

    def is_endpoint(self, stream):
        return False


def _sherpa():
    return SherpaSession(
        session_id="s", participant_id="human", recognizer=_Recognizer(),
        create_stream_fn=_Stream, vad_model=_Vad(),
        config={"silence_duration_ms": 500, "continuation_window_ms": 1000,
                "barge_in_min_speech_ms": 600, "rms_threshold": 0.001,
                "min_transcript_chars": 3, "speech_timeout": 10.0},
    )


def _audio(ms, loud):
    windows = int(round(ms / 1000 * RATE / WINDOW))
    samples = np.full(WINDOW * windows, 0.5 if loud else 0.0, dtype=np.float32)
    return (samples * 32767).astype(np.int16).tobytes()


def test_the_sherpa_final_carries_the_gap_and_its_rescued_pauses():
    session = _sherpa()
    events = []
    for ms, loud in [(1000, True), (800, False), (600, True), (1700, False)]:
        events += session.process_audio(_audio(ms, loud), RATE)

    finals = [e for e in events if e.is_final]
    assert len(finals) == 1
    final = finals[0]
    # Audio time: 500 ms to MAYBE_ENDING + the 1000 ms window, one window's slack.
    assert final.trailing_silence_ms == pytest.approx(1500, abs=40)
    assert final.HasField("decode_ms")
    assert final.speech_ms == pytest.approx(2400, abs=40)
    assert len(final.rescued_pauses) == 1
    assert final.rescued_pauses[0].pause_ms == pytest.approx(800, abs=40)
    assert final.rescued_pauses[0].into_window_ms == pytest.approx(300, abs=40)


# -- the proto -------------------------------------------------------------


def test_all_three_copies_of_the_proto_are_identical():
    root = Path(__file__).resolve().parents[2]
    copies = [
        root / "proto" / "stt.proto",
        root / "stt-service" / "proto" / "stt.proto",
        root / "agents" / "stella-ai-agent-sdk" / "proto" / "stt.proto",
    ]
    texts = {str(p.relative_to(root)): p.read_text() for p in copies}
    assert len(set(texts.values())) == 1, f"stt.proto copies differ: {sorted(texts)}"


def test_the_committed_stubs_know_the_new_fields():
    event = stt_pb2.TranscriptEvent(trailing_silence_ms=1, decode_ms=2, speech_ms=3)
    event.rescued_pauses.add(pause_ms=700, into_window_ms=200,
                             silence_threshold_ms=500, continuation_window_ms=600)
    assert stt_pb2.TranscriptEvent.FromString(event.SerializeToString()) == event
