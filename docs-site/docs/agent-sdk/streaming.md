---
sidebar_position: 5
title: Streaming
description: Streaming a reply from process() to the screen and the voice
---

# Streaming

A voice agent should start speaking before the language model has finished writing. In STELLA the agent does not handle audio for this: it yields text from `process()`, and the SDK shows it, cuts it into sentences, and sends each sentence to TTS as soon as it is complete.

```
process() ──text_chunk──▶ BaseAgent.run_audio_loop ──▶ agent_text (screen)
                                    │
                                    └── sentence by sentence ──▶ TTS service ──▶ LiveKit audio
```

## Streaming a reply

Yield `AgentOutput.text_chunk()` for each step of the reply. Two rules:

1. **Every chunk carries the whole reply so far**, not just the new tokens. The frontend replaces the bubble with the same `transcript_id`, and the SDK finds the new text by comparing with the previous chunk.
2. **All chunks of one reply share a `transcript_id`**, and the last one has `is_final=True` and the full text.

```python
import uuid
from typing import AsyncIterator

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent


async def fake_llm(prompt: str) -> AsyncIterator[str]:
    for token in ["Good ", "question. ", "Let me ", "think ", "about ", "that."]:
        yield token


class StreamingAgent(BaseAgent):
    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        transcript_id = f"response_{uuid.uuid4().hex[:8]}"
        reply = ""
        async for token in fake_llm(input.text):
            reply += token
            yield AgentOutput.text_chunk(input.session_id, reply, transcript_id=transcript_id)
        yield AgentOutput.text_chunk(
            input.session_id, reply, transcript_id=transcript_id, is_final=True
        )

    async def on_interrupt(self, session_id: str) -> None:
        pass
```

Text under one `transcript_id` may only grow. If a chunk does not start with the previous one, the SDK treats it as a new text and speaks it from the start.

Don't close a stream with an empty final chunk. The empty text replaces the bubble on screen.

If you have the whole reply at once, yield `AgentOutput.text_final(session_id, text)` instead. It is shown and spoken in one go.

## What the SDK does with each chunk

For every `TEXT_CHUNK` the default `run_audio_loop()`:

1. Strips `[emotion]` tags, if the agent supports them, and publishes them as face cues.
2. Publishes the text as an `agent_text` message (see [Message Types](./message-types.md#on-the-data-channel)).
3. Looks for sentence ends in the new text: `.`, `!` or `?` followed by whitespace. Abbreviations such as "Dr." do not count. Each complete sentence goes to the TTS queue straight away.
4. If a chunk that is not final ends on a full sentence ("Good question."), sends that sentence at once rather than waiting for the next chunk. This is how a short opening line is heard while the rest is still being written.
5. On the final chunk, sends whatever is left.

A background worker speaks the queued sentences in order while the next ones are synthesised, so there is no gap between sentences. When `process()` ends, the loop waits for the queue to finish before it takes the next turn.

With `TTS_ENABLED=false`, or when the participant uses the text interface (see [Platform Contract](./platform-contract.md#voice-or-text-stellainteraction_mode)), steps 3 to 5 are skipped and the reply is only shown.

### Per-chunk voice settings

These keys in a chunk's `metadata` change how the rest of the reply is spoken:

| Key | Effect |
|-----|--------|
| `language` | ISO 639-1 code for the TTS voice, e.g. `"de"`. |
| `voice` | A voice name, for TTS providers that select voices. Others ignore it. |
| `speed` | Speaking rate, 0.5 to 2.0. It is done by resampling, so it shifts pitch too; keep it close to 1. |
| `tts_source` | `"bridge"` or `"response"`. Labels the sentence in the latency analytics. |

```python
from stella_agent_sdk import AgentOutput

chunk = AgentOutput.text_chunk("session-1", "Guten Tag.", transcript_id="response_1")
chunk.metadata["language"] = "de"
chunk.metadata["speed"] = 0.95
```

## Interruptions

When the user interrupts by voice and the interruption is committed (see [Audio Pipeline](./audio-pipeline.md#barge-in)), the SDK stops the speech and drops the queued sentences; the user's words become the next turn.

A typed message works at the level of `process()` instead: while the interruption is decided, the SDK stops reading from your generator at its next `yield`, and on `COMMIT` it abandons the turn there. A turn that yields often therefore stops quickly. Work between two yields (a tool call, for example) still runs to completion.

The SDK does not call `on_interrupt()` in either case, so don't rely on it to stop generation.

## Sending text without `process()`

An agent that overrides `run_audio_loop()` does the same work itself with `self.audio`:

```python
import uuid
from typing import AsyncIterator

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent


class OwnLoopAgent(BaseAgent):
    async def run_audio_loop(self) -> None:
        async for event in self.audio.audio_in():
            reply = f"You said: {event.text}"
            transcript_id = f"response_{uuid.uuid4().hex[:8]}"
            await self.audio.publish_text(reply, is_final=True, transcript_id=transcript_id)
            await self.audio.speak(reply)

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        # Required by BaseAgent, but never called: this agent drives its own loop.
        yield AgentOutput.text_final(input.session_id, "")

    async def on_interrupt(self, session_id: str) -> None:
        await self.audio.stop_speaking()
```

`publish_text()` only shows text and `speak()` only speaks it; call both. `speak()` waits until the text has been synthesised and played. For sentence-by-sentence speech in your own loop, use `self.audio.enqueue_sentence(sentence)` for each sentence and `await self.audio.flush_speech_queue()` at the end of the turn.

## Audio formats

Agents do not handle raw audio. For reference:

| Direction | Format |
|-----------|--------|
| User to STT | The LiveKit track's frames (usually 48 kHz, mono, 16-bit PCM), streamed to the STT service, which resamples as it needs. |
| TTS to user | 24 kHz, mono, 16-bit PCM, published as the agent's audio track. |

## Latency settings

These environment variables belong to the SDK (see [Platform Contract](./platform-contract.md#environment-variables-the-sdk-owns)):

| Variable | Default | Effect |
|----------|---------|--------|
| `STELLA_TTS_PLAYBACK` | `auto` | `stream` plays audio as it is synthesised; `sentence` waits for each whole sentence. `auto` streams and switches to `sentence` once if synthesis cannot keep up. |
| `STELLA_TTS_PREROLL_MS` | unset | A fixed head start of audio before each sentence plays. Unset lets the SDK measure and adapt it. |
| `TTS_PLAYOUT_BUFFER_MS` | `1000` | How much audio the room may queue ahead of playout. |
| `TRANSCRIPT_DEBOUNCE_MS` | `0` | Joins final transcripts that arrive within this window into one turn. |

Each turn also reports its timings (end of speech, first token, first audio byte and so on) as analytics events, which the analytics dashboard shows. Add your own with `AgentOutput.analytics_event(...)`.

## Next Steps

- [Audio Pipeline](./audio-pipeline.md): turn-taking, barge-in and take-back
- [Message Types](./message-types.md): every input and output
- [Base Agent](./base-agent.md): the agent interface
