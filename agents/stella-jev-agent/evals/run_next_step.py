#!/usr/bin/env python3
"""Does the reply head where the plan really goes, and how much sooner does it start?

Forecast: Jev is real, the answers are labelled by hand. A wrong move means the reply
opened a step the plan did not take, a missed move means it stayed on a step that is done.
Stopwatch (--timed): whole turns with real Jev and language models, and a stand-in state
machine, once starting the reply straight away and once waiting for extraction first.
The stand-in never moves, so only the first path's replies say anything about the plan.

Needs TYPESAFE_API_KEY, and OPENAI_API_KEY for --timed. Sends only the hand-written text
in this folder and the plan passed in.

Usage: python evals/run_next_step.py --plan plan.json [--repeat 3] [--timed] [--out results.json]
"""
import argparse
import asyncio
import json
import statistics
import sys
import time
from collections import Counter
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from next_step_cases import GERMAN_FOCUS_GROUP, TIMED, VALUE_BRANCH_PLAN, VALUE_BRANCHES  # noqa: E402
from run_turns import FakeStateMachine, ROOT, defaults  # noqa: E402
from stella_agent_sdk import AgentInput  # noqa: E402
from stella_agent_sdk.messages.types import InputType  # noqa: E402
from stella_v2_agent.experts.registry import ExpertRegistry  # noqa: E402

from stella_jev_agent import StellaJevAgent  # noqa: E402
from stella_jev_agent import pool as pool_module  # noqa: E402
from stella_jev_agent.agent import _OWN_EXPERTS_DIR  # noqa: E402
from stella_jev_agent.ask_back import AskBack  # noqa: E402
from stella_jev_agent.jev import JevClient  # noqa: E402
from stella_jev_agent.next_step import END, pending_tasks  # noqa: E402

NAMES = ["common_sense", "medical", "legal", "probing", "timekeeper", "task_extraction"]


def load_plan(path):
    text = Path(path).read_text()
    raw = json.loads(text[text.index("{"):text.rindex("}") + 1])
    return raw.get("content", raw)


def title_of(plan, state_id):
    return END if state_id == END else next((s.get("title") for s in plan["states"] if s["id"] == state_id), state_id)


def _as_current(task):
    return {
        "id": task["id"], "description": task["description"], "instruction": task.get("instruction"),
        "has_deliverables": bool(task["deliverables"]), "deliverable_keys": [d["key"] for d in task["deliverables"]],
    }


def context_for(plan, case):
    entries = []
    current = None
    for state in plan["states"]:
        is_current = state.get("title") == case["state"]
        tasks = []
        for task in state.get("tasks", []):
            is_open = not is_current or task["description"] in case["open"]
            tasks.append({
                "id": task["id"], "description": task["description"], "instruction": task.get("instruction"),
                "status": "pending" if is_open else "completed",
                "deliverables": [{
                    "key": d["key"], "description": d.get("description"), "required": d.get("required", True),
                    "status": "pending" if is_open else "completed",
                } for d in task.get("deliverables", [])],
            })
        entry = {"id": state["id"], "title": state.get("title"), "is_current": is_current, "tasks": tasks}
        entries.append(entry)
        current = entry if is_current else current
    open_tasks = [t for t in current["tasks"] if t["status"] == "pending"]
    return {
        "state": {"id": current["id"], "title": current["title"], "type": "flexible"},
        "processing_mode": "flexible",
        "current_task": _as_current(open_tasks[0]),
        "available_tasks": [_as_current(t) for t in open_tasks],
        "deliverables": [d for t in open_tasks for d in t["deliverables"]],
        "collected_deliverables": {},
        "full_plan": entries,
    }


class ForecastOnly(pool_module.JevExpertPool):
    """Stops where the language models would start."""

    async def _run_experts(self, *args, **kwargs):
        return []


async def forecast(cases, plan, repeat, threshold, gate):
    jev = JevClient(timeout_s=15.0)

    async def one(case):
        pool = ForecastOnly(
            None, ExpertRegistry(experts_dir=str(_OWN_EXPERTS_DIR)), compiler_version="1.0.0",
            jev=jev, ask_back=AskBack(), plan=lambda: plan,
        )
        pool.forecast_threshold = threshold
        history = [{"role": "assistant", "content": case["asked"]}]
        context = context_for(plan, case)
        async with gate:
            await pool.run(NAMES, case["said"], history, context)
        tasks = pending_tasks(context)
        keys = set(pool.forecast.keys)
        done = pool.forecast.done_task
        picked = next((t["description"] for t in tasks if t["id"] == done or keys & {d["key"] for d in t["deliverables"]}), None)
        held = pool._held is not None
        moved = pool.forecast.next_state
        return {
            **case, "picked": picked, "held": held, "reached": title_of(plan, moved) if moved else None,
            "latency_ms": pool.last_jev.get("latency_ms"), "answered": pool.last_jev.get("answered"),
        }

    rows = await asyncio.gather(*(one(c) for c in cases for _ in range(repeat)))
    await jev.close()
    return list(rows)


def score(row):
    truth, reached = row["goes_to"], row["reached"]
    if truth == reached:
        return "right_move" if truth else "right_stay"
    if truth is None:
        return "wrong_move"
    return "missed_move" if reached is None else "wrong_branch"


def score_task(row):
    truth = row["task"] if isinstance(row["task"], (tuple, list)) else (row["task"],)
    if row["picked"] in truth:
        return "right_task"
    return "no_pick" if row["picked"] is None else "wrong_task"


def report(name, rows):
    print(f"\n=== {name}: {len(rows)} turns, Jev answered {sum(1 for r in rows if r['answered'])}")
    tasks = Counter(score_task(r) for r in rows)
    print("  " + "  ".join(f"{kind} {tasks[kind]}" for kind in ["right_task", "no_pick", "wrong_task"]))
    picks = Counter((score_task(r), r["said"], str(r["task"]), r["picked"]) for r in rows if score_task(r) != "right_task")
    for (kind, said, truth, picked), n in picks.items():
        print(f"  {kind} x{n} {said!r} truth={truth} picked={picked}")
    counts = Counter(score(r) for r in rows)
    for kind in ["right_move", "right_stay", "wrong_move", "missed_move", "wrong_branch"]:
        print(f"  {kind:<13}{counts[kind]:>4}")
    latencies = sorted(r["latency_ms"] for r in rows if r["latency_ms"])
    if latencies:
        print(f"  Jev ms       median {statistics.median(latencies):.0f}  p95 {latencies[int(len(latencies) * .95)]:.0f}")
    seen = Counter()
    for r in rows:
        if score(r) not in {"right_move", "right_stay"}:
            seen[(score(r), r["state"], r["said"], r["goes_to"], r["reached"])] += 1
    for (kind, state, said, truth, reached), n in seen.items():
        print(f"  {kind} x{n} [{state}] {said!r} truth={truth} forecast={reached}")


async def one_turn(case, plan, wait_for_extraction):
    agent_dir = ROOT / "stella-jev-agent"
    with patch("stella_v2_agent.agent.StateMachineClient", FakeStateMachine):
        agent = StellaJevAgent(experts_dir=str(agent_dir / "config" / "experts"))
        await agent.on_session_start("eval", {
            "model": "gpt-5.4-mini", "plan": plan, "pipeline_config": defaults(agent_dir),
        })
    context = context_for(plan, case)

    async def fake_history(limit=20):
        return [{"role": "assistant", "content": case["asked"]}]

    async def fake_context():
        return json.loads(json.dumps(context))

    agent._fetch_conversation_history = fake_history
    agent._fetch_sm_context = fake_context
    agent.language_resolver.forced = "de"
    started = time.monotonic()
    first = None
    text = ""
    route = pool_module.route if not wait_for_extraction else (lambda *_: None)
    with patch.object(pool_module, "route", route):
        async for output in agent.process(AgentInput(session_id="eval", type=InputType.TEXT, text=case["said"])):
            if output.type.value == "text_chunk":
                first = first if first is not None else (time.monotonic() - started) * 1000
                text = output.content
    return {"said": case["said"], "first_word_ms": round(first or 0), "reply": text,
            "forecast": title_of(plan, agent.expert_pool.forecast.next_state) if agent.expert_pool.forecast.next_state else None}


async def stopwatch(plan, repeat):
    rows = {True: [], False: []}
    for _ in range(repeat):
        for case in TIMED:
            for waiting in (False, True):
                row = await one_turn(case, plan, waiting)
                rows[waiting].append(row)
                print(f"[{'wait' if waiting else 'now '}] {row['first_word_ms']:>5} ms | {row['said'][:36]!r} -> {row['forecast']} | ...{row['reply'][-130:]!r}")
    for waiting, label in ((False, "reply starts at once"), (True, "reply waits for extraction")):
        values = sorted(r["first_word_ms"] for r in rows[waiting] if r["first_word_ms"])
        print(f"{label:<28} n={len(values)} median {statistics.median(values):.0f} ms  worst {values[-1]} ms")
    return rows


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--threshold", type=float, default=0.7)
    parser.add_argument("--timed", action="store_true")
    parser.add_argument("--out")
    args = parser.parse_args()

    plan = load_plan(args.plan)
    gate = asyncio.Semaphore(4)
    german = await forecast(GERMAN_FOCUS_GROUP, plan, args.repeat, args.threshold, gate)
    report("German Focus Group", german)
    branches = await forecast(VALUE_BRANCHES, VALUE_BRANCH_PLAN, args.repeat, args.threshold, gate)
    report("Value branches", branches)
    results = {"german": german, "branches": branches}
    if args.timed:
        results["timed"] = await stopwatch(plan, args.repeat)
    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=1, ensure_ascii=False, default=str))


if __name__ == "__main__":
    asyncio.run(main())
