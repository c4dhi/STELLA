"""#222: arbitration reads verdict rules from the expert files instead of code
tables. On the shipped files it must give the same result as before, verdict by
verdict, for every combination of the built-in experts' verdicts. Jev runs this
arbitration on its own expert files, so those are checked too."""

import dataclasses
import itertools
from pathlib import Path

import pytest

from stella_v2_agent.experts.registry import ExpertRegistry
from stella_v2_agent.models.expert_verdict import ExpertVerdict
from stella_v2_agent.pipeline.arbitration import Arbitration

from tests.legacy_arbitration_222 import Arbitration as LegacyArbitration

CONFIGS = ExpertRegistry().as_map()

# Every verdict each built-in expert can give, plus "doesn't report" (None).
VERDICTS = {
    name: [None, *cfg.verdict_directives]
    for name, cfg in CONFIGS.items()
    if name != "companion_router"
}

SM_CONTEXT = {
    "language": "en",
    "deliverables": [
        {"key": "age", "description": "the participant's age", "status": "pending"},
        {"key": "name", "description": "their name", "status": "collected"},
    ],
}


def _verdict(name, value, configs=CONFIGS):
    cfg = configs[name]
    return ExpertVerdict(
        expert_name=name,
        verdict=value,
        confidence=0.9,
        recommendation=f"{name} says {value}",
        priority=cfg.priority,
        success=True,
        raw_output={"deliverable_signals": ["age"]} if name == "probing" else {},
    )


def _outcome(result):
    return dataclasses.asdict(result.directive), result.conflicts, result.favored_expert


JEV_EXPERTS = Path(__file__).resolve().parents[2] / "stella-jev-agent" / "config" / "experts"


def test_every_combination_of_built_in_verdicts_resolves_as_before():
    _check_every_combination(CONFIGS, LegacyArbitration())


@pytest.mark.skipif(not JEV_EXPERTS.is_dir(), reason="Jev's expert files are not next to V2")
def test_every_combination_of_jev_verdicts_resolves_as_before():
    old = LegacyArbitration()
    old._flagging_verdicts["common_sense"] = {"slight_doubt", "doesnt_fit"}  # what Jev patched in
    # Jev's medical and legal become safety experts in #223; until then the
    # analytics line names the expert where it used to say "safety".
    _check_every_combination(ExpertRegistry(experts_dir=str(JEV_EXPERTS)).as_map(), old, jev_conflict_text=True)


def _check_every_combination(configs, old, jev_conflict_text=False):
    new = Arbitration()
    verdicts_by_expert = {
        name: [None, *cfg.verdict_directives] for name, cfg in configs.items() if name != "companion_router"
    }
    names = list(verdicts_by_expert)
    checked = 0
    for combo in itertools.product(*(verdicts_by_expert[n] for n in names)):
        verdicts = [_verdict(n, v, configs) for n, v in zip(names, combo) if v is not None]
        for context in (SM_CONTEXT, None):
            args = dict(sm_context=context, expert_configs=configs, user_input="hello")
            got = _outcome(new.resolve(verdicts, **args))
            if jev_conflict_text:
                got = (got[0], [c.replace("medical takes", "safety takes").replace("legal takes", "safety takes") for c in got[1]], got[2])
            assert got == _outcome(old.resolve(verdicts, **args)), combo
            checked += 1
    assert checked > 10_000


def test_a_failed_expert_is_ignored_as_before():
    old, new = LegacyArbitration(), Arbitration()
    for name, values in VERDICTS.items():
        for value in values[1:]:
            v = dataclasses.replace(_verdict(name, value), success=False)
            others = [
                _verdict(n, w)
                for n, w in (("probing", "needs_clarification"), ("timekeeper", "stuck"), ("medical", "high"))
                if n != name
            ]
            args = dict(sm_context=SM_CONTEXT, expert_configs=CONFIGS)
            assert _outcome(new.resolve([v, *others], **args)) == _outcome(old.resolve([v, *others], **args))


def test_no_expert_is_named_in_arbitration():
    import inspect
    import stella_v2_agent.pipeline.arbitration as module

    source = inspect.getsource(module)
    for name in CONFIGS:
        assert f'"{name}"' not in source, f"arbitration names the {name} expert"
