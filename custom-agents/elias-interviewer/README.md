# ELIAS-Interviewer

A STELLA agent that runs an [ELIAS](https://elias.apps.c4dhi.org) interview guide in a voice session.

## What it does

1. When the session starts, it loads the project's interview guide from ELIAS.
2. When a participant joins, it opens an interview in ELIAS, greets them, and asks the guide's questions **in order and word for word**. The questions are never rephrased.
3. After each reply, a small LLM check decides whether the reply answers the question:
   - **Answered**, including short, negative or "I don't know" answers: it moves on.
   - **Unclear** (off topic, garbled, a filler): it asks the same question again. After 3 asks in total it skips the question.
   - **Declined** ("I'd rather not say"): it skips the question at once.
4. **Every turn is written to ELIAS as it happens**, the agent's lines and the participant's replies, in order. When the last question is done, it says goodbye and closes the interview in ELIAS so ELIAS can analyse it.

STELLA shows progress per question. The answers are also kept in the session's deliverables (`q1_answer`, `q2_answer`, …).

## Failures

If the agent can't run the interview, it **says a brief error line** to the participant and ends the session. It doesn't sit silent. It also reports the reason as an error to the session view. The interview can't run when:

- the guide can't be loaded (bad connector, ELIAS down, a project with no guide);
- no project id is configured;
- ELIAS won't open the interview.

If writing a single turn fails, the interview carries on. The failures are retried, logged, and counted in the session summary.

The answer check fails open: if the LLM check times out or errors, the reply is accepted, so an outage can't trap a participant in a loop of repeated questions.

## Pause and wake

When a session auto-pauses, the pod stops. On wake, the agent picks up at the next unanswered question **in the same ELIAS interview**: it doesn't open a second transcript and doesn't greet again. Only a real session end, or finishing the guide, closes the interview in ELIAS.

A real session end is the time cap or the organiser ending the session. The agent's `session_end_mode()` returns `wrap_up`, so the SDK calls its `on_session_ending` then, which writes the last turns and closes the interview in ELIAS before the SDK says goodbye.

STELLA's progress panel shows one stage per run of questions in the same ELIAS category, in the order the questions are asked.

## Debug feed

The agent reports each step to the session's debug feed: the 🔧 lines in the chat, shown with the processing toggle on, and kept in the session history. Each line has `component: "elias"` and a level:

- **info:** connecting to the ELIAS project, the guide loaded (with the question count), the interview started or resumed, each question asked, each answer accepted, and every ELIAS call that worked, with its time in ms (`record_interview_message` says whose turn it saved).
- **warn:** a reply that wasn't accepted and is re-asked (which ask of how many, and the checker's reason), a skipped question, and a retried ELIAS call.
- **error:** an ELIAS call that failed, turns still unwritten at the end, and a startup failure.

Lines from before anyone joins wait until the participant is in the room. The lines hold ids, counts and timings, not the participant's reply itself. A line for an accepted, re-asked or skipped answer also carries the checker's short reason, which can paraphrase what the participant said.

## Setup

**Connector.** The agent never sees the ELIAS token. It reaches ELIAS only through a STELLA connector:

1. In Settings → Connectors, add an MCP connector for `https://elias.apps.c4dhi.org/mcp` with your ELIAS MCP token. You can share it with a project so its other members can use it too.
2. When you deploy the agent, pick that connector for the **ELIAS** slot.

**Env vars** (set at deploy time, like any other agent's):

| Variable | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | (required) | For the answer check |
| `ELIAS_PROJECT_ID` | (required) | The ELIAS project whose guide is asked |
| `ELIAS_MAX_ATTEMPTS` | `3` | Asks per question, the first one included, before it is skipped (1-5) |
| `ELIAS_OPENING` / `ELIAS_CLOSING` / `ELIAS_REASK_PREFIX` / `ELIAS_ERROR` | English defaults | The fixed lines it says |
| `ANSWER_CHECK_MODEL` | `gpt-4o-mini` | Model for the answer check |
| `ANSWER_CHECK_TIMEOUT_S` | `8` | Seconds the answer check may take (1-60), with no retry |
| `STELLA_LANGUAGE` | detect | Pin speech to one language (e.g. `de`). If the guide isn't in English, set it and translate the fixed lines too |

## Requirements

Needs `stella-ai-agent-sdk` with connector support (`self.connectors`). That's the release after 0.9.0, see `requirements.txt`. With an older SDK the agent starts, says its error line, and reports that connectors are missing.

## Development

```bash
PYTHONPATH=src:../../agents/stella-ai-agent-sdk/src python3.12 -m pytest tests -q
```

The tests run a whole interview against fakes for ELIAS, audio and the state machine.
