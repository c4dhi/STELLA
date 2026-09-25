"""TTS keep-alive: the model is warmed at start and on an interval, but never
competes with a synthesis that is already running."""

import asyncio
import os
import sys
import types

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

# The gRPC stubs are generated at image build time and are not needed here.
for _name in ("tts_pb2", "tts_pb2_grpc"):
    if _name not in sys.modules:
        _mod = types.ModuleType(_name)
        _mod.TextToSpeechServicer = object
        sys.modules[_name] = _mod

import tts_server  # noqa: E402
from tts_server import TTSEngine  # noqa: E402


class _Provider:
    def __init__(self, delay=0.0):
        self.calls = 0
        self.delay = delay

    async def cleanup(self):
        pass

    async def synthesize(self, text, voice=None, speed=1.0, language=None):
        self.calls += 1
        await asyncio.sleep(self.delay)
        return np.zeros(240, dtype=np.float32), 24000


def _engine(provider, interval):
    engine = TTSEngine()
    engine.provider = provider
    engine.provider_name = "fake"
    engine.initialized = True
    engine.keepalive_interval = interval
    return engine


def test_warms_at_start_then_on_every_interval():
    async def scenario():
        provider = _Provider()
        engine = _engine(provider, 0.05)
        engine.start_keepalive()
        await asyncio.sleep(0.4)
        await engine.cleanup()
        return provider.calls

    assert asyncio.run(scenario()) >= 3


def test_tick_is_skipped_while_a_synthesis_is_running():
    async def scenario():
        provider = _Provider(delay=0.3)
        engine = _engine(provider, 0.05)
        real = asyncio.create_task(engine.synthesize("hello"))
        await asyncio.sleep(0.02)  # the real request is in flight
        engine.start_keepalive()
        await asyncio.sleep(0.2)   # several ticks fall inside the real synthesis
        calls_during = provider.calls
        await real
        await engine.cleanup()
        return calls_during

    assert asyncio.run(scenario()) == 1, "keep-alive ran a synthesis next to a live one"


def test_interval_zero_disables_keepalive():
    engine = _engine(_Provider(), 0)

    async def scenario():
        engine.start_keepalive()
        return engine._keepalive_task

    assert asyncio.run(scenario()) is None


def test_warmup_reports_failure_without_raising():
    class Broken(_Provider):
        async def synthesize(self, *a, **k):
            raise RuntimeError("boom")

    ok, _, message = asyncio.run(_engine(Broken(), 0).warmup())
    assert ok is False and "boom" in message


def test_active_count_returns_to_zero_after_stream_and_failure():
    class Failing(_Provider):
        async def synthesize(self, *a, **k):
            raise RuntimeError("x")

    engine = _engine(Failing(), 0)
    try:
        asyncio.run(engine.synthesize("hi"))
    except RuntimeError:
        pass
    assert engine._active == 0


def test_stella_model_keep_warm_false_disables_the_keepalive(monkeypatch):
    monkeypatch.setenv("STELLA_MODEL_KEEP_WARM", "false")
    assert TTSEngine().keepalive_interval == 0

    monkeypatch.setenv("STELLA_MODEL_KEEP_WARM", "true")
    assert TTSEngine().keepalive_interval > 0


def test_a_live_request_never_overlaps_a_running_warmup():
    """The Qwen3 model must never run two syntheses at once (#463)."""

    class Tracking(_Provider):
        def __init__(self):
            super().__init__(delay=0.15)
            self.running = 0
            self.max_running = 0

        async def synthesize(self, text, voice=None, speed=1.0, language=None):
            self.running += 1
            self.max_running = max(self.max_running, self.running)
            try:
                return await super().synthesize(text, voice, speed, language)
            finally:
                self.running -= 1

    async def scenario():
        provider = Tracking()
        engine = _engine(provider, 0)
        warm = asyncio.create_task(engine.warmup())
        await asyncio.sleep(0.03)             # warmup is mid-synthesis
        live = asyncio.create_task(engine.synthesize("first sentence"))
        await asyncio.gather(warm, live)
        return provider.max_running

    assert asyncio.run(scenario()) == 1


def test_warmup_is_skipped_rather_than_started_next_to_a_live_request():
    async def scenario():
        provider = _Provider(delay=0.15)
        engine = _engine(provider, 0)
        live = asyncio.create_task(engine.synthesize("hello"))
        await asyncio.sleep(0.03)
        ok, _, message = await engine.warmup()
        await live
        return provider.calls, ok, message

    calls, ok, message = asyncio.run(scenario())
    assert calls == 1 and ok is True and message.startswith("skipped")


def test_concurrent_live_requests_are_not_serialised():
    """Only warmup is exclusive; live sessions keep today's concurrency."""

    class Tracking(_Provider):
        running = 0
        max_running = 0

        async def synthesize(self, *a, **k):
            Tracking.running += 1
            Tracking.max_running = max(Tracking.max_running, Tracking.running)
            try:
                return await super().synthesize(*a, **k)
            finally:
                Tracking.running -= 1

    async def scenario():
        engine = _engine(Tracking(delay=0.1), 0)
        await asyncio.gather(engine.synthesize("a"), engine.synthesize("b"))
        return Tracking.max_running

    assert asyncio.run(scenario()) == 2
