import asyncio

import pytest

from stella_v2_agent.agent import StellaV2Agent


def _minimal_pipeline_config() -> dict:
    return {
        "nodes": {},
        "thresholds": {"history_limit": 20},
    }


def test_stella_v2_startup_with_effective_config_and_pipeline_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("STELLA_PLANS_DIR", raising=False)
    monkeypatch.delenv("STELLA_EXPERTS_DIR", raising=False)
    agent = StellaV2Agent()
    config = {
        "model": "gpt-4.1-mini",
        "temperature": 0.3,
        "expert_overrides": {},
        "pipeline_config": {
            "nodes": {
                "response_generator": {"temperature": 0.2},
                "bridge_generator": {"max_tokens": 25},
            },
            "thresholds": {"history_limit": 25},
        },
    }

    asyncio.run(agent.on_session_start("session-stella-v2", config))

    assert agent.session_id == "session-stella-v2"
    assert agent.config == config
    assert agent.llm_service.default_config.model == "gpt-4.1-mini"
    assert agent.llm_service.default_config.temperature == 0.3
    assert agent.response_generator.response_temperature == 0.2
    assert agent.bridge_generator.bridge_max_tokens == 25
    assert agent._custom_history_limit == 25
    # Unspecified slots keep their code defaults (partial override doesn't reset
    # them). These are the in-code fallbacks; in production the configurator fills
    # agent.yaml slot defaults into the effective config it sends.
    assert agent.response_generator.response_max_tokens == 200
    assert agent.bridge_generator.bridge_temperature == 0.7


def test_stella_v2_startup_requires_pipeline_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("STELLA_PLANS_DIR", raising=False)
    monkeypatch.delenv("STELLA_EXPERTS_DIR", raising=False)

    agent = StellaV2Agent()
    config = {
        "model": "gpt-4.1-mini",
        "temperature": 0.3,
    }

    with pytest.raises(ValueError, match="pipeline_config is required"):
        asyncio.run(agent.on_session_start("session-stella-v2-missing-pipeline", config))


def test_stella_v2_startup_accepts_minimal_pipeline_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("STELLA_PLANS_DIR", raising=False)
    monkeypatch.delenv("STELLA_EXPERTS_DIR", raising=False)

    agent = StellaV2Agent()
    config = {"pipeline_config": _minimal_pipeline_config()}

    asyncio.run(agent.on_session_start("session-stella-v2-minimal", config))

    assert agent.session_id == "session-stella-v2-minimal"
    assert agent.config == config


def test_stella_v2_pipeline_slot_overrides_merge_with_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("STELLA_PLANS_DIR", raising=False)
    monkeypatch.delenv("STELLA_EXPERTS_DIR", raising=False)

    agent = StellaV2Agent()
    config = {
        "pipeline_config": {
            "nodes": {
                "arbitration": {"tone_map": {"medical": "very_cautious"}},
            },
            "thresholds": {},
        }
    }

    asyncio.run(agent.on_session_start("session-stella-v2-merge", config))

    # Explicit overrides are applied.
    assert agent.arbitration._tone_map["medical"] == "very_cautious"

    # Unspecified defaults remain intact (partial merge behavior).
    assert agent.response_generator.response_max_tokens == 200
    # Other experts keep the tone their verdicts carry (#222: no code table).
    assert "legal" not in agent.arbitration._tone_map
    assert agent.expert_registry.get("legal").verdict_directives["high"].tone == "cautious"
    assert agent.expert_registry.get("noise_detection").verdict_directives["unclear"].tone == "neutral"
