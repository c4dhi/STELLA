"""A reply call that stalls before its first token is retried once, quickly (#684).

On 7 Oct a response call stalled: the client's 30s timeout, then its own
retry, cost 32s of silence after the bridge. The budget that matters in a voice
turn is the time to the FIRST token; a stream that has started is never cut for
being long. Runs stream_completion against a paced fake service.
"""

import asyncio
import time

import pytest

from stella_agent_sdk.llm import (
    stream_completion, FirstTokenTimeout, LLMConfig, LLMMessage, LLMResponse, LLMProvider,
)


class _PacedService:
    """Attempt n waits first_token_delays[n] before its first token, then
    streams the tokens token_gap apart."""

    def __init__(self, first_token_delays, tokens=("Hello", " there"), token_gap=0.01):
        self.first_token_delays = list(first_token_delays)
        self.tokens = tokens
        self.token_gap = token_gap
        self.calls = 0
        self.cancelled = 0

    async def generate(self, messages, config, callback, component_name="unknown"):
        delay = self.first_token_delays[min(self.calls, len(self.first_token_delays) - 1)]
        self.calls += 1
        try:
            await asyncio.sleep(delay)
            acc = ""
            for i, tok in enumerate(self.tokens):
                if i:
                    await asyncio.sleep(self.token_gap)
                acc += tok
                await callback.on_token(tok, acc)
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        resp = LLMResponse(content=acc, model="t", provider="t")
        await callback.on_complete(resp)
        return resp


_CFG = LLMConfig(model="m", provider=LLMProvider.OPENAI_LANGCHAIN, streaming=True)
_MSGS = [LLMMessage(role="user", content="hi")]


async def _drain(agen):
    return [x async for x in agen]


@pytest.mark.asyncio
async def test_a_stall_on_the_first_attempt_is_retried_within_the_budget(caplog):
    svc = _PacedService([30.0, 0.05])
    t0 = time.monotonic()
    with caplog.at_level("INFO", logger="stella_agent_sdk.llm.service"):
        out = await _drain(stream_completion(
            svc, _MSGS, _CFG, component_name="response_generator",
            first_token_timeout=0.4, retry_first_token_timeout=0.2, log_context="turn t1",
        ))
    elapsed = time.monotonic() - t0

    assert out[-1] == ("Hello there", True)
    assert elapsed < 0.4 + 0.05 + 0.3, f"first token too late: {elapsed:.2f}s"
    assert svc.calls == 2 and svc.cancelled == 1, "the stalled call was not abandoned"
    messages = [r.getMessage() for r in caplog.records]
    assert sum("[REPLY-TIMEOUT]" in m for m in messages) == 1
    assert sum("[REPLY-RETRY]" in m for m in messages) == 1
    assert all("turn t1" in m for m in messages if "[REPLY-" in m)


@pytest.mark.asyncio
async def test_a_second_stall_raises_instead_of_hanging(caplog):
    svc = _PacedService([30.0, 30.0])
    t0 = time.monotonic()
    with caplog.at_level("INFO", logger="stella_agent_sdk.llm.service"):
        with pytest.raises(FirstTokenTimeout):
            await asyncio.wait_for(_drain(stream_completion(
                svc, _MSGS, _CFG, first_token_timeout=0.3, retry_first_token_timeout=0.2,
            )), timeout=3.0)
    assert time.monotonic() - t0 < 0.3 + 0.2 + 0.3
    await asyncio.sleep(0.01)  # let the second cancellation land
    assert svc.calls == 2 and svc.cancelled == 2
    assert sum("[REPLY-TIMEOUT]" in r.getMessage() for r in caplog.records) == 2


@pytest.mark.asyncio
async def test_a_long_stream_that_started_in_time_is_not_cut():
    # First token at 50ms, then 20 tokens 50ms apart: a second of streaming,
    # far past the 0.3s first-token budget.
    svc = _PacedService([0.05], tokens=tuple(f"w{i} " for i in range(20)), token_gap=0.05)
    out = await _drain(stream_completion(
        svc, _MSGS, _CFG, first_token_timeout=0.3, retry_first_token_timeout=0.2,
    ))
    assert out[-1][0] == "".join(f"w{i} " for i in range(20)) and out[-1][1] is True
    assert svc.calls == 1


@pytest.mark.asyncio
async def test_without_a_budget_nothing_changes():
    svc = _PacedService([0.5])
    out = await _drain(stream_completion(svc, _MSGS, _CFG))
    assert out[-1] == ("Hello there", True) and svc.calls == 1
