#!/usr/bin/env python3
"""Run Jev on the capabilities expert's hand-written cases (#992).

Asked together with every other question of the ordinary turn, as the pool sends
it, so the result also shows that bundling it costs the others nothing.

Needs TYPESAFE_API_KEY and typesafe-sdk. Sends only the cases in this folder.

Usage: python evals/run_capabilities.py [--repeat 2] [--out results.json]
"""
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from typesafe_sdk import AsyncTypeSafeClient  # noqa: E402

from capabilities_cases import CASES  # noqa: E402
from stella_v2_agent.experts.registry import ExpertRegistry  # noqa: E402
from stella_jev_agent.agent import _OWN_EXPERTS_DIR  # noqa: E402
from stella_jev_agent.ask_back import AskBack  # noqa: E402
from stella_jev_agent.jev import JevClient  # noqa: E402
from stella_jev_agent.pool import JevExpertPool  # noqa: E402
from stella_jev_agent.questions import turn_state  # noqa: E402

# Every expert Jev answers, asked as the pipeline asks them: from their default
# configuration, compiled with 1.2.0 so {{capabilities}} carries STELLA's list.
POOL = JevExpertPool(
    None, ExpertRegistry(experts_dir=str(_OWN_EXPERTS_DIR)), compiler_version="1.2.0",
    jev=JevClient(), ask_back=AskBack(),
)
NAMES = POOL._jev_experts(POOL._registry.get_enabled_names())


def questions_for(c):
    return POOL.expert_questions(NAMES, c["said"], c["history"], {"capabilities": c["capabilities"]})


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeat", type=int, default=2)
    parser.add_argument("--out")
    args = parser.parse_args()

    gate = asyncio.Semaphore(4)
    async with AsyncTypeSafeClient(model="jev-latest", timeout=20.0) as client:
        print(f"model: {client._config.default_model}  questions: {len(NAMES)}")

        async def ask(c):
            async with gate:
                started = time.monotonic()
                state = turn_state(c["said"], c["history"], c["task"], POOL._history_turns(NAMES))
                response = await client.system_one(state, questions_for(c))
                return c, response.answers, (time.monotonic() - started) * 1000

        results = await asyncio.gather(*(ask(c) for c in CASES for _ in range(args.repeat)))

    records, wrong, latencies = [], 0, []
    for c, answers, ms in results:
        answer = answers["capabilities"]
        right = answer.choice == c["expect"]
        wrong += not right
        latencies.append(ms)
        p = answer.probabilities[answer.choice]
        side = {k: answers[k].choice for k in ("medical", "legal", "common_sense")}
        records.append({"id": c["id"], "expect": c["expect"], "choice": answer.choice, "p": p, "ms": ms, **side})
        print(f"  {'ok ' if right else 'BAD'} {c['id']:<26} want {c['expect']:<9} got {answer.choice:<9} "
              f"p={p:.2f} {ms:5.0f} ms  {side}")
    latencies.sort()
    print(f"\n{len(results) - wrong}/{len(results)} as expected; "
          f"median {latencies[len(latencies) // 2]:.0f} ms, p90 {latencies[int(len(latencies) * 0.9)]:.0f} ms")
    if args.out:
        Path(args.out).write_text(json.dumps(records, indent=1, ensure_ascii=False))
    return 1 if wrong else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
