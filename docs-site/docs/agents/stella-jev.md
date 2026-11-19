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
| `task_extraction` | Still a language model, because it writes the values. It runs after the reply and saves only what Jev picked: the task the message answered, tasks in the same state mentioned in passing (saved unconfirmed, and the reply won't ask about them again) and corrections of a value already collected in this state (overwritten). When Jev is not sure which task was answered, nothing is saved and the question comes again. Two exceptions save without that limit: the answer to an ask-back, and a stalled plan. See [What gets saved](#what-gets-saved) |
| `companion_router` | Still a language model, because it calls tools. It runs after Jev, and only when Jev says there may be something to route |
| Reply | gpt-5.4-mini, as in V2, plus a question back when something doesn't fit. It doesn't wait for task extraction: it counts the answer as confirmed, and extraction saves it in the background |
| Barge-in | Jev decides whether an interruption is a real one or only "mhm" |

**Common sense.** When a message doesn't fit (asked how much they drink a day, someone says "Nine litres."; asked about a garden watering can, the same answer is fine), the agent asks back and saves nothing that turn. It asks at most once per statement, never twice in a row, and at most `max_ask_backs` times per session. A medical `critical` verdict always wins.

**Medical and legal.** A "low" or "high" counts only when Jev is at least `safety_threshold` sure of it; a "high" prepends a fixed warning to the reply. "Everyday forgetting or not knowing what to say" is listed as no health concern. The experts run on the language model only when Jev can't be reached, and then `expert_context` isn't used.

If Jev can't be reached in time, the experts run on the language model with the prompts in `config/experts/`, and on a barge-in the agent stops for the person.

## Settings

Set in the [Pipeline Configurator](./stella-v2/pipeline-configurator.md): click the **Expert Pool** stage, and the settings are listed under the experts.

| Node | Setting | Default | What it does |
|---|---|---|---|
| Turn Taking | `take_back_window_ms` | 6000 | See [Take-back](#take-back). 0 is off |
| Expert Pool | `ask_threshold` | 0.45 | How sure Jev must be that a message doesn't fit before the agent asks back |
| Expert Pool | `max_ask_backs` | 3 | The most times it asks back in one session |
| Expert Pool | `skip_threshold` | 0.8 | How sure Jev must be that there is nothing to route before the companion router is skipped. It skips task extraction only when the state has no open or collected task; otherwise Jev's pick decides |
| Expert Pool | `forecast_threshold` | 0.7 | How sure Jev must be which task the latest message answered before the reply moves on and extraction saves it. Below it nothing is saved and the question comes again |
| Expert Pool | `also_threshold` | 0.8 | How sure Jev must be that the message also settled another task in this state, or corrected a collected one, before that is saved too |
| Expert Pool | `safety_threshold` | 0.6 | How sure Jev must be of a medical or legal "low" or "high" before it counts. Below it the verdict steps down a level (high to low to none), so a weak guess never prepends the fixed warning. "critical" always counts |
| Expert Pool | `expert_context` | empty | A sentence or two on what kind of conversation this is and who the person is. Jev reads it with every message. Example: "A friendly weekly check-in chat with an older adult about their week. It is not a health service." |
| Expert Pool | `jev_timeout_ms` | 1500 | How long to wait for Jev before the experts run on the language model |
| Barge-in | `resume_threshold` | 0.7 | How sure Jev must be that an interruption is only an acknowledgement before the agent carries on |
| Barge-in | `history_limit` | 6 | Recent turns Jev sees when judging an interruption |
| Barge-in | `timeout_ms` | 1000 | How long to wait for Jev's barge-in decision. On a timeout the agent stops and responds |

## What gets saved

The reply is steered by Jev's pick before anything is saved, so extraction follows the same pick; otherwise the reply asks again for what is already saved, or moves on from what never was. In one call Jev answers which open task the message answered, and a yes or no for each other open task (mentioned in passing) and each task already collected in this state (corrected). Extraction gets state machine tools that write only those tasks, and refuses the rest.

The trade-off: when Jev is unsure, nothing is saved that turn, and Grace asks again. Corrections reach only the current state.

Each turn posts two debug lines to the session chat, which a transcript reader will see:
- `Jev: answered "…" (0.86), also mentioned "…" (0.90), reply moves on to …`, or that it asks back first and saves nothing yet.
- `Extraction saved …`, with what it refused or left unsaved.

When extraction leaves a picked task unsaved or tries to write another, the analytics event `extraction_declined_pick` records which tasks, without any words.

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
