"""Sherpa emits the full barge-in vocabulary, not just the first word of it.

The agent's interruption behaviour is three tiers: duck on `speech_started`,
come back up on `speech_ended`, yield the floor on `speech_confirmed`. This
provider used to emit only the first, from a bare energy gate, so on every
CPU/local deployment the agent could get quieter and then had nothing to tell
it to stop. Worse, it ducked for anything audible — a fan, a truck — because
an energy threshold cannot tell a voice from a noise.

Both halves are asserted here: the signals exist, and they follow the VAD
rather than the volume.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import stt_pb2  # noqa: E402
from providers.sherpa_provider import SherpaSession  # noqa: E402

RATE = 16000
WINDOW = 576                      # what sherpa-onnx reports for Silero
LOUD = 0.5                        # far above any energy threshold


class _FakeVad:
    """Silero stand-in driven by a script, so 'voiced' is ours to control."""

    def __init__(self, verdicts=True):
        self._verdicts = verdicts
        self.calls = 0
        self.resets = 0

    def window_size(self):
        return WINDOW

    def reset(self):
        self.resets += 1

    def is_speech(self, samples):
        self.calls += 1
        if isinstance(self._verdicts, bool):
            return self._verdicts
        return self._verdicts(samples)


class _FakeStream:
    def __init__(self):
        self.samples = 0

    def accept_waveform(self, sample_rate, waveform):
        self.samples += len(waveform)


class _FakeRecognizer:
    """Always has a transcript, never endpoints on its own.

    Endpointing is the gate's job in these tests; letting the recogniser also
    endpoint would make it ambiguous which one produced a final.
    """

    def __init__(self, text="Hallo"):
        self.text = text

    def is_ready(self, stream):
        return False

    def decode_stream(self, stream):
        pass

    def get_result(self, stream):
        return self.text

    def is_endpoint(self, stream):
        return False


def _session(vad=None, **config):
    settings = {
        "silence_duration_ms": 500,
        "continuation_window_ms": 1000,
        "barge_in_min_speech_ms": 600,
        "rms_threshold": 0.001,
        "min_transcript_chars": 3,
        "speech_timeout": 10.0,
        **config,
    }
    recognizer = _FakeRecognizer()
    session = SherpaSession(
        session_id="s",
        participant_id="human",
        recognizer=recognizer,
        create_stream_fn=_FakeStream,
        config=settings,
        vad_model=vad,
    )
    return session


def _pcm(windows, amplitude=LOUD):
    """`windows` worth of full-scale-ish audio as PCM bytes."""
    samples = np.full(WINDOW * windows, amplitude, dtype=np.float32)
    return (samples * 32767).astype(np.int16).tobytes()


def _feed(session, windows, *, amplitude=LOUD):
    """One process_audio call covering `windows` VAD windows.

    Time inside the gate advances with the AUDIO, so a single call can span a
    silence threshold — no wall-clock waiting and no sleeping in tests.
    """
    return session.process_audio(_pcm(windows, amplitude), RATE)


def _flags(events):
    return [
        (e.speech_started, e.speech_confirmed, e.speech_ended)
        for e in events
        if e.speech_started or e.speech_confirmed or e.speech_ended
    ]


# -- the three signals ---------------------------------------------------


def test_speech_started_is_emitted_on_onset():
    session = _session(vad=_FakeVad(True))
    events = _feed(session, 1)
    assert any(e.speech_started for e in events)


def test_speech_confirmed_is_emitted_once_the_user_holds_the_floor():
    """The tier that did not exist on this provider at all."""
    session = _session(vad=_FakeVad(True), barge_in_min_speech_ms=600)
    events = _feed(session, 30)          # ~1.08s of voiced audio
    confirmed = [e for e in events if e.speech_confirmed]
    assert len(confirmed) == 1, "barge-in must fire exactly once per utterance"


def test_speech_ended_is_emitted_when_the_user_stops():
    """The missing un-duck: without this the agent stays quiet forever."""
    vad = _FakeVad(True)
    session = _session(vad=vad, silence_duration_ms=500)
    _feed(session, 5)
    vad._verdicts = False
    events = _feed(session, 20)              # ~720ms of silence, past the 500ms
    assert any(e.speech_ended for e in events), _flags(events)


def test_every_duck_has_an_unduck():
    """The regression, stated end to end on the real provider."""
    vad = _FakeVad(True)
    session = _session(vad=vad)
    events = _feed(session, 5)
    vad._verdicts = False
    events += _feed(session, 20)
    starts = sum(1 for e in events if e.speech_started)
    ends = sum(1 for e in events if e.speech_ended)
    assert starts and ends == starts, _flags(events)


# -- following the VAD, not the volume -----------------------------------


def test_loud_non_speech_never_ducks_the_agent():
    """A fan is loud. The old energy gate could not tell, and ducked for it."""
    session = _session(vad=_FakeVad(False))
    events = _feed(session, 30, amplitude=LOUD)
    assert _flags(events) == [], "loud non-speech produced a barge-in signal"
    assert not any(e.speech_started for e in events)


def test_quiet_speech_still_counts():
    """The mirror image: 0.008 called soft speech silence and cut turns short."""
    session = _session(vad=_FakeVad(True))
    events = _feed(session, 5, amplitude=0.004)   # under the old 0.008 gate
    assert any(e.speech_started for e in events)


def test_the_energy_gate_still_skips_digital_silence():
    """True zero must not reach the VAD — it is the one thing RMS is good for."""
    vad = _FakeVad(True)
    session = _session(vad=vad)
    _feed(session, 5, amplitude=0.0)
    assert vad.calls == 0
    assert not session.gate.is_active


# -- degradation ---------------------------------------------------------


def test_without_a_vad_model_the_provider_still_works():
    """A missing model must not take transcription down with it."""
    session = _session(vad=None)
    events = _feed(session, 5)
    assert any(e.speech_started for e in events)


# -- housekeeping --------------------------------------------------------


def test_boundary_events_carry_no_text():
    """They ride the transcript channel; text on them would reach the screen."""
    session = _session(vad=_FakeVad(True))
    events = _feed(session, 30)
    for event in events:
        if event.speech_started or event.speech_confirmed or event.speech_ended:
            assert event.text == ""
            assert not event.is_final


def test_a_started_event_carries_the_utterance_it_belongs_to():
    session = _session(vad=_FakeVad(True))
    events = _feed(session, 1)
    started = [e for e in events if e.speech_started]
    assert started and started[0].transcript_id == session.transcript_id


def test_audio_shorter_than_a_window_is_held_over():
    """Silero is only defined on whole windows; a partial one must not be run."""
    vad = _FakeVad(True)
    session = _session(vad=vad)
    half = (np.full(WINDOW // 2, LOUD, dtype=np.float32) * 32767).astype(np.int16).tobytes()
    assert session.process_audio(half, RATE) == [] or vad.calls == 0
    assert vad.calls == 0
    session.process_audio(half, RATE)            # the two halves make one window
    assert vad.calls == 1


def test_reset_clears_the_vad_state():
    """Silero is stateful; a stale hidden state degrades the next utterance."""
    vad = _FakeVad(True)
    session = _session(vad=vad)
    _feed(session, 5)
    session.reset()
    assert vad.resets == 1
    assert not session.gate.is_active
    assert len(session.vad_buffer) == 0
