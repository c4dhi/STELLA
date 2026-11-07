# Session Auto-End — E2E Verification Runbook (#198)

The backend orchestration is covered deterministically in CI by
`src/sessions/session-auto-end.integration.spec.ts` (cap → graceful close → LiveKit
`session_end` → bounded grace → `CLOSED`). This runbook covers the **agent-side**
half, which needs a live stack and can't be unit-tested.

## What this verifies

```
first agent message ─► cap timer armed (SessionTimeoutService)
        cap elapses  ─► SessionsService.beginGracefulClose()  (only if ACTIVE)
                          ├─ status: ACTIVE → CLOSING   (lockdown)
                          └─ LiveKit data: {type:"session_end", reason, deadline_ms=30s}
        agent (rebuilt) ─► _handle_data_message → handle_session_end (re-entrancy-guarded)
                          ├─ interrupt_for_closing(): gate new turns, lock out
                          │   barge-in, abort the agent's own in-flight turn — NO
                          │   waiting on anyone, even mid-user-utterance
                          ├─ on_session_ending / farewell (always spoken; apologetic
                          │   default if none configured)
                          ├─ wait for playout to drain + grace, then publish
                          │   session_ended (so the overlay never covers the goodbye)
                          └─ shutdown → leaves room
        backstop (30s wait + 15s farewell reserve = 45s)
                     ─► force-close → status CLOSING → CLOSED, session.closed SSE
```

## Prerequisites

1. **Rebuild the agent image** — the SDK/agent changes (`pipeline._handle_data_message`
   `session_end` branch, `run.py` handler, `on_session_ending`, and the agent's
   `session_end_mode()`) only run in a rebuilt agent. A backend (SMS) rebuild alone is
   **not** enough: rebuild the agent **base image** and re-tag the cached
   `cfg-<fingerprint>` image.
2. **Apply the migration** — `npx prisma migrate deploy` (runs automatically via
   `prestart`/the K8s `run-migrations` init container) applies
   `20260611000000_add_session_max_duration_cap`.
3. A deployed stack: backend + LiveKit + STT/TTS + the rebuilt agent.

## Setup

1. Set a short cap for testing — e.g. **1 minute (60s)**. The cap is opt-in per
   session and is set in one of two places (never a project-wide default):
   - **Manual invite**: the "Session Duration" step in the Invite Participant modal
     (stored on the invitation, then propagated onto the session).
   - **Public session**: the "Session Duration" step when setting up the public
     session (stored as `publicMaxSessionDurationSeconds`, carried on the invitation
     the public join creates).
2. (Optional) Set an End-node **farewell message** on the plan so the default
   `farewell` mode has something to say. Or set the agent's **Session-End Wrap-up**
   node (Configurator) to `wrap_up` (custom closing) or `silent`.
3. Start a session and join as a participant; wait for the agent's first message
   (this arms the cap).

## Expected timeline (60s cap)

| t | Observe |
|---|---|
| ~0s | Agent speaks first message → cap armed. `Session.firstAgentMessageAt` set in DB. |
| ~30s before cap | Frontend shows the **"Session ending soon"** warning banner (`SESSION_TIMEOUT_WARNING_SECONDS` = 30s remaining → fires ~immediately for a sub-30s cap). |
| 60s | Backend log `Graceful close for session …`. DB `status` = **CLOSING**. A LiveKit data message `{"type":"session_end", deadline_ms:30000}` is published to the room. |
| 60s+ | Agent receives it and **immediately interrupts everything** (its own turn included — no waiting on the user), then **always speaks the farewell/wrap-up**, waits for the audio to drain + grace, signals `session_ended`, and disconnects. |
| ≤105s | DB `status` = **CLOSED**, `closedAt` set. `session.closed` SSE emitted. Agent pod torn down. (Backstop fires at 30s wait + 15s farewell reserve = 45s after `CLOSING` if the agent never leaves on its own.) |

### Verify the "interrupt and always farewell" behavior explicitly

- **Idle → immediate farewell**: when the cap fires while no one is talking, the
  farewell starts right away (`[SESSION END] terminal interrupt — closing the session`).
- **Mid-user-utterance → interrupt, then farewell**: when the cap fires while you are
  still talking, the agent **interrupts you immediately** — it does **not** wait for
  you to finish — and the farewell plays over you (barge-in is locked out for the
  goodbye). The frontend clears your lingering transcript so the farewell teleprompts.
- **Mid-agent-turn → cut its own turn, then farewell**: if the agent is mid-sentence
  when the cap fires, it aborts its own turn and goes straight to the farewell.

## What to check

- **DB**: `SELECT status, "closedAt", "firstAgentMessageAt", "maxSessionDurationSeconds" FROM "Session" WHERE id = '<id>';` →
  `ACTIVE` → `CLOSING` → `CLOSED`, `closedAt` non-null.
- **Backend logs**: `Graceful close for session … — wrap-up signal + 30000ms wait + 15000ms farewell reserve`, then `Closing session … - stopping all agents`.
- **Agent logs**: `[SESSION END] signal received …`, then `[SESSION END] terminal interrupt — closing the session`, then the farewell. The agent stops itself (disconnects).
- **Frontend**: the warning banner shows before the cap; the **timeout overlay appears only after the agent's goodbye** (on the agent's `session_ended` data signal, or — as a fallback — when the LiveKit room is torn down). It must NOT appear at the cap instant.
- **SSE** (`/projects/:id/events` or admin dashboard): a `session.closed` event.
- **Invitation**: `SELECT status FROM "Invitation" WHERE "sessionId" = '<id>';` → `REVOKED` after close.
- **Participant disconnect**: the human is kicked from the room (backend `close()` deletes the LiveKit room) — the participant client sees `Disconnected` and the overlay, never a dead room.

## Stall / deadline path

To verify the hard deadline (agent never finishes its wrap-up):

1. Make the agent's `session_end_mode()` return `wrap_up` (or set `SESSION_END_MODE=wrap_up`; for Stella Light, its Configurator's `interrupt_handler` node) and make `on_session_ending` hang
   (or just confirm the timing with a slow TTS).
2. The backend **force-closes at the backstop** regardless (wait budget + farewell
   reserve = ~45s after `CLOSING`) — `status` reaches `CLOSED` and
   `stopAllSessionAgents` tears the pod down. The session must never hang in
   `CLOSING`.

## Negative checks

- **No cap** (invite/public session created without a Session Duration): the
  session's `maxSessionDurationSeconds` stays null; session runs indefinitely and no
  `session_end` is ever published.
- **Inactivity ≠ close**: leaving the room only **pauses** agents
  (`agentInactivityTimeoutMinutes`); the session stays `ACTIVE`. Only the cap, a plan
  finish, or a manual close moves it to `CLOSED`.
