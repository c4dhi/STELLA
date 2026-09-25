"""Replay of session 6ebeacd8 ("New test"), where the gate flipped mid-utterance.

Two failures were reported from that call, and they are the same bug seen from
both sides. Whose floor an utterance began on is settled at its first frame,
but only asked at its last — and a whisper decode (692ms-1.1s measured on that
session) sits in between, long enough for the gate to flip underneath it.

  1. The user paused for breath 14ms past the endpointer, so one sentence
     endpointed into two finals. The agent's bridge started 652ms into the
     second half and closed the gate, and the second final — a complete
     sentence the user was never signalled to stop saying — was discarded.
     From the prod log, the turn simply never existed:

         19:39:24.477  Final #1 -> turn whisper_8f3a16b7 starts
         19:39:25.129  [TTS] Enqueued bridge -> [GATE] Closing transcript gate
         19:39:28.53   Final #2 arrives, gate closed -> discarded

  2. A backchannel ("Mm-hmm") correctly failed to interrupt playback, then its
     decode landed 26ms AFTER the gate reopened, was promoted to a full turn,
     and re-closed the gate — so the agent repeated its own question and the
     user was locked out of answering it.

Both run against the real AudioPipeline event loop.
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
    """Yields scripted STT events; a callable in the script runs instead.

    The callables are the point: these bugs only exist because the agent starts
    or stops speaking BETWEEN two events of one utterance.
    """

    def __init__(self, items):
        self.items = items

    async def stream_transcribe(self, audio_iter, **kwargs):
        for item in self.items:
            if callable(item):
                item()
                await asyncio.sleep(0)
                continue
            yield item
            await asyncio.sleep(0)


def ev(text="", is_final=False, tid="t", confirmed=False, started=False, ended=False):
    return TranscriptEvent(
        text=text, is_final=is_final, transcript_id=tid, participant_id="human",
        confidence=1.0, timestamp_ms=0, speech_confirmed=confirmed,
        speech_started=started, speech_ended=ended,
    )


def idle_pipeline():
    """Agent silent, gate open — the floor is the user's."""
    pipe = AudioPipeline(FakeRoom(), stt_client=None, tts_client=None, session_id="s")
    pipe._is_listening = True
    pipe._barge_in_enabled = True
    return pipe


def talking_pipeline():
    """Agent audibly speaking, gate closed."""
    pipe = idle_pipeline()
    start_speaking(pipe)
    return pipe


def start_speaking(pipe):
    """What _speech_worker does on entry."""
    pipe._is_speaking = True
    pipe._audio_active = True
    pipe._stop_speaking_event.clear()
    pipe._play_allowed.set()
    pipe.close_transcript_gate()


def stop_speaking(pipe):
    """What _speech_worker does on exit."""
    pipe._is_speaking = False
    pipe._audio_active = False
    pipe.open_transcript_gate()


async def drive(pipe, items):
    pipe._stt = ScriptedSTT(items)
    await pipe._run_stt_stream_inner()
    for _ in range(20):
        await asyncio.sleep(0)


def queued(pipe):
    out = []
    while not pipe._transcript_queue.empty():
        out.append(pipe._transcript_queue.get_nowait().text)
    return out


# ─────────────────────────────────────────────────────────────────────────
# 1. The gate closing mid-utterance must not delete the utterance
# ─────────────────────────────────────────────────────────────────────────

SECOND_HALF = "Und genau das habe ich eigentlich letzte Woche gemacht."


@pytest.mark.asyncio
async def test_the_split_sentence_keeps_both_halves():
    """The reported case, end to end. Endpointing splitting a sentence in two
    is a transcription artefact; losing half of it is not."""
    pipe = idle_pipeline()

    await drive(pipe, [
        # First half — an ordinary turn on an open gate.
        ev(started=True, tid="A"),
        ev(confirmed=True, tid="A"),
        ev(ended=True, tid="A"),
        ev("Ich musste an der Universität Zürich unterrichten.", is_final=True, tid="A"),

        # 3ms later they carry straight on. The bridge for the first half
        # starts partway through and shuts the gate on them.
        ev(started=True, tid="B"),
        ev(confirmed=True, tid="B"),
        lambda: start_speaking(pipe),
        ev(ended=True, tid="B"),
        ev(SECOND_HALF, is_final=True, tid="B"),
    ])

    assert queued(pipe) == ["Ich musste an der Universität Zürich unterrichten."]
    assert pipe._pending_barge_in is not None, "the second half was discarded"
    assert pipe._pending_barge_in.text == SECOND_HALF


@pytest.mark.asyncio
async def test_the_agent_does_not_speak_over_a_user_who_already_has_the_floor():
    """By the time the bridge is ready the user has been talking for 650ms and
    is already past the interruption threshold. Starting anyway and letting the
    final sort it out means talking over them for a whole decode first."""
    pipe = idle_pipeline()
    pipe._stt = ScriptedSTT([])

    await drive(pipe, [
        ev(started=True, tid="B"),
        ev(confirmed=True, tid="B"),
        lambda: start_speaking(pipe),
    ])

    assert pipe.is_suspended, "the agent talked over a confirmed interruption"
    assert pipe._barge_in_committed_tid == "B"


@pytest.mark.asyncio
async def test_a_short_utterance_that_began_on_an_open_gate_still_lands():
    """Same shape, but too short to have cleared the barge-in threshold before
    the gate shut. The floor was still theirs when they started."""
    pipe = idle_pipeline()

    await drive(pipe, [
        ev(started=True, tid="C"),
        lambda: start_speaking(pipe),
        ev(ended=True, tid="C"),
        ev("Nein, warte.", is_final=True, tid="C"),
    ])

    assert pipe._pending_barge_in is not None
    assert pipe._pending_barge_in.text == "Nein, warte."
    assert pipe._stop_speaking_event.is_set(), "the agent kept talking over its own interruption"


@pytest.mark.asyncio
async def test_turn_based_mode_queues_the_carry_over_instead_of_interrupting():
    """Without barge-in the agent finishes its sentence — strict alternation is
    the point of that mode. What it must not do is drop the turn."""
    pipe = idle_pipeline()
    pipe._barge_in_enabled = False

    await drive(pipe, [
        ev(started=True, tid="D"),
        lambda: start_speaking(pipe),
        ev(ended=True, tid="D"),
        ev("und dann noch etwas", is_final=True, tid="D"),
    ])

    assert pipe._stop_speaking_event.is_set() is False, "turn-based mode interrupted the agent"
    assert pipe._pending_barge_in is not None, "turn-based mode dropped the turn"
    assert pipe._pending_barge_in.text == "und dann noch etwas"
    assert pipe._pending_barge_in.is_barge_in is False


# ─────────────────────────────────────────────────────────────────────────
# 2. A backchannel decoded after playback stops must not become a turn
# ─────────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_backchannel_decoded_after_playback_is_not_a_turn():
    """'Mm-hmm' during playback, whose decode lands 26ms after the gate opens.

    Nothing about it is a turn: it never cleared the interruption threshold,
    and the user had already stopped before the agent did. Admitting it costs
    the user the floor twice — once for the wasted turn, and again because that
    turn re-closes the gate on what they say next.
    """
    pipe = talking_pipeline()

    await drive(pipe, [
        ev(started=True, tid="M"),
        ev("The", tid="M"),
        ev(ended=True, tid="M"),
        lambda: stop_speaking(pipe),
        ev("Mm-hmm", is_final=True, tid="M"),
    ])

    assert queued(pipe) == [], "a backchannel was promoted to a turn"
    assert pipe._pending_barge_in is None


@pytest.mark.asyncio
async def test_speech_still_running_when_the_gate_opens_is_a_turn():
    """The guard against over-filtering the case above. This user started
    during playback too — but was still talking when the floor came back, so
    the words after that point are addressed to an agent that has stopped."""
    pipe = talking_pipeline()

    await drive(pipe, [
        ev(started=True, tid="N"),
        ev("Nein", tid="N"),
        lambda: stop_speaking(pipe),
        ev(ended=True, tid="N"),
        ev("Nein, das war nicht gemeint.", is_final=True, tid="N"),
    ])

    assert queued(pipe) == ["Nein, das war nicht gemeint."]


@pytest.mark.asyncio
async def test_a_confirmed_interruption_is_never_filtered_as_a_backchannel():
    """A real interruption that the reflex could not act on — _audio_active is
    False in the gap between two sentences, so nothing was suspended. It is
    still a turn: confirmation is what separates one from a backchannel."""
    pipe = talking_pipeline()
    pipe._audio_active = False  # between sentences: nothing audible to duck

    await drive(pipe, [
        ev(started=True, tid="P"),
        ev(confirmed=True, tid="P"),
        ev(ended=True, tid="P"),
        ev("stopp, das ist falsch", is_final=True, tid="P"),
    ])

    assert pipe._pending_barge_in is not None, "a confirmed interruption was discarded"
    assert pipe._pending_barge_in.text == "stopp, das ist falsch"
