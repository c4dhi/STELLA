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
