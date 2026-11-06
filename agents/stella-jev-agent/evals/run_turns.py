#!/usr/bin/env python3
"""Run real turns of the agent in-process and time them. No voice and no backend.

The state machine and history are stand-ins. Jev and the language models are real,
so this needs TYPESAFE_API_KEY and OPENAI_API_KEY. It sends only the hand-written
text in this folder. Times stop at the first text, before any text-to-speech.

Usage: python evals/run_turns.py [--agent jev|v2] [--repeat 3] [--out results.json]
"""
import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path
from unittest.mock import patch

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))

from stella_agent_sdk import AgentInput  # noqa: E402
from stella_agent_sdk.messages.types import InputType  # noqa: E402
from common_sense_cases import CASES, EMERGENCIES  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
PLAN = json.loads((ROOT / "stella-v2-agent" / "config" / "study" / "plan_physical_activity_checkin.json").read_text())
ASK = "Wie viel trinken Sie ungefähr am Tag?"
PLAN_CONTEXT = {
    "state": {"id": "s1", "title": "Trinken und Essen"},
    "current_task": {"id": "t1", "description": "Trinkmenge erfragen", "status": "pending"},
    "available_tasks": [],
    "deliverables": [{"key": "trinkmenge", "description": "Trinkmenge pro Tag", "status": "pending", "required": True}],
    "collected_deliverables": {},
}
ORDINARY = [
    ("answer", "So etwa anderthalb Liter, meistens Tee und Wasser.", [("assistant", ASK)]),
    ("small_talk", "Heute ist so schönes Wetter bei uns.", [("assistant", "Wie geht es Ihnen heute?")]),
    ("short", "Ja, das stimmt.", [("assistant", "Sie gehen also gerne spazieren?")]),
    ("story", "Gestern war meine Tochter da, wir haben zusammen gekocht und viel gelacht, das war wirklich schön.",
     [("assistant", "Was war diese Woche schön?")]),
]


class FakeStateMachine:
    """Answers every call with success, so tools run without changing anything."""

    def __init__(self, *args, **kwargs):
        pass

    def __getattr__(self, name):
        async def call(*args, **kwargs):
            return {} if name == "get_collected_deliverables" else {"success": True}
        return call


def defaults(agent_dir: Path) -> dict:
    schema = yaml.safe_load((agent_dir / "agent.yaml").read_text())["pipelineSchema"]
    nodes = {}
    for node in schema["nodes"]:
        slots = {s["id"]: s["default"] for s in node.get("slots", []) if "default" in s}
        if slots:
            nodes[node["id"]] = slots
    return {"nodes": nodes, "thresholds": {}}


async def one_turn(kind, said, history, expect, agent_name):
    if agent_name == "jev":
        from stella_jev_agent import StellaJevAgent as Agent
        agent_dir = ROOT / "stella-jev-agent"
    else:
        from stella_v2_agent import StellaV2Agent as Agent
        agent_dir = ROOT / "stella-v2-agent"
    with patch("stella_v2_agent.agent.StateMachineClient", FakeStateMachine):
        agent = Agent(experts_dir=str(agent_dir / "config" / "experts"))
        await agent.on_session_start("eval", {
            "model": "gpt-5.4-mini",
            "plan": PLAN,
            "pipeline_config": defaults(agent_dir),
        })

    async def fake_history(limit=20):
        return [{"role": r, "content": c} for r, c in history]

    async def fake_context():
        return json.loads(json.dumps(PLAN_CONTEXT))

    agent._fetch_conversation_history = fake_history
    agent._fetch_sm_context = fake_context
    agent.language_resolver.forced = "de"

    started = time.monotonic()
    first_text = first_reply = None
    text = bridge = ""
    verdicts = {}
    async for output in agent.process(AgentInput(session_id="eval", type=InputType.TEXT, text=said)):
        now = (time.monotonic() - started) * 1000
        if output.type.value == "text_chunk":
            first_text = first_text if first_text is not None else now
            if output.metadata.get("tts_source") == "bridge":
                bridge = output.content
            else:
                first_reply = first_reply if first_reply is not None else now
                text = output.content
        elif output.type.value == "debug" and str(output.metadata.get("component", "")).startswith("expert:"):
            verdicts[output.metadata.get("expert_name")] = output.metadata.get("verdict")
    return {
        "kind": kind, "expect": expect, "said": said, "first_text_ms": round(first_text or 0),
        "first_reply_ms": round(first_reply or 0), "total_ms": round((time.monotonic() - started) * 1000),
        "bridge": bridge, "reply": text, "verdicts": verdicts,
    }


def summarise(rows, field):
    values = [r[field] for r in rows if r[field]]
    return f"{statistics.median(values):>5.0f} / {max(values):>5.0f}" if values else "    - /     -"


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--agent", default="jev", choices=["jev", "v2"])
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--out")
    args = parser.parse_args()

    def history_of(case):
        return [(t["role"], t["content"]) for t in case["history"]]

    work = [(k, s, h, "carry_on") for k, s, h in ORDINARY for _ in range(args.repeat)]
    work += [("ask_back", c["said"], history_of(c), "ask") for c in CASES if c["split"] == "dev" and c["expect"] == "ask"]
    work += [("emergency", c["said"], history_of(c), "critical") for c in EMERGENCIES if c["split"] == "dev"]

    rows = []
    for kind, said, history, expect in work:
        rows.append(await one_turn(kind, said, history, expect, args.agent))
        r = rows[-1]
        print(f"[{kind:<10}] first {r['first_text_ms']:>5} reply {r['first_reply_ms']:>5} total {r['total_ms']:>5} | {said[:44]!r}")
        print(f"             {('bridge: ' + r['bridge'] + ' | ') if r['bridge'] else ''}reply: {r['reply'][:170]}")
        print(f"             {r['verdicts']}")

    print("\nmedian / max ms          first text      first reply")
    for kind in sorted({r["kind"] for r in rows}):
        group = [r for r in rows if r["kind"] == kind]
        print(f"  {kind:<12} n={len(group):<3} {summarise(group, 'first_text_ms')}   {summarise(group, 'first_reply_ms')}")
    if args.out:
        Path(args.out).write_text(json.dumps(rows, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
