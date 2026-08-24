"""Bridge and Expert Pool must run CONCURRENTLY, not back to back (#455).

The pool used to be awaited only after the bridge stream had fully drained, so
the turn's critical path was ``bridge + experts``. Audibly that is the bridge
finishing, then a silence the length of the slowest expert before the response
starts. The pool is now kicked off before the bridge stream, making the path
``max(bridge, experts)``.

These tests pin the two things that can silently regress:
  1. the overlap itself (start ordering + wall clock), and
  2. that overlapping did not weaken any ordering guarantee downstream —
     arbitration and the response must still see a fully-completed pool.
"""

import asyncio
import time
from types import SimpleNamespace

import pytest

from stella_agent_sdk import AgentInput, AgentOutput
from stella_v2_agent.agent import StellaV2Agent
from stella_v2_agent.models.expert_verdict import ExpertVerdict
from stella_v2_agent.pipeline.arbitration import Arbitration

BRIDGE_MS = 120
EXPERTS_MS = 120


class _Recorder:
    """Shared clock so both stages' spans are comparable."""

    def __init__(self):
        self.bridge_start = None
        self.bridge_end = None
        self.pool_start = None
        self.pool_end = None
        self.pool_cancelled = False
        self.verdicts_at_arbitration = None
        self.response_collected_keys = None

    @staticmethod
    def now():
        return time.perf_counter()


def _make_agent(
    rec,
    *,
    bridge_ms=BRIDGE_MS,
    experts_ms=EXPERTS_MS,
    pool_error=None,
    already_collected=None,
    collected=None,
):
    """A StellaV2Agent with only the LLM-touching stages stubbed out.

    Arbitration is the REAL implementation so the test exercises the actual
    consumer of ``all_verdicts`` rather than a stand-in that cannot notice a
    half-finished pool.
    """
    agent = StellaV2Agent.__new__(StellaV2Agent)

    agent._audio_pipeline = None  # has_audio is a property → _elapsed_ms returns 0.0
    agent._is_processing = False
    agent._turn_counter = 0
    agent._last_reply_text = ""
    agent._session_language = None
    agent._session_voice = None
    agent._custom_history_limit = 20
    agent._plan_system_prompt = None
    agent._plan_config = {}
    agent._compiler_version = "1.0.0"

    # Mirrors production: task_extraction sets deliverables via tools DURING the
    # pool run, so a live read after the pool sees more than the turn-start
    # snapshot did. `collected` is what that live read returns.
    agent.sm_client = SimpleNamespace(
        get_collected_deliverables=_async_return(dict(collected or {})),
    )
    agent.language_resolver = SimpleNamespace(
        set_seed=lambda *_a, **_k: None,
        resolve=lambda *_a, **_k: "en",
        forced=None,
    )
    agent.expert_registry = SimpleNamespace(
        get_enabled_names=lambda: ["noise_detection", "task_extraction"],
        as_map=lambda: {},
    )
    agent.arbitration = Arbitration()
    agent.tool_registry = None

    async def _fetch_history(limit=20):
        return []

    async def _fetch_sm():
        return {
            "state": {"id": "s1", "title": "Phase"},
            "deliverables": [],
            "collected_deliverables": dict(already_collected or {}),
        }

    agent._fetch_conversation_history = _fetch_history  # type: ignore
    agent._fetch_sm_context = _fetch_sm  # type: ignore

    # ── Bridge: streams two accumulated chunks over bridge_ms ──
    async def _bridge_stream(text, history, language=None, variables=None):
        rec.bridge_start = rec.now()
        try:
            await asyncio.sleep(bridge_ms / 2000)
            yield "Got it."
            await asyncio.sleep(bridge_ms / 2000)
            yield "Got it. Let me think."
        finally:
            rec.bridge_end = rec.now()

    agent.bridge_generator = SimpleNamespace(generate_stream=_bridge_stream)

    # ── Expert pool: one slow await, so cancellation is observable ──
    async def _pool_run(names, user_input, history, sm_context):
        rec.pool_start = rec.now()
        try:
            await asyncio.sleep(experts_ms / 1000)
            if pool_error is not None:
                raise pool_error
            rec.pool_end = rec.now()
            return [
                ExpertVerdict(expert_name="noise_detection", verdict="clear", confidence=0.9),
                ExpertVerdict(expert_name="task_extraction", verdict="none", confidence=0.5),
            ]
        except asyncio.CancelledError:
            rec.pool_cancelled = True
            raise

    agent.expert_pool = SimpleNamespace(run=_pool_run)

    # ── Response generator: records what arbitration/response actually saw ──
    async def _response_generate(**kwargs):
        rec.response_collected_keys = list(
            kwargs["sm_context"].get("_collected_keys", [])
        )
        yield AgentOutput.text_chunk(
            kwargs["session_id"], "Here is the answer.",
            transcript_id=kwargs.get("transcript_id"), is_final=True,
        )

    agent.response_generator = SimpleNamespace(generate=_response_generate)

    async def _post_response(session_id, expert_verdicts):
        rec.verdicts_at_arbitration = list(expert_verdicts)
        return
        yield  # pragma: no cover — makes this an async generator

    agent._process_post_response = _post_response  # type: ignore

    return agent


def _async_return(value):
    async def _inner(*_a, **_k):
        return value
    return _inner


def _input():
    return AgentInput.text_input(session_id="sess-1", text="hello there")


async def _drain(agent):
    return [out async for out in agent.process(_input())]


@pytest.mark.asyncio
async def test_pool_starts_before_the_bridge_finishes():
    """The invariant, stated directly: the two spans overlap."""
    rec = _Recorder()
    await _drain(_make_agent(rec))

    assert rec.pool_start is not None, "expert pool never ran"
    # Serialised code would put pool_start AFTER bridge_end.
    assert rec.pool_start < rec.bridge_end, (
        "expert pool started only after the bridge drained — it is serialised again"
    )
    assert rec.pool_start <= rec.bridge_start + 0.05


@pytest.mark.asyncio
async def test_turn_costs_max_not_sum():
    """Wall clock is the point of the change, so measure it."""
    rec = _Recorder()
    started = time.perf_counter()
    await _drain(_make_agent(rec))
    elapsed_ms = (time.perf_counter() - started) * 1000

    serialised = BRIDGE_MS + EXPERTS_MS
    # Generous margin: this must fail on a regression, not on a busy CI box.
    assert elapsed_ms < serialised * 0.8, (
        f"turn took {elapsed_ms:.0f}ms; serialised would be ~{serialised}ms"
    )


@pytest.mark.asyncio
async def test_arbitration_still_sees_every_verdict():
    """Overlapping must not let a half-finished pool reach downstream stages."""
    rec = _Recorder()
    outputs = await _drain(_make_agent(rec))

    assert rec.pool_end is not None, "pool did not complete before the turn ended"
    names = {v.expert_name for v in (rec.verdicts_at_arbitration or [])}
    assert names == {"noise_detection", "task_extraction"}

    # The pool must have finished before the response was generated.
    assert any(o.type.value == "text_chunk" and o.is_final for o in outputs)


@pytest.mark.asyncio
async def test_pool_span_is_visible_in_the_analytics_timeline():
    """The marker that makes the overlap measurable in production."""
    rec = _Recorder()
    outputs = await _drain(_make_agent(rec))
    stages = [
        o.metadata.get("stage") for o in outputs
        if o.type.value == "analytics" and o.metadata.get("stage")
    ]
    assert "expert_pool_start" in stages
    assert "bridge_start" in stages
    assert "expert_pool_done" in stages
    # The pool must be launched before the bridge, not after it.
    assert stages.index("expert_pool_start") < stages.index("bridge_start")
    assert stages.index("bridge_start") < stages.index("expert_pool_done")


@pytest.mark.asyncio
async def test_barge_in_mid_bridge_cancels_the_pool():
    """Closing the generator early must not orphan an in-flight pool."""
    rec = _Recorder()
    # Pool outlives the bridge so it is guaranteed in flight when we abandon.
    agent = _make_agent(rec, bridge_ms=40, experts_ms=5000)

    gen = agent.process(_input())
    # Advance into the bridge stream — that is where a barge-in interrupts.
    async for out in gen:
        if out.type.value == "text_chunk":
            break
    assert rec.pool_start is not None, "pool was not in flight yet; test is not testing anything"

    await gen.aclose()  # what a committed barge-in does
    await asyncio.sleep(0)  # let the cancellation land

    assert rec.pool_cancelled, "expert pool kept running after the turn was abandoned"
    assert rec.pool_end is None


@pytest.mark.asyncio
async def test_pool_failure_surfaces_as_a_processing_error():
    """A pool that raises must be reported, not swallowed by the task boundary."""
    rec = _Recorder()
    agent = _make_agent(rec, pool_error=RuntimeError("expert boom"))
    outputs = await _drain(agent)

    errors = [o for o in outputs if o.type.value == "error"]
    assert errors, "expert pool failure produced no error output"
    assert "expert boom" in errors[0].content


@pytest.mark.asyncio
async def test_collected_keys_still_diffs_turn_start_against_post_pool():
    """The ordering the concurrency change must not break (#455 AC).

    ``pre_collected`` comes from the turn-start sm_context snapshot and
    ``post_collected`` from a LIVE read that has to happen AFTER the pool is
    joined. Read the live value too early — a tempting "optimisation" now that
    the pool is a task — and a deliverable the user just supplied drops out of
    ``collected_keys``, so the response prompt re-asks for it.
    """
    rec = _Recorder()
    agent = _make_agent(
        rec,
        already_collected={"name": "Felix"},          # known before this turn
        collected={"name": "Felix", "goal": "sleep"}, # task_extraction added "goal"
    )
    await _drain(agent)

    assert rec.response_collected_keys == ["goal"], (
        "collected_keys must contain only what THIS turn collected"
    )
