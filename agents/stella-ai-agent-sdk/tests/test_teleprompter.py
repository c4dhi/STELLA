"""Tests for the teleprompter speech-progress signal (#241).

Verifies the SDK emits agent_speech_progress envelopes that map the
byte-accurate audio playhead to character offsets in the published agent_text,
and that emission is gated by the STELLA_TELEPROMPTER_ENABLED flag.
"""

import asyncio
import time

import pytest

from stella_agent_sdk.audio.pipeline import (
    AudioPipeline,
    _BYTES_PER_SAMPLE,
    _PLAYOUT_FRAME_BYTES,
    _TTS_SAMPLE_RATE,
)


class CapturingRoom:
    """Room stand-in that records every publish_data envelope."""

    audio_sample_rate = 48000
    current_audio_speaker = None

    def __init__(self):
        self.published = bytearray()
        self.data = []
        # None = model a source draining at 1x (see queued_playout_ms).
        # A number pins the depth for tests that need it deterministic.
        self.queued_ms = None
        self.clear_count = 0
        self._first_push = None

    def on_data_received(self, cb):
        pass

    async def publish_audio(self, data: bytes):
        await asyncio.sleep(0)
        if self._first_push is None:
            self._first_push = time.perf_counter()
        self.published.extend(data)

    async def publish_data(self, payload, *a, **k):
        await asyncio.sleep(0)
        self.data.append(payload)

    def publish_data_ordered(self, payload, *a, **k):
        # Stand-in for RoomManager's FIFO publisher. Recording synchronously
        # preserves call order, which is the property it guarantees.
        self.data.append(payload)

    @property
    def queued_playout_ms(self):
        """Depth of the output source, modelled as draining at 1x real time.

        The real AudioSource holds what has been pushed and plays it out on a
        wall clock, so "how much is still queued" is pushed-minus-drained. The
        underrun guard reads this to decide whether the source needs bridging,
        so a stand-in that always answered 0 would make every test look like a
        permanent underrun. Tests that need a fixed depth still pin
        ``queued_ms`` directly and that wins.
        """
        if self.queued_ms is not None:
            return self.queued_ms
        if self._first_push is None:
            return 0.0
        pushed_ms = len(self.published) / (_TTS_SAMPLE_RATE * _BYTES_PER_SAMPLE) * 1000
        drained_ms = (time.perf_counter() - self._first_push) * 1000
        return max(0.0, pushed_ms - drained_ms)

    def clear_playout(self):
        self.clear_count += 1

    def flush_audio_queue(self):
        pass


class Chunk:
    def __init__(self, data: bytes):
        self.audio_data = data
        self.is_final = False
        self.chunk_index = 0


def silence(num_frames: int) -> list:
    return [Chunk(bytes(_PLAYOUT_FRAME_BYTES * num_frames))]


def make_pipeline(teleprompter=True):
    room = CapturingRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")
    pipe._teleprompter_enabled = teleprompter
    pipe._is_speaking = True
    return pipe, room


def progress_events(room):
    return [d for d in room.data if d.get("type") == "agent_speech_progress"]


META = {"transcript_id": "t1", "char_start": 10, "char_end": 20}


@pytest.mark.asyncio
async def test_speaking_then_spoken_emitted_with_offsets():
    pipe, room = make_pipeline()
    await pipe._play_prefetched(silence(10), meta=META)
    # Let scheduled publish tasks run.
    for _ in range(5):
        await asyncio.sleep(0)

    events = [e["data"] for e in progress_events(room)]
    states = [e["state"] for e in events]
    assert states == ["speaking", "spoken"]

    speaking = events[0]
    assert speaking["transcript_id"] == "t1"
    assert speaking["char_start"] == 10 and speaking["char_end"] == 20
    # Cursor maps into the sentence span and duration is the audible remainder.
    assert 10 <= speaking["spoken_char"] <= 20
    assert speaking["duration_ms"] > 0

    spoken = events[1]
    assert spoken["spoken_char"] == 20  # fully lit at end


@pytest.mark.asyncio
async def test_disabled_emits_nothing():
    pipe, room = make_pipeline(teleprompter=False)
    await pipe._play_prefetched(silence(10), meta=META)
    for _ in range(5):
        await asyncio.sleep(0)
    assert progress_events(room) == []


@pytest.mark.asyncio
async def test_no_meta_emits_nothing():
    pipe, room = make_pipeline()
    await pipe._play_prefetched(silence(10), meta=None)
    for _ in range(5):
        await asyncio.sleep(0)
    assert progress_events(room) == []


@pytest.mark.asyncio
async def test_interrupt_freezes_at_playhead():
    pipe, room = make_pipeline()
    # This test is about WHERE the highlight freezes, not about how much audio
    # the output source still holds — pin the depth so the suspend rewind (which
    # test_barge_in covers) does not move the playhead under it.
    room.queued_ms = 0.0
    task = asyncio.create_task(pipe._play_prefetched(silence(50), meta=META))

    # Push a few frames, then suspend mid-utterance.
    for _ in range(6):
        await asyncio.sleep(0)
    pipe.suspend_speech()
    for _ in range(5):
        await asyncio.sleep(0)

    events = [e["data"] for e in progress_events(room)]
    interrupted = [e for e in events if e["state"] == "interrupted"]
    assert len(interrupted) == 1
    frozen = interrupted[0]
    # Frozen strictly inside the sentence span — neither at start nor finished.
    assert 10 < frozen["spoken_char"] < 20

    # Clean up: commit so the suspended loop exits.
    pipe.commit_interrupt()
    for _ in range(5):
        await asyncio.sleep(0)
    task.cancel()


@pytest.mark.asyncio
async def test_resume_continues_same_message_after_rejected_barge_in():
    """A barge-in deemed unuseful: suspend freezes the cursor at the playhead,
    then resume continues on the SAME message from that exact point."""
    pipe, room = make_pipeline()
    task = asyncio.create_task(pipe._play_prefetched(silence(50), meta=META))

    # Play a few frames, then suspend (reflex) — freezes the highlight.
    for _ in range(6):
        await asyncio.sleep(0)
    pipe.suspend_speech()
    for _ in range(3):
        await asyncio.sleep(0)

    # Barge-in dismissed → resume the same utterance.
    pipe.resume_speech()
    for _ in range(5):
        await asyncio.sleep(0)

    events = [e["data"] for e in progress_events(room)]
    states = [e["state"] for e in events]
    assert states[0] == "speaking"          # initial playback
    assert "interrupted" in states          # suspend froze the cursor

    i = states.index("interrupted")
    frozen = events[i]
    resume_states = states[i + 1:]
    assert "speaking" in resume_states      # resume re-emits 'speaking'
    resumed = events[i + 1 + resume_states.index("speaking")]

    # Continues on the same message, from the frozen playhead — not restarted —
    # with audio still left to speak.
    assert resumed["transcript_id"] == frozen["transcript_id"]
    assert resumed["spoken_char"] == frozen["spoken_char"]
    assert 10 <= resumed["spoken_char"] <= 20
    assert resumed["duration_ms"] > 0

    # Clean up: commit so the suspended/playing loop exits.
    pipe.commit_interrupt()
    for _ in range(5):
        await asyncio.sleep(0)
    task.cancel()


def test_default_on_when_env_unset(monkeypatch):
    monkeypatch.delenv("STELLA_TELEPROMPTER_ENABLED", raising=False)
    room = CapturingRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")
    assert pipe._teleprompter_enabled is True   # on by default
    assert pipe._teleprompter_env_locked is False


def test_env_false_forces_off(monkeypatch):
    monkeypatch.setenv("STELLA_TELEPROMPTER_ENABLED", "false")
    room = CapturingRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")
    assert pipe._teleprompter_enabled is False
    assert pipe._teleprompter_env_locked is True


def test_enable_teleprompter_from_declaration(monkeypatch):
    monkeypatch.delenv("STELLA_TELEPROMPTER_ENABLED", raising=False)
    pipe, _ = make_pipeline(teleprompter=False)
    pipe._teleprompter_env_locked = False
    assert pipe._teleprompter_enabled is False
    pipe.enable_teleprompter()
    assert pipe._teleprompter_enabled is True


def test_env_override_locks_teleprompter_off():
    # An explicit env value wins over the agent declaration.
    pipe, _ = make_pipeline(teleprompter=False)
    pipe._teleprompter_enabled = False
    pipe._teleprompter_env_locked = True  # operator set STELLA_TELEPROMPTER_ENABLED=false
    pipe.enable_teleprompter()
    assert pipe._teleprompter_enabled is False  # declaration did not override


@pytest.mark.asyncio
async def test_enqueue_sentence_stores_offsets_in_queue():
    pipe, _ = make_pipeline()
    # Park a dummy worker so enqueue_sentence doesn't spawn a real one that
    # would race us for the queued items.
    pipe._speech_worker_task = asyncio.create_task(asyncio.sleep(3600))
    try:
        pipe.enqueue_sentence("Hello there.", transcript_id="t9", char_start=3, char_end=15)
        sentence, source, meta = pipe._speech_queue.get_nowait()
        assert sentence == "Hello there."
        assert meta == {"transcript_id": "t9", "char_start": 3, "char_end": 15}

        # Without offsets the queue entry carries no meta.
        pipe.enqueue_sentence("No offsets.")
        _, _, meta2 = pipe._speech_queue.get_nowait()
        assert meta2 is None
    finally:
        pipe._speech_worker_task.cancel()
