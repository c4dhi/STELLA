"""The stt_status envelope (#564): the screens are told when speech
recognition is still warming up, and only then."""

import asyncio

import pytest

from stella_agent_sdk.services.stt_readiness import SttReadiness


class Sent:
    def __init__(self):
        self.payloads = []

    async def __call__(self, payload):
        self.payloads.append(payload)

    @property
    def states(self):
        return [p["data"]["state"] for p in self.payloads]


async def _warmup(delay, success=True):
    await asyncio.sleep(delay)
    return {"success": success, "warmup_time_ms": int(delay * 1000), "provider": "whisper", "message": ""}


@pytest.mark.asyncio
async def test_a_warm_model_sends_nothing():
    sent = Sent()
    r = SttReadiness(sent, announce_after=0.05)
    result = await r.track(_warmup(0))
    assert result["success"]
    assert sent.payloads == []
    assert not r.needs_resend()


@pytest.mark.asyncio
async def test_a_slow_warmup_announces_warming_then_ready():
    sent = Sent()
    r = SttReadiness(sent, language=lambda: "DE", announce_after=0.02)
    await r.track(_warmup(0.1))
    assert sent.states == ["warming", "ready"]
    assert sent.payloads[0] == {
        "type": "stt_status",
        "data": {"state": "warming", "elapsed_ms": sent.payloads[0]["data"]["elapsed_ms"], "language": "de"},
    }
    assert sent.payloads[0]["data"]["elapsed_ms"] >= 20
    assert sent.payloads[1]["data"]["elapsed_ms"] == 0


@pytest.mark.asyncio
async def test_a_failed_warmup_is_reported_even_when_fast():
    sent = Sent()
    r = SttReadiness(sent, announce_after=1)
    await r.track(_warmup(0, success=False))
    assert sent.states == ["failed"]
    assert r.state == "failed"


@pytest.mark.asyncio
async def test_a_warmup_that_raises_is_a_failure():
    sent = Sent()
    r = SttReadiness(sent, announce_after=1)

    async def boom():
        raise RuntimeError("gone")

    result = await r.track(boom())
    assert result["success"] is False
    assert sent.states == ["failed"]


@pytest.mark.asyncio
async def test_a_participant_joining_mid_warmup_gets_the_current_state():
    sent = Sent()
    r = SttReadiness(sent, announce_after=0.01)
    task = asyncio.create_task(r.track(_warmup(0.1)))
    await asyncio.sleep(0.05)
    assert r.needs_resend()
    late = r.payload()
    assert late["data"]["state"] == "warming"
    assert late["data"]["elapsed_ms"] >= 40
    # A second join while warming does not report twice.
    await r.track(_warmup(0))
    await task
    assert sent.states == ["warming", "ready"]


@pytest.mark.asyncio
async def test_a_publish_error_does_not_break_the_warmup():
    async def broken(_payload):
        raise ConnectionError("room gone")

    r = SttReadiness(broken, announce_after=0.01)
    result = await r.track(_warmup(0.05))
    assert result["success"]
    assert r.state == "ready"
