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
    agent._compiler_version = compiler_version
    return agent


def test_a_compiler_without_capabilities_switches_the_expert_off():
    # A configuration pinned to 1.1.0 would send the expert the literal
    # {{capabilities}}; it gets no list to judge against, so it does not run.
    agent = _agent_with("1.1.0")
    agent._fit_experts_to_compiler()
    assert agent.expert_registry.get("capabilities").enabled is False
    assert "medical" in [e.name for e in agent.expert_registry.get_enabled()]


def test_the_pinned_compiler_keeps_it_on():
    agent = _agent_with("1.2.0")
    agent._fit_experts_to_compiler()
    assert agent.expert_registry.get("capabilities").enabled is True


def test_a_later_session_on_the_new_compiler_gets_it_back():
    agent = _agent_with("1.1.0")
    agent._fit_experts_to_compiler()
    agent._compiler_version = "1.2.0"
    agent._fit_experts_to_compiler()
    assert agent.expert_registry.get("capabilities").enabled is True


def test_switched_off_by_configuration_stays_off():
    agent = _agent_with("1.2.0")
    agent.expert_registry.get("capabilities").enabled = False
    agent._fit_experts_to_compiler()
    assert agent.expert_registry.get("capabilities").enabled is False


def test_an_unknown_compiler_leaves_it_alone():
    agent = _agent_with("0.1.0")
    agent._fit_experts_to_compiler()
    assert agent.expert_registry.get("capabilities").enabled is True
