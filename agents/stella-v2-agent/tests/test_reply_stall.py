"""A stalled reply call after the bridge (#684).

7 Oct: the bridge was spoken, then the reply call stalled for 32s (the
client's 30s timeout plus its own retry) before anything else was said.
Decided 19 Oct: about 4s to the first token, one retry of about 2s, and when
that stalls too, a short spoken line so the turn ends and Stella listens again.
These run ResponseGenerator.generate() against a paced fake service with the
budgets scaled down.
"""

import asyncio
import time

from stella_agent_sdk.llm import LLMResponse
from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.pipeline.response_generator import ResponseGenerator, FALLBACK_LINE

BRIDGE = "Alright, let's stop the activity here."


class _PacedService:
    def __init__(self, first_token_delays, reply="That was a good round."):
        self.first_token_delays = first_token_delays
        self.reply = reply
        self.calls = 0

    async def generate(self, messages, config, callback, component_name="unknown"):
        delay = self.first_token_delays[min(self.calls, len(self.first_token_delays) - 1)]
        self.calls += 1
        await asyncio.sleep(delay)
        await callback.on_token(self.reply, self.reply)
        resp = LLMResponse(content=self.reply, model="t", provider="t")
        await callback.on_complete(resp)
        return resp


def _generate(svc, bridge=BRIDGE):
    gen = ResponseGenerator(llm_service=svc)
    gen.first_token_timeout = 0.3
    gen.retry_first_token_timeout = 0.2

    async def run():
        t0 = time.monotonic()
        out = [o async for o in gen.generate(
            session_id="s", user_input="Let's stop", directive=ResponseDirective(),
            conversation_history=[], sm_context={}, bridge=bridge, transcript_id="tr1",
        )]
        return out, time.monotonic() - t0

    return asyncio.run(asyncio.wait_for(run(), timeout=5.0))


def test_the_decided_budgets_are_the_defaults():
    gen = ResponseGenerator(llm_service=None)
    assert (gen.first_token_timeout, gen.retry_first_token_timeout) == (4.0, 2.0)


def test_one_stall_is_recovered_by_the_retry():
    out, elapsed = _generate(_PacedService([30.0, 0.05]))
    assert out[-1].is_final and out[-1].content == f"{BRIDGE} That was a good round."
    assert elapsed < 0.3 + 0.05 + 0.3


def test_two_stalls_end_the_turn_with_the_fallback_line():
    out, elapsed = _generate(_PacedService([30.0, 30.0]))
    assert len(out) == 1 and out[0].is_final
    # The bridge is already spoken under this transcript id; the text only
    # grows, or the SDK would speak the whole utterance again from the start.
    assert out[0].content == f"{BRIDGE} {FALLBACK_LINE}"
    assert out[0].transcript_id == "tr1"
    assert elapsed < 0.3 + 0.2 + 0.3


def test_the_fallback_line_without_a_bridge():
    out, _ = _generate(_PacedService([30.0, 30.0]), bridge="")
    assert [o.content for o in out] == [FALLBACK_LINE]
