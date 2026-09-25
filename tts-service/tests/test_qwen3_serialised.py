"""Two sessions talking at once must not garble each other's TTS (#463).

One Qwen3 model instance is shared by every session and keeps mutable state
between decoder steps, so two syntheses running at once corrupt each other's
audio. The provider now lets one request use the model at a time. These tests
use a fake model that records how many calls are inside it at once, so they
show the overlap without needing torch or the weights.
"""

import asyncio
import os
import sys
import threading
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from providers.qwen3_provider import Qwen3Provider  # noqa: E402

TIMEOUT = 10.0


class FakeModel:
    """Streams `chunks` chunks, `step` seconds apart, and counts concurrent use."""

    def __init__(self, chunks=4, step=0.03):
        self.chunks = chunks
        self.step = step
        self.inside = 0
        self.max_inside = 0
        self.order = []
        self._mutex = threading.Lock()

    def _enter(self, name):
        with self._mutex:
            self.inside += 1
            self.max_inside = max(self.max_inside, self.inside)
            self.order.append(("start", name))

    def _leave(self, name):
        with self._mutex:
            self.inside -= 1
            self.order.append(("end", name))

    def generate_voice_clone_streaming(self, text, **kwargs):
        self._enter(text)
        try:
            for _ in range(self.chunks):
                time.sleep(self.step)
                yield np.zeros(4800, dtype=np.float32), 24000, {}
        finally:
            self._leave(text)

    def generate_voice_clone(self, text, **kwargs):
        self._enter(text)
        try:
            time.sleep(self.step * self.chunks)
            return [np.zeros(4800, dtype=np.float32)], 24000
        finally:
            self._leave(text)


def _provider(model):
    p = Qwen3Provider()
    p._initialized = True
    p._model = model
    return p


async def _drain(provider, text, **kw):
    frames = 0
    async for _chunk, _final in provider.synthesize_stream(text, chunk_size=480, **kw):
        frames += 1
    return frames


def test_two_streams_never_use_the_model_at_once():
    async def scenario():
        model = FakeModel()
        p = _provider(model)
        a, b = await asyncio.wait_for(
            asyncio.gather(_drain(p, "A"), _drain(p, "B")), TIMEOUT
        )
        return model, a, b

    model, a, b = asyncio.run(scenario())
    assert model.max_inside == 1, "two syntheses ran on the model at the same time"
    assert a > 0 and b > 0, "a queued session got no audio"
    # Strictly one after the other, in arrival order (first come, first served).
    assert [e for e in model.order] == [("start", "A"), ("end", "A"), ("start", "B"), ("end", "B")]


def test_many_sessions_all_finish_one_at_a_time():
    async def scenario():
        model = FakeModel(chunks=2, step=0.01)
        p = _provider(model)
        frames = await asyncio.wait_for(
            asyncio.gather(*[_drain(p, f"S{i}") for i in range(6)]), TIMEOUT
        )
        return model, frames

    model, frames = asyncio.run(scenario())
    assert model.max_inside == 1
    assert all(f > 0 for f in frames)


def test_a_slow_client_does_not_hold_the_model():
    """The lock covers compute, not however long a client takes to read."""

    async def scenario():
        model = FakeModel(chunks=3, step=0.02)
        p = _provider(model)
        slow = p.synthesize_stream("slow", chunk_size=480)
        first = await slow.__anext__()  # reads one frame, then stalls
        assert first is not None
        # While the slow client sits there, another session must still finish.
        other = await asyncio.wait_for(_drain(p, "other"), 3.0)
        await slow.aclose()
        return other

    assert asyncio.run(scenario()) > 0


def test_cancelling_a_stream_stops_it_before_the_next_one_starts():
    async def scenario():
        model = FakeModel(chunks=50, step=0.02)  # would run ~1 s if not stopped
        p = _provider(model)
        first = p.synthesize_stream("A", chunk_size=480)
        await first.__anext__()
        await first.aclose()  # barge-in
        model2 = model
        t0 = time.time()
        await asyncio.wait_for(_drain(p, "B"), TIMEOUT)
        return model2, time.time() - t0

    model, _ = asyncio.run(scenario())
    assert model.max_inside == 1, "B started while A's decoder was still running"
    ends = [e for e in model.order if e[0] == "end"]
    assert ends[0] == ("end", "A")


def test_non_streaming_and_streaming_exclude_each_other():
    async def scenario():
        model = FakeModel()
        p = _provider(model)
        await asyncio.wait_for(
            asyncio.gather(p.synthesize("whole"), _drain(p, "streamed")), TIMEOUT
        )
        return model

    assert asyncio.run(scenario()).max_inside == 1


def test_single_session_is_not_delayed_by_the_lock():
    async def scenario():
        model = FakeModel(chunks=3, step=0.01)
        p = _provider(model)
        t0 = time.time()
        gen = p.synthesize_stream("solo", chunk_size=480)
        await gen.__anext__()
        first_audio = time.time() - t0
        async for _ in gen:
            pass
        return first_audio

    # First frame arrives after the model's first step, plus scheduling only.
    assert asyncio.run(scenario()) < 0.2


# ── cancellation and failure paths (review of #581) ─────────────────────────


def test_cancelling_a_non_streaming_call_does_not_free_the_model_early():
    """The worker thread outlives a cancelled synthesize(); the next request must wait for it."""

    async def scenario():
        model = FakeModel(chunks=10, step=0.02)  # ~200 ms inside generate_voice_clone
        p = _provider(model)
        first = asyncio.create_task(p.synthesize("A"))
        await asyncio.sleep(0.05)  # the model is running A
        first.cancel()  # client went away / deadline / cancelled keep-alive
        try:
            await first
        except asyncio.CancelledError:
            pass
        await asyncio.wait_for(_drain(p, "B"), TIMEOUT)
        return model

    model = asyncio.run(scenario())
    assert model.max_inside == 1, "B started on the model while A's thread was still running"
    assert model.order[:2] == [("start", "A"), ("end", "A")]


def test_a_request_cancelled_while_queued_never_touches_the_model():
    async def scenario():
        model = FakeModel(chunks=6, step=0.02)
        p = _provider(model)
        running = asyncio.create_task(_drain(p, "A"))
        await asyncio.sleep(0.03)
        queued = asyncio.create_task(p.synthesize("Q"))  # waits behind A
        await asyncio.sleep(0.02)
        queued.cancel()
        try:
            await queued
        except asyncio.CancelledError:
            pass
        await running
        after = await asyncio.wait_for(_drain(p, "C"), TIMEOUT)  # the lock is not stuck
        return model, after

    model, after = asyncio.run(scenario())
    assert ("start", "Q") not in model.order
    assert after > 0
    assert model.max_inside == 1


def test_a_failing_model_call_releases_the_lock():
    class Exploding(FakeModel):
        def generate_voice_clone(self, text, **kwargs):
            raise RuntimeError("cuda oom")

    async def scenario():
        model = Exploding()
        p = _provider(model)
        first = await p.synthesize("boom")  # returns None, logs the failure
        # Streaming must still get the model afterwards.
        p._model = FakeModel()
        frames = await asyncio.wait_for(_drain(p, "after"), TIMEOUT)
        return first, frames

    first, frames = asyncio.run(scenario())
    assert first is None
    assert frames > 0


def test_a_streaming_error_releases_the_lock():
    class BrokenStream(FakeModel):
        def generate_voice_clone_streaming(self, text, **kwargs):
            raise RuntimeError("stream broke")
            yield  # pragma: no cover

    async def scenario():
        p = _provider(BrokenStream())
        await asyncio.wait_for(_drain(p, "x"), TIMEOUT)  # errors are swallowed, no audio
        p._model = FakeModel()
        return await asyncio.wait_for(_drain(p, "y"), TIMEOUT)

    assert asyncio.run(scenario()) > 0
