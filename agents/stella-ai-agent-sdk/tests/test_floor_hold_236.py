"""Regression tests for #236 — user speech captured during agent TTS must not
be processed as a user turn after the agent finishes speaking.

These exercise the turn-based path (barge-in OFF, the stopgap behaviour the
ticket describes): while the agent holds the floor (transcript gate closed),
final transcripts arriving from STT are dropped, never queued — so when TTS
ends there is no leftover "cached" user turn waiting to be processed.

The smart barge-in path (barge-in ON) deliberately does NOT drop overlap — it
routes it to on_barge_in() — and is covered by test_barge_in.py. When #15 fully
supersedes this stopgap, these tests (and the drop branch they pin) go away.
"""

import asyncio

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.services.stt_client import TranscriptEvent


class FakeRoom:
    """Minimal RoomManager stand-in for driving _run_stt_stream_inner."""

    audio_sample_rate = 48000
    current_audio_speaker = None

    def __init__(self):
        self.captured = []

    def on_data_received(self, cb):
        self.data_handler = cb

    async def publish_data(self, data, *a, **k):
        self.captured.append(data)
        await asyncio.sleep(0)

    def publish_data_ordered(self, data, *a, **k):
        # Stand-in for RoomManager's FIFO publisher. Recording synchronously
        # preserves call order, which is the property it guarantees.
        self.captured.append(data)

    def flush_audio_queue(self):
        pass

    def get_participant_name(self, identity):
        return identity

    async def subscribe_to_audio(self):
        # A couple of dummy frames, then the source ends. The fake STT ignores
        # the audio entirely; this just lets the audio generator drain.
        for _ in range(2):
            await asyncio.sleep(0)
            yield b"\x00\x00"


class FakeSTT:
    """Yields a scripted sequence of transcript events, ignoring the audio."""

    is_connected = True

    def __init__(self, events):
        self.events = events

    async def stream_transcribe(self, audio_iter, **kwargs):
        # Drain the audio generator so its gate-skip branch actually executes,
        # then emit the scripted transcripts.
        async for _ in audio_iter:
            pass
        for e in self.events:
            yield e
            await asyncio.sleep(0)


def _final(text):
    return TranscriptEvent(
        text=text,
        is_final=True,
        transcript_id="t1",
        participant_id="human",
        confidence=1.0,
        timestamp_ms=0,
        speech_started=False,
    )


def make_pipeline():
    room = FakeRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")
    pipe._is_listening = True
    # Drop the debounce delay so a queued final lands synchronously — keeps the
    # positive control deterministic without sleeping for the debounce window.
    pipe._debounce_window_ms = 0
    return pipe, room


@pytest.mark.asyncio
async def test_overlap_final_dropped_while_agent_speaking():
    """AC#1: a final transcript that arrives while the agent holds the floor
    (gate closed, TTS on, barge-in off) is never added to the transcript queue."""
    pipe, _room = make_pipeline()
    assert pipe._tts_enabled is True
    assert pipe._barge_in_enabled is False

    pipe.close_transcript_gate()  # agent is speaking
    pipe._stt = FakeSTT([_final("no wait I meant something else")])

    await pipe._run_stt_stream_inner()

    # Dropped, not queued — and not sitting in the debounce buffer either.
    assert pipe._transcript_queue.empty()
    assert pipe._pending_transcript is None


@pytest.mark.asyncio
async def test_no_cached_turn_survives_gate_reopen():
    """AC#2: after the agent finishes (gate reopens) no leftover user turn from
    the speaking window is delivered to the agent loop."""
    pipe, _room = make_pipeline()
    pipe.close_transcript_gate()
    pipe._stt = FakeSTT([_final("talking over the agent")])

    await pipe._run_stt_stream_inner()
    pipe.open_transcript_gate()  # agent finished speaking

    assert pipe._transcript_queue.empty()
    assert pipe._pending_barge_in is None


@pytest.mark.asyncio
async def test_positive_control_open_gate_queues_final():
    """Control: with the floor open (agent not speaking) the SAME final IS
    queued — proving it is the closed gate, not some unrelated filter, that
    drops overlap speech above."""
    pipe, _room = make_pipeline()
    # Gate is open by default; agent is not speaking.
    assert pipe.is_gate_closed is False
    pipe._stt = FakeSTT([_final("a real user turn")])

    await pipe._run_stt_stream_inner()

    assert pipe._transcript_queue.qsize() == 1
    queued = pipe._transcript_queue.get_nowait()
    assert queued.text == "a real user turn"
