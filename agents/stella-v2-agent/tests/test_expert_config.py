"""Tests for ExpertConfig + VerdictDirective (experts/base.py) and the registry's
coercion of verdict_directives overrides.

verdict_directives is the per-expert, per-verdict deterministic-response map that
drives literature-informed override/prepend/short_circuit at arbitration time.
These tests pin the (de)serialization and coercion contract that the configurator
and runtime config flow rely on.
"""

from stella_v2_agent.experts.base import ExpertConfig, VerdictDirective, VERDICT_ACTIONS
from stella_v2_agent.experts.registry import ExpertRegistry


# ---------------------------------------------------------------------------
# VerdictDirective coercion
# ---------------------------------------------------------------------------

def test_coerce_from_dict():
    vd = VerdictDirective.coerce({"action": "override", "template": "Call 911.", "description": "emergency"})
    assert isinstance(vd, VerdictDirective)
    assert vd.action == "override"
    assert vd.template == "Call 911."
    # The label + description are handed to the classifying LLM.
    assert vd.description == "emergency"


def test_coerce_passes_through_instance():
    original = VerdictDirective("prepend", "x")
    assert VerdictDirective.coerce(original) is original


def test_coerce_invalid_action_falls_back_to_inform():
    assert VerdictDirective.coerce({"action": "explode", "template": "x"}).action == "inform"
    assert "inform" in VERDICT_ACTIONS


def test_coerce_map_normalizes_all_entries():
    result = VerdictDirective.coerce_map({"critical": {"action": "override", "template": "T"}})
    assert isinstance(result["critical"], VerdictDirective)
    assert VerdictDirective.coerce_map("nonsense") == {}


# ---------------------------------------------------------------------------
# ExpertConfig round-trip
# ---------------------------------------------------------------------------

def test_from_dict_coerces_verdict_directives():
    cfg = ExpertConfig.from_dict({
        "name": "medical",
        "verdict_directives": {"critical": {"action": "override", "template": "T"}},
    })
    assert isinstance(cfg.verdict_directives["critical"], VerdictDirective)
    assert cfg.verdict_directives["critical"].action == "override"


def test_to_dict_serializes_verdict_directives():
    cfg = ExpertConfig(
        name="medical",
        verdict_directives={"high": VerdictDirective("prepend", "x", "a high concern")},
    )
    data = cfg.to_dict()
    assert data["verdict_directives"] == {
        "high": {"action": "prepend", "template": "x", "description": "a high concern"}
    }


def test_round_trip_preserves_verdict_directives():
    source = {
        "name": "legal",
        "priority": 90,
        "verdict_directives": {"critical": {"action": "short_circuit", "template": "Stop."}},
    }
    cfg = ExpertConfig.from_dict(source)
    again = ExpertConfig.from_dict(cfg.to_dict())
    assert again.verdict_directives["critical"].action == "short_circuit"
    assert again.verdict_directives["critical"].template == "Stop."


def test_default_expert_has_empty_directives():
    assert ExpertConfig(name="x").verdict_directives == {}


# ---------------------------------------------------------------------------
# Registry coercion of overrides (the configurator config path)
# ---------------------------------------------------------------------------

def test_runtime_override_coerces_verdict_directives():
    # Overrides arrive as plain dicts from AGENT_CONFIG; the registry must coerce
    # them to VerdictDirective instances so arbitration can read .action/.template.
    overrides = {
        "medical": {"verdict_directives": {"high": {"action": "prepend", "template": "Note."}}},
    }
    registry = ExpertRegistry(overrides=overrides)
    medical = registry.get("medical")
    assert medical is not None
    assert isinstance(medical.verdict_directives["high"], VerdictDirective)
    assert medical.verdict_directives["high"].action == "prepend"


def test_apply_config_coerces_built_in_and_custom():
    registry = ExpertRegistry()
    registry.apply_config({
        "experts": {"medical": {"verdict_directives": {"critical": {"action": "override", "template": "A"}}}},
        "custom_experts": {
            "compliance": {
                "description": "Compliance checks",
                "verdict_directives": {"violation": {"action": "short_circuit", "template": "Blocked."}},
            }
        },
    })
    medical = registry.get("medical")
    assert isinstance(medical.verdict_directives["critical"], VerdictDirective)
    assert medical.verdict_directives["critical"].action == "override"

    compliance = registry.get("compliance")
    assert compliance is not None
    assert isinstance(compliance.verdict_directives["violation"], VerdictDirective)
    assert compliance.verdict_directives["violation"].action == "short_circuit"


def test_as_map_exposes_registry():
    registry = ExpertRegistry()
    mapping = registry.as_map()
    assert "medical" in mapping
    assert mapping["medical"].name == "medical"


# ---------------------------------------------------------------------------
# Tool allow-list must survive loading from JSON
# ---------------------------------------------------------------------------

def test_from_dict_keeps_tool_allowlist():
    cfg = ExpertConfig.from_dict({"name": "x", "tools": ["a", "b"]})
    assert cfg.tools == ["a", "b"]
    assert ExpertConfig.from_dict(cfg.to_dict()).tools == ["a", "b"]


def test_shipped_experts_only_get_their_own_tools():
    # from_dict used to drop "tools", so every tool-calling expert was handed every
    # registered tool: task_extraction could start and end activities.
    from pathlib import Path

    from stella_v2_agent.experts.registry import ExpertRegistry

    config_dir = Path(__file__).parent.parent / "config" / "experts"
    registry = ExpertRegistry(experts_dir=str(config_dir))
    activity_tools = {"list_activities", "start_activity", "go_to_sleep"}
    assert set(registry.get("companion_router").tools) == activity_tools
    assert not activity_tools & set(registry.get("task_extraction").tools)
    assert registry.get("task_extraction").tools
