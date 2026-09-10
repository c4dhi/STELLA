"""Tests for text-based interruption / barge-in (#278).

A typed message that arrives while the agent is still generating or speaking
must interrupt the current turn — reusing the voice barge-in plumbing (suspend /
resume / commit) plus a generation-level halt for the TTS-disabled case — rather
than sitting in the queue until the turn ends (the deferred-processing problem,
#236). The agent runs the SAME decider as the voice path to choose RESUME vs
COMMIT (AC#2), and input stays serialized (AC#3).
"""

import asyncio
import json

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline, _PLAYOUT_FRAME_BYTES
from stella_agent_sdk.messages.types import BargeInDecision
from stella_agent_sdk.services.stt_client import TranscriptEvent


class FakeRoom:
    """Minimal RoomManager stand-in (mirrors test_barge_in.py)."""

    audio_sample_rate = 48000
    current_audio_speaker = None

    def __init__(self):
        self.published = bytearray()
        self.clear_count = 0
        self.queued_ms = 0.0
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
        # Stand-in for RoomManager's FIFO publisher. Recording synchronously
        # preserves call order, which is the property it guarantees.
        self.captured.append(data)

    def flush_audio_queue(self):
        pass

    @property
    def queued_playout_ms(self):
        return self.queued_ms

    def clear_playout(self):
        self.clear_count += 1

    def get_participant_name(self, identity):
        return identity


def make_pipeline():
    room = FakeRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")
    pipe._barge_in_enabled = True
    return pipe, room


def silence(num_frames: int) -> list:
    return [Chunk(bytes(_PLAYOUT_FRAME_BYTES * num_frames))]


class Chunk:
    def __init__(self, data: bytes):
        self.audio_data = data
        self.is_final = False
        self.chunk_index = 0


def _text_event(text, participant_id="alice"):
    return TranscriptEvent(
        text=text,
        is_final=True,
        transcript_id="text1",
        participant_id=participant_id,
        confidence=1.0,
        timestamp_ms=0,
        speech_started=False,
    )


def _async(value):
    async def _coro():
        return value
    return _coro()


def _user_text_envelope(text, participant_id="alice", correlation_id="c1"):
    return json.dumps({
        "type": "user_text",
        "data": {"text": text, "correlation_id": correlation_id},
        "participant_id": participant_id,
        "transcript_id": "env1",
    }).encode("utf-8")


# ── Generation-control primitives (used by run_audio_loop) ────────────────


def test_begin_turn_clears_stale_state():
    pipe, _ = make_pipeline()
    pipe.request_turn_suspend()       # no turn active → no-op
    assert pipe.is_turn_suspended is False
    pipe.begin_turn()
    assert pipe.is_turn_active is True
    pipe.request_turn_suspend()       # now allowed
    assert pipe.is_turn_suspended is True
    pipe.request_turn_abort()
    assert pipe.is_turn_aborted is True
    pipe.begin_turn()                 # a fresh turn must start clean
    assert pipe.is_turn_suspended is False
    assert pipe.is_turn_aborted is False


@pytest.mark.asyncio
async def test_await_turn_release_returns_true_on_resume():
    pipe, _ = make_pipeline()
    pipe.begin_turn()
    pipe.request_turn_suspend()
    waiter = asyncio.create_task(pipe.await_turn_release())
    await asyncio.sleep(0)
    assert not waiter.done()           # blocked while suspended
    pipe.request_turn_resume()
    assert await asyncio.wait_for(waiter, timeout=1.0) is True


@pytest.mark.asyncio
async def test_await_turn_release_returns_false_on_abort():
    pipe, _ = make_pipeline()
    pipe.begin_turn()
    pipe.request_turn_suspend()
    waiter = asyncio.create_task(pipe.await_turn_release())
    await asyncio.sleep(0)
    pipe.request_turn_abort()
    assert await asyncio.wait_for(waiter, timeout=1.0) is False


# ── Text barge-in while the agent is audibly speaking (TTS on) ────────────


@pytest.mark.asyncio
async def test_text_commit_while_speaking_injects_new_turn():
    pipe, room = make_pipeline()
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.COMMIT))
    pipe.begin_turn()
    pipe._is_speaking = True
    pipe._speech_queue.put_nowait(("later sentence", "response"))
    task = asyncio.create_task(pipe._play_prefetched(silence(50)))
    for _ in range(5):
        await asyncio.sleep(0)

    await pipe._handle_text_barge_in(_text_event("actually, change of plan"))
    await asyncio.wait_for(task, timeout=1.0)

    # Audio stopped, queue drained, typed text delivered as the next turn.
    assert pipe._stop_speaking_event.is_set()
    assert pipe._speech_queue.empty()
    injected = pipe._pending_barge_in
    assert injected is not None
    assert injected.text == "actually, change of plan"
    assert injected.is_barge_in is True
    assert injected.participant_id == "alice"
    # Generation halt was requested too (covers a still-streaming turn).
    assert pipe.is_turn_aborted is True


@pytest.mark.asyncio
async def test_text_resume_while_speaking_keeps_talking_and_drops_text():
    pipe, room = make_pipeline()
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.RESUME))
    pipe.begin_turn()
    pipe._is_speaking = True
    task = asyncio.create_task(pipe._play_prefetched(silence(50)))
    for _ in range(5):
        await asyncio.sleep(0)

    await pipe._handle_text_barge_in(_text_event("go on"))

    # RESUME → no new turn, playback re-allowed, generation not aborted.
    assert pipe._pending_barge_in is None
    assert pipe._transcript_queue.empty()
    assert pipe._play_allowed.is_set()
    assert pipe.is_turn_aborted is False
    assert pipe.is_turn_suspended is False
    await asyncio.wait_for(task, timeout=1.0)
    assert len(room.published) >= _PLAYOUT_FRAME_BYTES * 50


# ── Text barge-in while generating, TTS disabled (AC#4 / AC#5) ─────────────


@pytest.mark.asyncio
async def test_text_commit_while_generating_tts_off_halts_generation():
    """With TTS disabled the agent never speaks, so there is no audio to stop —
    the interruption must halt the in-flight generation and hand over the new
    turn (block only until the answer is generated)."""
    pipe, room = make_pipeline()
    pipe._tts_enabled = False
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.COMMIT))
    pipe.begin_turn()                  # generating, not speaking
    assert pipe._is_speaking is False

    await pipe._handle_text_barge_in(_text_event("stop, new question"))

    assert pipe.is_turn_aborted is True            # generation will halt
    injected = pipe._pending_barge_in
    assert injected is not None
    assert injected.text == "stop, new question"
    assert injected.is_barge_in is True
    assert room.published == bytearray()           # nothing was ever spoken


@pytest.mark.asyncio
async def test_text_resume_while_generating_releases_suspend():
    pipe, _ = make_pipeline()
    pipe._tts_enabled = False
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.RESUME))
    pipe.begin_turn()

    await pipe._handle_text_barge_in(_text_event("mhm"))

    assert pipe.is_turn_aborted is False
    assert pipe.is_turn_suspended is False         # released → generation continues
    assert pipe._pending_barge_in is None


@pytest.mark.asyncio
async def test_text_barge_in_defaults_to_commit_when_decider_raises():
    pipe, _ = make_pipeline()

    async def boom(_t):
        raise RuntimeError("decider down")

    pipe.set_barge_in_decider(boom)
    pipe.begin_turn()
    await pipe._handle_text_barge_in(_text_event("x"))
    assert pipe.is_turn_aborted is True            # failure → commit, never stuck
    assert pipe._pending_barge_in is not None


# ── Routing & serialization via _handle_data_message (AC#3) ───────────────


@pytest.mark.asyncio
async def test_data_message_routes_to_barge_in_when_turn_active():
    pipe, room = make_pipeline()
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.COMMIT))
    pipe.begin_turn()
    pipe._is_speaking = True

    pipe._handle_data_message("alice", _user_text_envelope("interrupt me"))
    for _ in range(10):                # let the spawned tasks run
        await asyncio.sleep(0)

    # Delivered as a barge-in turn (out-of-band), not left in the queue.
    assert pipe._pending_barge_in is not None
    assert pipe._pending_barge_in.text == "interrupt me"
    assert pipe._transcript_queue.empty()


@pytest.mark.asyncio
async def test_data_message_enqueues_when_idle():
    pipe, _ = make_pipeline()
    # barge-in enabled but no turn in flight → a normal next turn, not a barge-in.
    pipe._handle_data_message("alice", _user_text_envelope("hello"))
    for _ in range(5):
        await asyncio.sleep(0)
    assert pipe._pending_barge_in is None
    assert pipe._transcript_queue.qsize() == 1
    assert pipe._transcript_queue.get_nowait().text == "hello"


@pytest.mark.asyncio
async def test_data_message_defers_when_barge_in_disabled():
    pipe, _ = make_pipeline()
    pipe._barge_in_enabled = False     # same toggle as voice
    pipe.begin_turn()
    pipe._is_speaking = True
    pipe._handle_data_message("alice", _user_text_envelope("typed during speech"))
    for _ in range(5):
        await asyncio.sleep(0)
    # No interruption: falls back to today's queue-and-defer behaviour.
    assert pipe._pending_barge_in is None
    assert pipe._transcript_queue.qsize() == 1


@pytest.mark.asyncio
async def test_rapid_sends_do_not_run_concurrent_resolutions():
    """A second message arriving while the first is still resolving must not
    spawn a second decider — it queues as a normal next turn (no interleave)."""
    pipe, _ = make_pipeline()
    pipe.begin_turn()
    pipe._is_speaking = True

    decider_calls = []

    async def slow_decider(t):
        decider_calls.append(t)
        await asyncio.sleep(0.05)
        return BargeInDecision.COMMIT

    pipe.set_barge_in_decider(slow_decider)

    # First send → starts resolving (sets _barge_in_resolving while awaiting).
    pipe._handle_data_message("alice", _user_text_envelope("first"))
    for _ in range(3):
        await asyncio.sleep(0)
    assert pipe._barge_in_resolving is True

    # Second send mid-resolution → must NOT start another decider; queues instead.
    pipe._handle_data_message("alice", _user_text_envelope("second"))
    for _ in range(3):
        await asyncio.sleep(0)
    assert len(decider_calls) == 1
    assert pipe._transcript_queue.qsize() == 1

    await asyncio.sleep(0.1)            # let the first resolution finish
    assert pipe._pending_barge_in.text == "first"


@pytest.mark.asyncio
async def test_rapid_sends_same_loop_iteration_single_decider():
    """Two data frames delivered back-to-back in the SAME loop iteration (no
    await between) must not both pass the guard. The flag is claimed
    synchronously in _handle_data_message, so the second frame queues instead of
    spawning a second concurrent decider (the TOCTOU the sleep(0) variant misses)."""
    pipe, _ = make_pipeline()
    pipe.begin_turn()
    pipe._is_speaking = True

    decider_calls = []

    async def decider(t):
        decider_calls.append(t)
        return BargeInDecision.COMMIT

    pipe.set_barge_in_decider(decider)

    # Fire both synchronously — no await in between (same event-loop tick).
    pipe._handle_data_message("alice", _user_text_envelope("first"))
    pipe._handle_data_message("alice", _user_text_envelope("second"))

    # The second was claimed-out synchronously before any task ran.
    assert pipe._barge_in_resolving is True
    assert pipe._transcript_queue.qsize() == 1
    assert pipe._transcript_queue.get_nowait().text == "second"

    for _ in range(10):
        await asyncio.sleep(0)
    assert len(decider_calls) == 1            # only one decider ever ran
    assert pipe._pending_barge_in.text == "first"


@pytest.mark.asyncio
async def test_text_during_voice_suspend_does_not_run_concurrent_decider():
    """A typed message arriving while a VOICE barge-in is mid-resolution
    (_barge_in_active set, awaiting the STT final) must queue, not race a second
    decider against the voice resolution."""
    pipe, _ = make_pipeline()
    pipe.begin_turn()
    pipe._is_speaking = True
    pipe._barge_in_active = True               # voice suspend in progress

    decider_calls = []

    async def decider(t):
        decider_calls.append(t)
        return BargeInDecision.COMMIT

    pipe.set_barge_in_decider(decider)

    pipe._handle_data_message("alice", _user_text_envelope("typed mid-voice"))
    for _ in range(10):
        await asyncio.sleep(0)

    assert decider_calls == []                 # text decider never ran
    assert pipe._transcript_queue.qsize() == 1
    assert pipe._transcript_queue.get_nowait().text == "typed mid-voice"
