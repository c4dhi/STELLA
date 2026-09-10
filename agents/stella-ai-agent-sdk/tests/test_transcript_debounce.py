"""The transcript debounce is off by default, and still works when asked for.

The window used to default to 300ms, which was a fixed tax on every turn: the
sleep sits AFTER _begin_turn_analytics sets stt_end, so it came straight off
time-to-first-audio. It bought nothing, because neither STT provider in this
tree can emit two finals inside a window that small — both wait out a fixed
span of silence before finalising and reset to IDLE afterwards, putting the
floor between consecutive finals above 1s.

These pin both halves: the default no longer delays a turn, and the
aggregation path is still intact for a provider that needs it.
"""

import asyncio

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.services.stt_client import TranscriptEvent


class FakeRoom:
    """Minimal RoomManager stand-in — the pipeline only needs it to construct."""

    audio_sample_rate = 48000
    current_audio_speaker = None

    def on_data_received(self, cb):
        pass

    async def publish_data(self, data, *a, **k):
        await asyncio.sleep(0)

    def publish_data_ordered(self, data, *a, **k):
        pass

    def flush_audio_queue(self):
        pass

    def get_participant_name(self, identity):
        return identity

    async def subscribe_to_audio(self):
        for _ in range(2):
            await asyncio.sleep(0)
            yield b"\x00\x00"


class FakeSTT:
    """Yields a scripted sequence of transcript events, ignoring the audio."""

    is_connected = True

    def __init__(self, events):
        self.events = events

    async def stream_transcribe(self, audio_iter, **kwargs):
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


def make_pipeline(monkeypatch, window=None):
    """Build a listening pipeline with TRANSCRIPT_DEBOUNCE_MS controlled.

    The window is read in __init__, so the env has to be set before construction
    — patching the attribute afterwards would test the attribute, not the default.
    """
    if window is None:
        monkeypatch.delenv("TRANSCRIPT_DEBOUNCE_MS", raising=False)
    else:
        monkeypatch.setenv("TRANSCRIPT_DEBOUNCE_MS", str(window))
    pipe = AudioPipeline(FakeRoom(), stt_client=None, tts_client=None, session_id="s")
    pipe._is_listening = True
    return pipe


def test_default_is_off(monkeypatch):
    """With the env unset the window is 0 — no per-turn sleep."""
    assert make_pipeline(monkeypatch)._debounce_window_ms == 0


def test_env_still_overrides(monkeypatch):
    """The escape hatch survives: an explicit value is honoured."""
    assert make_pipeline(monkeypatch, 250)._debounce_window_ms == 250


@pytest.mark.asyncio
async def test_final_reaches_the_queue_without_a_debounce_task(monkeypatch):
    """By default a final is queued outright, not parked in the buffer.

    Asserting on _debounce_task rather than on elapsed wall-clock keeps this
    from being a timing test: no task means no sleep was ever scheduled.
    """
    pipe = make_pipeline(monkeypatch)
    pipe._stt = FakeSTT([_final("a real user turn")])

    await pipe._run_stt_stream_inner()

    assert pipe._transcript_queue.qsize() == 1
    assert pipe._transcript_queue.get_nowait().text == "a real user turn"
    assert pipe._pending_transcript is None
    assert pipe._debounce_task is None


@pytest.mark.asyncio
async def test_explicit_window_still_aggregates(monkeypatch):
    """The merge path is unchanged — two finals inside the window become one turn.

    This is the behaviour the default gives up. It has to keep working, or
    re-enabling the window for a fragmenting provider would be a dead switch.
    """
    pipe = make_pipeline(monkeypatch, 40)

    await pipe._debounce_transcript(_final("I go for walks a lot"))
    await pipe._debounce_transcript(_final("but not in this heat"))

    # Nothing emitted yet — still inside the window.
    assert pipe._transcript_queue.empty()

    await pipe._debounce_task

    assert pipe._transcript_queue.qsize() == 1
    assert pipe._transcript_queue.get_nowait().text == (
        "I go for walks a lot but not in this heat"
    )


@pytest.mark.asyncio
async def test_explicit_window_delays_a_lone_final(monkeypatch):
    """Positive control for the test above: with a window set, a single final
    really is held back rather than passed straight through — so the empty
    queue there is the window at work, not a broken enqueue."""
    pipe = make_pipeline(monkeypatch, 40)

    await pipe._debounce_transcript(_final("just the one"))
    assert pipe._transcript_queue.empty()
    assert pipe._pending_transcript is not None

    await pipe._debounce_task
    assert pipe._transcript_queue.qsize() == 1
