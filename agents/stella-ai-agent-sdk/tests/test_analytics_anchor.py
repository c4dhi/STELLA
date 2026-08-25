"""Analytics ground zero for TYPED turns.

Every pipeline-stage analytics event is reported as ``elapsed_ms`` relative to
the turn anchor (``turn_anchor_ts``), and every TTS timing event is emitted only
``if self.turn_anchor_ts > 0``. The anchor was set in exactly one place — the
STT final-transcript branch — so a turn that arrived as typed text never had
one. The result was not a missing row here and there but a wholly zeroed
session: every stage stamped elapsed_ms=0.0 and every *_tts_first_byte /
*_tts_done event suppressed outright.
"""

import asyncio
import json
import time

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline


class FakeRoom:
    """Minimal RoomManager stand-in (mirrors test_text_barge_in.py)."""

    audio_sample_rate = 48000
    current_audio_speaker = None

    def __init__(self):
        self.published = bytearray()
        self.data_handler = None
        self.captured = []

    def on_data_received(self, cb):
        self.data_handler = cb

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

    @property
    def queued_playout_ms(self):
        return 0.0

    def clear_playout(self):
        pass

    def get_participant_name(self, identity):
        return identity


def make_pipeline():
    room = FakeRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")
    return pipe, room


def _user_text(text, transcript_id="env1"):
    return json.dumps({
        "type": "user_text",
        "data": {"text": text},
        "participant_id": "alice",
        "transcript_id": transcript_id,
    }).encode("utf-8")


async def next_turn(pipe, room, text, transcript_id="env1"):
    """Feed a typed message and pull the turn the agent would receive.

    Anchoring happens at the turn boundary (audio_in), not on receipt, so a
    message still queued behind an in-flight turn cannot move that turn's
    ground zero out from under it.
    """
    pipe._is_listening = True
    room.data_handler("human", _user_text(text, transcript_id))
    await asyncio.sleep(0.05)
    agen = pipe.audio_in()
    event = await asyncio.wait_for(agen.__anext__(), timeout=2.0)
    await agen.aclose()
    return event


def _analytics(room, stage):
    return [
        c for c in room.captured
        if c.get("type") == "analytics" and c.get("data", {}).get("stage") == stage
    ]


@pytest.mark.asyncio
async def test_typed_turn_sets_the_turn_anchor():
    """A typed turn is a turn: it needs a ground zero like a spoken one."""
    pipe, room = make_pipeline()
    await next_turn(pipe, room, "hello")

    assert pipe.turn_anchor_ts > 0, "typed turn left analytics with no ground zero"


@pytest.mark.asyncio
async def test_typed_turn_stamps_a_turn_id():
    """Without this every typed event is recorded under turn_id ''."""
    pipe, room = make_pipeline()
    await next_turn(pipe, room, "hello", transcript_id="t-42")

    assert pipe._turn_id == "t-42"


@pytest.mark.asyncio
async def test_typed_turn_emits_first_byte_timing():
    """The `turn_anchor_ts > 0` guard silently dropped these for typed turns."""
    pipe, room = make_pipeline()
    await next_turn(pipe, room, "hello")

    pipe._emit_first_byte("response")
    await asyncio.sleep(0.05)

    events = _analytics(room, "response_tts_first_byte")
    assert len(events) == 1, "no first-byte timing recorded for a typed turn"
    assert events[0]["data"]["elapsed_ms"] > 0


@pytest.mark.asyncio
async def test_stage_elapsed_is_nonzero_for_a_typed_turn():
    """The symptom users saw: every stage pinned to 0ms, so the chart's axis
    max was 0 and every marker collapsed onto the origin."""
    pipe, room = make_pipeline()
    await next_turn(pipe, room, "hello")

    # Mirrors StellaV2Agent._elapsed_ms(), which returns a flat 0.0 whenever
    # the anchor is unset — the exact path that zeroed every lane.
    elapsed = (
        0.0 if pipe.turn_anchor_ts == 0
        else (time.perf_counter() - pipe.turn_anchor_ts) * 1000
    )
    assert elapsed > 0.0


@pytest.mark.asyncio
async def test_each_typed_turn_re_arms_the_first_byte_flags():
    """Turn 2 must report its own first byte, not be deduped against turn 1."""
    pipe, room = make_pipeline()

    await next_turn(pipe, room, "first", transcript_id="t1")
    pipe._emit_first_byte("response")
    await asyncio.sleep(0.05)

    # End of turn 1 — the run loop always reaches this (base.py finally block).
    pipe._reset_turn_analytics()

    await next_turn(pipe, room, "second", transcript_id="t2")
    pipe._emit_first_byte("response")
    await asyncio.sleep(0.05)

    assert len(_analytics(room, "response_tts_first_byte")) == 2


@pytest.mark.asyncio
async def test_spoken_turn_keeps_stt_end_as_ground_zero():
    """The dequeue-time anchor must not overwrite a better one.

    For speech, ground zero is stt_end — the transcript is locked in and the
    pipeline starts working. That is strictly earlier than the moment the agent
    dequeues the turn, and re-anchoring here would quietly under-report every
    latency in the session.
    """
    from stella_agent_sdk.services.stt_client import TranscriptEvent

    pipe, room = make_pipeline()
    pipe._is_listening = True

    pipe._begin_turn_analytics("spoken-1")
    anchor = pipe.turn_anchor_ts
    await asyncio.sleep(0.02)

    pipe._transcript_queue.put_nowait(TranscriptEvent(
        text="hello", is_final=True, transcript_id="spoken-1",
        participant_id="alice", confidence=1.0, timestamp_ms=0,
    ))
    agen = pipe.audio_in()
    await asyncio.wait_for(agen.__anext__(), timeout=2.0)
    await agen.aclose()

    assert pipe.turn_anchor_ts == anchor, "spoken turn was re-anchored at dequeue"


@pytest.mark.asyncio
async def test_committed_barge_in_turn_is_anchored():
    """Barge-in finals `continue` before the STT anchor line, so a committed
    interruption used to become a turn with no ground zero at all."""
    from stella_agent_sdk.services.stt_client import TranscriptEvent

    pipe, room = make_pipeline()
    pipe._is_listening = True

    pipe._pending_barge_in = TranscriptEvent(
        text="actually wait", is_final=True, transcript_id="bargein_1",
        participant_id="alice", confidence=1.0, timestamp_ms=0,
        is_barge_in=True,
    )
    agen = pipe.audio_in()
    await asyncio.wait_for(agen.__anext__(), timeout=2.0)
    await agen.aclose()

    assert pipe.turn_anchor_ts > 0
    assert pipe._turn_id == "bargein_1"
