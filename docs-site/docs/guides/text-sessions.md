---
sidebar_position: 5
title: "Text sessions"
---

# Text sessions

Participants can hold a conversation in writing instead of by voice. Text is one of the faces in the participant's face gallery, next to Face, Sphere, Galaxy and the others.

## What the participant sees

- **The Text face** fills the screen with the conversation. The participant types their answers. The agent's replies show as the agent sends them: an agent that streams its reply shows it growing, with "… is writing…" under it until it is done; an agent that sends whole messages shows each one at once.
- **Nothing is spoken.** The microphone is off, and nothing the participant says aloud counts as an answer.
- **The other faces** are the voice interface. Their chat drawer stays as a fallback for typing next to speech; the voice carries on while it is open.
- **Silence** has no special handling in text: the agent waits.

## Choosing it for a study

The face is set on the invitation (or, for a public link, on the project), the same way as any other face:

| Face | Locked | What happens |
|---|---|---|
| Text | yes | A text-only session. The join page skips the microphone setup and says the conversation is in writing. The participant cannot switch to voice. |
| Text | no | The session starts in writing, and the join page skips the microphone setup here too. The participant can open the face gallery and move to a voice face at any time, and back. |
| Any other face | no | The session starts by voice. The participant can move to the Text face at any time. |
| Any other face | yes | Voice only. The chat drawer is still there as a fallback. |

Through the API or MCP, set `visualizerType: "text"` and `visualizerLocked: true` on the invitation for a text-only session.

## Switching to voice later

When a participant who started in writing moves to a voice face, the session opens the device check (microphone and speaker) first, unless the browser already allows the microphone. **Continue with voice** goes on by voice; **Stay in writing** closes the check and goes back to the Text face. A session that starts on a voice face shows the device check on the join page, as before, and skips it when the microphone is already allowed.

## The end of the session

When the agent completes the session, the **Session complete** screen waits until the agent has finished speaking and its last message has fully arrived, then leaves time to read it: a quarter second per word, at least 3 and at most 10 seconds (and never more than 25 seconds after the agent's signal). The screen thanks the participant and says they can close the window. A session that ends at its time limit shows a matching **Session timed out** screen. Neither screen shows a code to paste into a survey any more.

## What it changes for the agent

On every switch the screen tells the agent which interface is on, and the agent stops or starts speaking. Agents built with the SDK need no code for this; see [Voice or text](../agent-sdk/platform-contract.md#voice-or-text-stellainteraction_mode). The switches are kept in the session history (`client_event` rows), so text and voice parts of a session can be told apart in the data.
