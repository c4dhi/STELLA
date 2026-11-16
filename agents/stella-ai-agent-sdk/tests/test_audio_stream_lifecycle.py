"""Incoming audio must not pile up in memory (#922).

Each reconnect of a participant used to leave its old LiveKit AudioStream
open, still filling an unbounded queue nobody read, and the room's own audio
queue was unbounded too. Together they grew a long Grace session until the
agent pod was OOM-killed.
"""

import asyncio

import pytest

from stella_agent_sdk.livekit.room import RoomManager


def _room() -> RoomManager:
    room = RoomManager("ws://localhost:7880", "key", "secret")
    room._connected = True
    return room


class _Stream:
    def __init__(self):
        self.closed = False

    async def aclose(self):
        self.closed = True


class _Participant:
    def __init__(self, identity: str):
        self.identity = identity


def _subscribe(room: RoomManager, identity: str) -> _Stream:
    stream = _Stream()
    room._subscribed_tracks[identity] = object()
    room._audio_streams[identity] = stream
    return stream


@pytest.mark.asyncio
async def test_unsubscribe_closes_the_stream():
    room = _room()
    stream = _subscribe(room, "participant-ipad")

    room._on_track_unsubscribed(None, None, _Participant("participant-ipad"))
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert stream.closed
    assert "participant-ipad" not in room._audio_streams
    assert not room._closing_streams


@pytest.mark.asyncio
async def test_every_reconnect_closes_its_stream():
    room = _room()
    streams = []
    for _ in range(20):
        streams.append(_subscribe(room, "participant-ipad"))
        room._on_track_unsubscribed(None, None, _Participant("participant-ipad"))
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert all(s.closed for s in streams)
    assert not room._audio_streams


@pytest.mark.asyncio
async def test_unsubscribe_still_ends_the_stt_audio():
    room = _room()
    _subscribe(room, "participant-ipad")

    room._on_track_unsubscribed(None, None, _Participant("participant-ipad"))

    assert room._audio_queue.get_nowait() == b""


@pytest.mark.asyncio
async def test_unread_audio_queue_is_bounded_and_keeps_the_newest(monkeypatch):
    monkeypatch.setattr(RoomManager, "AUDIO_QUEUE_MAX_FRAMES", 5)
    room = _room()

    for i in range(50):
        room._enqueue_audio(bytes([i]))

    assert room._audio_queue.qsize() == 5
    assert [room._audio_queue.get_nowait() for _ in range(5)] == [bytes([i]) for i in range(45, 50)]
    assert room._audio_frames_dropped == 45


@pytest.mark.asyncio
async def test_default_cap_holds_thirty_seconds():
    room = _room()
    # 10 ms LiveKit frames: longer than any STT reconnect backoff.
    assert room._audio_queue.maxsize * 10 >= 30_000
