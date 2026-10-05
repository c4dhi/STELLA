"""The companion replay set: always checked for shape, replayed only on request.

The scenarios are data that people edit by hand, so the cheap half runs every
time: a typo in an activity id or an outcome would otherwise score as a model
failure. The replay itself needs real LLM calls and is opt-in:

    STELLA_RUN_EXPERT_EVALS=1 OPENAI_API_KEY=... pytest tests/test_companion_replay.py -q -s

See ``companion_replay.py`` for the command-line form, which is the one to use
when comparing prompt variants.
"""

import os

import pytest

from .companion_replay import Replay, accepted, load_scenarios, replay_all, report

OUTCOMES = {"none", "offered", "exit_asked", "exited", "exit_declined", "dismissed", "unheard"}
MODES = {"free", "activity", "awaiting_exit"}
# 96% on 5 Oct with the exit dialogue on its own model (84% before). This only
# catches a collapse, not a regression of a few scenarios — compare two --out
# files for that.
MIN_PASS_RATE = 0.9


def test_the_scenarios_are_well_formed():
    data = load_scenarios()
    activity_ids = {a["id"] for a in data["activities"]}
    known = OUTCOMES | {f"started:{i}" for i in activity_ids}

    ids = [s["id"] for s in data["scenarios"]]
    assert len(ids) == len(set(ids)), "duplicate scenario ids"

    for scenario in data["scenarios"]:
        where = scenario["id"]
        assert scenario.get("in_activity") in activity_ids | {None}, where
        assert not scenario.get("awaiting_exit") or scenario.get("in_activity"), where
        assert scenario["turns"], where
        for turn in scenario["turns"]:
            assert turn["user"], where
            assert turn.get("only_if") in MODES | {None}, where
            assert "expect" in turn, where
            unknown = set(accepted(turn["expect"]) or []) - known
            assert not unknown, f"{where}: unknown outcome {unknown}"


@pytest.mark.skipif(
    os.environ.get("STELLA_RUN_EXPERT_EVALS") != "1" or not os.environ.get("OPENAI_API_KEY"),
    reason="LLM eval — set STELLA_RUN_EXPERT_EVALS=1 and OPENAI_API_KEY to run",
)
@pytest.mark.asyncio
async def test_replay_pass_rate():
    data = load_scenarios()
    results = await replay_all(Replay(data["activities"]), data["scenarios"], trials=3)
    rate = report(results)
    assert rate >= MIN_PASS_RATE, f"companion replay pass rate {rate:.0%} below {MIN_PASS_RATE:.0%}"
