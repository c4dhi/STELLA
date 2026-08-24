"""Tests for barge-in suspend / resume / commit playback primitives."""

import asyncio

import pytest

from stella_agent_sdk.audio.pipeline import (
    AudioPipeline,
    _PLAYOUT_FRAME_BYTES,
)
from stella_agent_sdk.messages.types import BargeInDecision
from stella_agent_sdk.services.stt_client import TranscriptEvent


class FakeRoom:
    """Minimal RoomManager stand-in for exercising the playback loop."""

    audio_sample_rate = 48000
    current_audio_speaker = None

    def __init__(self):
        self.published = bytearray()
        self.clear_count = 0
        self.queued_ms = 0.0
        self.data_handler = None
        self.captured = []  # every publish_data payload, for envelope assertions

    def on_data_received(self, cb):
        self.data_handler = cb

    async def publish_audio(self, data: bytes):
        # Yield to the event loop each frame so a concurrent suspend() can
        # interleave mid-utterance (real publish_audio awaits the network).
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

    async def subscribe_to_audio(self):
        # A couple of dummy frames, then end (the fake STT ignores them).
        for _ in range(2):
            await asyncio.sleep(0)
            yield b"\x00\x00"


class FakeSTT:
    """Yields a scripted sequence of transcript events, ignoring the audio."""

    def __init__(self, events):
        self.events = events

    async def stream_transcribe(self, audio_iter, **kwargs):
        for e in self.events:
            yield e
            await asyncio.sleep(0)


class FakeTTSClient:
    """Yields a fixed number of silent PCM chunks for synthesis."""

    async def synthesize_stream(self, **kwargs):
        for _ in range(12):
            await asyncio.sleep(0)
            yield Chunk(bytes(_PLAYOUT_FRAME_BYTES))


def _event(text, is_final, speech_started=False):
    return TranscriptEvent(
        text=text,
        is_final=is_final,
        transcript_id="t1",
        participant_id="human",
        confidence=1.0,
        timestamp_ms=0,
        speech_started=speech_started,
    )


class Chunk:
    def __init__(self, data: bytes):
        self.audio_data = data
        self.is_final = False
        self.chunk_index = 0


def make_pipeline():
    room = FakeRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")
    return pipe, room


def silence(num_frames: int) -> list:
    """One chunk containing num_frames worth of silent PCM."""
    return [Chunk(bytes(_PLAYOUT_FRAME_BYTES * num_frames))]


@pytest.mark.asyncio
async def test_plays_full_utterance_without_barge_in():
    pipe, room = make_pipeline()
    pipe._is_speaking = True
    chunks = silence(10)
    await pipe._play_prefetched(chunks)
    assert len(room.published) == _PLAYOUT_FRAME_BYTES * 10
    assert pipe._cur_audio == b""  # held audio cleared on completion


@pytest.mark.asyncio
async def test_suspend_pauses_and_clears_playout():
    pipe, room = make_pipeline()
    pipe._is_speaking = True
    task = asyncio.create_task(pipe._play_prefetched(silence(50)))

    # Let a few frames push, then suspend mid-utterance.
    for _ in range(5):
        await asyncio.sleep(0)
    pipe.suspend_speech()

    assert pipe.is_suspended is True
    assert room.clear_count == 1            # output buffer flushed

    # At most one in-flight frame may land after suspend (it had already passed
    # the gate check). Let it settle, then confirm playback stays paused.
    for _ in range(5):
        await asyncio.sleep(0)
    settled = len(room.published)
    for _ in range(10):
        await asyncio.sleep(0)
    assert len(room.published) == settled   # stays paused, no more frames
    assert not task.done()

    # Resume → playback finishes the rest of the utterance.
    pipe.resume_speech()
    await asyncio.wait_for(task, timeout=1.0)
    assert len(room.published) >= _PLAYOUT_FRAME_BYTES * 50


@pytest.mark.asyncio
async def test_suspend_rewinds_playhead_by_unplayed_buffer():
    pipe, room = make_pipeline()
    pipe._is_speaking = True
    task = asyncio.create_task(pipe._play_prefetched(silence(50)))
    for _ in range(10):
        await asyncio.sleep(0)

    cursor_before = pipe._cur_cursor
    # Pretend 100ms (=2400 samples =4800 bytes) is buffered-but-unplayed.
    room.queued_ms = 100.0
    pipe.suspend_speech()
    # Playhead rewound by the unplayed tail so resume replays it (no gap).
    assert pipe._cur_cursor < cursor_before
    assert cursor_before - pipe._cur_cursor == int(100.0 * 24000 / 1000) * 2

    pipe.resume_speech()
    await asyncio.wait_for(task, timeout=1.0)


@pytest.mark.asyncio
async def test_commit_aborts_playback_and_drains_queue():
    pipe, room = make_pipeline()
    pipe._is_speaking = True
    # Queue some pending sentences that must be discarded on commit.
    pipe._speech_queue.put_nowait(("next one", "response"))
    pipe._speech_queue.put_nowait(("and another", "response"))

    task = asyncio.create_task(pipe._play_prefetched(silence(50)))
    for _ in range(5):
        await asyncio.sleep(0)
    pipe.suspend_speech()
    for _ in range(3):
        await asyncio.sleep(0)

    pipe.commit_interrupt()
    await asyncio.wait_for(task, timeout=1.0)

    assert pipe._speech_queue.empty()       # pending sentences dropped
    assert pipe._stop_speaking_event.is_set()
    assert pipe._cur_audio == b""


@pytest.mark.asyncio
async def test_stop_speaking_is_hard_stop():
    pipe, room = make_pipeline()
    pipe._is_speaking = True
    pipe._speech_queue.put_nowait(("queued", "response"))
    task = asyncio.create_task(pipe._play_prefetched(silence(50)))
    for _ in range(5):
        await asyncio.sleep(0)

    await pipe.stop_speaking()
    await asyncio.wait_for(task, timeout=1.0)

    assert pipe._stop_speaking_event.is_set()
    assert pipe._speech_queue.empty()
    assert room.clear_count >= 1


@pytest.mark.asyncio
async def test_suspend_is_noop_when_not_speaking():
    pipe, room = make_pipeline()
    # Not speaking → suspend does nothing.
    pipe.suspend_speech()
    assert room.clear_count == 0
    assert pipe.is_suspended is False


# ── Resolution loop: decider → resume / commit ────────────────────────────


@pytest.mark.asyncio
async def test_resolve_resume_continues_playback():
    pipe, room = make_pipeline()
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.RESUME))
    pipe._is_speaking = True
    task = asyncio.create_task(pipe._play_prefetched(silence(50)))
    for _ in range(5):
        await asyncio.sleep(0)

    # Detect + suspend (as _handle_speech_started would).
    pipe._barge_in_active = True
    pipe.suspend_speech()
    assert pipe.is_suspended is True

    await pipe._resolve_barge_in("mhm")
    # RESUME → playback un-paused, no new turn injected.
    assert pipe.is_suspended is False
    assert pipe._transcript_queue.empty()
    assert pipe._pending_barge_in is None
    await asyncio.wait_for(task, timeout=1.0)
    assert len(room.published) >= _PLAYOUT_FRAME_BYTES * 50


@pytest.mark.asyncio
async def test_resolve_commit_injects_new_turn():
    pipe, room = make_pipeline()
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.COMMIT))
    pipe._is_speaking = True
    pipe._speech_queue.put_nowait(("later sentence", "response"))
    task = asyncio.create_task(pipe._play_prefetched(silence(50)))
    for _ in range(5):
        await asyncio.sleep(0)

    pipe._barge_in_active = True
    pipe.suspend_speech()
    await pipe._resolve_barge_in("wait, stop")
    await asyncio.wait_for(task, timeout=1.0)

    # COMMIT → playback aborted, queue drained, transcript injected as new turn.
    assert pipe._stop_speaking_event.is_set()
    assert pipe._speech_queue.empty()
    injected = pipe._pending_barge_in
    assert injected is not None
    assert injected.text == "wait, stop"
    assert injected.is_final is True
    assert injected.is_barge_in is True


@pytest.mark.asyncio
async def test_resolve_defaults_to_commit_when_no_decider():
    pipe, room = make_pipeline()
    pipe._is_speaking = True
    task = asyncio.create_task(pipe._play_prefetched(silence(30)))
    for _ in range(3):
        await asyncio.sleep(0)
    pipe._barge_in_active = True
    pipe.suspend_speech()
    await pipe._resolve_barge_in("do something")
    await asyncio.wait_for(task, timeout=1.0)
    assert pipe._stop_speaking_event.is_set()
    assert pipe._pending_barge_in is not None
    assert pipe._pending_barge_in.is_barge_in is True


@pytest.mark.asyncio
async def test_resolve_commits_when_decider_raises():
    pipe, room = make_pipeline()

    async def boom(_t):
        raise RuntimeError("decider down")

    pipe.set_barge_in_decider(boom)
    pipe._is_speaking = True
    task = asyncio.create_task(pipe._play_prefetched(silence(30)))
    for _ in range(3):
        await asyncio.sleep(0)
    pipe._barge_in_active = True
    pipe.suspend_speech()
    await pipe._resolve_barge_in("x")
    await asyncio.wait_for(task, timeout=1.0)
    assert pipe._stop_speaking_event.is_set()  # failure → commit, never stuck


def _async(value):
    async def _coro():
        return value
    return _coro()


@pytest.mark.asyncio
async def test_commit_on_last_sentence_does_not_deadlock_worker():
    # Committing a barge-in while the worker is on its LAST sentence (no
    # prefetch in flight) must not hang the worker — the injected turn must
    # become available and flush must return.
    pipe, room = make_pipeline()
    pipe._tts = FakeTTSClient()
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.COMMIT))

    pipe.enqueue_sentence("the only sentence")  # single sentence → last sentence
    for _ in range(60):                          # wait until audio is flowing
        await asyncio.sleep(0)
        if pipe._audio_active:
            break
    assert pipe._audio_active is True

    # Barge-in: suspend, then commit (as detection + resolve would).
    pipe._barge_in_active = True
    pipe.suspend_speech()
    await pipe._resolve_barge_in("wait stop")

    # The worker must exit cleanly — flush must not hang (the bug deadlocked here).
    await asyncio.wait_for(pipe.flush_speech_queue(), timeout=1.0)
    injected = pipe._pending_barge_in
    assert injected is not None
    assert injected.is_barge_in is True
    assert injected.text == "wait stop"


# ── Detection loop: listens during speech, threshold-gated, resolves ──────


async def _run_detection(pipe, events, audio_active=True):
    """Drive the STT loop with scripted events while the agent is 'speaking'.

    audio_active simulates whether the agent is *audibly* talking (frames
    flowing) — a barge-in may only start when this is True.
    """
    pipe._barge_in_enabled = True
    pipe._is_speaking = True
    pipe._audio_active = audio_active
    pipe._is_listening = True
    pipe.close_transcript_gate()          # gate closed == agent speaking
    pipe._stt = FakeSTT(events)
    await pipe._run_stt_stream_inner()
    await asyncio.sleep(0.05)             # let the resolve task finish


@pytest.mark.asyncio
async def test_detection_listens_and_commits_real_interruption():
    pipe, room = make_pipeline()
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.COMMIT))
    await _run_detection(pipe, [
        _event("wait", is_final=False),          # >= 3 chars → suspend
        _event("wait stop", is_final=True),      # final → resolve → COMMIT
    ])
    assert room.clear_count >= 1                  # playout flushed on suspend
    injected = pipe._pending_barge_in
    assert injected is not None
    assert injected.is_barge_in is True
    assert injected.text == "wait stop"
    assert pipe._stop_speaking_event.is_set()     # committed → playback aborted


@pytest.mark.asyncio
async def test_detection_ignores_below_threshold_noise():
    pipe, room = make_pipeline()
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.COMMIT))
    await _run_detection(pipe, [
        _event("a", is_final=False),             # < 3 chars
        _event("uh", is_final=True),             # < 3 chars → never triggers
    ])
    assert pipe.is_suspended is False             # agent never paused
    assert room.clear_count == 0
    assert pipe._transcript_queue.empty()         # no new turn injected
    assert pipe._pending_barge_in is None


@pytest.mark.asyncio
async def test_detection_skipped_when_agent_not_audibly_talking():
    # Agent's worker is active (gate closed) but no audio frames are flowing
    # yet (e.g. synthesizing). A user utterance must NOT trigger a barge-in.
    pipe, room = make_pipeline()
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.COMMIT))
    await _run_detection(pipe, [
        _event("hello there, how are you", is_final=True),
    ], audio_active=False)
    assert pipe.is_suspended is False        # never suspended
    assert room.clear_count == 0             # never flushed playout
    assert pipe._transcript_queue.empty()    # no barge-in turn injected
    assert pipe._pending_barge_in is None


@pytest.mark.asyncio
async def test_detection_resume_keeps_speaking():
    pipe, room = make_pipeline()
    pipe.set_barge_in_decider(lambda t: _async(BargeInDecision.RESUME))
    await _run_detection(pipe, [
        _event("hold on", is_final=True),        # >= 3 → suspend → RESUME
    ])
    assert pipe._transcript_queue.empty()         # resume → no new turn
    assert pipe._pending_barge_in is None
    assert pipe._play_allowed.is_set()            # playback re-allowed
    assert pipe._barge_in_active is False         # re-armed for next time


# ── Enablement: agent declaration vs env override ─────────────────────────


def test_enable_barge_in_from_agent_declaration(monkeypatch):
    monkeypatch.delenv("BARGE_IN_ENABLED", raising=False)
    pipe, _ = make_pipeline()
    assert pipe.barge_in_enabled is False   # off until the agent declares it
    pipe.enable_barge_in()
    assert pipe.barge_in_enabled is True


def test_env_override_forces_off_despite_declaration(monkeypatch):
    monkeypatch.setenv("BARGE_IN_ENABLED", "false")
    pipe, _ = make_pipeline()
    assert pipe.barge_in_enabled is False
    pipe.enable_barge_in()  # operator override wins — stays off
    assert pipe.barge_in_enabled is False


def test_env_override_forces_on(monkeypatch):
    monkeypatch.setenv("BARGE_IN_ENABLED", "true")
    pipe, _ = make_pipeline()
    assert pipe.barge_in_enabled is True


# ── Client silencing signal: decoupled from the teleprompter (A) ──────────


def _playback_states(room):
    return [
        d["data"]["state"]
        for d in room.captured
        if isinstance(d, dict) and d.get("type") == "agent_playback"
    ]


@pytest.mark.asyncio
async def test_playback_state_emitted_with_teleprompter_off():
    """Client silencing must fire even when the teleprompter is disabled — it's
    a barge-in concern, not a highlight one (would otherwise no-op and the agent
    stays audible after a barge-in)."""
    pipe, room = make_pipeline()
    pipe._barge_in_enabled = True
    pipe._teleprompter_enabled = False     # teleprompter OFF
    pipe._is_speaking = True

    task = asyncio.create_task(pipe._play_prefetched(silence(50)))
    for _ in range(5):
        await asyncio.sleep(0)
    pipe.suspend_speech()
    for _ in range(5):
        await asyncio.sleep(0)

    # An agent_playback "interrupted" must have been published to silence the
    # client, despite no agent_speech_progress (teleprompter) envelope.
    assert "interrupted" in _playback_states(room)
    assert not any(d.get("type") == "agent_speech_progress" for d in room.captured)

    pipe.resume_speech()
    await asyncio.wait_for(task, timeout=1.0)
    assert _playback_states(room)[-1] == "speaking"   # un-silenced on resume


@pytest.mark.asyncio
async def test_no_playback_state_when_barge_in_disabled():
    """With barge-in off there is no interruption to silence — emit nothing."""
    pipe, room = make_pipeline()
    pipe._barge_in_enabled = False
    pipe._is_speaking = True
    await asyncio.wait_for(pipe._play_prefetched(silence(20)), timeout=1.0)
    for _ in range(3):
        await asyncio.sleep(0)
    assert _playback_states(room) == []


# ── Suspension watchdog: never-resolved barge-in auto-resumes (B) ─────────


@pytest.mark.asyncio
async def test_suspend_watchdog_auto_resumes_when_never_resolved():
    """If STT never delivers a final after the partial that triggered the
    suspend, _resolve_barge_in never runs. The watchdog must auto-resume so
    playback does not stay suspended (silent) forever."""
    pipe, room = make_pipeline()
    pipe._barge_in_enabled = True
    pipe._is_speaking = True
    pipe._barge_in_suspend_timeout_s = 0.05    # fire fast
    pipe._barge_in_active = True               # as detection would have set it

    task = asyncio.create_task(pipe._play_prefetched(silence(80)))
    for _ in range(5):
        await asyncio.sleep(0)
    pipe.suspend_speech()
    assert pipe.is_suspended is True

    # No final transcript ever arrives — only the watchdog can recover.
    await asyncio.sleep(0.12)

    assert pipe._play_allowed.is_set()         # auto-resumed
    assert pipe.is_suspended is False
    assert pipe._barge_in_active is False      # flags cleared → detection re-armed
    assert "speaking" in _playback_states(room)
    await asyncio.wait_for(task, timeout=1.0)  # utterance plays to the end


@pytest.mark.asyncio
async def test_suspend_watchdog_disarmed_on_normal_resume():
    """A timely resolution cancels the watchdog so it never double-fires."""
    pipe, room = make_pipeline()
    pipe._barge_in_enabled = True
    pipe._is_speaking = True
    pipe._barge_in_suspend_timeout_s = 0.05

    task = asyncio.create_task(pipe._play_prefetched(silence(80)))
    for _ in range(5):
        await asyncio.sleep(0)
    pipe.suspend_speech()
    pipe.resume_speech()                        # resolved before the watchdog
    assert pipe._barge_in_watchdog_task is None # disarmed

    await asyncio.sleep(0.12)                    # let the old window elapse
    await asyncio.wait_for(task, timeout=1.0)    # completes cleanly, no re-fire
