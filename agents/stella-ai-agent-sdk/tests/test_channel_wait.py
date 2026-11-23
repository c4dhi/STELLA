"""An agent waits for a speech service that is still loading its model (#151)."""

import asyncio

import pytest

from stella_agent_sdk.services import channel_wait
from stella_agent_sdk.services.channel_wait import (
    DEFAULT_WAIT_SECONDS,
    open_ready_channel,
    speech_wait_seconds,
)


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    async def sleep(self, seconds):
        self.now += seconds


class Service:
    """A gRPC endpoint that becomes ready ``ready_at`` seconds in."""

    def __init__(self, clock, ready_at):
        self.clock = clock
        self.ready_at = ready_at
        self.opened = 0
        self.closed = 0

    def channel(self, address):
        self.opened += 1
        service = self

        class Channel:
            async def channel_ready(self):
                if service.clock() >= service.ready_at:
                    return
                # Not ready: the attempt runs into its timeout.
                await asyncio.sleep(3600)

            async def close(self):
                service.closed += 1

        return Channel()


@pytest.fixture(autouse=True)
def instant_timeouts(monkeypatch):
    """asyncio.wait_for's timeout moves the fake clock instead of waiting."""
    real_wait_for = asyncio.wait_for

    async def wait_for(aw, timeout):
        clock = getattr(instant_timeouts, "clock", None)
        task = asyncio.ensure_future(aw)
        await asyncio.sleep(0)
        if task.done():
            return task.result()
        task.cancel()
        if clock is not None:
            clock.now += timeout
        raise asyncio.TimeoutError()

    monkeypatch.setattr(channel_wait.asyncio, "wait_for", wait_for)
    yield
    monkeypatch.setattr(channel_wait.asyncio, "wait_for", real_wait_for)
    instant_timeouts.clock = None


def _setup(ready_at):
    clock = FakeClock()
    instant_timeouts.clock = clock
    return clock, Service(clock, ready_at)


async def _open(clock, service, wait_seconds):
    return await open_ready_channel(
        "TTS", "tts-service:50052", wait_seconds,
        make_channel=service.channel, clock=clock, sleep=clock.sleep,
    )


@pytest.mark.asyncio
async def test_a_cold_tts_load_is_waited_for():
    # 10 Nov 2026: the cold Qwen3 load took 366 s. The old ~80 s gave up.
    clock, service = _setup(ready_at=366)
    channel = await _open(clock, service, DEFAULT_WAIT_SECONDS)
    assert channel is not None
    assert 366 <= clock.now < 366 + 20
    assert service.closed == service.opened - 1  # every earlier channel was closed


@pytest.mark.asyncio
async def test_a_ready_service_connects_at_once():
    clock, service = _setup(ready_at=0)
    await _open(clock, service, DEFAULT_WAIT_SECONDS)
    assert service.opened == 1 and clock.now == 0


@pytest.mark.asyncio
async def test_a_service_that_never_starts_still_fails_after_the_budget():
    clock, service = _setup(ready_at=10_000)
    with pytest.raises(ConnectionError, match=r"not ready after 720s of 720s"):
        await _open(clock, service, DEFAULT_WAIT_SECONDS)
    assert clock.now == pytest.approx(720, abs=1)
    assert service.closed == service.opened


@pytest.mark.asyncio
async def test_retries_are_at_most_ten_seconds_apart(caplog):
    clock, service = _setup(ready_at=200)
    sleeps = []

    async def sleep(seconds):
        sleeps.append(seconds)
        clock.now += seconds

    await open_ready_channel(
        "STT", "stt-service:50051", 720,
        make_channel=service.channel, clock=clock, sleep=sleep,
    )
    assert sleeps[:3] == [2, 4, 8]
    assert max(sleeps) == 10


@pytest.mark.asyncio
async def test_every_attempt_logs_how_long_it_has_waited(caplog):
    clock, service = _setup(ready_at=30)
    with caplog.at_level("INFO"):
        await _open(clock, service, 720)
    text = caplog.text
    assert "not ready after 10s of 720s (attempt 1)" in text
    assert "ready after" in text and "attempts)" in text


def test_the_budget_comes_from_the_environment():
    assert speech_wait_seconds({}) == DEFAULT_WAIT_SECONDS == 720
    assert speech_wait_seconds({"STELLA_SPEECH_WAIT_SECONDS": "90"}) == 90
    assert speech_wait_seconds({"STELLA_SPEECH_WAIT_SECONDS": "soon"}) == 720
    assert speech_wait_seconds({"STELLA_SPEECH_WAIT_SECONDS": "0"}) == 720
