"""Per-expert engage/tap-out contract tests (#363).

With the Input Gate removed, there is no longer a centralized relevance judge
*or its backstop*: every enabled expert runs every turn and must self-gate. The
load-bearing invariants are therefore:

  1. Each expert declares a single canonical TAP-OUT (abstain) verdict that
     arbitration's ``_is_flagging`` treats as inactive — so a tapped-out expert
     never leaks a tone/directive into the response.
  2. Every other declared verdict is an ENGAGE verdict that arbitration *does*
     treat as flagging.
  3. When every expert taps out on the same turn (the common case), arbitration
     surfaces a fully neutral, no-action directive.
  4. The responsibilities the gate used to own still hold — most importantly the
     noise_detection unclear → short-circuit path (old ``gate_result.failed``).

These run against the REAL shipped configs in ``config/experts/`` and the REAL
arbitration logic — no LLM, deterministic, CI-safe. The opt-in LLM precision/
recall eval lives in ``test_expert_engagement_eval.py``.
"""

import json
from pathlib import Path

import pytest

from stella_v2_agent.experts.registry import ExpertRegistry
from stella_v2_agent.pipeline.arbitration import Arbitration
from stella_v2_agent.models.expert_verdict import ExpertVerdict


CONFIG_DIR = Path(__file__).parent.parent / "config" / "experts"


# Each built-in expert's engagement contract: the canonical tap-out verdict and
# a representative engage verdict whose effect we can observe through arbitration.
# This is the executable spec for "when do you engage vs tap out".
CONTRACTS = {
    "noise_detection": {"abstain": "clear", "engage": "unclear"},
    "medical": {"abstain": "none", "engage": "high"},
    "legal": {"abstain": "none", "engage": "high"},
    "probing": {"abstain": "no_probe", "engage": "needs_clarification"},
    "timekeeper": {"abstain": "on_track", "engage": "stuck"},
    # task_extraction is tool-calling: it has no verdict_directives. Its abstain
    # is the implicit "called no tool" verdict; engaging means it ran a tool.
    "task_extraction": {"abstain": "no_tool_calls", "engage": "tool_calls_executed"},
}


@pytest.fixture(scope="module")
def registry() -> ExpertRegistry:
    # Pin to the shipped config dir so the test validates what actually deploys,
    # regardless of any STELLA_EXPERTS_DIR set in the environment.
    return ExpertRegistry(experts_dir=str(CONFIG_DIR))


@pytest.fixture(scope="module")
def flagging(registry) -> dict:
    # Which verdicts flag is the ``flag`` on each verdict in the file (#222).
    return {
        name: {v for v, d in cfg.verdict_directives.items() if d.flag}
        for name, cfg in registry.as_map().items()
    }


def _verdict(name: str, verdict: str, *, priority: int = 50, recommendation: str = "",
             raw_output: dict | None = None) -> ExpertVerdict:
    return ExpertVerdict(
        expert_name=name, verdict=verdict, confidence=0.9, recommendation=recommendation,
        priority=priority, success=True, raw_output=raw_output or {},
    )


# ---------------------------------------------------------------------------
# Structural: the shipped configs honor the contract
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", list(CONTRACTS))
def test_expert_is_shipped_and_enabled(registry, name):
    cfg = registry.get(name)
    assert cfg is not None, f"{name} missing from config/experts/"
    assert cfg.enabled is True


@pytest.mark.parametrize("name", list(CONTRACTS))
def test_abstain_verdict_is_not_flagging(flagging, name):
    # A tapped-out expert must never count as flagging — that is what keeps it
    # from leaking a directive into the response now that the gate is gone.
    abstain = CONTRACTS[name]["abstain"]
    assert abstain not in flagging[name], (
        f"{name} abstain verdict {abstain!r} is in its flagging set — a tap-out "
        f"would leak a directive every turn"
    )


@pytest.mark.parametrize("name", list(CONTRACTS))
def test_engage_verdict_is_flagging(flagging, name):
    assert CONTRACTS[name]["engage"] in flagging[name]


@pytest.mark.parametrize("name", ["noise_detection", "medical", "legal", "probing", "timekeeper"])
def test_declared_verdicts_partition_into_one_abstain_and_the_rest_engage(registry, flagging, name):
    # For JSON-mode experts, the verdict_directives keys must partition cleanly:
    # exactly the canonical abstain verdict is non-flagging; every other declared
    # verdict is a flagging engage verdict. No ambiguous middle.
    cfg = registry.get(name)
    declared = set(cfg.verdict_directives)
    abstain = CONTRACTS[name]["abstain"]
    assert abstain in declared, f"{name} does not declare its abstain verdict {abstain!r}"
    engage_declared = declared - {abstain}
    assert engage_declared == flagging[name], (
        f"{name}: declared engage verdicts {engage_declared} do not match "
        f"arbitration's flagging set {flagging[name]}"
    )


@pytest.mark.parametrize("name", list(CONTRACTS))
def test_no_always_triggered_residue(registry, name):
    # The always-run concept is fully removed (#363): neither the dataclass nor
    # the raw JSON may carry it.
    cfg = registry.get(name)
    assert not hasattr(cfg, "always_triggered")
    raw = json.loads((CONFIG_DIR / f"{name}.json").read_text())
    assert "always_triggered" not in raw, f"{name}.json still carries always_triggered"


@pytest.mark.parametrize("name", ["noise_detection", "medical", "legal", "probing", "timekeeper"])
def test_prompt_states_engage_and_tap_out(registry, name):
    # The engage/tap-out contract must be explicit in the expert's own prompt —
    # that is what replaces the gate's centralized relevance judgment.
    prompt = registry.get(name).system_prompt.lower()
    assert "tap out" in prompt and "engage" in prompt, (
        f"{name} prompt does not spell out its engage/tap-out contract"
    )


# ---------------------------------------------------------------------------
# Arbitration boundary: tap-out is silent, engage surfaces
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("name", list(CONTRACTS))
def test_tap_out_surfaces_no_directive(registry, name):
    # A lone tapped-out expert must yield the neutral default directive — no
    # tone shift, no must_avoid, no follow-up, no short-circuit.
    arb = Arbitration()
    cfg = registry.get(name)
    v = _verdict(name, CONTRACTS[name]["abstain"], priority=cfg.priority)
    result = arb.resolve([v], expert_configs=registry.as_map())

    d = result.directive
    assert d.tone == "neutral"
    assert d.short_circuit is False
    assert d.ask_followup is False
    assert d.force_redirect is False
    assert d.must_avoid == []
    assert d.primary_action == ""
    assert result.favored_expert == ""


def test_noise_unclear_short_circuits(registry):
    # Regression for the old gate_result.failed path: garbled input must still
    # short-circuit the turn and ask the user to repeat.
    arb = Arbitration()
    v = _verdict("noise_detection", "unclear", priority=100)
    result = arb.resolve([v], expert_configs=registry.as_map())

    assert result.directive.short_circuit is True
    assert result.directive.action == "short_circuit"
    # Empty template falls back to the locale-aware "didn't catch that" line.
    assert result.directive.resolved_response == arb.gate_failure_message


@pytest.mark.parametrize("name", ["medical", "legal"])
def test_safety_high_adds_must_avoid(registry, name):
    arb = Arbitration()
    cfg = registry.get(name)
    v = _verdict(name, "high", priority=cfg.priority, recommendation="be careful")
    result = arb.resolve([v], expert_configs=registry.as_map())

    assert result.directive.must_avoid, f"{name} high should add a must_avoid constraint"
    # high maps to a prepend directive in the shipped config.
    assert result.directive.action == "prepend"


def test_probing_needs_clarification_asks_followup(registry):
    arb = Arbitration()
    v = _verdict("probing", "needs_clarification", priority=60, recommendation="What's your goal?")
    result = arb.resolve([v], expert_configs=registry.as_map())
    assert result.directive.ask_followup is True
    assert result.directive.followup_question == "What's your goal?"


def test_timekeeper_stuck_asks_followup_when_alone(registry):
    arb = Arbitration()
    v = _verdict("timekeeper", "stuck", priority=50, recommendation="Shall we move on?")
    result = arb.resolve([v], expert_configs=registry.as_map())
    assert result.directive.ask_followup is True


# ---------------------------------------------------------------------------
# The gate-replacement invariant: every expert reporting, all tapped out
# ---------------------------------------------------------------------------

def test_all_experts_tapping_out_is_fully_neutral(registry):
    # The common case now that every enabled expert runs every turn: all six
    # report their abstain verdict. Arbitration must filter them ALL and produce
    # the same neutral directive as if no expert had run.
    arb = Arbitration()
    verdicts = [
        _verdict(name, CONTRACTS[name]["abstain"], priority=registry.get(name).priority)
        for name in CONTRACTS
    ]
    result = arb.resolve(verdicts, expert_configs=registry.as_map())

    d = result.directive
    assert d.tone == "neutral"
    assert d.short_circuit is False
    assert d.ask_followup is False
    assert d.force_redirect is False
    assert d.must_avoid == []
    assert d.primary_action == ""
    assert result.conflicts == []


def test_one_engaging_expert_among_tap_outs_still_surfaces(registry):
    # Full set reports; only medical engages. Its directive must survive the
    # crowd of abstentions.
    arb = Arbitration()
    verdicts = []
    for name in CONTRACTS:
        verdict = "high" if name == "medical" else CONTRACTS[name]["abstain"]
        verdicts.append(_verdict(name, verdict, priority=registry.get(name).priority,
                                 recommendation="careful"))
    result = arb.resolve(verdicts, expert_configs=registry.as_map())

    assert result.directive.must_avoid
    assert result.favored_expert == "medical"
