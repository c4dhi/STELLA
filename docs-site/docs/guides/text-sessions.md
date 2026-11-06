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
| Text | no | The session starts in writing. The participant can open the face gallery and move to a voice face at any time, and back. |
| Any other face | no | The session starts by voice. The participant can move to the Text face at any time. |
| Any other face | yes | Voice only. The chat drawer is still there as a fallback. |

Through the API or MCP, set `visualizerType: "text"` and `visualizerLocked: true` on the invitation for a text-only session.

## What it changes for the agent

On every switch the screen tells the agent which interface is on, and the agent stops or starts speaking. Agents built with the SDK need no code for this; see [Voice or text](../agent-sdk/platform-contract.md#voice-or-text-stellainteraction_mode). The switches are kept in the session history (`client_event` rows), so text and voice parts of a session can be told apart in the data.
