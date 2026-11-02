import asyncio

import pytest

from stella_jev_agent import StellaJevAgent
from stella_jev_agent.pool import JevExpertPool
from stella_jev_agent.stages import JevBargeInEvaluator, JevResponseGenerator, NoBridge


def _config(**extra) -> dict:
    return {
        "model": "gpt-5.4-mini",
        "pipeline_config": {
            "nodes": {
                "response_generator": {"temperature": 0.2},
                "expert_pool": {"ask_threshold": 0.6, "max_ask_backs": 2},
                "barge_in": {"resume_threshold": 0.9},
            },
            "thresholds": {"history_limit": 25},
        },
        **extra,
    }


@pytest.fixture
def agent(monkeypatch: pytest.MonkeyPatch) -> StellaJevAgent:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.delenv("STELLA_PLANS_DIR", raising=False)
    monkeypatch.delenv("STELLA_EXPERTS_DIR", raising=False)
    return StellaJevAgent()


def test_starts_without_a_jev_key_and_swaps_the_stages(agent: StellaJevAgent) -> None:
    asyncio.run(agent.on_session_start("session-jev", _config()))

    assert agent._agent_type == "stella-jev-agent"
    assert isinstance(agent.bridge_generator, NoBridge)
    assert isinstance(agent.expert_pool, JevExpertPool)
    assert isinstance(agent.response_generator, JevResponseGenerator)
    assert isinstance(agent.barge_in_evaluator, JevBargeInEvaluator)
    assert agent.response_generator.response_temperature == 0.2
    assert agent.expert_pool.ask_threshold == 0.6
    assert agent.ask_back.max_per_session == 2
    assert agent.barge_in_evaluator.resume_threshold == 0.9


def test_loads_its_own_experts(agent: StellaJevAgent) -> None:
    names = agent.expert_registry.get_enabled_names()
    assert "common_sense" in names
    assert "noise_detection" not in names


def test_expert_overrides_keep_the_jev_pool(agent: StellaJevAgent) -> None:
    asyncio.run(agent.on_session_start(
        "session-jev", _config(expert_overrides={"legal": {"enabled": False}})
    ))

    assert isinstance(agent.expert_pool, JevExpertPool)
    assert agent.expert_pool.ask_threshold == 0.6
    names = agent.expert_registry.get_enabled_names()
    assert "common_sense" in names and "legal" not in names


def test_requires_a_pipeline_config(agent: StellaJevAgent) -> None:
    with pytest.raises(ValueError, match="pipeline_config"):
        asyncio.run(agent.on_session_start("session-jev", {"model": "gpt-5.4-mini"}))
