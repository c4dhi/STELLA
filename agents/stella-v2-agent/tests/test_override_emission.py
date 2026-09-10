"""Pipeline-level proxy for the live medical-critical smoke test (verdict directives).

Drives ``StellaV2Agent.process()`` with mocked I/O components but the REAL
arbitration + emission logic, to assert that a flagging expert's ``override`` /
``short_circuit`` verdict directive:
  - replaces the spoken response with the deterministic template, and
  - is emitted as a single finalized utterance that REUSES the bridge's
    transcript_id — so the acknowledgment bridge and the safety line are one
    coherent TTS utterance, not two disjoint chunks with a dangling bridge.

This is the closest executable check for the live "trip medical critical, confirm
the override is spoken coherently" smoke test, minus the TTS/LiveKit/gRPC stack.
"""

import asyncio
from unittest.mock import AsyncMock

from stella_agent_sdk.messages.input import AgentInput
from stella_agent_sdk.messages.types import OutputType

from stella_v2_agent.agent import StellaV2Agent
from stella_v2_agent.experts.base import ExpertConfig, VerdictDirective
from stella_v2_agent.models.expert_verdict import ExpertVerdict

BRIDGE_TEXT = "Mm, okay."
OVERRIDE_TEMPLATE = "Please contact emergency services right away."


def _build_agent(monkeypatch, *, action: str) -> StellaV2Agent:
    """A StellaV2Agent whose I/O stages are mocked but arbitration is real."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("STELLA_PLANS_DIR", raising=False)
    monkeypatch.delenv("STELLA_EXPERTS_DIR", raising=False)

    agent = StellaV2Agent()
    agent.sm_client = None  # no state machine -> Stage 5 no-ops, collected-keys skipped

    # Stage 1: a non-empty acknowledgment bridge (no Input Gate anymore — #363).
    #
    # process() consumes generate_STREAM, not generate — mocking the latter left
    # the real streaming call in place, which reached a live LLM, failed on the
    # test API key, and was rescued by the canned-inventory fallback. These
    # tests were green for the wrong reason. The inventories are gone and a
    # failed bridge is now silent, so mock what the agent actually calls.
    async def _bridge_stream(*_a, **_kw):
        yield BRIDGE_TEXT

    agent.bridge_generator.generate_stream = _bridge_stream

    # Stage 2: the medical expert returns a CRITICAL verdict.
    agent.expert_pool.run = AsyncMock(
        return_value=[
            ExpertVerdict(
                expert_name="medical", verdict="critical",
                confidence=0.95, priority=95, success=True,
            )
        ]
    )

    # Stage 3 runs the REAL arbitration; wire the medical expert's verdict directive.
    medical = ExpertConfig(
        name="medical", priority=95,
        verdict_directives={"critical": VerdictDirective(action, OVERRIDE_TEMPLATE)},
    )
    agent.expert_registry.as_map = lambda: {"medical": medical}

    agent._fetch_conversation_history = AsyncMock(return_value=[])
    return agent


async def _collect(agent, text="I have chest pain and can't breathe"):
    return [o async for o in agent.process(AgentInput.text_input("s1", text))]


def _text_chunks(outputs):
    return [o for o in outputs if o.type == OutputType.TEXT_CHUNK]


def _errors(outputs):
    return [o.content for o in outputs if o.type == OutputType.ERROR]


def test_override_chunk_reuses_bridge_transcript_id(monkeypatch):
    agent = _build_agent(monkeypatch, action="override")
    outputs = asyncio.run(_collect(agent))

    assert _errors(outputs) == []  # nothing swallowed by the top-level handler

    chunks = _text_chunks(outputs)
    bridge = next(c for c in chunks if c.metadata.get("tts_source") == "bridge")
    override = next(c for c in chunks if c.content == OVERRIDE_TEMPLATE)

    # The deterministic safety line is the SAME logical utterance as the bridge.
    assert override.transcript_id == bridge.transcript_id
    assert bridge.is_final is False
    assert override.is_final is True
    # Override REPLACES the reply: it is the last text chunk (Stage 4 was skipped).
    assert chunks[-1] is override
    # Language metadata is stamped so TTS speaks it in the coherent turn voice.
    assert "language" in override.metadata


def test_short_circuit_chunk_reuses_bridge_transcript_id_and_ends_turn(monkeypatch):
    agent = _build_agent(monkeypatch, action="short_circuit")
    outputs = asyncio.run(_collect(agent))

    assert _errors(outputs) == []

    chunks = _text_chunks(outputs)
    bridge = next(c for c in chunks if c.metadata.get("tts_source") == "bridge")
    short_circuit = next(c for c in chunks if c.content == OVERRIDE_TEMPLATE)

    assert short_circuit.transcript_id == bridge.transcript_id
    assert short_circuit.is_final is True
    # Turn ends immediately after the short-circuit line — nothing downstream.
    assert chunks[-1] is short_circuit
    assert len(chunks) == 2
