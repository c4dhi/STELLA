"""Text typed while speech services were still loading (#193, GitHub #999).

`run_agent_from_env` joins the room before waiting (up to
STELLA_SPEECH_WAIT_SECONDS) for STT/TTS, but nothing listens for data-channel
messages until AudioPipeline exists afterwards — so anything typed in that
window used to vanish with no trace. `_buffer_early_data_message` holds it
with its real arrival time; `_replay_early_data_messages` hands it to the now-
built pipeline, in order, once it exists. The replayed TranscriptEvent must
keep the time it actually arrived at, not the time it's replayed — agents
like the ELIAS interviewer (#219) use that to tell "before the first
question" apart from an answer.
"""

import json

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.run import _buffer_early_data_message, _replay_early_data_messages


class FakeRoom:
    """Minimal RoomManager stand-in (mirrors test_text_barge_in.py)."""

    audio_sample_rate = 48000
    current_audio_speaker = None

    def __init__(self):
        self.data_handler = None
        self.published = []

    def on_data_received(self, cb):
        self.data_handler = cb

    async def publish_data(self, data, *a, **k):
        self.published.append(data)

    def flush_audio_queue(self):
        pass

    @property
    def queued_playout_ms(self):
        return 0.0

    def clear_playout(self):
        pass

    def get_participant_name(self, identity):
        return identity


def _user_text_envelope(text, participant_id="alice", correlation_id="c1", transcript_id="env1"):
    return json.dumps({
        "type": "user_text",
        "data": {"text": text, "correlation_id": correlation_id},
        "participant_id": participant_id,
        "transcript_id": transcript_id,
    }).encode("utf-8")


def _drain_transcripts(pipeline: AudioPipeline):
    events = []
    while not pipeline._transcript_queue.empty():
        events.append(pipeline._transcript_queue.get_nowait())
    return events


def test_buffering_records_the_real_arrival_time(monkeypatch):
    buffer = []
    monkeypatch.setattr("stella_agent_sdk.run.time.time", lambda: 1_000.0)

    _buffer_early_data_message(buffer, "alice", _user_text_envelope("hi"))

    assert len(buffer) == 1
    participant_id, data, received_at_ms = buffer[0]
    assert participant_id == "alice"
    assert data == _user_text_envelope("hi")
    assert received_at_ms == 1_000_000


@pytest.mark.asyncio
async def test_replay_preserves_order_and_original_timestamp(monkeypatch):
    buffer = []
    monkeypatch.setattr("stella_agent_sdk.run.time.time", lambda: 1_000.0)
    _buffer_early_data_message(buffer, "alice", _user_text_envelope("first", transcript_id="t1"))
    monkeypatch.setattr("stella_agent_sdk.run.time.time", lambda: 1_005.0)
    _buffer_early_data_message(buffer, "alice", _user_text_envelope("second", transcript_id="t2"))

    room = FakeRoom()
    pipeline = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")

    # Replaying happens long after both messages arrived - a naive replay
    # that stamped "now" would show them both typed at the same, later time.
    monkeypatch.setattr("stella_agent_sdk.audio.pipeline.time.time", lambda: 1_090.0)
    _replay_early_data_messages(buffer, pipeline)

    events = _drain_transcripts(pipeline)
    assert [e.text for e in events] == ["first", "second"]
    assert events[0].timestamp_ms == 1_000_000
    assert events[1].timestamp_ms == 1_005_000
    assert buffer == []


@pytest.mark.asyncio
async def test_a_message_that_never_arrived_early_still_gets_now(monkeypatch):
    """Unaffected path: a normal, live message (no buffering involved) still
    gets stamped with its own arrival time, as before #193."""
    room = FakeRoom()
    pipeline = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")
    monkeypatch.setattr("stella_agent_sdk.audio.pipeline.time.time", lambda: 2_000.0)

    pipeline._handle_data_message("alice", _user_text_envelope("live"))
    for _ in range(5):
        import asyncio
        await asyncio.sleep(0)

    events = _drain_transcripts(pipeline)
    assert len(events) == 1
    assert events[0].timestamp_ms == 2_000_000
