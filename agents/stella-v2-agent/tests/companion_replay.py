"""Replay companion transcripts against the real models and score the outcomes.

Every companion change is a prompt trade-off: a router that starts less eagerly
also leaves less readily. This runs a fixed set of transcripts through the same
pieces a live turn uses — the ``companion_router`` expert, the exit dialogue and
``Companion.decide`` — several times each, and reports how often each turn ended
where it should. Run it before and after a change, or with ``--router-prompt`` /
``--router-model`` to try a variant without editing the config:

    OPENAI_API_KEY=... PYTHONPATH=src:../stella-ai-agent-sdk/src \\
        python tests/companion_replay.py --trials 5 --out before.json

Scenarios are scored on the OUTCOME (what the user would experience), not on
which tool the router called, so they stay valid when the routing is rebuilt.
The assistant's lines are scripted: this measures routing, not the reply model.
"""

import argparse
import asyncio
import dataclasses
import json
import logging
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from stella_agent_sdk.llm import LLMService
from stella_v2_agent.companion_tools import create_companion_tools

from stella_v2_agent.agent import PROMPT_COMPILER_VERSION
from stella_v2_agent.companion import (
    EXIT_MODEL,
    ROUTER,
    Change,
    Companion,
    Transition,
    commands_from,
    exit_dialogue,
)
from stella_v2_agent.experts.registry import ExpertRegistry
from stella_v2_agent.experts.runner import ExpertRunner
from stella_v2_agent.pipeline.history_scope import ActivitySegment, ended_note

HERE = Path(__file__).parent
SCENARIOS = HERE / "companion_replay_scenarios.json"
EXPERTS_DIR = HERE.parent / "config" / "experts"

FAILED_CALL = "error"
_FAILED_VERDICTS = {"error", "parse_error", "timeout"}


def load_scenarios(path: Path = SCENARIOS) -> Dict[str, Any]:
    data = json.loads(path.read_text())
    # decide() only starts an activity that carries a plan; which plan is not
    # the replay's business.
    for activity in data["activities"]:
        activity.setdefault("plan", {"id": f"{activity['id']}-plan", "title": activity["title"]})
    return data


def outcome_of(transition: Transition) -> str:
    if transition.change is Change.STARTED:
        return f"started:{transition.activity['id']}"
    return transition.change.value


def accepted(expect: Any) -> Optional[List[str]]:
    """The outcomes that pass, or None for an undecided turn."""
    if expect is None:
        return None
    return [expect] if isinstance(expect, str) else list(expect)


def _mode(companion: Companion) -> str:
    if not companion.active:
        return "free"
    return "awaiting_exit" if companion.pending_exit else "activity"


def _default_reply(transition: Transition) -> str:
    """Stands in for the reply when the scenario scripts none."""
    if transition.change is Change.OFFERED:
        titles = ", ".join(a.get("title", "") for a in transition.offered)
        return f"We could do: {titles}. What would you like?"
    if transition.change is Change.STARTED:
        return f"Okay, let's start {transition.title}."
    if transition.change is Change.EXITED:
        return f"Okay, we'll leave {transition.title} there."
    return "Okay."


class Replay:
    """The routing half of a companion turn, on the real models."""

    def __init__(
        self,
        activities: List[Dict[str, Any]],
        *,
        router_prompt: Optional[str] = None,
        router_model: Optional[str] = None,
        exit_model: str = EXIT_MODEL,
        persona: Optional[str] = None,
        language: Optional[str] = None,
    ):
        self.activities = activities
        self.llm = LLMService()
        self.runner = ExpertRunner(self.llm, compiler_version=PROMPT_COMPILER_VERSION)
        router = ExpertRegistry(experts_dir=str(EXPERTS_DIR)).get(ROUTER)
        overrides = {
            k: v for k, v in (("system_prompt", router_prompt), ("model", router_model)) if v
        }
        self.router = dataclasses.replace(router, **overrides)
        self.exit_model = exit_model
        self.persona = persona
        self.language = language

    async def run(self, scenario: Dict[str, Any]) -> List[Dict[str, Any]]:
        """One trial of a scenario: a record per turn that ran."""
        companion = Companion(activities=self.activities)
        history: List[Dict[str, str]] = list(scenario.get("history") or [])
        # What free conversation looked like before the running activity, so
        # leaving it restores that plus the one-line note, as the agent does.
        free_history: List[Dict[str, str]] = []
        if scenario.get("in_activity"):
            companion.enter(companion.find(scenario["in_activity"]))
            if scenario.get("awaiting_exit"):
                companion.ask_exit()
        tools = create_companion_tools(self.activities, lambda: companion.running_title)

        records = []
        for index, turn in enumerate(scenario["turns"]):
            mode = _mode(companion)
            if turn.get("only_if") and turn["only_if"] != mode:
                continue
            record = {"turn": index, "mode": mode, "user": turn["user"], "router": "-", "exit": ""}
            transition = await self._decide(companion, tools, turn["user"], history, record)
            record["outcome"] = FAILED_CALL if transition is None else outcome_of(transition)
            records.append(record)
            if transition is None:
                break

            history.append({"role": "user", "content": turn["user"]})
            change = transition.change
            if change is Change.STARTED:
                free_history, history = history, []
                companion.enter(transition.activity)
            elif change is Change.EXITED:
                history = free_history + [{"role": "system", "content": ended_note(
                    ActivitySegment(transition.title, companion.started_at, companion.started_at)
                )}]
                companion.leave()
            elif change is Change.EXIT_ASKED:
                companion.ask_exit()
            elif change is Change.EXIT_DECLINED:
                companion.stay()
            reply = transition.say if change is Change.EXIT_ASKED and transition.say else None
            history.append({
                "role": "assistant",
                "content": reply or turn.get("assistant") or _default_reply(transition),
            })
        return records

    async def _decide(self, companion, tools, text, history, record) -> Optional[Transition]:
        commands: List[Dict[str, Any]] = []
        if not companion.pending_exit:
            # With the stop question open the agent ignores the router entirely,
            # so the call is skipped here rather than made and thrown away.
            verdict = await self.runner.run(self.router, text, history, {}, tools=tools)
            if verdict.verdict in _FAILED_VERDICTS:
                record["router"] = verdict.verdict
                return None
            commands = commands_from([verdict])
            record["router"] = commands[0]["command"] if commands else "-"
        exit_step = None
        if companion.needs_exit_step(commands):
            exit_step = await exit_dialogue(
                self.llm,
                model=self.exit_model,
                title=companion.running_title or "the activity",
                user_input=text,
                history=history,
                awaiting_answer=companion.pending_exit,
                language=self.language,
                persona=self.persona,
            )
            if exit_step is None:
                record["exit"] = "failed"
                return None
            record["exit"] = f"{exit_step.decision}: {exit_step.user_intent}"
        return companion.decide(commands, exit_step)


async def replay_all(
    replay: Replay, scenarios: List[Dict[str, Any]], trials: int, concurrency: int = 8
) -> List[Dict[str, Any]]:
    """Every scenario ``trials`` times; one result per scenario turn."""
    gate = asyncio.Semaphore(concurrency)

    async def one(scenario):
        async with gate:
            return await replay.run(scenario)

    results = []
    for scenario, runs in zip(scenarios, await asyncio.gather(*(
        asyncio.gather(*(one(s) for _ in range(trials))) for s in scenarios
    ))):
        by_turn: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        for run in runs:
            for record in run:
                by_turn[record["turn"]].append(record)
        for index, records in sorted(by_turn.items()):
            turn = scenario["turns"][index]
            expect = accepted(turn.get("expect"))
            outcomes = Counter(r["outcome"] for r in records)
            results.append({
                "id": scenario["id"] + (f"#{index + 1}" if len(scenario["turns"]) > 1 else ""),
                "tags": scenario.get("tags", []),
                "user": turn["user"],
                "expect": expect,
                "ran": len(records),
                "passed": None if expect is None else sum(outcomes[o] for o in expect),
                "outcomes": dict(outcomes),
                "misses": [
                    {k: r[k] for k in ("outcome", "router", "exit")}
                    for r in records if expect is not None and r["outcome"] not in expect
                ],
            })
    return results


def report(results: List[Dict[str, Any]], out=sys.stdout) -> float:
    """Print the table; return the overall pass rate over scored turns."""
    def line(r):
        spread = ", ".join(f"{o} {n}" for o, n in sorted(r["outcomes"].items(), key=lambda x: -x[1]))
        if r["passed"] is None:
            mark, score = "?", "  -  "
        else:
            mark = "ok" if r["passed"] == r["ran"] else ("~" if r["passed"] else "XX")
            score = f"{r['passed']}/{r['ran']}".rjust(5)
        print(f"{mark:>2} {score}  {r['id']:<50} {r['user'][:38]!r:<41} {spread}", file=out)

    for r in results:
        line(r)

    scored = [r for r in results if r["passed"] is not None]
    by_tag: Dict[str, List[int]] = defaultdict(lambda: [0, 0])
    for r in scored:
        for tag in r["tags"] or ["untagged"]:
            by_tag[tag][0] += r["passed"]
            by_tag[tag][1] += r["ran"]
    print("\nBy tag:", file=out)
    for tag, (passed, ran) in sorted(by_tag.items()):
        print(f"  {tag:<14} {passed}/{ran}  {passed / ran:.0%}", file=out)

    failing = [r for r in scored if r["passed"] < r["ran"]]
    if failing:
        print("\nMisses:", file=out)
        for r in failing:
            print(f"  {r['id']}  {r['user']!r}  expected {' | '.join(r['expect'])}", file=out)
            for kind, n in Counter(
                (m["outcome"], m["router"], m["exit"]) for m in r["misses"]
            ).most_common():
                outcome, router, exit_note = kind
                detail = f"router: {router}" + (f"; exit dialogue: {exit_note}" if exit_note else "")
                print(f"      {n}x {outcome}  ({detail})", file=out)

    passed, ran = sum(r["passed"] for r in scored), sum(r["ran"] for r in scored)
    rate = passed / ran if ran else 1.0
    print(f"\nOverall: {passed}/{ran} scored turn-trials  {rate:.1%}", file=out)
    return rate


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--scenarios", type=Path, default=SCENARIOS)
    parser.add_argument("--trials", type=int, default=5)
    parser.add_argument("--only", help="run scenarios whose id contains this")
    parser.add_argument("--tag", help="run scenarios carrying this tag")
    parser.add_argument("--router-prompt", type=Path, help="file with a replacement router prompt")
    parser.add_argument("--router-model")
    parser.add_argument("--exit-model", default=EXIT_MODEL)
    parser.add_argument("--persona", type=Path, help="file with the persona the exit dialogue speaks in")
    parser.add_argument("--language", help="session language code for the exit dialogue")
    parser.add_argument("--out", type=Path, help="write the results as JSON")
    parser.add_argument("--threshold", type=float, default=0.0, help="fail below this overall pass rate")
    parser.add_argument("--concurrency", type=int, default=8)
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.ERROR)

    data = load_scenarios(args.scenarios)
    scenarios = [
        s for s in data["scenarios"]
        if (not args.only or args.only in s["id"]) and (not args.tag or args.tag in s.get("tags", []))
    ]
    replay = Replay(
        data["activities"],
        router_prompt=args.router_prompt.read_text() if args.router_prompt else None,
        router_model=args.router_model,
        exit_model=args.exit_model,
        persona=args.persona.read_text() if args.persona else None,
        language=args.language,
    )
    results = asyncio.run(replay_all(replay, scenarios, args.trials, args.concurrency))
    rate = report(results)
    if args.out:
        args.out.write_text(json.dumps({
            "router_model": replay.router.model,
            "exit_model": args.exit_model,
            "trials": args.trials,
            "pass_rate": rate,
            "results": results,
        }, indent=1, ensure_ascii=False))
    return 0 if rate >= args.threshold else 1


if __name__ == "__main__":
    sys.exit(main())
