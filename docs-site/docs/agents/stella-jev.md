---
title: "🧠 STELLA Jev"
---

# 🧠 STELLA Jev

A built-in agent (`agents/stella-jev-agent`, slug `stella-jev-agent`) that runs STELLA V2's pipeline with four stages swapped. One Jev call decides the experts and barge-in, and the agent asks back when what it heard isn't believable. It is for research use and is not yet cleared for participant sessions.

:::caution Conversation text goes to TypeSafe
Jev is TypeSafe's model. Every turn's text, and the recent history it judges, is sent to TypeSafe. Deploy it only where that is agreed for the study.
:::

## What changes from STELLA V2

| Stage | STELLA Jev |
|---|---|
| Bridge | None. Nothing is said before the experts have decided |
| Experts | One Jev call answers `common_sense`, `medical`, `legal`, `probing` and `timekeeper` |
| `task_extraction`, `companion_router` | Still language models, because they write values or call tools. They run after Jev, and only when Jev says there may be something to do |
| Reply | gpt-5.4-mini, as in V2, plus a question back when something doesn't fit. It doesn't wait for task extraction: it counts the answer as confirmed, and extraction saves it in the background |
| Barge-in | Jev decides whether an interruption is a real one or only "mhm" |

**Common sense.** When a message doesn't fit (asked how much they drink a day, someone says "Nine litres."; asked about a garden watering can, the same answer is fine), the agent asks back and saves nothing that turn. It asks at most once per statement, never twice in a row, and at most `max_ask_backs` times per session. A medical `critical` verdict always wins.

If Jev can't be reached in time, the experts run on the language model with the prompts in `config/experts/`, and on a barge-in the agent stops for the person.

## Settings

Set in the [Pipeline Configurator](./stella-v2/pipeline-configurator.md), like V2's.

| Node | Setting | Default | What it does |
|---|---|---|---|
| Turn Taking | `take_back_window_ms` | 6000 | See [Take-back](#take-back). 0 is off |
| Expert Pool | `ask_threshold` | 0.45 | How sure Jev must be that a message doesn't fit before the agent asks back |
| Expert Pool | `max_ask_backs` | 3 | The most times it asks back in one session |
| Expert Pool | `skip_threshold` | 0.8 | How sure Jev must be that there is nothing to record or route before task extraction and the companion router are skipped |
| Expert Pool | `jev_timeout_ms` | 1500 | How long to wait for Jev before the experts run on the language model |
| Barge-in | `resume_threshold` | 0.7 | How sure Jev must be that an interruption is only an acknowledgement before the agent carries on |
| Barge-in | `history_limit` | 6 | Recent turns Jev sees when judging an interruption |
| Barge-in | `timeout_ms` | 1000 | How long to wait for Jev's barge-in decision. On a timeout the agent stops and responds |

## Take-back

Sometimes a person's turn is closed and they carry on a moment later ("Ja." … "Letzte Woche war Allerheiligen."). If they start again within `take_back_window_ms` and none of the reply has been heard yet, the reply is held, and Jev decides as for a barge-in:
- If they're carrying on, the reply is dropped and the agent answers all of their words as one turn.
- If it's a stray noise or "mhm", the held reply plays.

Once any of the reply was heard, it's an ordinary barge-in.

Values are saved only once the reply is first heard, so a dropped reply saves nothing. The one exception is a turn where the router starts or ends an activity: that extracts before swapping the plan. On the Text face nothing is played, so turns are never held there.

Analytics events, with timings and outcomes only and no words: `take_back_held`, `take_back_done`, `take_back_no_speech`. The SDK side is described in [Audio pipeline → Take-back](../agent-sdk/audio-pipeline.md#take-back).

## What it declares

| `agent.yaml` | Value |
|---|---|
| `features` | `persona: true`; plans required, modes `plan` and `companion`; a Configurator configuration required |
| `env.required` | `OPENAI_API_KEY`, `TYPESAFE_API_KEY`. A deploy without them is refused, and a session won't start without `TYPESAFE_API_KEY` |
| `sdk.minVersion` | `0.10.0` (take-back) |

## Evals

`agents/stella-jev-agent/evals/` uses only the hand-written cases in `common_sense_cases.py` and `next_step_cases.py`. See the agent's README for the commands. Tune on `dev`, and keep `holdout` for a final check.
