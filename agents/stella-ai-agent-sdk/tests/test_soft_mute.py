"""Soft mute (#362): a deliberate mute keeps the STT stream and is treated as silence."""

import asyncio
import json

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.livekit.room import RoomManager


def _room(connected: bool = True) -> RoomManager:
    room = RoomManager("ws://localhost:7880", "key", "secret")
    room._connected = connected
    return room


def _drain(room: RoomManager):
    chunks = []
    while not room._audio_queue.empty():
        chunks.append(room._audio_queue.get_nowait())
    return chunks


@pytest.mark.asyncio
async def test_mute_feeds_silence_and_never_the_end_of_audio_sentinel():
    room = _room()
    room.MUTE_SILENCE_MS = 200

    room.set_mic_muted(True)
    await asyncio.sleep(0.35)
    chunks = _drain(room)

    assert len(chunks) >= 5
    assert all(c != b"" for c in chunks), "b'' would end the STT stream (tear-down)"
    assert all(set(c) == {0} for c in chunks), "padding must be digital silence"
    # 20 ms at the room's sample rate, 16-bit mono
    assert len(chunks[0]) == int(room.audio_sample_rate * 0.02) * 2


@pytest.mark.asyncio
async def test_silence_stops_after_the_window():
    room = _room()
    room.MUTE_SILENCE_MS = 100

    room.set_mic_muted(True)
    await asyncio.sleep(0.3)
    _drain(room)
    await asyncio.sleep(0.1)

    assert room._audio_queue.empty()


@pytest.mark.asyncio
async def test_unmute_stops_the_feeder():
    room = _room()
    room.MUTE_SILENCE_MS = 5000

    room.set_mic_muted(True)
    await asyncio.sleep(0.1)
    room.set_mic_muted(False)
    _drain(room)
    await asyncio.sleep(0.1)

    assert room._audio_queue.empty()
    assert room._mute_silence_task is None


@pytest.mark.asyncio
async def test_not_connected_feeds_nothing():
    room = _room(connected=False)
    room.set_mic_muted(True)
    await asyncio.sleep(0.05)
    assert room._audio_queue.empty()


class _FakeRoom:
    def __init__(self):
        self.calls = []

    def set_mic_muted(self, muted):
        self.calls.append(muted)


@pytest.mark.parametrize(
    "msg_type,expected", [("audio_stream_mute", True), ("audio_stream_unmute", False)]
)
def test_data_message_reaches_the_room(msg_type, expected):
    pipeline = AudioPipeline.__new__(AudioPipeline)  # bypass heavy __init__
    pipeline._room = _FakeRoom()

    payload = json.dumps({"type": msg_type, "data": {"reason": "user_muted"}}).encode()
    pipeline._handle_data_message("human", payload)

    assert pipeline._room.calls == [expected]
