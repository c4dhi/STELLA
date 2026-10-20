"""Replay synthetic companion sessions through the real BridgeGenerator and
measure repetition, variety, and bridges on turns that did not need one (#94).

Felix, 20 Oct 2026, dev session: "we have a general problem with bridges, as it
causes repetitions and is very monotonous." This runs fixed-script synthetic
sessions (``bridge_repetition_scenarios.json``) turn by turn through
``BridgeGenerator.generate()`` — the exact method a live turn calls — several
times each, and reports:

  - exact and near-duplicate repeats across all generated bridges;
  - variety: distinct openers and the share held by the most common one;
  - how many bridges were generated on a turn ``select_bridge_mode`` itself
    classifies as needing no more than a beat (BRIEF), and how much LESS varied
    that subset is than the rest — the brief's "bridges that didn't need one".

No transcript text from a real session is used; every turn is scripted. Needs
OPENAI_API_KEY (the bridge model is gpt-4o-mini via OPENAI_LANGCHAIN by
default) — this script makes real model calls, so run it where that key is
set, not inside a session that has none:

    OPENAI_API_KEY=... PYTHONPATH=src:../stella-ai-agent-sdk/src \\
        python tests/bridge_repetition_replay.py --out before.json

To isolate a single candidate cause (per the card: "change one factor at a
time"), override just that one knob and diff the reports:

    # the configured production temperature (agent.yaml default is 0.4,
    # below the BridgeGenerator class's own 0.7 "for natural variety")
    python tests/bridge_repetition_replay.py --temperature 0.4 --out temp_0.4.json
    python tests/bridge_repetition_replay.py --temperature 0.7 --out temp_0.7.json

    # whether the model can see its own past bridges at all
    python tests/bridge_repetition_replay.py --history-mode reply_only --out no_bridge_history.json
"""

import argparse
import asyncio
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

from stella_agent_sdk.llm import LLMService
from stella_v2_agent.pipeline.bridge_generator import BRIDGE_MODE_BRIEF, BridgeGenerator

HERE = Path(__file__).parent
SCENARIOS = HERE / "bridge_repetition_scenarios.json"

# Two bridges count as a near-duplicate when they share this share of their
# words (by exact token, not stemmed — good enough to show convergence on the
# same handful of phrasings without claiming linguistic precision).
_NEAR_DUP_OVERLAP = 0.7
# How many leading words count as the "opener" for variety purposes. Long
# enough to tell "Fair enough, that makes sense" apart from "Fair enough then",
# short enough that two bridges which only diverge after this don't count as
# different opening moves.
_OPENER_WORDS = 4


def _words(text: str) -> List[str]:
    return re.findall(r"\w+", text.lower(), flags=re.UNICODE)


def _opener(bridge: str) -> str:
    return " ".join(_words(bridge)[:_OPENER_WORDS])


def _near_duplicate(a: str, b: str) -> bool:
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return False
    shared = len(set(wa) & set(wb))
    return shared / max(len(wa), len(wb)) >= _NEAR_DUP_OVERLAP


def load_scenarios(path: Path = SCENARIOS) -> List[Dict[str, Any]]:
    return json.loads(path.read_text())["sessions"]


def _clone(generator: BridgeGenerator) -> BridgeGenerator:
    """A fresh BridgeGenerator with the same config, sharing the LLM service
    (cheap: one underlying HTTP client) but with its own ``_previous_mode`` —
    the one piece of per-session state, which must not be shared between
    sessions/trials running concurrently."""
    clone = BridgeGenerator(generator._llm_service)
    for attr in (
        "bridge_model", "bridge_max_tokens", "bridge_temperature",
        "custom_system_prompt", "history_limit", "bridge_timeout_s",
    ):
        setattr(clone, attr, getattr(generator, attr))
    return clone


async def run_session(
    generator: BridgeGenerator, session: Dict[str, Any], history_mode: str,
) -> List[Dict[str, Any]]:
    """One pass through a session's fixed script. Returns one record per turn."""
    history: List[Dict[str, str]] = []
    records = []
    for turn in session["turns"]:
        bridge = await generator.generate(
            turn["user"],
            history,
            language=session.get("language"),
            variables={
                "activitiesOnOffer": turn.get("activities_on_offer", False),
                "isBargeIn": turn.get("barge_in", False),
            },
        )
        # select_bridge_mode's own BRIEF rule *is* "this turn carries too
        # little to receive in full" — reused in summarize() as the
        # definition of "didn't need one" rather than inventing a second one.
        records.append({
            "session": session["id"],
            "user": turn["user"],
            "mode": generator.last_bridge_mode,
            "bridge": bridge,
        })
        history.append({"role": "user", "content": turn["user"]})
        reply = turn.get("reply", "")
        # 'with_bridge': history carries bridge+reply as one utterance, matching
        # the shared-transcript_id design intent in bridge_generator.py's own
        # comments. 'reply_only': the model never sees its own past bridges —
        # tests whether that visibility is actually what "vary how you open"
        # needs, since it's unconfirmed from backend code alone whether a real
        # session's persisted history includes the bridge text (see record).
        content = f"{bridge} {reply}".strip() if (bridge and history_mode == "with_bridge") else reply
        history.append({"role": "assistant", "content": content})
    return records


async def replay_all(
    generator: BridgeGenerator, sessions: List[Dict[str, Any]], trials: int, history_mode: str,
    concurrency: int = 6,
) -> List[Dict[str, Any]]:
    gate = asyncio.Semaphore(concurrency)

    # Turns within one session run sequentially (history builds up turn over
    # turn), but different sessions/trials are independent — run those
    # concurrently, bounded by the gate. Each task gets its own generator
    # clone (see _clone) so the anti-lockstep state can't leak between them.
    async def one(session):
        async with gate:
            return await run_session(_clone(generator), session, history_mode)

    tasks = [one(session) for session in sessions for _ in range(trials)]
    results = await asyncio.gather(*tasks)
    return [record for run in results for record in run]


def summarize(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    bridges = [r["bridge"] for r in records if r["bridge"]]
    empty = len(records) - len(bridges)

    exact_counts = Counter(bridges)
    exact_repeats = {text: n for text, n in exact_counts.items() if n > 1}

    near_dup_pairs = 0
    for i in range(len(bridges)):
        for j in range(i + 1, len(bridges)):
            if bridges[i] != bridges[j] and _near_duplicate(bridges[i], bridges[j]):
                near_dup_pairs += 1

    openers = Counter(_opener(b) for b in bridges)
    top_opener, top_opener_n = (openers.most_common(1) or [("", 0)])[0]

    by_mode: Dict[str, Dict[str, Any]] = {}
    for mode in ("brief", "full", "thinking"):
        mode_bridges = [r["bridge"] for r in records if r["mode"] == mode and r["bridge"]]
        mode_openers = Counter(_opener(b) for b in mode_bridges)
        top_mode_opener, top_mode_n = (mode_openers.most_common(1) or [("", 0)])[0]
        by_mode[mode] = {
            "turns": sum(1 for r in records if r["mode"] == mode),
            "bridges_generated": len(mode_bridges),
            "distinct_text": len(set(mode_bridges)),
            "distinct_openers": len(mode_openers),
            "top_opener": top_mode_opener,
            "top_opener_share": round(top_mode_n / len(mode_bridges), 2) if mode_bridges else None,
        }

    # "bridges on turns that didn't need one": BRIDGE_MODE_BRIEF is
    # select_bridge_mode's own judgment that the turn carries nothing worth a
    # full reception — yet a bridge (an LLM call) still ran every time, since
    # agent.py has no gate that skips the call outright, only one that shrinks
    # it (see record). That subset's own repetition is reported in by_mode.
    brief_n = by_mode[BRIDGE_MODE_BRIEF]["turns"]

    return {
        "total_turns": len(records),
        "bridges_generated": len(bridges),
        "bridges_empty": empty,
        "distinct_bridge_text": len(exact_counts),
        "exact_repeats": {
            "count_of_repeated_texts": len(exact_repeats),
            "total_repeat_occurrences": sum(exact_repeats.values()),
            "worst_offenders": dict(Counter(exact_repeats).most_common(10)),
        },
        "near_duplicate_pairs": near_dup_pairs,
        "distinct_openers": len(openers),
        "top_opener": {"text": top_opener, "count": top_opener_n,
                        "share_of_all_bridges": round(top_opener_n / len(bridges), 2) if bridges else None},
        "by_mode": by_mode,
        "brief_mode_share_of_all_turns": round(brief_n / len(records), 2) if records else None,
    }


def report(summary: Dict[str, Any], out=sys.stdout) -> None:
    print(json.dumps(summary, indent=2, ensure_ascii=False), file=out)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--scenarios", type=Path, default=SCENARIOS)
    parser.add_argument("--trials", type=int, default=3, help="independent runs per session")
    parser.add_argument("--model")
    parser.add_argument("--temperature", type=float)
    parser.add_argument("--max-tokens", type=int)
    parser.add_argument("--history-limit", type=int)
    parser.add_argument("--prompt", type=Path, help="file with a replacement bridge system prompt")
    parser.add_argument(
        "--history-mode", choices=["with_bridge", "reply_only"], default="with_bridge",
        help="whether conversationHistory carries the bridge text too (see docstring)",
    )
    parser.add_argument("--out", type=Path, help="write per-turn records + summary as JSON")
    parser.add_argument("--concurrency", type=int, default=6)
    args = parser.parse_args(argv)

    generator = BridgeGenerator(LLMService())
    overrides: Dict[str, Any] = {}
    if args.model:
        overrides["model"] = args.model
    if args.temperature is not None:
        overrides["temperature"] = args.temperature
    if args.max_tokens is not None:
        overrides["max_tokens"] = args.max_tokens
    if args.history_limit is not None:
        overrides["history_limit"] = args.history_limit
    if args.prompt:
        overrides["system_prompt"] = args.prompt.read_text()
    if overrides:
        generator.apply_config(overrides)

    sessions = load_scenarios(args.scenarios)
    records = asyncio.run(replay_all(generator, sessions, args.trials, args.history_mode, args.concurrency))
    summary = summarize(records)
    summary["config"] = {
        "model": generator.bridge_model,
        "temperature": generator.bridge_temperature,
        "max_tokens": generator.bridge_max_tokens,
        "history_limit": generator.history_limit or 6,
        "history_mode": args.history_mode,
        "trials": args.trials,
        "sessions": len(sessions),
    }
    report(summary)
    if args.out:
        args.out.write_text(json.dumps({"summary": summary, "records": records}, indent=1, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
