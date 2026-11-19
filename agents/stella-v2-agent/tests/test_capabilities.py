"""What Grace can do (#992): extras, the expert, arbitration and the reply prompt."""

import json
import os

import pytest

from stella_agent_sdk import prompts
from stella_v2_agent.capabilities import parse_extras, with_extras
from stella_v2_agent.experts.base import ExpertConfig
from stella_v2_agent.models.expert_verdict import ExpertVerdict
from stella_v2_agent.pipeline.arbitration import Arbitration
from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.prompts.response_prompt import build_response_system_prompt

from tests.test_companion_turns import FakeStateMachine, Session, _companion_in_activity

EXPERT_JSON = os.path.join(os.path.dirname(os.path.dirname(__file__)), "config", "experts", "capabilities.json")

COMPANION = {
    "mode": "companion",
    "capabilities": [
        {"id": "activity.quiz", "kind": "activity", "title": "Memory quiz", "description": "Ten questions"},
        {"id": "go_to_sleep", "kind": "action", "title": "Go to sleep", "description": ""},
    ],
}


def _expert():
    with open(EXPERT_JSON) as f:
        return json.load(f)


# ── extras ───────────────────────────────────────────────────────────────


def test_extras_are_one_entry_per_line_for_known_modes_only():
    assert parse_extras({
        "companion": "Answer general-knowledge questions\n\n- Tell a joke ",
        "plan": "",
        "weekend": "Anything",
    }) == {"companion": ["Answer general-knowledge questions", "Tell a joke"]}
    assert parse_extras(None) == {}


def test_extras_join_only_their_own_mode():
    extras = {"companion": ["Answer general-knowledge questions"], "plan": ["Something else"]}
    merged = with_extras(COMPANION, extras)
    assert [c["title"] for c in merged["capabilities"]] == [
        "Memory quiz", "Go to sleep", "Answer general-knowledge questions",
    ]
    assert merged["capabilities"][-1]["kind"] == "extra"
    assert len(COMPANION["capabilities"]) == 2  # not mutated


def test_without_stellas_list_there_is_nothing_to_extend():
    assert with_extras(None, {"companion": ["Answer anything"]}) is None


# ── the expert's prompt ──────────────────────────────────────────────────


def test_the_expert_prompt_compiles_fully_under_the_pinned_compiler():
    expert = _expert()
    assert prompts.get_compiler("1.2.0").validate(expert["system_prompt"]) == []
    compiled = prompts.compile(
        expert["system_prompt"], "1.2.0",
        sm_context={"capabilities": COMPANION, "persona": {"name": "Grace"}, "language": "de"},
        conversation_history=[], user_input="Wie wird das Wetter morgen?",
    )
    assert "- Memory quiz: Ten questions" in compiled
    assert "Grace" in compiled and "{{" not in compiled


def test_the_expert_ranks_below_medical_and_legal_and_only_informs():
    expert = _expert()
    assert 70 < expert["priority"] < 90  # above task_extraction, below legal (90) and medical (95)
    assert set(expert["verdict_directives"]) == {"within", "cannot_do", "off_role"}
    assert {d["action"] for d in expert["verdict_directives"].values()} == {"inform"}


# ── arbitration ──────────────────────────────────────────────────────────


def _verdict(name, verdict, priority, recommendation=""):
    return ExpertVerdict(expert_name=name, verdict=verdict, confidence=0.9,
                         recommendation=recommendation, priority=priority, success=True)


def _configs():
    return {"capabilities": ExpertConfig.from_dict(_expert())}


def test_within_is_not_a_flag():
    result = Arbitration().resolve([_verdict("capabilities", "within", 80)], expert_configs=_configs())
    assert result.directive.primary_action == ""
    assert result.favored_expert == ""


@pytest.mark.parametrize("verdict", ["cannot_do", "off_role"])
def test_a_flag_steers_the_reply_with_the_recommendation(verdict):
    say = "Say checking the weather isn't something you can do; mention the memory quiz; go back."
    result = Arbitration().resolve([_verdict("capabilities", verdict, 80, say)], expert_configs=_configs())
    assert result.directive.primary_action == say
    assert result.directive.action != "override"  # she still answers in her own words


def test_medical_keeps_priority():
    result = Arbitration().resolve(
        [
            _verdict("capabilities", "cannot_do", 80, "Say you can't do that"),
            _verdict("medical", "high", 95, "Be careful"),
        ],
        expert_configs=_configs(),
    )
    assert result.favored_expert == "medical"
    assert result.directive.primary_action == "Be careful"


# ── the reply's guidelines ───────────────────────────────────────────────


def test_guidelines_can_place_capabilities():
    prompt = build_response_system_prompt(
        sm_context={"capabilities": with_extras(COMPANION, {"companion": ["Answer general-knowledge questions"]})},
        directive=ResponseDirective(),
        conversation_history=[],
        custom_guidelines="You can do:\n{{capabilities}}",
    )
    assert "- Memory quiz: Ten questions\n- Go to sleep\n- Answer general-knowledge questions" in prompt


# ── a real turn ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_every_turn_carries_stellas_list_with_the_extras():
    session = Session(companion=True, sm=FakeStateMachine())
    session.agent._capability_extras = {"companion": ["Answer general-knowledge questions"]}
    await session.turn("Was ist die Hauptstadt von Australien?")

    caps = session.pool_inputs[-1]["sm_context"]["capabilities"]
    assert caps["mode"] == "companion"
    assert [c["title"] for c in caps["capabilities"]] == ["Go to sleep", "Answer general-knowledge questions"]
    assert session.reply["sm_context"]["capabilities"] == caps


@pytest.mark.asyncio
async def test_inside_an_activity_the_list_is_the_activity():
    session = await _companion_in_activity()
    await session.turn("Ich heiße Felix")
    caps = session.pool_inputs[-1]["sm_context"]["capabilities"]
    assert caps["mode"] == "activity"
    assert [c["id"] for c in caps["capabilities"]] == ["follow_plan", "leave_activity"]


def _agent_with(compiler_version):
    from stella_v2_agent.agent import StellaV2Agent
    from stella_v2_agent.experts.registry import ExpertRegistry

    agent = StellaV2Agent.__new__(StellaV2Agent)
    agent.expert_registry = ExpertRegistry()
    agent._shipped_enabled = {n: e.enabled for n, e in agent.expert_registry.as_map().items()}
    agent._compiler_version = compiler_version
    return agent


def _saved(authored=None, enabled=None):
    """A pipeline config as resolveForDeploy hands it over."""
    pipeline = {"nodes": {}}
    if enabled is not None:
        pipeline["nodes"]["expert_pool"] = {"experts": {"capabilities": {"enabled": enabled}}}
    if authored is not None:
        pipeline["authored_compiler_version"] = authored
    return pipeline


def _fit(agent, pipeline):
    pool = pipeline["nodes"].get("expert_pool")
    if pool:
        agent.expert_registry.apply_config(pool)
    agent._fit_experts_to_configuration(pipeline)
    return agent.expert_registry.get("capabilities").enabled


def test_a_new_configuration_gets_the_expert():
    assert _fit(_agent_with("1.2.0"), _saved(authored="1.2.0")) is True


def test_a_configuration_saved_before_the_expert_existed_runs_without_it():
    # Felix (#191): existing saved configurations keep running as they were.
    assert _fit(_agent_with("1.2.0"), _saved(authored="1.1.0")) is False
    assert "medical" in [e.name for e in _agent_with("1.2.0").expert_registry.get_enabled()]


def test_without_an_authored_version_it_counts_as_saved_before():
    # Inline pipeline configs and rows with no compiler floor carry none.
    assert _fit(_agent_with("1.2.0"), _saved()) is False
    assert _fit(_agent_with("1.2.0"), _saved(authored="garbage")) is False


def test_an_old_configuration_can_switch_it_on():
    assert _fit(_agent_with("1.2.0"), _saved(authored="1.1.0", enabled=True)) is True


def test_a_new_configuration_can_switch_it_off():
    assert _fit(_agent_with("1.2.0"), _saved(authored="1.2.0", enabled=False)) is False


def test_a_compiler_without_capabilities_switches_the_expert_off():
    # A configuration pinned to 1.1.0 would send the expert the literal
    # {{capabilities}}; it gets no list to judge against, so it does not run,
    # even when the configuration switched it on.
    assert _fit(_agent_with("1.1.0"), _saved(authored="1.2.0")) is False
    assert _fit(_agent_with("1.1.0"), _saved(authored="1.2.0", enabled=True)) is False


def test_an_unknown_compiler_does_not_decide_it():
    assert _fit(_agent_with("0.1.0"), _saved(authored="1.2.0")) is True


def test_nothing_carries_over_between_sessions_on_one_instance():
    agent = _agent_with("1.2.0")
    assert _fit(agent, _saved(authored="1.1.0")) is False
    assert _fit(agent, _saved(authored="1.2.0")) is True
    assert _fit(agent, _saved(authored="1.2.0", enabled=False)) is False
    assert _fit(agent, _saved(authored="1.3.0")) is True


def test_an_expert_without_a_floor_is_not_touched():
    agent = _agent_with("1.2.0")
    _fit(agent, _saved(authored="1.0.0"))
    assert agent.expert_registry.get("medical").enabled is True


def test_the_shipped_json_carries_the_floor():
    import json
    from pathlib import Path

    raw = json.loads((Path(__file__).resolve().parents[1] / "config/experts/capabilities.json").read_text())
    assert raw["enabled_from_compiler"] == "1.2.0"
