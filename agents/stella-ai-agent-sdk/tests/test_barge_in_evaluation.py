"""Judging a voice interruption, and surviving a run of false ones.

Duration decides whether to YIELD the floor — it is acoustic, it arrives before
any decode, and it is language-agnostic. What it cannot decide is whether the
words were a turn: "mhm" and "nein, warte" are both short, and only meaning
separates them. So the floor is yielded reversibly and the Barge-in Evaluator
is asked once, on the FINAL transcript, whether to keep it.

Reported from the "Another test" session: "Mhmm again triggered a new turn."
It cleared BARGE_IN_MIN_SPEECH_MS (400ms on prod — a nodded "mhmm" runs
400-700ms of voiced audio), and the only test the final then faced was whether
it was non-empty.
"""

import asyncio
import time

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline, _PLAYOUT_FRAME_BYTES
from stella_agent_sdk.messages.types import BargeInDecision
from stella_agent_sdk.services.stt_client import TranscriptEvent


class FakeRoom:
    audio_sample_rate = 48000
    current_audio_speaker = None
    queued_playout_ms = 0.0

    def __init__(self):
        self.published = bytearray()
        self.clear_count = 0
        self.captured = []

    def on_data_received(self, cb):
        pass

    async def publish_audio(self, data: bytes):
        await asyncio.sleep(0)
        self.published.extend(data)

    async def publish_data(self, data, *a, **k):
        self.captured.append(data)
        await asyncio.sleep(0)

    def publish_data_ordered(self, data, *a, **k):
        self.captured.append(data)

    def flush_audio_queue(self):
        pass

    def clear_playout(self):
        self.clear_count += 1

    def get_participant_name(self, identity):
        return identity


class FakeSTT:
    def __init__(self, events):
        self.events = events

    async def stream_transcribe(self, audio_iter, **kwargs):
        for e in self.events:
            yield e
            await asyncio.sleep(0)


class Decider:
    """Stands in for the agent's on_barge_in / BargeInEvaluator."""

    def __init__(self, decision=BargeInDecision.COMMIT, raises=False):
        self.decision = decision
        self.raises = raises
        self.calls = []

    async def __call__(self, transcript):
        self.calls.append(transcript)
        if self.raises:
            raise RuntimeError("evaluator exploded")
        return self.decision


def _event(text, is_final=False, **flags):
    return TranscriptEvent(
        text=text,
        is_final=is_final,
        transcript_id=flags.pop("tid", "t1"),
        participant_id="human",
        confidence=1.0,
        timestamp_ms=0,
        speech_started=flags.get("speech_started", False),
        speech_confirmed=flags.get("speech_confirmed", False),
        speech_ended=flags.get("speech_ended", False),
    )


def _vad_barge_in(tid="t1"):
    """The VAD signal: enough voiced audio to be an interruption. No text."""
    return _event("", speech_confirmed=True, tid=tid)


def make_pipeline(decider=None):
    room = FakeRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")
    if decider is not None:
        pipe.set_barge_in_decider(decider)
    return pipe, room


async def _run_detection(pipe, events, audio_active=True):
    pipe._barge_in_enabled = True
    pipe._is_speaking = True
    pipe._audio_active = audio_active
    pipe._is_listening = True
    pipe.close_transcript_gate()
    pipe._stt = FakeSTT(events)
    await pipe._run_stt_stream_inner()
    await asyncio.sleep(0.05)


# ── The judgement ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_long_backchannel_is_not_a_turn():
    """It cleared the duration gate, so the agent went quiet and listened —
    correctly, because at that moment nothing knew what was being said. The
    final says it was "Mhmm.", the evaluator says that is not a turn, and the
    agent picks its sentence back up from exactly where it paused."""
    decider = Decider(BargeInDecision.RESUME)
    pipe, room = make_pipeline(decider)
    await _run_detection(pipe, [_vad_barge_in(), _event("Mhmm.", is_final=True)])

    assert decider.calls == ["Mhmm."]
    assert pipe._stop_speaking_event.is_set() is False   # turn NOT discarded
    assert pipe._play_allowed.is_set() is True           # speaking again
    assert pipe._pending_barge_in is None                # nothing handed on
    assert pipe._transcript_queue.empty()
    assert pipe._ducked is False
    assert pipe._barge_in_committed_tid is None
    assert pipe._barge_in_active is False


@pytest.mark.asyncio
async def test_a_real_interruption_takes_the_floor():
    decider = Decider(BargeInDecision.COMMIT)
    pipe, room = make_pipeline(decider)
    await _run_detection(pipe, [_vad_barge_in(), _event("Nein, warte.", is_final=True)])

    assert decider.calls == ["Nein, warte."]
    assert pipe._stop_speaking_event.is_set() is True
    assert pipe._pending_barge_in is not None
    assert pipe._pending_barge_in.text == "Nein, warte."
    assert pipe._pending_barge_in.is_barge_in is True
    assert pipe._barge_in_active is False


@pytest.mark.asyncio
async def test_noise_never_reaches_the_evaluator():
    """A cough transcribes to nothing. There is no judgement to make and none
    is paid for — resume immediately, which is the fastest path there is."""
    decider = Decider(BargeInDecision.COMMIT)
    pipe, room = make_pipeline(decider)
    await _run_detection(pipe, [_vad_barge_in(), _event("", is_final=True)])

    assert decider.calls == []
    assert pipe._play_allowed.is_set() is True
    assert pipe._stop_speaking_event.is_set() is False


@pytest.mark.asyncio
async def test_an_evaluator_that_fails_commits():
    """Never silently swallow a real interruption because the classifier did
    not answer. Being wrong this way keeps the user's words; the other way
    throws them out."""
    decider = Decider(raises=True)
    pipe, room = make_pipeline(decider)
    await _run_detection(pipe, [_vad_barge_in(), _event("stop mal", is_final=True)])

    assert pipe._pending_barge_in is not None
    assert pipe._pending_barge_in.text == "stop mal"


@pytest.mark.asyncio
async def test_an_evaluator_that_never_answers_commits():
    """The agent's hook fetches conversation history before the evaluator's own
    budget starts, so the evaluator's timeout does not cover the whole call. The
    user hears silence for every millisecond of it — bound it here, and resolve
    while there is still a suspension to resolve (the watchdog is the net, not
    the mechanism)."""
    async def never(transcript):
        await asyncio.sleep(30)
        return BargeInDecision.RESUME

    pipe, room = make_pipeline(never)
    pipe._barge_in_decision_timeout_s = 0.05
    await _run_detection(pipe, [_vad_barge_in(), _event("warte mal", is_final=True)])

    assert pipe._pending_barge_in is not None
    assert pipe._pending_barge_in.text == "warte mal"
    assert pipe._barge_in_active is False


@pytest.mark.asyncio
async def test_the_decision_budget_stays_inside_the_watchdog():
    """Both bound the same silence; a decision allowed to outlast the net that
    guards the suspension is one that can arrive after something else resolved
    it."""
    pipe, _ = make_pipeline()
    assert pipe._barge_in_decision_timeout_s < pipe._barge_in_suspend_timeout_s


@pytest.mark.asyncio
async def test_the_watchdog_does_not_fire_while_the_decision_is_running():
    """Observed on prod: the user interrupted, spoke for 7.6s, the final landed
    inside the budget — and the watchdog, armed back at the SUSPEND, fired
    375ms into an 822ms evaluator call. Playback resumed for 452ms before the
    commit silenced it again: the "word or two" heard after going quiet.

    The transcript being in hand means nothing can stall any more, so the net
    comes down before the decision starts — as the text path already did."""
    async def slow(transcript):
        await asyncio.sleep(0.25)
        return BargeInDecision.COMMIT

    pipe, room = make_pipeline(slow)
    pipe._barge_in_suspend_timeout_s = 0.05      # net would fire mid-decision

    # The symptom is audible, not structural: the end state is a commit either
    # way. What must not happen is playback restarting while we decide.
    resumed = []
    original = pipe.resume_speech
    pipe.resume_speech = lambda: (resumed.append(1), original())[1]

    await _run_detection(pipe, [_vad_barge_in(), _event("warte kurz", is_final=True)])

    assert resumed == [], "playback resumed mid-decision — the user hears a word or two"
    assert pipe._pending_barge_in is not None
    assert pipe._pending_barge_in.text == "warte kurz"


@pytest.mark.asyncio
async def test_a_long_interruption_does_not_get_talked_over():
    """The watchdog budget must measure silence FROM STT, not the length of the
    interruption. Armed at the suspend and never pushed out, an answer longer
    than BARGE_IN_SUSPEND_TIMEOUT_MS resumed playback on top of a user who was
    still mid-sentence — the exact thing yielding the floor prevents."""
    pipe, room = make_pipeline()
    pipe._barge_in_enabled = True
    pipe._is_speaking = True
    pipe._audio_active = True
    pipe._is_listening = True
    pipe._barge_in_suspend_timeout_s = 0.12
    pipe.close_transcript_gate()

    async def slow_stream(audio_iter, **kwargs):
        yield _vad_barge_in()
        # Partials keep arriving for well over the watchdog budget.
        for i in range(6):
            await asyncio.sleep(0.04)
            yield _event(f"ich habe {i}")
        yield _event("ich habe bei der Uni unterrichten muessen", is_final=True)

    pipe._stt = type("S", (), {"stream_transcribe": staticmethod(slow_stream)})()
    await pipe._run_stt_stream_inner()
    await asyncio.sleep(0.05)

    # Never handed back mid-sentence: the turn was committed, not resumed.
    assert pipe._pending_barge_in is not None
    assert pipe._pending_barge_in.text == "ich habe bei der Uni unterrichten muessen"


@pytest.mark.asyncio
async def test_with_no_evaluator_wired_every_interruption_commits():
    """Turn-taking must not depend on an agent having implemented the hook."""
    pipe, room = make_pipeline()
    await _run_detection(pipe, [_vad_barge_in(), _event("warte", is_final=True)])
    assert pipe._pending_barge_in is not None


@pytest.mark.asyncio
async def test_a_backchannel_in_a_gap_between_sentences_is_not_a_turn():
    """The same "mhm", landing where there was no audible speech to suspend —
    between two sentences, or while the next one is still synthesizing. The
    reflex cannot act, so this arrives through the gate's carry-over branch,
    which used to promote it to a turn purely for being audible."""
    decider = Decider(BargeInDecision.RESUME)
    pipe, room = make_pipeline(decider)
    await _run_detection(pipe, [
        _event("", speech_started=True),
        _vad_barge_in(),
        _event("Mhmm.", is_final=True),
    ], audio_active=False)

    assert decider.calls == ["Mhmm."]
    assert pipe._pending_barge_in is None
    assert pipe._transcript_queue.empty()


@pytest.mark.asyncio
async def test_the_user_keeping_the_floor_is_never_second_guessed():
    """An utterance that began while the gate was OPEN is the user's turn by
    right — they were already speaking when the agent started. There is no
    interruption to judge, so the evaluator is not consulted at all."""
    decider = Decider(BargeInDecision.RESUME)
    pipe, room = make_pipeline(decider)
    pipe._barge_in_enabled = True
    pipe._is_speaking = True
    pipe._audio_active = False
    pipe._is_listening = True
    # Gate OPEN when speech starts, closed before the final lands.
    pipe._stt = FakeSTT([
        _event("", speech_started=True),
        _event("ich wollte noch sagen", is_final=True),
    ])
    orig = pipe._track_utterance

    def track(event):
        utt = orig(event)
        if event.speech_started:
            pipe.close_transcript_gate()   # agent starts talking over them
        return utt

    pipe._track_utterance = track
    await pipe._run_stt_stream_inner()
    await asyncio.sleep(0.05)

    assert decider.calls == []
    assert pipe._pending_barge_in is not None
    assert pipe._pending_barge_in.text == "ich wollte noch sagen"


# ── The false-interruption storm guard ───────────────────────────────────


def test_a_run_of_false_interruptions_suspends_barge_in():
    pipe, _ = make_pipeline()
    pipe._barge_in_enabled = True
    assert pipe._barge_in_available() is True

    for _ in range(pipe._barge_in_storm_count - 1):
        pipe._note_false_interruption()
        assert pipe._barge_in_available() is True

    pipe._note_false_interruption()
    assert pipe._barge_in_available() is False


def test_false_interruptions_spread_out_never_trip_it():
    """The guard is for a noisy environment, not for a long conversation that
    happens to accumulate the odd cough."""
    pipe, _ = make_pipeline()
    pipe._barge_in_enabled = True
    pipe._barge_in_storm_window_s = 0.01
    for _ in range(pipe._barge_in_storm_count + 2):
        pipe._note_false_interruption()
        time.sleep(0.02)
    assert pipe._barge_in_available() is True


def test_the_cooldown_expires_on_its_own():
    pipe, _ = make_pipeline()
    pipe._barge_in_enabled = True
    for _ in range(pipe._barge_in_storm_count):
        pipe._note_false_interruption()
    assert pipe._barge_in_available() is False

    pipe._barge_in_suppressed_until = time.monotonic() - 0.001
    assert pipe._barge_in_available() is True
    assert pipe._barge_in_suppressed_until == 0.0


@pytest.mark.asyncio
async def test_real_interruptions_never_count_toward_the_storm():
    """A user who genuinely cuts in three times in a minute is having a
    conversation. Locking them out is the failure this guard exists to
    prevent, not a form of it."""
    decider = Decider(BargeInDecision.COMMIT)
    pipe, room = make_pipeline(decider)
    for i in range(5):
        pipe._pending_barge_in = None
        pipe._stop_speaking_event.clear()
        await _run_detection(pipe, [
            _vad_barge_in(tid=f"t{i}"),
            _event("warte kurz", is_final=True, tid=f"t{i}"),
        ])
    assert pipe._barge_in_available() is True


@pytest.mark.asyncio
async def test_resume_verdicts_are_what_feed_the_guard():
    decider = Decider(BargeInDecision.RESUME)
    pipe, room = make_pipeline(decider)
    for i in range(pipe._barge_in_storm_count):
        await _run_detection(pipe, [
            _vad_barge_in(tid=f"t{i}"),
            _event("mhm", is_final=True, tid=f"t{i}"),
        ])
    assert pipe._barge_in_available() is False


@pytest.mark.asyncio
async def test_a_suppressed_session_keeps_talking_and_queues_what_was_said():
    """During the cooldown the agent finishes its sentence — but what the user
    said is not thrown away. It goes through the turn-based path that already
    exists: delivered out-of-band as the next turn, flagged as NOT a barge-in
    so the agent does not think it was interrupted."""
    decider = Decider(BargeInDecision.COMMIT)
    pipe, room = make_pipeline(decider)
    pipe._barge_in_enabled = True
    pipe._barge_in_suppressed_until = time.monotonic() + 60

    await _run_detection(pipe, [
        _event("", speech_started=True),
        _vad_barge_in(),
        _event("und noch etwas", is_final=True),
    ])

    assert pipe.is_suspended is False              # never went quiet
    assert pipe._stop_speaking_event.is_set() is False
    assert pipe._pending_barge_in is not None
    assert pipe._pending_barge_in.is_barge_in is False
    # Still judged. Suppression governs whether the agent YIELDS, not whether
    # noise may become a turn — queueing an "mhm" for the next turn is the same
    # bug arriving one turn later.
    assert decider.calls == ["und noch etwas"]


@pytest.mark.asyncio
async def test_a_suppressed_session_still_drops_what_was_only_noise():
    decider = Decider(BargeInDecision.RESUME)
    pipe, room = make_pipeline(decider)
    pipe._barge_in_enabled = True
    pipe._barge_in_suppressed_until = time.monotonic() + 60

    await _run_detection(pipe, [
        _event("", speech_started=True),
        _vad_barge_in(),
        _event("mhm", is_final=True),
    ])

    assert pipe._pending_barge_in is None
    assert pipe._transcript_queue.empty()
    assert pipe.is_suspended is False
