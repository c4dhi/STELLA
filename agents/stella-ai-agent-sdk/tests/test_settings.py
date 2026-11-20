"""AgentSettings (#996): an agent's declared settings, defaults from agent.yaml."""

from pathlib import Path

import pytest

from stella_agent_sdk.settings import AgentSettings, declarations_of, find_manifest

MANIFEST = """
version: "2.0"
pipelineSchema:
  nodes:
    - id: expert_pool
      slots:
        - { id: ask_threshold, label: Ask, type: number, default: 0.45 }
        - { id: model, label: Model, type: select, options: [a, b], default: a }
settings:
  - { key: expert_pool.expert_context, type: text, default: "" }
  - { key: expert_pool.max_rounds, type: integer, default: 3 }
"""


@pytest.fixture
def settings(tmp_path: Path) -> AgentSettings:
    path = tmp_path / "agent.yaml"
    path.write_text(MANIFEST)
    return AgentSettings.from_manifest(path)


def test_slots_and_the_settings_section_are_both_declared(settings):
    assert settings.keys() == [
        "expert_pool.ask_threshold",
        "expert_pool.model",
        "expert_pool.expert_context",
        "expert_pool.max_rounds",
    ]


def test_an_unset_setting_reads_the_manifest_default(settings):
    settings.apply({"nodes": {}})
    assert settings.get("expert_pool.ask_threshold") == 0.45
    assert settings.get("expert_pool.max_rounds") == 3
    assert settings.is_set("expert_pool.ask_threshold") is False


def test_a_configured_value_wins_and_is_typed(settings):
    settings.apply({"nodes": {"expert_pool": {"ask_threshold": 1, "max_rounds": 5.0, "expert_context": "chat"}}})
    assert settings.get("expert_pool.ask_threshold") == 1.0
    assert isinstance(settings.get("expert_pool.ask_threshold"), float)
    assert settings.get("expert_pool.max_rounds") == 5
    assert settings.get("expert_pool.expert_context") == "chat"
    assert settings.is_set("expert_pool.expert_context") is True


def test_apply_replaces_what_an_earlier_call_set(settings):
    settings.apply({"nodes": {"expert_pool": {"ask_threshold": 0.9}}})
    settings.apply({"nodes": {}})
    assert settings.get("expert_pool.ask_threshold") == 0.45


def test_an_undeclared_value_is_reported_and_left_out(settings):
    undeclared = settings.apply({"nodes": {"expert_pool": {"safty_threshold": 0.8}, "other": {"x": 1}}})
    assert undeclared == ["expert_pool.safty_threshold", "other.x"]


def test_reading_an_undeclared_key_is_an_error(settings):
    with pytest.raises(KeyError):
        settings.get("expert_pool.safty_threshold")


def test_select_slots_are_enums():
    declared = declarations_of({"pipelineSchema": {"nodes": [{"id": "n", "slots": [{"id": "m", "type": "select"}]}]}})
    assert declared["n.m"].type == "enum"


def test_the_manifest_is_found_in_the_working_directory(tmp_path, monkeypatch):
    (tmp_path / "agent.yaml").write_text(MANIFEST)
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("STELLA_AGENT_MANIFEST", raising=False)
    assert find_manifest(["/nowhere/agent.yaml"]) == Path("agent.yaml")


def test_a_missing_manifest_says_where_it_looked(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("STELLA_AGENT_MANIFEST", raising=False)
    with pytest.raises(FileNotFoundError, match="looked in"):
        find_manifest()
