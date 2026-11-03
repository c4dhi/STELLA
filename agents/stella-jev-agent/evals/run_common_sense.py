#!/usr/bin/env python3
"""Run Jev on the hand-written cases and print how often it gets them right.

Needs TYPESAFE_API_KEY and typesafe-sdk. Sends only the cases in this folder.

Usage: python evals/run_common_sense.py [--split dev|holdout|all] [--threshold 0.45] [--out results.json]
"""
import argparse
import asyncio
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from typesafe_sdk import AsyncTypeSafeClient  # noqa: E402

from common_sense_cases import (  # noqa: E402
    BARGE_IN as BARGE_CASES, CASES, CONFIRMED_CONCERNS, EMERGENCIES, HAS_ANSWER_CASES,
)
from stella_jev_agent.questions import (  # noqa: E402
    BARGE_IN, COMMON_SENSE, HAS_ANSWER, MEDICAL, RECOGNISER_ARTIFACT, RESUME, barge_in_state, not_believable,
    turn_state,
)


async def ask(client, gate, state, questions):
    async with gate:
        started = time.monotonic()
        response = await client.system_one(state, questions)
        return response, (time.monotonic() - started) * 1000


def pct(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * q))]


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--split", default="dev", choices=["dev", "holdout", "all"])
    parser.add_argument("--threshold", type=float, default=0.45)
    parser.add_argument("--skip-threshold", type=float, default=0.8)
    parser.add_argument("--out")
    args = parser.parse_args()

    def chosen(items):
        return [c for c in items if args.split == "all" or c["split"] == args.split]

    gate = asyncio.Semaphore(4)
    latencies = []
    records = []
    async with AsyncTypeSafeClient(model="jev-latest", timeout=20.0) as client:
        print(f"model: {client._config.default_model}  split: {args.split}  threshold: {args.threshold}")

        cases = chosen(CASES)
        answers = await asyncio.gather(*(
            ask(client, gate, turn_state(c["said"], c["history"], c["task"]),
                {"common_sense": COMMON_SENSE, "recogniser_artifact": RECOGNISER_ARTIFACT, "medical": MEDICAL})
            for c in cases
        ))
        hit = {}
        print("\ncommon sense")
        for c, (response, ms) in zip(cases, answers):
            latencies.append(ms)
            answer = response.answers["common_sense"]
            p = not_believable(answer.probabilities, response.answers["recogniser_artifact"].probabilities)
            asks = p >= args.threshold
            right = asks == (c["expect"] == "ask")
            hit[c["id"]] = right
            records.append({"id": c["id"], "expect": c["expect"], "p_doesnt_fit": p, "choice": answer.choice, "right": right})
            print(f"  {'ok ' if right else 'BAD'} {c['id']:<18} want {c['expect']:<8} p={p:.2f} {answer.choice}")

        should_ask = [c for c in cases if c["expect"] == "ask"]
        should_not = [c for c in cases if c["expect"] == "carry_on"]
        caught = sum(hit[c["id"]] for c in should_ask)
        false_alarms = sum(not hit[c["id"]] for c in should_not)
        print(f"\ncaught: {caught}/{len(should_ask)}   false alarms: {false_alarms}/{len(should_not)}")
        pairs = {}
        for c in cases:
            if c["pair"]:
                pairs.setdefault(c["pair"], []).append(hit[c["id"]])
        print(f"flipped pairs right on both sides: {sum(all(v) for v in pairs.values())}/{len(pairs)}")

        emergencies = chosen(EMERGENCIES)
        answers = await asyncio.gather(*(
            ask(client, gate, turn_state(c["said"], c["history"]), {"medical": MEDICAL})
            for c in emergencies
        ))
        print("\nemergencies")
        critical = 0
        for c, (response, ms) in zip(emergencies, answers):
            latencies.append(ms)
            answer = response.answers["medical"]
            critical += answer.choice == "critical"
            records.append({"id": c["id"], "expect": "critical", "choice": answer.choice, "p": answer.probabilities})
            print(f"  {'ok ' if answer.choice == 'critical' else 'BAD'} {c['id']:<18} {answer.choice} p={answer.probabilities['critical']:.2f}")
        print(f"critical: {critical}/{len(emergencies)}")

        gate_cases = chosen(HAS_ANSWER_CASES)
        answers = await asyncio.gather(*(
            ask(client, gate, turn_state(c["said"], c["history"], c["task"]), {"has_answer": HAS_ANSWER})
            for c in gate_cases
        ))
        print("\nextraction gate")
        false_skips = needless_runs = 0
        for c, (response, ms) in zip(gate_cases, answers):
            latencies.append(ms)
            p_no = response.answers["has_answer"].probabilities["no"]
            skipped = p_no >= args.skip_threshold
            false_skips += skipped and c["expect"] == "yes"
            needless_runs += not skipped and c["expect"] == "no"
            records.append({"id": c["id"], "expect": c["expect"], "p_no": p_no, "skipped": skipped})
            bad = skipped and c["expect"] == "yes"
            print(f"  {'BAD' if bad else 'ok '} {c['id']:<18} want {c['expect']:<3} p_no={p_no:.2f} {'skipped' if skipped else 'runs'}")
        with_answer = sum(c["expect"] == "yes" for c in gate_cases)
        print(f"answers lost by skipping: {false_skips}/{with_answer}   "
              f"needless runs: {needless_runs}/{len(gate_cases) - with_answer}")

        concerns = chosen(CONFIRMED_CONCERNS)
        answers = await asyncio.gather(*(
            ask(client, gate, turn_state(c["said"], c["history"]), {"medical": MEDICAL}) for c in concerns
        ))
        print("\nhealth concern after a plain yes")
        for c, (response, ms) in zip(concerns, answers):
            latencies.append(ms)
            answer = response.answers["medical"]
            records.append({"id": c["id"], "expect": c["expect"], "choice": answer.choice})
            print(f"  {'ok ' if answer.choice in ('high', 'critical') else 'BAD'} {c['id']:<18} {answer.choice}")

        answers = await asyncio.gather(*(
            ask(client, gate, barge_in_state(c["said"], [], c["interrupted"]), {"barge_in": BARGE_IN})
            for c in BARGE_CASES
        ))
        print("\nbarge-in")
        right_count = 0
        for c, (response, ms) in zip(BARGE_CASES, answers):
            latencies.append(ms)
            answer = response.answers["barge_in"]
            right = answer.choice == c["expect"]
            right_count += right
            records.append({"id": c["id"], "expect": c["expect"], "choice": answer.choice, "p_resume": answer.probabilities[RESUME]})
            print(f"  {'ok ' if right else 'BAD'} {c['id']:<18} want {c['expect']:<7} {answer.choice} p_resume={answer.probabilities[RESUME]:.2f}")
        print(f"right: {right_count}/{len(BARGE_CASES)}")

    print(f"\nlatency ms: median {statistics.median(latencies):.0f}  p90 {pct(latencies, 0.9):.0f}  max {max(latencies):.0f}  n={len(latencies)}")
    if args.out:
        Path(args.out).write_text(json.dumps(records, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
