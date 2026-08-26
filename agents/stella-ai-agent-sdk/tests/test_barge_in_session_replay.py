"""End-to-end replay of the production session that motivated this design.

Session 5b758b59 ("Next barge in test") on a fully-German plan. The sequence
below is the real one, taken from the STT service log. Every symptom the user
reported is reproduced here as an assertion, so a regression shows up as a test
failure rather than as another broken conversation:

  1. a backchannel ("Yeah." -> revised to "Mm-hmm.") must not stop the agent;
  2. the NEXT interruption must still land — in production it did not, because
     per-utterance state from (1) leaked and swallowed it for the whole session;
  3. whisper hallucinating over near-silence ("Thank you.", "You", "Спасибо.")
     must not be able to interrupt anything, in any language.

These run against the real AudioPipeline event loop, not a stub of it.
"""

import asyncio

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.services.stt_client import TranscriptEvent


class FakeRoom:
    audio_sample_rate = 48000
    current_audio_speaker = None
    queued_playout_ms = 0.0

    def __init__(self):
        self.clear_count = 0

    def on_data_received(self, cb):
        pass

    async def publish_audio(self, data):
        await asyncio.sleep(0)

    async def publish_data(self, data, *a, **k):
        await asyncio.sleep(0)

    def publish_data_ordered(self, data, *a, **k):
        pass

    def clear_playout(self):
        self.clear_count += 1

    def flush_audio_queue(self):
        pass

    def get_participant_name(self, identity):
        return identity


class ScriptedSTT:
    def __init__(self, events):
        self.events = events

    async def stream_transcribe(self, audio_iter, **kwargs):
        for e in self.events:
            yield e
            await asyncio.sleep(0)


def ev(text="", is_final=False, tid="t", confirmed=False):
    return TranscriptEvent(
        text=text, is_final=is_final, transcript_id=tid, participant_id="human",
        confidence=1.0, timestamp_ms=0, speech_confirmed=confirmed,
    )


def talking_pipeline():
    """The state that matters: agent audibly speaking, transcript gate closed."""
    pipe = AudioPipeline(FakeRoom(), stt_client=None, tts_client=None, session_id="s")
    pipe._is_listening = True
    pipe._barge_in_enabled = True
    pipe._is_speaking = True
    pipe._audio_active = True
    pipe.close_transcript_gate()
    return pipe


async def drive(pipe, events):
    pipe._stt = ScriptedSTT(events)
    await pipe._run_stt_stream_inner()
    for _ in range(20):
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_the_full_reported_sequence():
    """Backchannel, then a real interruption, then hallucinations."""
    pipe = talking_pipeline()

    # ── Utterance A: the backchannel. Partial 'Yeah.', final revised to
    #    'Mm-hmm.'. VAD never confirms — it was ~600ms of audio but only 0.6s
    #    of it voiced. The agent must not so much as pause.
    await drive(pipe, [ev("Yeah.", tid="A"), ev("Mm-hmm.", is_final=True, tid="A")])
    assert pipe._stop_speaking_event.is_set() is False, "a backchannel stopped the agent"
    assert pipe.is_suspended is False
    assert pipe._pending_barge_in is None

    # ── Utterance B: a real interruption that HAPPENS TO START with the same
    #    word. This is the one production dropped: 'Yeah.' was still sitting in
    #    a guard from utterance A, so the interruption was silently discarded
    #    and the turn was committed as a normal message instead.
    await drive(pipe, [
        ev("Yeah.", tid="B"),
        ev(confirmed=True, tid="B"),
        ev("ja, aber warte, das stimmt nicht", is_final=True, tid="B"),
    ])
    assert pipe._stop_speaking_event.is_set(), "the second interruption was swallowed"
    injected = pipe._pending_barge_in
    assert injected is not None
    assert injected.text == "ja, aber warte, das stimmt nicht"
    assert injected.is_barge_in is True


@pytest.mark.asyncio
async def test_hallucinations_cannot_interrupt_in_any_language():
    """These are the exact strings whisper produced over near-silence in that
    session — in three languages, on a German call. Under the old design each
    was a partial long enough to trigger a suspend. Now text cannot trigger
    anything at all, so the language it hallucinates in stops mattering."""
    pipe = talking_pipeline()
    for i, phantom in enumerate(["Thank you.", "You", "Спасибо.", "Понял.", "We'll be right back."]):
        await drive(pipe, [ev(phantom, tid=f"h{i}"), ev(phantom, is_final=True, tid=f"h{i}")])

    assert pipe._stop_speaking_event.is_set() is False
    assert pipe.is_suspended is False
    assert pipe._pending_barge_in is None
    assert pipe._room.clear_count == 0


@pytest.mark.asyncio
async def test_a_long_interruption_delivers_the_whole_utterance():
    """VAD stops playback partway through, but the turn handed to the agent is
    the FINAL transcript — not the prefix that happened to trigger it."""
    pipe = talking_pipeline()
    await drive(pipe, [
        ev("nein", tid="C"),
        ev(confirmed=True, tid="C"),          # stops here, mid-utterance
        ev("nein das", tid="C"),
        ev("nein das ist falsch, bitte wechsel auf Deutsch", is_final=True, tid="C"),
    ])
    injected = pipe._pending_barge_in
    assert injected is not None
    assert injected.text == "nein das ist falsch, bitte wechsel auf Deutsch"


@pytest.mark.asyncio
async def test_a_dropped_final_does_not_relabel_the_next_turn():
    """STT can drop the final after a reconnect. The commit state is keyed on
    the utterance's transcript_id, so it dies with that utterance instead of
    marking an unrelated later turn as the interruption."""
    pipe = talking_pipeline()
    await drive(pipe, [
        ev("warte", tid="D"),
        ev(confirmed=True, tid="D"),
        # no final for D — the stream moves on to a different utterance
        ev("guten Morgen", is_final=True, tid="E"),
    ])
    assert pipe._barge_in_committed_tid is None
    assert pipe._pending_barge_in is None, "an unrelated turn was labelled a barge-in"
