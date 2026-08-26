"""Speculative barge-in resolution — deciding while the user is still talking.

The decision used to wait for a FINAL transcript, which cannot exist until the
user stops AND the endpointing windows elapse AND whisper decodes (~1.6s
measured on prod), and only then did the LLM classifier start. An interruption
therefore cost roughly three seconds of dead air.

These pin the two behaviours that remove that wait:

  * RESUME is acted on mid-utterance, so a backchannel barely dents playback.
  * COMMIT is classified mid-utterance and BANKED, so when the final lands it
    is acted on with no further classifier round trip.

and the two properties that stop it misbehaving: a dismissed utterance must not
re-suspend on its own trailing partials, and a stale verdict must never be
applied to a later utterance.
"""

import asyncio

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline, _speech_grew
from stella_agent_sdk.messages.types import BargeInDecision


class FakeRoom:
    audio_sample_rate = 48000
    current_audio_speaker = None
    queued_playout_ms = 0.0

    def __init__(self):
        self.captured = []

    def on_data_received(self, cb):
        pass

    async def publish_audio(self, data):
        await asyncio.sleep(0)

    async def publish_data(self, data, *a, **k):
        self.captured.append(data)
        await asyncio.sleep(0)

    def publish_data_ordered(self, data, *a, **k):
        self.captured.append(data)

    def flush_audio_queue(self):
        pass

    def clear_playout(self):
        pass

    def get_participant_name(self, identity):
        return identity


def make_pipeline(decider=None):
    pipe = AudioPipeline(FakeRoom(), stt_client=None, tts_client=None, session_id="s")
    pipe._barge_in_enabled = True
    pipe._barge_in_decider = decider
    # Stand in for "the agent is audibly talking and has been suspended".
    pipe._is_speaking = True
    pipe._barge_in_active = True
    return pipe


def decider_returning(decision, calls=None, delay=0.0):
    async def _decider(text):
        if calls is not None:
            calls.append(text)
        if delay:
            await asyncio.sleep(delay)
        return decision
    return _decider


# ── _speech_grew ─────────────────────────────────────────────────────────────

def test_growth_requires_materially_more_speech():
    assert _speech_grew("mhm okay also", "mhm") is True
    assert _speech_grew("mhm", "mhm") is False
    # STT re-emits near-identical partials; a single extra character is noise,
    # not the user continuing to speak.
    assert _speech_grew("mhm.", "mhm") is False


def test_growth_from_nothing_is_growth():
    assert _speech_grew("anything", "") is True
    assert _speech_grew("", "something") is False


def test_growth_ignores_whitespace_reflow():
    """Partials re-flow spacing between revisions; that is not new speech."""
    assert _speech_grew("ja  genau", "ja genau") is False


def test_growth_is_not_word_delimited():
    """Scripts without spaces must still register growth — a word-count metric
    would report 1 word for a whole sentence and never re-arm."""
    assert _speech_grew("今日はいい天気ですね", "今日は") is True


# ── early RESUME ─────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_resume_acts_immediately_on_a_partial():
    """The headline behaviour: a backchannel resumes playback without ever
    waiting for a final transcript."""
    pipe = make_pipeline(decider_returning(BargeInDecision.RESUME))
    pipe.suspend_speech()
    assert pipe._play_allowed.is_set() is False

    pipe._maybe_speculate_barge_in("mhm")
    await pipe._barge_in_speculative_task

    assert pipe._play_allowed.is_set() is True   # resumed
    assert pipe._barge_in_active is False
    assert pipe._barge_in_resumed_text == "mhm"


@pytest.mark.asyncio
async def test_dismissed_utterance_does_not_bank_a_decision():
    """After an early resume there must be nothing left to spend, or the next
    utterance would inherit this one's verdict."""
    pipe = make_pipeline(decider_returning(BargeInDecision.RESUME))
    pipe.suspend_speech()
    pipe._maybe_speculate_barge_in("mhm")
    await pipe._barge_in_speculative_task
    assert pipe._barge_in_speculative_decision is None


# ── banked COMMIT ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_commit_is_banked_and_playback_stays_suspended():
    """COMMIT must NOT act early — a partial is an incomplete turn. It is
    classified early and held, so the final pays no classifier latency."""
    pipe = make_pipeline(decider_returning(BargeInDecision.COMMIT))
    pipe.suspend_speech()

    pipe._maybe_speculate_barge_in("nein warte das stimmt nicht")
    await pipe._barge_in_speculative_task

    assert pipe._barge_in_speculative_decision == BargeInDecision.COMMIT
    assert pipe._play_allowed.is_set() is False  # still suspended
    assert pipe._barge_in_active is True


@pytest.mark.asyncio
async def test_banked_decision_is_spent_without_a_second_call():
    """The saving itself: resolving on the final must not re-ask the classifier."""
    calls = []
    pipe = make_pipeline(decider_returning(BargeInDecision.COMMIT, calls))
    pipe.suspend_speech()
    pipe._maybe_speculate_barge_in("nein das stimmt nicht")
    await pipe._barge_in_speculative_task
    assert len(calls) == 1

    await pipe._resolve_barge_in("nein das stimmt nicht so ganz")

    assert len(calls) == 1                       # no second round trip
    assert pipe._pending_barge_in is not None    # committed as a new turn


@pytest.mark.asyncio
async def test_in_flight_speculation_is_awaited_not_duplicated():
    """If the final arrives mid-classification, wait for the request already
    running — it has a head start, so re-asking is strictly slower."""
    calls = []
    pipe = make_pipeline(decider_returning(BargeInDecision.COMMIT, calls, delay=0.05))
    pipe.suspend_speech()
    pipe._maybe_speculate_barge_in("warte mal kurz")

    await pipe._resolve_barge_in("warte mal kurz bitte")

    assert len(calls) == 1
    assert pipe._pending_barge_in is not None


# ── request economy ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_overlapping_partials_do_not_spam_the_classifier():
    """Partials arrive continuously and overlap heavily; without a growth gate
    this would fire a request every few hundred milliseconds."""
    calls = []
    pipe = make_pipeline(decider_returning(BargeInDecision.COMMIT, calls))
    pipe.suspend_speech()

    for text in ("warte", "warte", "warte."):
        pipe._maybe_speculate_barge_in(text)
        if pipe._barge_in_speculative_task:
            await pipe._barge_in_speculative_task

    assert len(calls) == 1


@pytest.mark.asyncio
async def test_speculation_can_be_switched_off(monkeypatch):
    """BARGE_IN_SPECULATIVE=0 restores decide-only-on-final."""
    monkeypatch.setenv("BARGE_IN_SPECULATIVE", "0")
    calls = []
    pipe = make_pipeline(decider_returning(BargeInDecision.RESUME, calls))
    pipe.suspend_speech()

    pipe._maybe_speculate_barge_in("mhm")

    assert pipe._barge_in_speculative_task is None
    assert calls == []
    assert pipe._play_allowed.is_set() is False  # still suspended, as before


# ── staleness ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_verdict_landing_after_resolution_is_discarded():
    """A classifier that answers after the final already resolved must not
    resume playback for a turn that was committed."""
    pipe = make_pipeline(decider_returning(BargeInDecision.RESUME, delay=0.05))
    pipe.suspend_speech()
    pipe._maybe_speculate_barge_in("mhm ja gut")

    # The final resolves first and commits.
    pipe._barge_in_resolving = True
    task = pipe._barge_in_speculative_task
    await task

    assert pipe._play_allowed.is_set() is False  # verdict ignored
    assert pipe._barge_in_resumed_text == ""


@pytest.mark.asyncio
async def test_failed_speculation_falls_back_to_the_final(monkeypatch):
    """Speculation is an optimisation — if it errors, the final path must still
    produce a decision the normal way."""
    calls = []

    async def _boom(text):
        calls.append(text)
        raise RuntimeError("classifier down")

    pipe = make_pipeline(_boom)
    pipe.suspend_speech()
    pipe._maybe_speculate_barge_in("warte kurz")
    await pipe._barge_in_speculative_task

    assert pipe._barge_in_speculative_decision is None
    # Final path: decider raises again, and the safe default is to interrupt.
    await pipe._resolve_barge_in("warte kurz bitte")
    assert pipe._pending_barge_in is not None


# ── integration: the re-suspend guard, through the real STT loop ─────────────

class _FakeSTT:
    is_connected = True

    def __init__(self, events):
        self.events = events

    async def stream_transcribe(self, audio_iter, **kwargs):
        async for _ in audio_iter:
            pass
        for e in self.events:
            yield e
            await asyncio.sleep(0)


def _event(text, is_final):
    from stella_agent_sdk.services.stt_client import TranscriptEvent
    return TranscriptEvent(
        text=text,
        is_final=is_final,
        transcript_id="t1",
        participant_id="human",
        confidence=1.0,
        timestamp_ms=0,
        speech_started=False,
    )


def _talking_pipeline(decider):
    """A pipeline in the state that matters: agent audibly talking, gate closed."""
    room = FakeRoom()

    async def _audio():
        for _ in range(2):
            await asyncio.sleep(0)
            yield b"\x00\x00"

    room.subscribe_to_audio = _audio
    pipe = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")
    pipe._is_listening = True
    pipe._barge_in_enabled = True
    pipe._barge_in_decider = decider
    pipe._is_speaking = True
    pipe._audio_active = True
    pipe.close_transcript_gate()
    return pipe, room


@pytest.mark.asyncio
async def test_backchannel_echo_does_not_restutter_playback():
    """Regression guard for the loop this could create.

    STT keeps re-emitting overlapping partials for the same "mhm". Once it has
    been dismissed, those repeats must not suspend the agent again — otherwise
    one backchannel stutters playback repeatedly.
    """
    calls = []
    pipe, _room = _talking_pipeline(decider_returning(BargeInDecision.RESUME, calls))
    pipe._stt = _FakeSTT([_event("mhm", False), _event("mhm", False), _event("mhm", True)])

    await pipe._run_stt_stream_inner()
    for _ in range(20):
        await asyncio.sleep(0)

    # Classified once, and the agent is talking again.
    assert len(calls) == 1
    assert pipe._play_allowed.is_set() is True


@pytest.mark.asyncio
async def test_continued_speech_after_a_dismissal_does_re_arm():
    """The other half: if the user actually keeps going, the agent must yield.

    Without this the echo guard above would swallow real interruptions that
    happen to start with a backchannel ("mhm, aber warte...").
    """
    decisions = [BargeInDecision.RESUME, BargeInDecision.COMMIT]
    calls = []

    async def _decider(text):
        calls.append(text)
        return decisions[min(len(calls) - 1, len(decisions) - 1)]

    pipe, _room = _talking_pipeline(_decider)
    pipe._stt = _FakeSTT([
        _event("mhm", False),
        _event("mhm aber warte das stimmt nicht", False),
    ])

    await pipe._run_stt_stream_inner()
    for _ in range(20):
        await asyncio.sleep(0)

    assert len(calls) == 2                       # re-armed on the new speech
    assert pipe._barge_in_active is True         # suspended again
    assert pipe._play_allowed.is_set() is False  # and staying quiet
