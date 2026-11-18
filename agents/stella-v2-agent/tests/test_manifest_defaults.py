"""The defaults an agent.yaml shows match what the code runs (#137, GitHub 866).

Optional env vars aren't put into the pod when unset, so the code's own
default is what runs; the manifest's ``default`` is only what the
configurator and the docs show. These were 300 ms (debounce) and 3000 ms
(expert timeout) while the code ran 0 and 15000.
"""
from pathlib import Path

import pytest
import yaml

from stella_agent_sdk.platform_env import PLATFORM_ENV
from stella_v2_agent.pipeline.expert_pool import DEFAULT_EXPERT_TIMEOUT_MS

AGENTS = Path(__file__).resolve().parents[2]
SDK_DEFAULTS = {v.name: v.default for v in PLATFORM_ENV}

# Agent-owned variables with a default, and the default their code uses.
# Jev runs v2's ExpertPool, so it shares v2's.
AGENT_DEFAULTS = {
    "stella-v2-agent": {"EXPERT_TIMEOUT_MS": str(DEFAULT_EXPERT_TIMEOUT_MS)},
    "stella-jev-agent": {"EXPERT_TIMEOUT_MS": str(DEFAULT_EXPERT_TIMEOUT_MS)},
    "stella-light-agent": {},
}


def optional_defaults(agent: str) -> dict:
    manifest = yaml.safe_load((AGENTS / agent / "agent.yaml").read_text())
    return {
        e["name"]: str(e["default"])
        for e in manifest.get("env", {}).get("optional", [])
        if e.get("default") is not None
    }


@pytest.mark.parametrize("agent", sorted(AGENT_DEFAULTS))
def test_sdk_owned_defaults_match_the_sdk(agent):
    shown = optional_defaults(agent)
    wrong = {
        name: (value, SDK_DEFAULTS[name])
        for name, value in shown.items()
        if name in SDK_DEFAULTS and SDK_DEFAULTS[name] is not None and value != SDK_DEFAULTS[name]
    }
    assert wrong == {}, f"{agent}/agent.yaml default vs the SDK's: {wrong}"


@pytest.mark.parametrize("agent", sorted(AGENT_DEFAULTS))
def test_agent_owned_defaults_match_the_code(agent):
    shown = optional_defaults(agent)
    for name, code_default in AGENT_DEFAULTS[agent].items():
        assert shown.get(name) == code_default, f"{agent}/agent.yaml {name}: {shown.get(name)} vs code {code_default}"


def test_expert_pool_runs_that_default_when_unset(monkeypatch):
    from stella_v2_agent.pipeline.expert_pool import ExpertPool

    monkeypatch.delenv("EXPERT_TIMEOUT_MS", raising=False)
    pool = ExpertPool(object(), object(), compiler_version="test")
    assert pool._timeout_ms == DEFAULT_EXPERT_TIMEOUT_MS == 15000
