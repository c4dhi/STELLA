"""Playback must start on the FIRST synthesized chunk, not the last.

`_prefetch_sentence` used to collect every chunk into a list before playback
began, so the first audible sample of a sentence waited for the whole sentence
to synthesize. Against the Qwen3 provider that is ~235ms time-to-first-audio
versus 1040-4138ms for a full stream — we were paying 4-17x the latency the
provider could already deliver.

`_play_utterance` now consumes a buffer that synthesis appends to while it
plays. These tests pin the overlap and the three things it must not break:
whole-frame publishing, barge-in responsiveness while starved, and the
teleprompter staying in step with the voice at ANY real-time factor — the last
of which streaming playback did break, by tying progress to a "synthesis
finished" event that at RTF ~1 only arrives once the sentence is over.
"""

import asyncio

import pytest

from stella_agent_sdk.audio.pipeline import (
    AudioPipeline,
    _BYTES_PER_SAMPLE,
    _DECLICK_SAMPLES,
    _PLAYOUT_FRAME_BYTES,
    _PLAYOUT_FRAME_SAMPLES,
    _fade_in,
    _silence_frame,
    _StreamingUtterance,
)

# tests/ is a package (__init__.py), so import the shared harness relatively —
# a bare `from test_teleprompter import ...` only resolves when the tests
# directory happens to be on sys.path.
from .test_teleprompter import CapturingRoom, Chunk, progress_events, META


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
                # Non-zero, so real audio is distinguishable from the silence
                # the underrun guard bridges with (see real_audio()).
                yield Chunk(bytes([(i % 250) + 1]) * _PLAYOUT_FRAME_BYTES)
        except asyncio.CancelledError:
            self.cancelled = True
            raise


def real_frame_ids(room) -> list:
    """Markers of the SPEECH frames published, in order.

    SlowTTS fills chunk i with the constant byte i+1, so a frame's last byte
    identifies which chunk it came from — and the last byte survives the
    de-click fade-in, which only touches the head of a frame. A frame bridged
    in by the underrun guard is silence past its ramp, so its tail is zero and
    it is skipped. This makes "every chunk, once, in order" directly assertable
    without the guard's silence confusing the count.
    """
    buf = bytes(room.published)
    ids = []
    for i in range(0, len(buf), _PLAYOUT_FRAME_BYTES):
        frame = buf[i:i + _PLAYOUT_FRAME_BYTES]
        if any(frame[_DECLICK_SAMPLES * _BYTES_PER_SAMPLE:]):
            ids.append(frame[-1])
    return ids


def make_pipeline(tts, teleprompter=True, barge_in=True, preroll_frames=2):
    room = CapturingRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=tts, session_id="s")
    pipe._teleprompter_enabled = teleprompter
    pipe._barge_in_enabled = barge_in
    # Pin the jitter buffer so tests do not inherit the production default.
    pipe._preroll_bytes = _PLAYOUT_FRAME_BYTES * preroll_frames
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
    assert real_frame_ids(room) == list(range(1, 7))


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

    # 8 frames x 30ms = ~240ms to synthesize the whole sentence. With a 2-frame
    # cushion audio starts after ~60ms — the win is intact, it just is not zero.
    assert ttfa_ms < 150, f"first audio took {ttfa_ms:.0f}ms — still buffering?"


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


def make_paced_pipeline(tts, teleprompter=True, preroll_frames=2):
    room = PacedRoom()
    pipe = AudioPipeline(room, stt_client=None, tts_client=tts, session_id="s")
    pipe._teleprompter_enabled = teleprompter
    pipe._barge_in_enabled = True
    pipe._preroll_bytes = _PLAYOUT_FRAME_BYTES * preroll_frames
    pipe._is_speaking = True
    pipe._stop_speaking_event.clear()
    pipe._play_allowed.set()
    return pipe, room


def animated_fraction(room, span_ms: float) -> float:
    """Share of a sentence the teleprompter is actually told to animate over."""
    events = [e["data"] for e in progress_events(room)]
    speaking = [e for e in events if e["state"] == "speaking"]
    return sum(e["duration_ms"] for e in speaking) / span_ms


@pytest.mark.asyncio
@pytest.mark.parametrize("rtf", [0.3, 0.6, 1.0, 1.3])
async def test_highlight_animates_the_whole_sentence_at_every_rtf(rtf):
    """The regression this design exists to prevent.

    Progress used to be ONE envelope per sentence, held until synthesis
    completed so it could carry the true byte length. That silently assumed
    synthesis finishes well before playback (RTF ~0.3). At the deployed model's
    RTF 0.92-1.33 "complete" arrives at the END of the sentence, so the envelope
    described 4-8% of it and the highlight jumped straight to the end — which is
    what "the teleprompter jumps ahead / never shows" actually was.

    Streaming ticks are RTF-independent: however slow synthesis is, the ticks
    together still cover the sentence.
    """
    PacedRoom.frame_delay = 0.012  # 20ms of audio per 12ms of wall clock
    tts = SlowTTS(frames=25, gap=0.012 * rtf)
    pipe, room = make_paced_pipeline(tts, teleprompter=True)

    utt = pipe._begin_synthesis("a sentence")
    await asyncio.wait_for(pipe._play_utterance(utt, meta=META), timeout=15)
    for _ in range(5):
        await asyncio.sleep(0)

    covered = animated_fraction(room, 25 * 20)
    assert covered >= 0.8, (
        f"RTF {rtf}: ticks only animate {covered:.0%} of the sentence — "
        "the highlight will jump the rest"
    )


@pytest.mark.asyncio
async def test_ticks_never_promise_past_the_end_of_the_sentence():
    """A highlight that runs AHEAD of the voice is the unreadable failure.

    Mid-sentence targets are estimated, so they must be clamped: no tick may
    light a character the sentence has not reached, and none may walk backwards
    when the estimate is later replaced by the true total.
    """
    tts = SlowTTS(frames=20, gap=0.01)
    pipe, room = make_paced_pipeline(tts, teleprompter=True)

    utt = pipe._begin_synthesis("a sentence")
    await asyncio.wait_for(pipe._play_utterance(utt, meta=META), timeout=10)
    for _ in range(5):
        await asyncio.sleep(0)

    events = [e["data"] for e in progress_events(room)]
    speaking = [e for e in events if e["state"] == "speaking"]
    assert len(speaking) > 1, "expected a stream of ticks, not one envelope"
    for e in speaking:
        assert META["char_start"] <= e["spoken_char"] <= e["target_char"] <= META["char_end"]
    # Monotonic: the highlight never retreats mid-sentence.
    assert [e["spoken_char"] for e in speaking] == sorted(e["spoken_char"] for e in speaking)
    assert events[-1]["state"] == "spoken"
    assert events[-1]["spoken_char"] == META["char_end"]


@pytest.mark.asyncio
async def test_first_tick_is_emitted_without_waiting_for_synthesis():
    """The first tick must go out on the first frame.

    Holding it until the buffer completed is what coupled the teleprompter to
    RTF. A tick only ever describes audio already in hand, so there is nothing
    to wait for.
    """
    tts = SlowTTS(frames=30, gap=0.03)  # never completes during the window
    pipe, room = make_pipeline(tts, teleprompter=True)

    utt = pipe._begin_synthesis("a sentence")
    play = asyncio.create_task(pipe._play_utterance(utt, meta=META))
    await asyncio.sleep(0.15)
    for _ in range(5):
        await asyncio.sleep(0)

    assert not utt.complete, "test needs synthesis still running"
    speaking = [e["data"] for e in progress_events(room) if e["data"]["state"] == "speaking"]
    assert speaking, "no progress emitted while the sentence was still synthesizing"
    assert speaking[0]["duration_ms"] > 0

    pipe._stop_speaking_event.set()
    await asyncio.wait_for(play, timeout=5)


@pytest.mark.asyncio
async def test_playback_state_does_not_tick_with_the_teleprompter():
    """agent_playback drives the barge-in mute — it is a transition signal.

    Progress now fires several times a second; re-announcing "speaking" on every
    tick would spam the mute channel. One per sentence, as before.
    """
    tts = SlowTTS(frames=25, gap=0.005)
    pipe, room = make_paced_pipeline(tts, teleprompter=True)

    utt = pipe._begin_synthesis("a sentence")
    await asyncio.wait_for(pipe._play_utterance(utt, meta=META), timeout=10)
    for _ in range(5):
        await asyncio.sleep(0)

    playback = [d for d in room.data if d.get("type") == "agent_playback"]
    ticks = [d for d in progress_events(room) if d["data"]["state"] == "speaking"]
    assert len(ticks) > 1
    assert len(playback) == 1, f"{len(playback)} agent_playback envelopes for one sentence"


@pytest.mark.asyncio
async def test_pace_is_calibrated_from_completed_sentences():
    """The mid-sentence estimate is only as good as the pace behind it.

    Seeding a constant would misplace the highlight for any voice or language
    that does not happen to match it, so the pace is re-measured from every
    sentence that finishes.
    """
    tts = SlowTTS(frames=25, gap=0.0)
    pipe, room = make_paced_pipeline(tts, teleprompter=True)
    seeded = pipe._ms_per_char

    # 25 frames x 20ms = 500ms of audio over META's 10-char span => 50ms/char,
    # well away from the 70ms/char seed.
    utt = pipe._begin_synthesis("a sentence")
    await asyncio.wait_for(pipe._play_utterance(utt, meta=META), timeout=10)

    assert pipe._ms_per_char != seeded, "pace never re-measured"
    assert 50 <= pipe._ms_per_char < seeded, f"pace moved the wrong way: {pipe._ms_per_char}"


@pytest.mark.asyncio
async def test_client_unsilencing_is_not_deferred_with_the_teleprompter():
    """agent_playback gates barge-in muting — it must fire on the first frame,
    while the sentence is still synthesizing. Nothing on this channel may wait
    for the buffer to complete: the client stays muted until it arrives."""
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


class ConcurrencyTrackingTTS:
    """Records the maximum number of overlapping synthesize_stream calls."""

    def __init__(self, frames=4, gap=0.01):
        self.frames = frames
        self.gap = gap
        self.live = 0
        self.max_live = 0

    async def synthesize_stream(self, **kwargs):
        self.live += 1
        self.max_live = max(self.max_live, self.live)
        try:
            for _ in range(self.frames):
                await asyncio.sleep(self.gap)
                yield Chunk(bytes(_PLAYOUT_FRAME_BYTES))
        finally:
            self.live -= 1


@pytest.mark.asyncio
async def test_only_one_synthesis_runs_at_a_time():
    """The regression that shipped and had to be rolled back.

    The TTS service shares one model across a 10-thread gRPC pool with no lock,
    so two overlapping generations contend on the same weights and CUDA graphs.
    On prod that showed up as two streams starting in the same millisecond,
    finishing in lockstep, TTFA doubling 235ms -> 495ms, and audibly garbled
    speech.

    Buffered playback used to serialize this by accident: sentence N was fully
    synthesized before it began playing, so only N+1 was ever in flight.
    Streaming playback removes that accident, so the lock has to hold the line.
    """
    tts = ConcurrencyTrackingTTS(frames=6, gap=0.01)
    pipe, _room = make_pipeline(tts)

    # Arm several sentences at once — exactly what the speech worker does when
    # the response LLM has run ahead of playback.
    utts = [pipe._begin_synthesis(f"sentence {i}") for i in range(4)]
    await asyncio.gather(*(u.task for u in utts))

    assert tts.max_live == 1, (
        f"{tts.max_live} concurrent synthesis calls — the service cannot take that"
    )
    assert all(u.complete for u in utts)


@pytest.mark.asyncio
async def test_next_sentence_still_overlaps_the_current_playback():
    """Serializing must not cost us the prefetch overlap.

    The provider runs well faster than real time, so the current sentence's
    synthesis finishes early in its own playback and the next one acquires the
    lock while that playback is still going. If this ever regresses to
    "synthesize N+1 only after N finished playing", the gap between sentences
    comes straight back.
    """
    tts = ConcurrencyTrackingTTS(frames=4, gap=0.001)
    pipe, _room = make_paced_pipeline(tts)

    current = pipe._begin_synthesis("first")
    nxt = pipe._begin_synthesis("second")

    play = asyncio.create_task(pipe._play_utterance(current, source="response"))
    # Long enough for the first synthesis to finish and the second to get the
    # lock, but well short of the first sentence's playback ending.
    await asyncio.sleep(0.05)
    assert nxt.complete or len(nxt.data) > 0, (
        "next sentence had not started synthesizing during current playback"
    )
    assert not play.done(), "test is not exercising mid-playback overlap"

    await asyncio.wait_for(play, timeout=5)


@pytest.mark.asyncio
async def test_preroll_cushion_is_held_before_the_first_frame():
    """The second regression that shipped: interference between chunks.

    LiveKit's AudioSource.capture_frame self-paces at 1x real time, so once
    playout starts the source drains steadily — but TTS does not ARRIVE
    steadily (the Qwen3 provider yields ~167ms lumps at an uneven rate).
    Starting on the very first frame leaves zero cushion, so a late lump empties
    the source: an underrun, heard as interference at the chunk boundaries.
    """
    tts = SlowTTS(frames=10, gap=0.02)
    pipe, room = make_pipeline(tts, preroll_frames=4)

    utt = pipe._begin_synthesis("a sentence")
    play = asyncio.create_task(pipe._play_utterance(utt))

    # One frame exists well before four do; nothing may go out yet.
    await asyncio.sleep(0.035)
    assert len(utt.data) >= _PLAYOUT_FRAME_BYTES, "test timing is off"
    assert len(room.published) == 0, "played before the cushion was filled"

    await asyncio.wait_for(play, timeout=5)
    assert real_frame_ids(room) == list(range(1, 11))


@pytest.mark.asyncio
async def test_short_utterance_does_not_wait_for_a_cushion_it_will_never_get():
    """A sentence shorter than the cushion must still play, not deadlock."""
    tts = SlowTTS(frames=2, gap=0.01)
    pipe, room = make_pipeline(tts, preroll_frames=50)  # far more than exists

    utt = pipe._begin_synthesis("hi")
    await asyncio.wait_for(pipe._play_utterance(utt), timeout=2)

    assert real_frame_ids(room) == [1, 2]


@pytest.mark.asyncio
async def test_starvation_delivers_every_sample_in_order():
    """A starved player must still deliver the whole utterance, once, in order.

    This used to assert the cushion was RE-ARMED after a starve. That was the
    bug: at RTF ~1 re-arming stops the pushes for a whole pre-roll while the
    output source drains the same amount, so the source hits empty on every
    cycle. What actually matters is the invariant below — no sample dropped,
    duplicated, or reordered, however often synthesis falls behind.
    """
    tts = SlowTTS(frames=12, gap=0.02)
    pipe, room = make_pipeline(tts, preroll_frames=3)

    utt = pipe._begin_synthesis("a sentence")
    await asyncio.wait_for(pipe._play_utterance(utt), timeout=5)

    assert real_frame_ids(room) == list(range(1, 13))


# ---------------------------------------------------------------------------
# Jitter-buffer sawtooth (the "interference between chunks" report)
# ---------------------------------------------------------------------------


def _spy_on_waits(monkeypatch, pipe, room):
    """Record (want - cursor, already_playing) for every wait_for_data call."""
    from stella_agent_sdk.audio import pipeline as P

    orig = P._StreamingUtterance.wait_for_data
    seen = []

    async def spy(self, want, stop_event, *a, **k):
        seen.append((want - pipe._cur_cursor, len(room.published) > 0))
        return await orig(self, want, stop_event, *a, **k)

    monkeypatch.setattr(P._StreamingUtterance, "wait_for_data", spy)
    return seen


@pytest.mark.asyncio
async def test_cushion_is_not_rearmed_mid_sentence(monkeypatch):
    """Once playing, a starved player must wait for ONE frame — not a new cushion.

    Re-arming the whole pre-roll mid-sentence is what makes the LiveKit source
    sawtooth: the player dumps its buffer into the source, immediately runs dry,
    then stops pushing for a full pre-roll while the source drains that same
    amount. The source grazes empty on every cycle, and an empty source is what
    makes the client's Opus PLC invent audio — the warble people hear.

    The initial pre-roll (before the first frame) is deliberate and stays.
    """
    # Synthesis well slower than playout (PacedRoom spends 12ms/frame)
    # reproduces prod, where measured RTF is 0.92-1.33. The margin is wide on
    # purpose: a ratio near 1.0 makes whether the player starves at all depend
    # on machine load, which is not what this test is about.
    tts = SlowTTS(frames=8, gap=0.04)
    pipe, room = make_paced_pipeline(tts, preroll_frames=4)
    seen = _spy_on_waits(monkeypatch, pipe, room)

    utt = pipe._begin_synthesis("a sentence that streams in over time")
    await pipe._play_utterance(utt, source="response", meta=META)

    mid = [want for want, playing in seen if playing]
    assert mid, "test did not exercise a mid-sentence starve"
    assert max(mid) <= _PLAYOUT_FRAME_BYTES, (
        f"player re-armed a {max(mid)}-byte cushion mid-sentence "
        f"(one frame is {_PLAYOUT_FRAME_BYTES}); this drains the LiveKit source "
        f"to empty on every cycle. waits={mid}"
    )


# ---------------------------------------------------------------------------
# Underrun guard + de-click
# ---------------------------------------------------------------------------


def _samples(frame: bytes) -> list:
    return [
        int.from_bytes(frame[i * 2:i * 2 + 2], "little", signed=True)
        for i in range(len(frame) // 2)
    ]


@pytest.mark.asyncio
async def test_underrun_is_bridged_with_silence():
    """A source about to run dry gets real silence, not the client's guesswork.

    An empty AudioSource sends no packets, so Opus concealment extrapolates the
    last frame — the warble. Bridging keeps the stream continuous.
    """
    tts = SlowTTS(frames=8, gap=0.05)  # far slower than playout: certain to starve
    pipe, room = make_paced_pipeline(tts, preroll_frames=2)

    utt = pipe._begin_synthesis("a slowly arriving sentence")
    await asyncio.wait_for(pipe._play_utterance(utt, source="response"), timeout=15)

    assert real_frame_ids(room) == list(range(1, 9)), "speech was lost or reordered"
    total_frames = len(room.published) // _PLAYOUT_FRAME_BYTES
    assert total_frames > 8, "source ran dry but no silence was bridged"


@pytest.mark.asyncio
async def test_healthy_stream_is_never_spliced_with_silence():
    """The guard must not fire on a stream that is keeping up."""
    tts = SlowTTS(frames=10, gap=0.001)  # synthesis far ahead of playout
    pipe, room = make_paced_pipeline(tts, preroll_frames=2)

    utt = pipe._begin_synthesis("a comfortable sentence")
    await asyncio.wait_for(pipe._play_utterance(utt, source="response"), timeout=10)

    assert len(room.published) == _PLAYOUT_FRAME_BYTES * 10, (
        "silence was spliced into a stream that never starved"
    )


def test_silence_frame_ramps_down_instead_of_cutting():
    """Cutting a waveform to zero is a step, and a step is an audible click."""
    frame = _silence_frame(fade_from=10000)
    samples = _samples(frame)

    assert samples[0] != 0, "silence cut straight to zero — that clicks"
    assert abs(samples[0]) < 10000, "ramp must start below the source sample"
    assert all(s == 0 for s in samples[_DECLICK_SAMPLES:]), "ramp overran"
    head = [abs(s) for s in samples[:_DECLICK_SAMPLES]]
    assert head == sorted(head, reverse=True), "ramp is not monotonically decaying"


def test_silence_frame_with_no_predecessor_is_pure_silence():
    assert _silence_frame() == bytes(_PLAYOUT_FRAME_BYTES)


def test_fade_in_ramps_up_and_leaves_the_tail_alone():
    """Resuming from silence must fade in; the rest of the frame is untouched."""
    loud = b"\x40\x1f" * _PLAYOUT_FRAME_SAMPLES  # constant 7999
    faded = _samples(_fade_in(loud))
    original = _samples(loud)

    assert faded[0] < original[0], "first sample was not attenuated"
    head = faded[:_DECLICK_SAMPLES]
    assert head == sorted(head), "fade-in is not monotonically rising"
    assert faded[_DECLICK_SAMPLES:] == original[_DECLICK_SAMPLES:], "tail was altered"
