---
title: "🎙️ ELIAS-Interviewer"
---

# 🎙️ ELIAS-Interviewer

An uploadable agent (`custom-agents/elias-interviewer`) that runs an ELIAS interview guide in a voice session. It asks every question word for word, asks an unclear answer again up to three times, and writes each turn to ELIAS as it happens. It is the reference for an agent that is only `agent.yaml` plus a `BaseAgent` subclass.

## What it declares

| `agent.yaml` | Value |
|---|---|
| `features.persona` | `false`: it reads the guide verbatim, so a persona has nothing to change |
| `features.plans` | none: it builds its plan from the ELIAS guide itself |
| `env.required` | `OPENAI_API_KEY` (the answer check), `ELIAS_PROJECT_ID` |
| `env.optional` | `ELIAS_MAX_ATTEMPTS` (3), `ELIAS_OPENING`, `ELIAS_REASK_PREFIX`, `ELIAS_CLOSING`, `ELIAS_ERROR`, `ANSWER_CHECK_MODEL` (`gpt-4o-mini`), `ANSWER_CHECK_TIMEOUT_S` (8), `STELLA_LANGUAGE` |
| `connectors` | slot `elias`, required, with `get_interview_guide`, `start_interview`, `record_interview_message` and `end_interview` |

The ELIAS token never reaches the pod: the agent calls ELIAS only through the connector the deployer binds to the `elias` slot (see [Connectors](../agent-sdk/connectors.md)).

## When the interview starts

ELIAS speaks first, so it waits (`wait_for_participant`) before its opening line. Two things start it:

- **A participant joins** through the invitation link or a public project.
- **An organiser on the session page writes or says something.** That is how to test it without a participant link. The message that starts it is not taken as an answer: ELIAS says its opening line and asks the first question.

An organiser who only opens the session page does not start it. This needs stella-ai-agent-sdk 0.10.0; with 0.9.0 it starts as soon as anyone, organisers included, is in the room.

## Session end

- **Auto-pause** stops the pod but leaves the ELIAS interview open. On wake the agent continues at the next unanswered question in the same interview.
- **The time cap or the organiser** ending the session: the agent's `session_end_mode()` returns `wrap_up`, so its `on_session_ending` writes the last turns and closes the interview in ELIAS (see [When the session ends](../agent-sdk/platform-contract.md#when-the-session-ends)).
- **The last question** done: it says its closing line and closes the interview.

## Debug feed

With the chat's processing toggle on, the agent's 🔧 lines show each step: the connection to ELIAS, the guide loaded, every ELIAS call (with its time), each question asked, an answer accepted, re-asked (with the reason) or skipped, and the interview ended. Retries are warnings and failures are errors. The lines are kept in the session history. They do not copy the participant's reply, but the checker's short reason on an accepted, re-asked or skipped answer can paraphrase it. See the agent's README for the full list.

## Deploying it

Upload the package from Settings → Agent Library, build it, and share it with the projects that should use it. While **Review uploaded agents** is on (the default), a system admin must approve it in Settings → Agent Review before anyone can deploy it, the uploader included. Then deploy it like any other agent: pick the ELIAS connector and set `ELIAS_PROJECT_ID`.

The package README has the full behaviour, the failure cases and how to run its tests.
