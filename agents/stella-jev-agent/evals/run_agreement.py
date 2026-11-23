#!/usr/bin/env python3
"""Do Jev and task_extraction agree on which task an answer closed?

Jev decides which task the latest message answered, and the reply is steered by that
decision before anything is saved. task_extraction then decides on its own what to save.
When the two disagree the reply and the plan drift apart: the reply asks a question again
whose answer is already saved, and the next answer lands in the next free slot.

Each turn runs the real Jev and the real extraction model against a state machine that
only records what would be written. A turn counts as:
  agree            extraction saved exactly the tasks Jev picked (its main pick, plus what
                   it says was mentioned or corrected along the way), or neither did anything
  jev_only         Jev picked a task, extraction saved nothing for it
  extraction_only  extraction saved a task Jev did not pick
  different        both picked, but different tasks
  asked_back       the reply checks what it heard first, and nothing is saved

A case may label `also`: the other tasks the message settled. Jev's extras are scored
against it.

Needs TYPESAFE_API_KEY and OPENAI_API_KEY. Sends only the hand-written text in this
folder and the plan passed in.

Usage: python evals/run_agreement.py --plan plan.json [--repeat 3] [--out results.json]
"""
import argparse
import asyncio
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agreement_cases import CASES  # noqa: E402
from next_step_cases import GERMAN_FOCUS_GROUP  # noqa: E402
from stella_agent_sdk.tools import ToolRegistry  # noqa: E402
from stella_agent_sdk.tools.state_machine import create_state_machine_tools  # noqa: E402

from stella_jev_agent import StellaJevAgent  # noqa: E402
from stella_jev_agent.agent import _OWN_EXPERTS_DIR  # noqa: E402
from stella_jev_agent.jev import JevClient  # noqa: E402

NAMES = ["common_sense", "medical", "legal", "probing", "timekeeper", "task_extraction"]


def load_plan(path):
    text = Path(path).read_text()
    raw = json.loads(text[min(i for i in (text.find("{"), text.find("[")) if i >= 0):text.rindex("}") + 1]
                     if text.lstrip().startswith("{") else text)
    raw = raw.get("content", raw) if isinstance(raw, dict) else raw
    return raw if isinstance(raw, dict) and "states" in raw else {"states": raw}


class RecordingStateMachine:
    """Accepts every write and remembers it. Reads answer from the case's context."""

    def __init__(self, context):
        self.context = context
        self.writes = []

    async def set_deliverable(self, key, value, reasoning="", unconfirmed=False, correction=False):
        self.writes.append(("set", key, value, correction))
        return {"success": True}

    async def complete_task(self, task_id, *args, **kwargs):
        self.writes.append(("complete", task_id, None, False))
        return {"success": True}

    async def skip_task(self, task_id, *args, **kwargs):
        self.writes.append(("skip", task_id, None, False))
        return {"success": True}

    async def skip_state(self, *args, **kwargs):
        self.writes.append(("skip_state", None, None, False))
        return {"success": True}

    async def get_pending_tasks(self):
        current = next(s for s in self.context["full_plan"] if s["is_current"])
        return [t for t in current["tasks"] if t["status"] == "pending"]

    async def get_pending_deliverables(self):
        return [d for d in self.context["deliverables"] if d["status"] == "pending"]

    async def get_current_state(self):
        return self.context["state"]


def context_for(plan, case):
    """The state machine context for a case: its state current, finished tasks collected."""
    done = case.get("done", {})
    entries, current = [], None
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
                    "acceptance_criteria": d.get("acceptance_criteria", ""),
                    "status": "pending" if is_open else "completed",
                    **({} if is_open else {"value": done.get(task["description"], "(gesammelt)")}),
                } for d in task.get("deliverables", [])],
            })
        entry = {"id": state["id"], "title": state.get("title"), "is_current": is_current, "tasks": tasks}
        entries.append(entry)
        current = entry if is_current else current
    open_tasks = [t for t in current["tasks"] if t["status"] == "pending"]

    def as_current(task):
        return {"id": task["id"], "description": task["description"], "instruction": task.get("instruction"),
                "has_deliverables": bool(task["deliverables"]), "deliverable_keys": [d["key"] for d in task["deliverables"]]}

    every = [d for t in current["tasks"] for d in t["deliverables"]]
    return {
        "state": {"id": current["id"], "title": current["title"], "type": "flexible"},
        "processing_mode": "flexible",
        "current_task": as_current(open_tasks[0]) if open_tasks else None,
        "available_tasks": [as_current(t) for t in open_tasks],
        "deliverables": every,
        "collected_deliverables": {d["key"]: d["value"] for d in every if d["status"] == "completed"},
        "full_plan": entries,
        "progress": {"percentage": 0, "turns_without_deliverable": 0},
    }


def task_of(context, key_or_id):
    current = next(s for s in context["full_plan"] if s["is_current"])
    for task in current["tasks"]:
        if task["id"] == key_or_id or key_or_id in {d["key"] for d in task["deliverables"]}:
            return task["description"]
    return None


async def one(case, plan, jev, threshold):
    agent = StellaJevAgent(experts_dir=str(_OWN_EXPERTS_DIR))
    agent._plan_config = plan
    agent.jev = jev
    pool = agent._jev_pool()
    pool.forecast_threshold = threshold
    context = context_for(plan, case)
    machine = RecordingStateMachine(context)
    registry = ToolRegistry()
    registry.register_all(create_state_machine_tools(machine))
    pool.set_tool_registry(registry)

    answers = {}
    real_ask = jev.ask

    async def ask(state, questions, timeout_s=0):
        result = await real_ask(state, questions, timeout_s)
        answers.update(result.answers)
        return result

    pool._jev = type("Recording", (), {"ask": staticmethod(ask), "timeout_s": jev.timeout_s})()
    history = case.get("history") or [{"role": "assistant", "content": case["asked"]}]
    await pool.run(NAMES, case["said"], history, json.loads(json.dumps(context)))
    jev_task, jev_p = jev_pick(pool, answers, context)
    also = [_label(context, p) for p in getattr(pool, "last_picks", []) if p is not getattr(pool, "last_pick", None)]
    pool.start_held_extraction()
    late = await pool.finish_extraction()
    ran = any(v.expert_name == "task_extraction" for v in late)
    saved = sorted({t for kind, ref, _, _ in machine.writes if kind in ("set", "complete")
                    for t in [task_of(context, ref)] if t})
    return {**case, "jev": jev_task, "jev_p": jev_p, "jev_also": also, "jev_ms": pool.last_jev.get("latency_ms"), "extraction_ran": ran, "saved": saved,
            "asked_back": bool(pool._ask_back.now),
            "writes": machine.writes}


def _label(context, pick):
    task = task_of(context, pick["task_id"])
    return ["fix", task] if pick.get("correction") else task


def jev_pick(pool, answers, context):
    """The task Jev picked with enough confidence to steer the reply, or None."""
    picked = getattr(pool, "last_pick", None)
    if picked is not None:
        # This branch's pool says what it decided, corrections included.
        task = task_of(context, picked["task_id"]) if picked.get("task_id") else None
        return (("fix", task) if task and picked.get("correction") else task), picked.get("p")
    answer = answers.get("answered_task")
    if answer is None:
        return None, None
    p = answer.probabilities[answer.choice]
    if answer.choice == "nothing" or p < pool.forecast_threshold:
        return None, round(p, 2)
    open_tasks = [t for t in next(s for s in context["full_plan"] if s["is_current"])["tasks"] if t["status"] == "pending"]
    return open_tasks[int(answer.choice.split("_")[1])]["description"], round(p, 2)


def _name(pick):
    """A correction ("fix", task) writes to that task, so it is compared by the task."""
    return pick[1] if isinstance(pick, (tuple, list)) else pick


def outcome(row):
    if row.get("asked_back"):
        # The reply checks what it heard first, and saves nothing on this turn.
        return "asked_back"
    picked = sorted({_name(p) for p in [row["jev"], *row.get("jev_also", [])] if p})
    saved = row["saved"]
    if saved == picked:
        return "agree"
    if not saved:
        return "jev_only"
    if not picked:
        return "extraction_only"
    return "different"


def _choices(truth):
    """A label is one pick, ("fix", task), or a tuple of acceptable picks."""
    if isinstance(truth, (tuple, list)) and not (len(truth) == 2 and truth[0] == "fix"):
        return [tuple(t) if isinstance(t, list) else t for t in truth]
    return [tuple(truth) if isinstance(truth, list) else truth]


def truth_ok(row):
    jev = tuple(row["jev"]) if isinstance(row["jev"], list) else row["jev"]
    return jev in _choices(row["task"])


def _key(pick):
    return tuple(pick) if isinstance(pick, list) else pick


def also_ok(row):
    if "also" not in row:
        return True
    return sorted(map(str, map(_key, row.get("jev_also", [])))) == sorted(map(str, map(_key, row["also"])))


def report(name, rows):
    counts = Counter(outcome(r) for r in rows)
    right = sum(1 for r in rows if truth_ok(r))
    labelled = [r for r in rows if "also" in r]
    print(f"\n=== {name}: {len(rows)} turns")
    print("  " + "  ".join(f"{k} {counts[k]}" for k in ["agree", "jev_only", "extraction_only", "different", "asked_back"]))
    print(f"  Jev's main pick matches the hand label: {right}/{len(rows)}")
    ms = sorted(r["jev_ms"] for r in rows if r.get("jev_ms"))
    if ms:
        print(f"  Jev latency: median {ms[len(ms) // 2]:.0f} ms, p90 {ms[int(len(ms) * 0.9)]:.0f} ms")
    if labelled:
        print(f"  Jev's extras match the hand label: {sum(map(also_ok, labelled))}/{len(labelled)}")
    seen = Counter()
    for r in rows:
        if outcome(r) not in ("agree", "asked_back") or not truth_ok(r) or not also_ok(r):
            also = tuple(map(str, map(_key, r.get("jev_also", []))))
            seen[(outcome(r), r["said"], str(r["task"]), str(r.get("also", "-")), str(r["jev"]), r["jev_p"], also,
                  tuple(r["saved"]))] += 1
    for (kind, said, truth, want_also, jev, p, also, saved), n in sorted(seen.items(), key=str):
        print(f"  {kind} x{n} {said!r} truth={truth} also={want_also} | jev={jev} ({p}) also={list(also)} saved={list(saved)}")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--plan", required=True)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--threshold", type=float, default=0.7)
    parser.add_argument("--only-drift", action="store_true")
    parser.add_argument("--out")
    args = parser.parse_args()

    plan = load_plan(args.plan)
    jev = JevClient(timeout_s=15.0)
    gate = asyncio.Semaphore(4)

    async def run(case):
        async with gate:
            return await one(case, plan, jev, args.threshold)

    results = {}
    suites = [("Drift cases", CASES)] + ([] if args.only_drift else [("German Focus Group", GERMAN_FOCUS_GROUP)])
    for name, cases in suites:
        rows = list(await asyncio.gather(*(run(c) for c in cases for _ in range(args.repeat))))
        report(name, rows)
        results[name] = rows
    await jev.close()
    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=1, ensure_ascii=False, default=str))


if __name__ == "__main__":
    asyncio.run(main())
