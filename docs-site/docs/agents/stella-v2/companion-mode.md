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
| *(tapped awake)* | "Woken up" appears in the transcript, and she greets them and asks how they are doing, without waiting to be spoken to. |
| "Hi Grace" *(first thing said)* | The same greeting. |
| *(their answer)* | She reacts in a few words and offers the activities, once. |
| "No." *(to that offer)* | She says she is there when wanted, and goes to sleep. "No thanks, let's just chat" keeps her awake. |
| *(anything else in free conversation)* | A sentence or two about what they said, and no follow-up question. Only when they bring up an activity themselves does she ask whether they want to do it. |
| "Let's do the memory game." | That plan is loaded and starts from its first step. |
| "The fitness one." | She asks which she understood — "Do you mean the Extended Fitness Check-in?" — and starts it on a yes. |
| "Actually, stop." | The agent asks whether to stop it (or, if the request was unmistakable, stops right away). |
| "Yes." | The plan is dropped; she says so in a sentence and asks whether they would like to do one of the other activities instead. "No", and the activity carries on; unclear, and it asks once more. |
| *(the plan reaches its end)* | The plan's farewell plays, then she thanks them and asks whether they would like to do one of the other activities. |
| "No thanks." *(to that)* | She winds down: that is fine, and they can wake her whenever they want to talk again. Then she sleeps. |
| "Good night." / "Go to sleep." | She says goodbye in a sentence and goes to sleep until tapped awake. |
| *(nothing, for 45 seconds, outside an activity)* | She goes to sleep without a word. |

Reaching a plan's `__end__` means **pop, not hang up**. A finished activity is not a finished conversation.

## Inside an activity it is plan mode

The one rule everything else follows: **an activity runs exactly as a plan-mode deployment of that plan would.** The reply and every expert get the same plan context and the same history, and that history starts where the activity started, the way a plan-mode session has nothing before its first turn. Nothing from the free conversation carries into the activity.

The only additions are the way out (asked, then confirmed) and the hand-back at the plan's end. A test replays an activity turn and the same turn in a plan-mode deployment, and fails if their inputs differ (`tests/test_companion_turns.py`).

## How it works

Each mode has **one judge**, asking one question:

| Mode at turn start | Judge | Its question |
|---|---|---|
| Free conversation | `companion_router`, an ordinary expert with three tools | Do they want to see the activities, start one, or are they done for now? |
| In an activity | the exit dialogue, on every turn | Do they want to leave? |
| Asked to stop | the exit dialogue | Was that a yes? |

The router's tools, `list_activities`, `start_activity` and `go_to_sleep`, only **propose**: each returns a command and touches nothing. The router does not run inside an activity, and there is no tool for leaving.

The agent then makes at most one transition per turn, after every expert has finished, judged against the mode the turn started in (`stella_v2_agent/companion.py`):

| Mode at turn start | The judge says | What happens |
|---|---|---|
| Free conversation | list | The activities are offered. |
| Free conversation | start, and the user said its title | The plan is loaded (`LoadPlan`); the reply opens its first step. |
| Free conversation | start, title not said | "Do you mean X?" is asked; nothing starts yet. |
| Asked "do you mean X?" | *(a yes)* | X starts. Anything else closes the question: another activity they name is handled as a fresh choice, and a plain no starts nothing. |
| Free conversation | sleep | The reply says goodbye; the device is told to sleep once that has been heard. |
| In an activity | stay | Nothing. The turn is an ordinary plan turn. |
| In an activity | ask | "Shall we stop X?" is asked; nothing ends yet. |
| In an activity | leave | The request was unmistakable: the plan is dropped (`ClearPlan`). |
| Asked to stop | leave / stay / ask | Leave, carry on, or — if genuinely unclear — ask once more. |

The **exit dialogue** is one scoped LLM call, separate from the reply model. It sees only the user's words and the last few turns. It first states what it understands the user to want, checks that against their words, and only then decides. When it asks, it writes the question itself, in the session's language and the persona's voice, and that question is spoken as written. Given only an instruction to ask, the reply model followed the plan instead. Its reading of the user appears as the detail line of the decision tag. If the call fails, nothing changes.

It runs on its own model (the Companion node's *Judge Model*, `gpt-5.4-mini` as shipped), not the reply model: with the stop question open, `gpt-4o-mini` left on almost any answer, including transcription noise.

Leaving used to take two judges in a row: the router had to notice a stop before the exit dialogue was asked what it was, so a stop the router missed never reached the judge that would have understood it.

Because nothing is applied until the pool has finished, the experts cannot race the plan loading or clearing.

`LoadPlan` deliberately is **not** `Initialize`. `Initialize` resumes existing state so a paused agent restarts where it left off, which is wrong here: a user who runs an activity, stops, and picks it again expects it from the top. `ClearPlan` deletes the row rather than blanking it, so every existing "no plan" code path applies unchanged — which is exactly the state a free-flow turn is in.

### Free conversation is company, not an interview

Outside an activity the reply is written from its own short style guide (*Free Conversation Guidelines*), not from the Response Generator's conversation guidelines. Those are written for plans: a curious interviewer working towards something, with every example ending in a question. Used in free conversation they made her ask a follow-up on every turn.

She has one routine of her own, run once each time she is woken: on the first turn she asks how they are, on the next she offers the activities. What the user asks for comes first, so "what can we do?" or "good night" on the first turn is simply answered. After the offer she only responds. Going to sleep, asked or idle, starts the routine over. Clearing the `greeting` or `offered_unasked` reply instruction switches that step off.

Stepping away is the router's decision, not the reply's, so it is in the replay set: `go_to_sleep` also fires when the activities were just offered and they want none. `list_activities` also fires when the user says they have nothing on their mind.

### Going to sleep

A companion is not meant to keep a conversation going. It ends one in two ways, both only in free conversation:

**Only the agent sends her to sleep.** The face has no timer of its own in a session: only the agent knows whether a conversation is over, and a face that dozed off by itself could do so while the agent was waiting for an answer.

**Woken, she speaks first.** When the user taps her awake, the device tells the agent (`client_event: wake`). The agent notes "Woken up" in the transcript and opens the turn itself: she greets them and asks how they are, without waiting to be spoken to. The device also reports when she has fallen asleep, so a sleeping face is not sent to sleep a second time by the idle timer.

- **Asked, or nothing left to do.** The router proposes `go_to_sleep` on a goodbye, a good night, or "go to sleep", and when the user wants none of the activities she just offered. The reply is one short goodbye, and the agent sends the device a `sleep` command, which the SDK delivers once the goodbye has finished playing.
- **Unasked.** After 45 seconds with no turn, no speech and nothing done on the device, the agent sends `sleep` without saying anything. *Sleep After Silence* changes it; `0` switches it off.

**She never sleeps inside an activity.** When one starts, the agent tells the device `sleep_allowed: false`, and the face then ignores any `[sleep]` tag in a reply and any sleep command until the activity ends or is left. A goodbye said mid-activity is the exit dialogue's to judge: it leaves or asks, and she can be sent to sleep from free conversation afterwards.

### A poorly heard message never changes the mode

Each spoken turn arrives with a transcript confidence between 0 and 1, computed by the STT service from the decode itself: low for mumbled speech, and low for filler the transcriber invents over near-silence ("Thank you.", "Bye."). Typed text is 1; 0 means the provider gave no signal and is not treated as doubt.

Below `min_confidence` (default 0.4), a message cannot leave an activity, start one, or send her to sleep. It can only make her ask:

| Heard poorly | Instead of | She |
|---|---|---|
| a yes to "shall we stop?", or a stop request | leaving | asks (again) whether to stop |
| a choice of activity, or a goodbye | starting it, or going to sleep | says she did not catch that and asks them to repeat |

A poorly heard "no", an ordinary activity answer, or "what can we do?" are handled as usual: none of them commits to anything.

The default is where Whisper's own conventions put "low confidence"; it has not been calibrated on recorded sessions. Every turn logs its confidence, and *Minimum Transcript Confidence* changes it (`0` switches the check off).

### What you can change

The code decides *when* something happens: one judge per mode, one transition per turn. What is said about it, which model judges and how long she waits are settings. They are the **Companion** node of the Pipeline Configurator, shipped as that node's defaults in `agent.yaml`, and the running agent reads the same file, so what the configurator shows is what runs.

| Setting | What it holds |
|---|---|
| Free Conversation Guidelines | The reply's style guide outside an activity. |
| Reply Instructions | One instruction per situation: `greeting`, `offered_unasked`, `offered`, `offered_none`, `free`, `started`, `start_asked`, `start_declined`, `exit_asked`, `exit_declined`, `exited`, `finished`, `unheard`, `dismissed`. Each is the last thing the reply model reads on that turn, and can use `{{bridge}}`, the opener already spoken, so she does not greet or react twice, and `{{other_activities}}` for the hand-back after an activity. Clearing `finished` removes that line; rewording `exited` or `finished` without the question removes the off-boarding offer. |
| Leaving / Starting an Activity: Judge Instructions | What the two judges are told. The answer format is appended by the agent and is not editable, so an edit cannot break the parsing. |
| Judge Model | The model for both judges. |
| Stop / Start Questions in a Row | How often she asks again before letting it go (2). |
| Sleep After Silence | Seconds of quiet before she sleeps (45; 0 = never). |
| Minimum Transcript Confidence | Below this a message cannot change the mode (0.4; 0 = off). |

Nothing in companion mode overrules a setting out of sight. The reply instruction for a turn is passed on as written, introduced only by "For this turn:". The free-conversation guide replaces the Response Generator's guidelines outside an activity, and both nodes say so. The one hidden predecessor, `nodes.exit_dialogue.model`, is read only when the configuration does not set *Judge Model*.

A saved configuration overrides these one value at a time, and reply instructions one entry at a time. When and what the router proposes is the router expert's own prompt, in the Structural section.

### It is structural, not an expert you opt into

The router sits in its own section of the Pipeline Configurator, beside Task Extraction, and has **no on/off switch**. That is deliberate: it is the mechanism companion mode is made of, the same way `task_extraction` is the mechanism plans are made of. Deleting either does not leave a working system with one fewer opinion in it — it removes the thing the mode runs on.

So its enablement is a function of the **deploy mode**, not of the configuration: forced on in companion mode, forced off in plan mode, applied *after* the saved configuration so neither direction can be countermanded. One configuration therefore works for both modes, and in plan mode the router costs nothing — it never runs.

It rides on the `companion` capability, so an agent that does not declare that capability never shows the router at all.

### Starting and leaving err in opposite directions

Starting an activity takes over the conversation and costs the user a turn to undo, so it must never be a guess. The router's prompt leans hard on abstaining, and its choice is only acted on at once when the user's own words contain the activity's title. Otherwise — a description, "the fitness one", a garbled name, a yes to a spoken offer, a choice heard poorly — she asks about the one the router picked, and a second scoped call (`start_dialogue`, on the exit dialogue's model) judges whether the answer is a yes. Give activities short, distinct titles in the language the study is run in: a title people actually say starts without the extra turn. Leaving errs the other way, because asking to stop and not being let go is the worse failure: the exit dialogue asks when someone seems to want out without saying so.

Both are checked against a fixed set of transcripts before a prompt or model changes (`tests/companion_replay.py`). To tune them, edit the router prompt in `config/experts/companion_router.json` or the exit dialogue's model.

### Routing outranks expert suggestions

What the router did is a **fact about the session**, not advice. It is delivered to the response prompt as a `routing_directive`, which ranks above every expert suggestion and below the safety boundaries.

It is also given to the reply model twice: in the system prompt, and again as the last instruction after the user's message. Inside the system prompt it is followed by the history, the emotion-tag examples and the rules for continuing the spoken opener, all of which model a reply that ends in a question. Told only there to say goodbye and sleep, `gpt-4o-mini` asked a follow-up question ten times out of ten; with the instruction repeated last, never.

This matters more than it sounds. "What can we do together?" is also a probing cue, so the probing expert reliably produces a follow-up question on precisely the turns the router fires. When the routing outcome was ranked as an ordinary suggestion, probing won — the agent asked *"which tasks would you like to do?"* and invented activities, while the real list sat unread.

## What you see while it runs

**In the chat**, routing decisions appear as accented tags — offered, started, left, finished — in the same shape as the join/leave notices. They travel on the debug channel so they persist and replay like any other message, but the processing-message toggle does **not** hide them: they are narrative, not diagnostics.

**In the agent sidebar**, a companion shows `Free conversation` and a **Can offer** list while idle, and the running activity's name once one starts. This is read from the live progress stream, not the deploy snapshot — a companion picks a plan up and drops it mid-session, so the snapshot cannot answer "what is running right now".

**With the processing toggle on**, every tool call the pipeline makes is also shown — `start_activity`, `set_deliverable`, `complete_task` — with the arguments the model passed and what came back. A companion tool call only shows the proposal; the decision tag next to it shows what the agent actually did with it.

## Interaction with other features

- **Auto-pause / wake.** A companion that is paused mid-activity resumes into it: the state-machine row outlives the pod, and the agent re-adopts the running plan on ready. If a redeploy removed that plan from the allow-list, the plan is cleared and the session drops back to free conversation rather than running a plan the deployment no longer offers. Two things do not survive a restart yet: an open "shall we stop?" question, and where the resumed activity's history begins.
- **Persona.** Identity comes from the persona; activities are structure, and the same persona can front any set of them. There are two built-in personas: *STELLA (default)*, written for plans, and *STELLA Companion (default)*, which keeps company and asks nothing to keep a conversation going. The deploy flow asks for the mode first and preselects the matching one; a deployment that names no persona gets the one for its mode. A persona you chose is never swapped. A persona written for interviewing will pull against the free-conversation guide, so give a companion one written for company.
- **Language.** A loaded plan may declare a language, which pins the session for as long as it is running.
