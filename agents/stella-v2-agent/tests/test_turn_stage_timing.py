"""Every turn records where its seconds went (#454).

The analytics timeline had no events for the context fetch, the end of bridge
generation, each expert, or arbitration: expert and arbitration latencies
reached only debug rows with no turn_id, which cannot be charted. These run a
real turn through StellaV2Agent.process() with the LLM stages stubbed, and
check that every stage lands as an analytics event on the turn's id, in order,
on the stt_end ground zero.
"""

import time

import pytest

from stella_v2_agent.models.expert_verdict import ExpertVerdict
from tests.test_bridge_expert_concurrency import _Recorder, _make_agent, _drain


def _timed_agent(verdicts=None):
    agent = _make_agent(_Recorder())
    t0 = time.perf_counter()
    agent._elapsed_ms = lambda: (time.perf_counter() - t0) * 1000  # stt_end at t0
    if verdicts is not None:
        async def _pool_run(names, user_input, history, sm_context):
            return verdicts
        agent.expert_pool.run = _pool_run
    return agent


def _events(outputs):
    return {
        o.metadata["stage"]: o.metadata
        for o in outputs if o.type.value == "analytics" and "elapsed_ms" in o.metadata
    }


@pytest.mark.asyncio
async def test_every_stage_of_a_turn_is_an_analytics_event_in_order():
    ev = _events(await _drain(_timed_agent()))
    order = [
        "context_fetch_start", "context_fetch_done", "expert_pool_start", "bridge_start",
        "bridge_ready", "bridge_done", "expert_pool_done", "arbitration_done",
    ]
    missing = [s for s in order if s not in ev]
    assert not missing, f"no analytics event for {missing}"
    times = [ev[s]["elapsed_ms"] for s in order]
    assert times == sorted(times), dict(zip(order, times))
    assert len({ev[s]["turn_id"] for s in order}) == 1


@pytest.mark.asyncio
async def test_each_expert_gets_its_own_lane_with_its_latency():
    verdicts = [
        ExpertVerdict(expert_name="noise_detection", verdict="clear", confidence=0.9,
                      latency_ms=30.0, priority=5),
        ExpertVerdict(expert_name="task_extraction", verdict="none", confidence=0.5,
                      latency_ms=110.0, success=False),
    ]
    ev = _events(await _drain(_timed_agent(verdicts)))
    pool_start = ev["expert_pool_start"]["elapsed_ms"]

    fast, slow = ev["expert_done:noise_detection"], ev["expert_done:task_extraction"]
    # Experts run concurrently from the pool's start, so each one finished at
    # pool start + its own latency.
    assert fast["elapsed_ms"] == pytest.approx(pool_start + 30.0, abs=0.5)
    assert slow["elapsed_ms"] == pytest.approx(pool_start + 110.0, abs=0.5)
    assert (fast["expert_name"], fast["verdict"], fast["confidence"], fast["latency_ms"],
            fast["success"], fast["priority"]) == ("noise_detection", "clear", 0.9, 30.0, True, 5)
    assert slow["success"] is False


@pytest.mark.asyncio
async def test_arbitration_done_carries_its_own_latency_and_outcome():
    ev = _events(await _drain(_timed_agent()))
    arb = ev["arbitration_done"]
    assert {"latency_ms", "favored_expert", "action"} <= set(arb)
