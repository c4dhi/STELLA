"""Replay synthetic companion sessions through the real BridgeGenerator AND
ResponseGenerator, and measure repetition, variety, and bridge/reply overlap
(#94).

Felix, 20 Oct 2026, dev session: "we have a general problem with bridges, as it
causes repetitions and is very monotonous." Felix (relayed by @zenith, 16:43)
rules out skipping the bridge on trivial turns; his actual goal is narrower:
the bridge must not preview what the reply says, and the reply must never
repeat the bridge, in wording or in meaning. So this generates the REAL reply
after each bridge too — bridge as its spoken prefix, exactly as agent.py does
— and reports, turn by turn and in aggregate:

  - exact and near-duplicate repeats across all generated bridges;
  - variety: distinct openers and the share held by the most common one;
  - how many bridges were generated on a turn ``select_bridge_mode`` itself
    classifies as needing no more than a beat (BRIEF), and how much LESS varied
    that subset is than the rest — the brief's "bridges that didn't need one";
  - bridge/reply WORDING overlap (shared words and shared bigrams, as a share
    of the bridge's own words) for every turn;
  - bridge/reply MEANING overlap on a sample (``--judge-every``): a separate,
    narrow, temperature-0 LLM call asked only "does the reply repeat, in
    different words, something the bridge already conveyed?".

Every generator this drives is configured from agent.yaml's ACTUAL deployed
defaults (``slot_defaults()``, read fresh from the file, not copied by hand)
— the bridge model/temperature/max_tokens/prompt, the response model/
temperature/max_tokens, the companion free-conversation guidelines, the
per-situation reply_instructions (the real ``routing_directive`` a live
free-conversation turn gets, via ``Companion.instruction()``), and the judge
model. So running this with NO flags at all reproduces the actual deployed
baseline, not any hand-picked stand-in — the first version of this harness
got exactly this wrong (used BridgeGenerator's code-fallback 0.7 instead of
agent.yaml's deployed 0.4), caught by @zenith before it reached the card.

No transcript text from a real session is used; every turn is scripted. Needs
OPENAI_API_KEY (both models are gpt-4o-mini via OPENAI_LANGCHAIN by default)
— this script makes real model calls, so run it where that key is set, not
inside a session that has none:

    OPENAI_API_KEY=... PYTHONPATH=src:../stella-ai-agent-sdk/src \\
        python tests/bridge_repetition_replay.py --out before.json

To isolate a single candidate cause (per the card: "change one factor at a
time"), override just that one knob on top of the deployed baseline above,
and diff the reports:

    python tests/bridge_repetition_replay.py --temperature 0.7 --out temp_0.7.json

    # whether the model can see its own past bridges at all (settled by code
    # per @sable's review — kept only as a control, not a candidate fix)
    python tests/bridge_repetition_replay.py --history-mode reply_only --out no_bridge_history.json

    # option 1's "after": BRIEF's literal canned examples diversified/removed.
    # NOT the same as --prompt: the BRIEF directive text lives in a separate
    # code constant (_MODE_DIRECTIVES), appended to whatever base prompt is in
    # play, so --prompt alone can't change it — hence this dedicated flag.
    python tests/bridge_repetition_replay.py \\
        --brief-directive tests/bridge_brief_directive_diversified.txt --out option1_after.json

    # option 2's "after": a sharpened "free" reply_instruction that explicitly
    # forbids restating the bridge's point in different words, not just a
    # literal repeat.
    python tests/bridge_repetition_replay.py \\
        --free-instruction tests/companion_free_instruction_sharpened.txt --out option2_after.json
"""

import argparse
import asyncio
import json
import re
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from stella_agent_sdk.llm import LLMConfig, LLMMessage, LLMProvider, LLMService, stream_completion
from stella_v2_agent.companion import NO_CHANGE, Companion
from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.pipeline import bridge_generator as bridge_generator_module
from stella_v2_agent.pipeline.bridge_generator import BRIDGE_MODE_BRIEF, BridgeGenerator
from stella_v2_agent.pipeline.response_generator import ResponseGenerator

HERE = Path(__file__).parent
SCENARIOS = HERE / "bridge_repetition_scenarios.json"
AGENT_YAML = HERE.parent / "agent.yaml"


def slot_defaults(node_id: str, manifest_path: Path = AGENT_YAML) -> Dict[str, Any]:
    """A pipelineSchema node's slot defaults, read straight from agent.yaml —
    not hand-copied into this script, which is exactly how the first version
    of this harness got the bridge temperature wrong (0.7, the BridgeGenerator
    CLASS's fallback, instead of 0.4, what agent.yaml actually ships — caught
    by @zenith before it reached the card). Every generator this script drives
    is configured FROM this, so a future agent.yaml change can't silently
    drift out of sync with what gets measured."""
    manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))
    nodes = (manifest.get("pipelineSchema") or {}).get("nodes") or []
    node = next((n for n in nodes if n.get("id") == node_id), None)
    if node is None:
        raise ValueError(f"agent.yaml has no '{node_id}' node")
    return {s["id"]: s.get("default") for s in node.get("slots") or []}

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


def _bigrams(words: List[str]) -> List[str]:
    return [f"{a} {b}" for a, b in zip(words, words[1:])]


def _opener(bridge: str) -> str:
    return " ".join(_words(bridge)[:_OPENER_WORDS])


def _near_duplicate(a: str, b: str) -> bool:
    wa, wb = _words(a), _words(b)
    if not wa or not wb:
        return False
    shared = len(set(wa) & set(wb))
    return shared / max(len(wa), len(wb)) >= _NEAR_DUP_OVERLAP


def _wording_overlap(bridge: str, reply: str) -> Optional[Dict[str, float]]:
    """How much of the BRIDGE's own wording reappears in the reply that
    follows it — the share is relative to the bridge (not the longer reply),
    since what matters is whether the bridge gets echoed, not how much of the
    reply happens to share common words."""
    bw, rw = _words(bridge), _words(reply)
    if not bw or not rw:
        return None
    shared_words = len(set(bw) & set(rw))
    bb, rb = _bigrams(bw), _bigrams(rw)
    shared_bigrams = len(set(bb) & set(rb)) if bb else 0
    return {
        "word_overlap": round(shared_words / len(bw), 2),
        "bigram_overlap": round(shared_bigrams / len(bb), 2) if bb else 0.0,
    }


_JUDGE_PROMPT = (
    "A spoken companion said BRIDGE as a quick first reaction, then immediately "
    "continued with REPLY as the rest of the same turn. Does REPLY repeat, in "
    "different words, something BRIDGE already conveyed (the same reaction, "
    "the same observation, the same point) — not just related, but saying the "
    "same thing again? Answer with exactly one word: YES or NO."
)


async def _judge_meaning_overlap(
    llm_service: LLMService, bridge: str, reply: str, model: str,
) -> Optional[bool]:
    """A narrow, temperature-0, single-purpose judge call — not the bridge or
    response model itself, so a verdict on either doesn't bias the other.
    Returns None on any failure (timeout, parse) rather than guessing."""
    if not bridge or not reply:
        return None
    messages = [
        LLMMessage(role="system", content=_JUDGE_PROMPT),
        LLMMessage(role="user", content=f"BRIDGE: {bridge}\nREPLY: {reply}"),
    ]
    config = LLMConfig(
        model=model, temperature=0.0, max_tokens=5,
        provider=LLMProvider.OPENAI_LANGCHAIN, streaming=True,
    )
    try:
        verdict = ""
        async for text, is_final in stream_completion(
            llm_service, messages, config, component_name="bridge_reply_overlap_judge",
        ):
            verdict = text
            if is_final:
                break
    except Exception:
        return None
    return verdict.strip().upper().startswith("YES")


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


async def _generate_reply(
    response_generator: ResponseGenerator, companion: Companion, session_id: str,
    user_input: str, history: List[Dict[str, str]], bridge: str, language: Optional[str],
) -> str:
    """The real reply, as agent.py's free-conversation path builds it:

    - ``bridge`` as the spoken prefix the model must continue from, not repeat;
    - the turn's ``routing_directive`` from ``Companion.instruction()`` — the
      SAME per-situation instruction production uses (agent.py:594), which for
      an ordinary free-conversation turn renders agent.yaml's
      ``companion.reply_instructions['free']`` ("you already reacted aloud
      with {{bridge}}... add at most ONE short sentence... no second
      reaction"). This is the actual deployed mechanism meant to stop
      exactly the overlap this ticket measures — the first version of this
      harness omitted it entirely, which would have mismeasured the
      mechanism under test rather than its absence;
    - ``companion.settings.free_conversation_guidelines`` as the style guide,
      not whatever ``ResponseGenerator`` falls back to (the PLAN-mode default,
      a different prompt — see agent.py's ``_free_guidelines()``).

    Returns only the generated CONTINUATION (the prefix stripped back off) —
    what should be compared against the bridge for overlap, since the prefix
    is the bridge's own text by construction and comparing it to itself would
    be a trivial 100% every time."""
    routing_directive = companion.instruction(NO_CHANGE, bridge=bridge)
    prefix = f"{bridge} " if bridge else ""
    final_text = ""
    async for output in response_generator.generate(
        session_id, user_input, ResponseDirective(routing_directive=routing_directive),
        history, {"language": language}, bridge=bridge,
        guidelines=companion.settings.free_conversation_guidelines,
    ):
        final_text = output.content
    return final_text[len(prefix):].strip() if final_text.startswith(prefix) else final_text.strip()


async def run_session(
    generator: BridgeGenerator, response_generator: ResponseGenerator, companion: Companion,
    session: Dict[str, Any], history_mode: str, judge_model: str, judge_every: int,
) -> List[Dict[str, Any]]:
    """One pass through a session's fixed script. Returns one record per turn."""
    history: List[Dict[str, str]] = []
    records = []
    for index, turn in enumerate(session["turns"]):
        # Wall-clock around the whole call, not just a log line: generate()
        # drains generate_stream(), which is bounded by bridge_timeout_s, so
        # an EMPTY bridge that took ~the full timeout is a drop from running
        # out of time, while an empty one that returned fast is a drop from
        # the validator rejecting the first sentence (echo/question/length) —
        # the two live-session drop causes @zenith/Felix asked to tell apart
        # (20 Oct, 19:58: "Bridge first-sentence latency against the 2 s
        # timeout matters too").
        start = time.monotonic()
        bridge = await generator.generate(
            turn["user"],
            history,
            language=session.get("language"),
            variables={
                "activitiesOnOffer": turn.get("activities_on_offer", False),
                "isBargeIn": turn.get("barge_in", False),
            },
        )
        latency_ms = (time.monotonic() - start) * 1000
        session_id = f"bridge94-{session['id']}"
        try:
            reply = await _generate_reply(
                response_generator, companion, session_id, turn["user"], history, bridge, session.get("language"),
            )
        except Exception:
            reply = ""
        overlap = _wording_overlap(bridge, reply)
        # A sample, not every turn (@zenith, 16:43: "an LLM judge on a
        # sample") — one real call per sampled turn is enough signal without
        # doubling the model-call cost of the whole run.
        meaning_overlap = None
        if reply and bridge and judge_every > 0 and index % judge_every == 0:
            meaning_overlap = await _judge_meaning_overlap(generator._llm_service, bridge, reply, judge_model)
        # select_bridge_mode's own BRIEF rule *is* "this turn carries too
        # little to receive in full" — reused in summarize() as the
        # definition of "didn't need one" rather than inventing a second one.
        records.append({
            "session": session["id"],
            "user": turn["user"],
            "mode": generator.last_bridge_mode,
            "bridge": bridge,
            "reply": reply,
            "latency_ms": round(latency_ms),
            "wording_overlap": overlap,
            "meaning_overlap_repeats": meaning_overlap,
        })
        history.append({"role": "user", "content": turn["user"]})
        # 'with_bridge': history carries bridge+reply as one utterance, matching
        # what response_generator.py itself persists as the turn's spoken
        # content — confirmed in review (@sable), not a candidate cause.
        # 'reply_only' is kept as a control for anyone who wants to re-check.
        content = f"{bridge} {reply}".strip() if (bridge and history_mode == "with_bridge") else reply
        history.append({"role": "assistant", "content": content})
    return records


async def replay_all(
    generator: BridgeGenerator, sessions: List[Dict[str, Any]], trials: int, history_mode: str,
    judge_model: str, judge_every: int, concurrency: int = 6,
    free_instruction_override: Optional[str] = None, response_model_override: Optional[str] = None,
) -> List[Dict[str, Any]]:
    gate = asyncio.Semaphore(concurrency)

    # Turns within one session run sequentially (history builds up turn over
    # turn), but different sessions/trials are independent — run those
    # concurrently, bounded by the gate. Each task gets its own generator
    # clone (see _clone) so the anti-lockstep state can't leak between them.
    # ResponseGenerator and the Companion helper (used only to render the
    # real reply_instructions text — see _generate_reply) carry no
    # per-session state, so one instance of each is shared across every task.
    response_generator = ResponseGenerator(generator._llm_service)
    response_defaults = slot_defaults("response_generator")
    response_generator.apply_config({
        "model": response_model_override or response_defaults["model"],
        "temperature": response_defaults["temperature"],
        "max_tokens": response_defaults["max_tokens"],
    })
    companion = Companion(activities=[])
    companion.greeted = True  # skip the opening greeting/offer path (not under test)
    companion.offered = True
    if free_instruction_override is not None:
        # Option 2's "after": a sharpened version of agent.yaml's own
        # companion.reply_instructions['free'] (see --free-instruction).
        companion.settings.reply_instructions["free"] = free_instruction_override

    async def one(session):
        async with gate:
            return await run_session(
                _clone(generator), response_generator, companion, session, history_mode, judge_model, judge_every,
            )

    tasks = [one(session) for session in sessions for _ in range(trials)]
    results = await asyncio.gather(*tasks)
    return [record for run in results for record in run]


def summarize(records: List[Dict[str, Any]], timeout_ms: float = 2000.0) -> Dict[str, Any]:
    bridges = [r["bridge"] for r in records if r["bridge"]]
    empty = len(records) - len(bridges)

    # A drop's own latency says which of the two live causes it was: ran out
    # of the bridge_timeout_s budget (latency close to it), or the validator
    # rejected the first sentence and the call returned early (#94, 20 Oct
    # 19:58). 90% of the timeout is a deliberately loose cutoff — the budget
    # covers first-byte AND the tail, so a genuine timeout rarely lands
    # exactly at the millisecond.
    dropped = [r for r in records if not r["bridge"]]
    drop_latencies = [r["latency_ms"] for r in dropped]
    near_timeout_drops = sum(1 for ms in drop_latencies if ms >= 0.9 * timeout_ms)
    all_latencies = [r["latency_ms"] for r in records]

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

    # Felix's actual goal (relayed by @zenith, 16:43): not that trivial turns
    # skip the bridge, but that the bridge never previews the reply and the
    # reply never repeats the bridge. Wording: computed for every turn that
    # has both. Meaning: only for the turns a judge call actually ran on.
    overlap_pairs = [r["wording_overlap"] for r in records if r.get("wording_overlap")]
    judged = [r for r in records if r.get("meaning_overlap_repeats") is not None]
    judged_yes = sum(1 for r in judged if r["meaning_overlap_repeats"])

    return {
        "total_turns": len(records),
        "bridges_generated": len(bridges),
        "bridges_empty": empty,
        "bridge_latency_ms": {
            "mean_all": round(sum(all_latencies) / len(all_latencies)) if all_latencies else None,
            "max_all": round(max(all_latencies)) if all_latencies else None,
            "mean_dropped": round(sum(drop_latencies) / len(drop_latencies)) if drop_latencies else None,
            "max_dropped": round(max(drop_latencies)) if drop_latencies else None,
            "timeout_ms": timeout_ms,
            "drops_near_timeout": near_timeout_drops,
            "drops_early_reject": empty - near_timeout_drops,
        },
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
        "bridge_reply_overlap": {
            "turns_with_both": len(overlap_pairs),
            "mean_word_overlap": round(sum(p["word_overlap"] for p in overlap_pairs) / len(overlap_pairs), 2) if overlap_pairs else None,
            "mean_bigram_overlap": round(sum(p["bigram_overlap"] for p in overlap_pairs) / len(overlap_pairs), 2) if overlap_pairs else None,
            "turns_above_0.5_word_overlap": sum(1 for p in overlap_pairs if p["word_overlap"] > 0.5),
            "meaning_overlap_sample": {
                "judged": len(judged),
                "repeats_meaning_count": judged_yes,
                "repeats_meaning_rate": round(judged_yes / len(judged), 2) if judged else None,
            },
        },
    }


def report(summary: Dict[str, Any], out=sys.stdout) -> None:
    print(json.dumps(summary, indent=2, ensure_ascii=False), file=out)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--scenarios", type=Path, default=SCENARIOS)
    parser.add_argument("--trials", type=int, default=2, help="independent runs per session")
    parser.add_argument("--model", help="override for the bridge generator's model")
    parser.add_argument(
        "--response-model",
        help="override for the response generator's model (agent.yaml's response_generator.model moved "
        "to gpt-5.4-mini alongside the bridge's, per PR #707 — override both together to match a given "
        "deployed config, since this script's own agent.yaml hasn't got that change on this branch)",
    )
    parser.add_argument("--temperature", type=float)
    parser.add_argument("--max-tokens", type=int)
    parser.add_argument("--history-limit", type=int)
    parser.add_argument("--prompt", type=Path, help="file with a replacement bridge BASE system prompt")
    parser.add_argument(
        "--brief-directive", type=Path,
        help="file replacing _MODE_DIRECTIVES[BRIEF] for this run (option 1's 'after': BRIEF's "
        "canned examples diversified/removed — NOT part of the base --prompt text, see docstring)",
    )
    parser.add_argument(
        "--free-instruction", type=Path,
        help="file replacing agent.yaml's companion.reply_instructions['free'] for this run "
        "(option 2's 'after': a sharpened anti-restate instruction)",
    )
    parser.add_argument(
        "--history-mode", choices=["with_bridge", "reply_only"], default="with_bridge",
        help="whether conversationHistory carries the bridge text too (see docstring)",
    )
    parser.add_argument(
        "--judge-model", help="model for the meaning-overlap judge call "
        "(default: companion.judge_model from agent.yaml — the same judge model "
        "companion mode already uses for its exit/start confirmation checks; "
        "this specific judge TASK is new to this script, not a deployed mechanism)",
    )
    parser.add_argument(
        "--judge-every", type=int, default=3,
        help="run the meaning-overlap judge on every Nth turn (0 disables it)",
    )
    parser.add_argument("--out", type=Path, help="write per-turn records + summary as JSON")
    parser.add_argument("--concurrency", type=int, default=6)
    args = parser.parse_args(argv)

    # Deployed defaults FIRST (agent.yaml, read fresh — not hand-copied), then
    # CLI overrides on top of those, never instead of them. This is what makes
    # "no flags at all" mean "the actual production baseline" rather than
    # BridgeGenerator's own code-fallback values, which is exactly the bug
    # @zenith caught in this harness's first real run.
    bridge_defaults = slot_defaults("bridge_generator")
    generator = BridgeGenerator(LLMService())
    generator.apply_config({
        "model": bridge_defaults["model"],
        "temperature": bridge_defaults["temperature"],
        "max_tokens": bridge_defaults["max_tokens"],
        "system_prompt": bridge_defaults["system_prompt"],
        "timeout_ms": bridge_defaults["timeout_ms"],
    })
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

    judge_model = args.judge_model or Companion(activities=[]).settings.judge_model

    if args.brief_directive:
        # Mutates the module-level dict in place: scoped to this one process/
        # run, same convention as the rest of this script's config overrides.
        bridge_generator_module._MODE_DIRECTIVES[BRIDGE_MODE_BRIEF] = args.brief_directive.read_text().strip()
    free_instruction = args.free_instruction.read_text().strip() if args.free_instruction else None

    sessions = load_scenarios(args.scenarios)
    records = asyncio.run(replay_all(
        generator, sessions, args.trials, args.history_mode, judge_model, args.judge_every, args.concurrency,
        free_instruction_override=free_instruction, response_model_override=args.response_model,
    ))
    summary = summarize(records, timeout_ms=generator.bridge_timeout_s * 1000)
    response_defaults = slot_defaults("response_generator")
    summary["config"] = {
        "bridge_generator": {
            "model": generator.bridge_model,
            "temperature": generator.bridge_temperature,
            "max_tokens": generator.bridge_max_tokens,
            "timeout_ms": generator.bridge_timeout_s * 1000,
            "history_limit": generator.history_limit or 6,
            "prompt_source": "agent.yaml (CLI --prompt override)" if args.prompt else "agent.yaml bridge_generator.system_prompt",
            "brief_directive_source": f"--brief-directive {args.brief_directive}" if args.brief_directive else "agent.yaml-equivalent code default (_MODE_DIRECTIVES[BRIEF], unchanged)",
        },
        "response_generator": {
            "model": args.response_model or response_defaults["model"],
            "model_source": "--response-model override" if args.response_model else "agent.yaml response_generator.model (unchanged)",
            "temperature": response_defaults["temperature"],
            "max_tokens": response_defaults["max_tokens"],
            "guidelines_source": "agent.yaml companion.free_conversation_guidelines (via Companion, not the response_generator node's own guidelines — matches agent.py's _free_guidelines())",
            "routing_directive_source": "Companion.instruction(NO_CHANGE, bridge) -> agent.yaml companion.reply_instructions['free']",
            "free_instruction_source": f"--free-instruction {args.free_instruction}" if args.free_instruction else "agent.yaml companion.reply_instructions['free'] (unchanged)",
        },
        "judge_model": judge_model,
        "judge_model_source": "agent.yaml companion.judge_model" if not args.judge_model else "--judge-model override",
        "judge_every": args.judge_every,
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
