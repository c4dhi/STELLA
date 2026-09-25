"""A cold Whisper warmup must not freeze the STT event loop.

The server is grpc.aio: every stream shares one event loop. Warmup used to call
`whisper_model.transcribe()` (15-35 s cold) directly inside its coroutine, and
`StreamTranscribe` called `session.process_audio()` inline, so while either ran
no other stream could be read or answered. These tests hold a blocking call open
and assert other work still gets through.
"""

import asyncio
import sys
import threading
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import stt_pb2  # noqa: E402

if "torch" not in sys.modules:
    _torch = types.ModuleType("torch")
    _torch.from_numpy = lambda a: a
    _torch.Tensor = type("Tensor", (), {})
    sys.modules["torch"] = _torch

from providers import whisper_provider  # noqa: E402
from providers.whisper_provider import WhisperProvider  # noqa: E402
import stt_server  # noqa: E402

TIMEOUT = 5.0


class _BlockingModel:
    """Stands in for faster-whisper: transcribe() blocks until released."""

    def __init__(self):
        self.entered = threading.Event()
        self.release = threading.Event()

    def transcribe(self, *args, **kwargs):
        self.entered.set()
        assert self.release.wait(TIMEOUT * 2), "test never released the model"
        return iter(()), None


class _FakeSession:
    def __init__(self, session_id):
        self.session_id = session_id
        self.calls = []

    def set_language_hint(self, _lang):
        pass

    def process_audio(self, audio, sample_rate=16000):
        self.calls.append(threading.current_thread() is threading.main_thread())
        return [stt_pb2.TranscriptEvent()]


class _FakeProvider:
    def create_session(self, session_id, participant_id):
        return _FakeSession(session_id)


class _FakeEngine:
    provider_name = "fake"
    provider = _FakeProvider()


async def _chunks(session_id, n):
    for _ in range(n):
        yield stt_pb2.AudioChunk(session_id=session_id, participant_id="p", audio_data=b"\0" * 320)
        await asyncio.sleep(0)


async def _collect(servicer, session_id, n):
    return [e async for e in servicer.StreamTranscribe(_chunks(session_id, n), None)]


def _cold_provider():
    # The stub torch has no cuda; skip the post-warmup GPU cache clear.
    whisper_provider.TORCH_AVAILABLE = False
    provider = WhisperProvider()
    provider.model_ready = True
    provider.whisper_model = _BlockingModel()
    return provider


def test_second_stream_is_served_while_warmup_runs():
    async def scenario():
        provider = _cold_provider()
        model = provider.whisper_model
        warmup = asyncio.create_task(provider.warmup(100))

        # Wait until the warmup is really inside transcribe().
        await asyncio.wait_for(asyncio.to_thread(model.entered.wait, TIMEOUT), TIMEOUT)
        assert not warmup.done()

        servicer = stt_server.SpeechToTextServicer(_FakeEngine())
        try:
            events = await asyncio.wait_for(_collect(servicer, "second", 3), TIMEOUT)
            assert len(events) == 3
            assert not warmup.done(), "warmup finished early; the test proved nothing"
        finally:
            model.release.set()

        assert await asyncio.wait_for(warmup, TIMEOUT) is True

    asyncio.run(scenario())


def test_event_loop_ticks_while_warmup_runs():
    async def scenario():
        provider = _cold_provider()
        model = provider.whisper_model
        warmup = asyncio.create_task(provider.warmup(100))
        await asyncio.wait_for(asyncio.to_thread(model.entered.wait, TIMEOUT), TIMEOUT)
        try:
            for _ in range(5):
                await asyncio.wait_for(asyncio.sleep(0.01), 1.0)
        finally:
            model.release.set()
        await asyncio.wait_for(warmup, TIMEOUT)

    asyncio.run(scenario())


def test_process_audio_runs_off_the_event_loop_and_stays_ordered():
    async def scenario():
        servicer = stt_server.SpeechToTextServicer(_FakeEngine())
        seen = {}
        original = _FakeProvider.create_session

        def spy(self, session_id, participant_id):
            seen["session"] = original(self, session_id, participant_id)
            return seen["session"]

        _FakeProvider.create_session = spy
        try:
            events = await _collect(servicer, "s", 4)
        finally:
            _FakeProvider.create_session = original

        assert len(events) == 4
        assert seen["session"].calls == [False] * 4, "process_audio ran on the loop thread"

    asyncio.run(scenario())
