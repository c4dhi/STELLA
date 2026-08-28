"""What may be published as a user transcript, and what may not.

The STT service carries VAD boundary signals (speech_started, speech_confirmed,
speech_ended) on the SAME TranscriptEvent type as real partials, with the same
transcript_id and no text. They are control signals for the pipeline, not
transcripts — and the frontend upserts a transcript by its id and REPLACES it,
so publishing one blanks the bubble the partials have been filling.

Reported from the "Another test" session as "the bubble was empty at the end
before the final arrived": speech_ended fires ~500ms after the user stops and
the final only lands after the continuation window plus decode, so the blank
sat on screen for ~0.6-1.1s. Intermittent, because a straggler partial
resolving inside the continuation window would refill it.
"""

import asyncio

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.services.stt_client import TranscriptEvent


class FakeRoom:
    audio_sample_rate = 48000
    current_audio_speaker = "human"
    queued_playout_ms = 0.0

    def __init__(self):
        self.published = []

    def on_data_received(self, cb):
        pass

    async def publish_data(self, data, *a, **k):
        self.published.append(data)
        await asyncio.sleep(0)

    def publish_data_ordered(self, data, *a, **k):
        self.published.append(data)

    def get_participant_name(self, identity):
        return identity


def _event(text, *, is_final=False, **flags):
    return TranscriptEvent(
        text=text,
        is_final=is_final,
        transcript_id="t1",
        participant_id="human",
        confidence=1.0,
        timestamp_ms=0,
        speech_started=flags.get("speech_started", False),
        speech_confirmed=flags.get("speech_confirmed", False),
        speech_ended=flags.get("speech_ended", False),
    )


def _pipeline():
    room = FakeRoom()
    return AudioPipeline(room, stt_client=None, tts_client=None, session_id="s"), room


def _texts(room):
    return [p["data"]["text"] for p in room.published if p.get("type") == "transcript"]


@pytest.mark.asyncio
@pytest.mark.parametrize("flag", ["speech_started", "speech_confirmed", "speech_ended"])
async def test_a_vad_boundary_signal_is_not_a_transcript(flag):
    pipe, room = _pipeline()
    await pipe._publish_user_transcript(_event("", **{flag: True}))
    assert _texts(room) == []


@pytest.mark.asyncio
async def test_speech_ended_cannot_blank_a_bubble_the_partials_filled():
    """The reported symptom, end to end: partials build the text up, the
    boundary signal lands between the last partial and the final, and the
    bubble must still be showing the last partial when it does."""
    pipe, room = _pipeline()
    await pipe._publish_user_transcript(_event("Ich musste letzte"))
    await pipe._publish_user_transcript(_event("Ich musste letzte Woche"))
    await pipe._publish_user_transcript(_event("", speech_ended=True))
    await pipe._publish_user_transcript(
        _event("Ich musste letzte Woche unterrichten.", is_final=True)
    )
    assert _texts(room) == [
        "Ich musste letzte",
        "Ich musste letzte Woche",
        "Ich musste letzte Woche unterrichten.",
    ]


@pytest.mark.asyncio
async def test_an_empty_final_is_not_published_either():
    """Nothing was transcribed, so there is nothing to show — and publishing it
    would both wipe the bubble and record an empty message."""
    pipe, room = _pipeline()
    await pipe._publish_user_transcript(_event("", is_final=True))
    assert _texts(room) == []


@pytest.mark.asyncio
async def test_real_transcripts_still_carry_their_attribution():
    pipe, room = _pipeline()
    await pipe._publish_user_transcript(_event("hallo", is_final=True))
    (payload,) = [p for p in room.published if p.get("type") == "transcript"]
    assert payload["data"]["text"] == "hallo"
    assert payload["data"]["is_final"] is True
    assert payload["data"]["speaker_id"] == "human"
    assert payload["data"]["source"] == "user_speech"
