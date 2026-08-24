"""Playback must start on the FIRST synthesized chunk, not the last.

`_prefetch_sentence` used to collect every chunk into a list before playback
began, so the first audible sample of a sentence waited for the whole sentence
to synthesize. Against the Qwen3 provider that is ~235ms time-to-first-audio
versus 1040-4138ms for a full stream — we were paying 4-17x the latency the
provider could already deliver.

`_play_utterance` now consumes a buffer that synthesis appends to while it
plays. These tests pin the overlap and the three things it must not break:
whole-frame publishing, barge-in responsiveness while starved, and the
teleprompter's duration accounting.
"""

import asyncio

import pytest

from stella_agent_sdk.audio.pipeline import (
    AudioPipeline,
    _PLAYOUT_FRAME_BYTES,
    _StreamingUtterance,
)

from test_teleprompter import CapturingRoom, Chunk, progress_events, META


class SlowTTS:
    """TTS stand-in that emits `frames` chunks, `gap` seconds apart."""

    def __init__(self, frames=4, gap=0.02, fail_after=None):
        self.frames = frames
        self.gap = gap
        self.fail_after = fail_after
        self.started = 0
        self.cancelled = False

    async def synthesize_stream(self, **kwargs):
        self.started += 1
        try:
            for i in range(self.frames):
                await asyncio.sleep(self.gap)
                if self.fail_after is not None and i >= self.fail_after:
                    raise RuntimeError("tts exploded")
                yield Chunk(bytes(_PLAYOUT_FRAME_BYTES))
        except asyncio.CancelledError:
            self.cancelled = True
            raise


def make_pipeline(tts, teleprompter=True, barge_in=True):
    room = CapturingRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=tts, session_id="s")
    pipe._teleprompter_enabled = teleprompter
    pipe._barge_in_enabled = barge_in
    pipe._is_speaking = True
    pipe._stop_speaking_event.clear()
    pipe._play_allowed.set()
    return pipe, room


@pytest.mark.asyncio
async def test_audio_is_published_before_synthesis_finishes():
    """The whole point: first frame out while the stream is still arriving."""
    tts = SlowTTS(frames=6, gap=0.03)
    pipe, room = make_pipeline(tts)

    utt = pipe._begin_synthesis("hello there")
    play = asyncio.create_task(pipe._play_utterance(utt, source="response"))

    # After roughly two chunks, audio must already be flowing and synthesis
    # must still be running. Serialised code would have published nothing.
    await asyncio.sleep(0.09)
    assert len(room.published) > 0, "no audio published while synthesis was in flight"
    assert not utt.complete, "test is not exercising the streaming case"

    await asyncio.wait_for(play, timeout=5)
    assert len(room.published) == _PLAYOUT_FRAME_BYTES * 6


@pytest.mark.asyncio
async def test_turn_costs_first_chunk_not_whole_stream():
    """Time-to-first-audio tracks the first chunk, not the full synthesis."""
    tts = SlowTTS(frames=8, gap=0.03)  # full stream ~240ms
    pipe, room = make_pipeline(tts)

    loop = asyncio.get_event_loop()
    t0 = loop.time()
    utt = pipe._begin_synthesis("hello")
    play = asyncio.create_task(pipe._play_utterance(utt, source="response"))
    while not room.published:
        await asyncio.sleep(0.005)
    ttfa_ms = (loop.time() - t0) * 1000
    await asyncio.wait_for(play, timeout=5)

    # Buffered playback could not have produced audio before ~240ms.
    assert ttfa_ms < 120, f"first audio took {ttfa_ms:.0f}ms — still buffering?"


@pytest.mark.asyncio
async def test_only_whole_frames_published_while_synthesizing():
    """A short frame mid-stream would glitch the output.

    Synthesis emits half-frames, so the player must coalesce them and only
    publish once a whole frame is available.
    """
    half = _PLAYOUT_FRAME_BYTES // 2

    class HalfFrameTTS:
        async def synthesize_stream(self, **kwargs):
            for _ in range(5):
                await asyncio.sleep(0.01)
                yield Chunk(bytes(half))

    pipe, room = make_pipeline(HalfFrameTTS())
    utt = pipe._begin_synthesis("x")
    await asyncio.wait_for(pipe._play_utterance(utt), timeout=5)

    # 5 half-frames = 2.5 frames; the trailing half is published once complete.
    assert len(room.published) == half * 5


@pytest.mark.asyncio
async def test_stop_while_starved_breaks_out_promptly():
    """Barge-in must land even while the player waits on slow synthesis.

    This is the hazard the old code guarded with an explicit stop-race around
    the prefetch await; the wait now lives in wait_for_data and must race stop
    the same way, or the worker pins with the transcript gate closed.
    """
    tts = SlowTTS(frames=50, gap=0.05)  # much slower than playback
    pipe, room = make_pipeline(tts)

    utt = pipe._begin_synthesis("long one")
    play = asyncio.create_task(pipe._play_utterance(utt))
    await asyncio.sleep(0.12)  # get into the starved state

    pipe._stop_speaking_event.set()
    await asyncio.wait_for(play, timeout=1.0)  # must not hang

    assert utt.task.cancelled() or utt.task.done()


@pytest.mark.asyncio
async def test_abandoned_playback_cancels_synthesis():
    """Never keep synthesizing audio nobody will hear."""
    tts = SlowTTS(frames=50, gap=0.05)
    pipe, room = make_pipeline(tts)

    utt = pipe._begin_synthesis("long one")
    play = asyncio.create_task(pipe._play_utterance(utt))
    await asyncio.sleep(0.12)
    pipe._stop_speaking_event.set()
    await asyncio.wait_for(play, timeout=1.0)
    await asyncio.sleep(0.05)

    assert tts.cancelled, "synthesis kept running after playback was abandoned"


@pytest.mark.asyncio
async def test_synthesis_failure_does_not_raise_into_the_worker():
    """A failed synthesis yields what arrived and moves on — old contract."""
    tts = SlowTTS(frames=6, gap=0.01, fail_after=3)
    pipe, room = make_pipeline(tts)

    utt = pipe._begin_synthesis("boom")
    await asyncio.wait_for(pipe._play_utterance(utt), timeout=5)  # must not raise

    assert utt.complete
    assert isinstance(utt.error, RuntimeError)
    assert len(room.published) == _PLAYOUT_FRAME_BYTES * 3  # what made it through


class PacedRoom(CapturingRoom):
    """CapturingRoom that spends wall-clock per frame, like real playout.

    Without this the player drains the buffer instantly and is permanently
    starved, which inverts the production relationship between synthesis and
    playback (the Qwen3 provider runs at RTF ~0.3, so synthesis finishes well
    before the audio it produced has been spoken).
    """

    frame_delay = 0.012

    async def publish_audio(self, data: bytes):
        await asyncio.sleep(self.frame_delay)
        self.published.extend(data)


def make_paced_pipeline(tts, teleprompter=True):
    room = PacedRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=tts, session_id="s")
    pipe._teleprompter_enabled = teleprompter
    pipe._barge_in_enabled = True
    pipe._is_speaking = True
    pipe._stop_speaking_event.clear()
    pipe._play_allowed.set()
    return pipe, room


@pytest.mark.asyncio
async def test_teleprompter_duration_uses_the_true_total():
    """The regression this design has to avoid.

    ``duration_ms`` is derived from ``len(_cur_audio)``. Emitting ``speaking``
    on the first frame while the buffer is still filling would tell the frontend
    to race a word cursor to the end of a sentence that is still growing. So the
    envelope is held until the buffer completes, then carries the true remaining
    duration — the same shape used when resuming after a barge-in suspend.
    """
    # Synthesis finishes long before playback does, as in production.
    tts = SlowTTS(frames=20, gap=0.0)
    pipe, room = make_paced_pipeline(tts, teleprompter=True)

    utt = pipe._begin_synthesis("a sentence")
    await asyncio.wait_for(pipe._play_utterance(utt, meta=META), timeout=5)
    for _ in range(5):
        await asyncio.sleep(0)

    events = [e["data"] for e in progress_events(room)]
    speaking = [e for e in events if e["state"] == "speaking"]
    assert speaking, "no speaking envelope emitted"

    # 20 frames x 20ms = 400ms of audio. Emitted off a partial buffer this would
    # have been a small fraction; emitted off the true total it is most of it.
    assert speaking[0]["duration_ms"] >= 300, (
        f"duration_ms={speaking[0]['duration_ms']} — emitted off a partial buffer"
    )
    assert [e["state"] for e in events][-1] == "spoken"
    assert events[-1]["spoken_char"] == META["char_end"]


@pytest.mark.asyncio
async def test_teleprompter_still_settles_when_synthesis_is_slower_than_playback():
    """Documented degradation, pinned so it stays a known quantity.

    If synthesis is slower than real-time playback the buffer only completes near
    the end of the utterance, so the held ``speaking`` envelope reports little
    remaining time and the highlight barely animates. Audio is choppy in that
    regime regardless — the point here is that the highlight still SETTLES
    correctly rather than being dropped or left mid-sentence.
    """
    tts = SlowTTS(frames=6, gap=0.05)  # far slower than playback
    pipe, room = make_paced_pipeline(tts, teleprompter=True)

    utt = pipe._begin_synthesis("a sentence")
    await asyncio.wait_for(pipe._play_utterance(utt, meta=META), timeout=5)
    for _ in range(5):
        await asyncio.sleep(0)

    events = [e["data"] for e in progress_events(room)]
    assert [e["state"] for e in events][-1] == "spoken"
    assert events[-1]["spoken_char"] == META["char_end"]


@pytest.mark.asyncio
async def test_client_unsilencing_is_not_deferred_with_the_teleprompter():
    """agent_playback gates barge-in muting — it must fire on the first frame,
    not wait for the buffer to complete like the teleprompter envelope does."""
    tts = SlowTTS(frames=12, gap=0.03)
    pipe, room = make_pipeline(tts, teleprompter=True)

    utt = pipe._begin_synthesis("a sentence")
    play = asyncio.create_task(pipe._play_utterance(utt, meta=META))
    await asyncio.sleep(0.09)
    for _ in range(5):
        await asyncio.sleep(0)

    playback = [d["data"] for d in room.data if d.get("type") == "agent_playback"]
    assert any(d["state"] == "speaking" for d in playback), (
        "client was never un-silenced while audio was already playing"
    )
    assert not utt.complete, "test is not exercising the in-flight case"

    pipe._stop_speaking_event.set()
    await asyncio.wait_for(play, timeout=1.0)


@pytest.mark.asyncio
async def test_empty_utterance_emits_no_progress():
    """Preserves the old `if not chunks: continue` behaviour."""
    class EmptyTTS:
        async def synthesize_stream(self, **kwargs):
            return
            yield  # pragma: no cover

    pipe, room = make_pipeline(EmptyTTS(), teleprompter=True)
    utt = pipe._begin_synthesis("")
    await asyncio.wait_for(pipe._play_utterance(utt, meta=META), timeout=5)

    assert len(room.published) == 0
    assert progress_events(room) == []
