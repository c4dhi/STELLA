---
sidebar_position: 3
title: "Companion Mode"
---

# Companion Mode

A companion agent runs **without a plan**. It talks freely, offers the plans you allow-listed when the user asks what they can do, runs one on request, and drops it whenever they want to stop — including mid-activity.

Plan-following is unchanged. Companion is a different `mode` at deploy time; a deployment that does not ask for it behaves exactly as before.

## When to use it

Use a **plan** when the session has one job: an intake, an assessment, a structured check-in. The agent should reach the end.

Use a **companion** when the person decides what happens. They may do nothing structured at all, one activity, or three in a row. The conversation is the container; activities are things that happen inside it.

## Deploying one

In the deploy flow, the **How should it run?** step offers *Plan* or *Companion*. Choosing Companion replaces the plan picker with an activity picker, where you tick the plans this agent may offer (up to 20).

Those plans are **snapshotted into the deployment**. Editing a plan afterwards does not change what a running session offers, and a restart reproduces the original set. This is the same rule the persona and the pipeline configuration follow.

## What the user experiences

| They say | What happens |
|---|---|
| "What can we do together?" | The agent names the allow-listed activities and invites a choice. |
| "Let's do the memory game." | That plan is loaded and starts from its first step. |
| "Actually, stop." | The plan is dropped; the conversation continues. |
| *(the plan reaches its end)* | The plan's farewell plays as a hand-back line, and free conversation resumes. |

Reaching a plan's `__end__` means **pop, not hang up**. A finished activity is not a finished conversation.

## How it works

The router is an ordinary expert — `companion_router` — with three tools:

- `list_activities` answers **locally** from the deploy snapshot. It runs inside a conversational turn, so it must not add a network round trip.
- `start_activity` calls `LoadPlan` on the state machine.
- `end_activity` calls `ClearPlan`.

`LoadPlan` deliberately is **not** `Initialize`. `Initialize` resumes existing state so a paused agent restarts where it left off, which is wrong here: a user who runs an activity, stops, and picks it again expects it from the top. `ClearPlan` deletes the row rather than blanking it, so every existing "no plan" code path applies unchanged — which is exactly the state a free-flow turn is in.

### It is structural, not an expert you opt into

The router sits in its own section of the Pipeline Configurator, beside Task Extraction, and has **no on/off switch**. That is deliberate: it is the mechanism companion mode is made of, the same way `task_extraction` is the mechanism plans are made of. Deleting either does not leave a working system with one fewer opinion in it — it removes the thing the mode runs on.

So its enablement is a function of the **deploy mode**, not of the configuration: forced on in companion mode, forced off in plan mode, applied *after* the saved configuration so neither direction can be countermanded. One configuration therefore works for both modes, and in plan mode the router costs nothing — it never runs.

It rides on the `companion` capability, so an agent that does not declare that capability never shows the router at all.

### The router is asymmetric on purpose

Starting an activity takes over the conversation and costs the user a turn to undo, so it must never be a guess — the prompt leans hard on abstaining. Ending one errs the other way, because asking to stop and not being let go is the worse failure.

If it starts activities too eagerly, tune the router prompt or raise its model in `config/experts/companion_router.json`. Both are one-line changes.

### Routing outranks expert suggestions

What the router did is a **fact about the session**, not advice. It is delivered to the response prompt as a `routing_directive`, which ranks above every expert suggestion and below the safety boundaries.

This matters more than it sounds. "What can we do together?" is also a probing cue, so the probing expert reliably produces a follow-up question on precisely the turns the router fires. When the routing outcome was ranked as an ordinary suggestion, probing won — the agent asked *"which tasks would you like to do?"* and invented activities, while the real list sat unread.

## What you see while it runs

**In the chat**, routing decisions appear as accented tags — offered, started, left, finished — in the same shape as the join/leave notices. They travel on the debug channel so they persist and replay like any other message, but the processing-message toggle does **not** hide them: they are narrative, not diagnostics.

**In the agent sidebar**, a companion shows `Free conversation` and a **Can offer** list while idle, and the running activity's name once one starts. This is read from the live progress stream, not the deploy snapshot — a companion picks a plan up and drops it mid-session, so the snapshot cannot answer "what is running right now".

**With the processing toggle on**, every tool call the pipeline makes is also shown — `start_activity`, `set_deliverable`, `complete_task` — with the arguments the model passed and what came back.

## Interaction with other features

- **Auto-pause / wake.** A companion that is paused mid-activity resumes into it: the state-machine row outlives the pod, and the agent re-adopts the running plan on ready. If a redeploy removed that plan from the allow-list, the session drops back to free conversation rather than running a plan the deployment no longer offers.
- **Persona.** Unchanged and orthogonal. Identity comes from the persona; activities are structure. The same persona can front any set of activities.
- **Language.** A loaded plan may declare a language, which pins the session for as long as it is running.
