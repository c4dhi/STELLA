---
sidebar_position: 5
title: "🎙️ Audio Pipeline"
---

# 🎙️ Audio Pipeline

The audio pipeline carries a conversation between the LiveKit room and the agent: the user's speech goes to speech-to-text (STT), the agent's replies go to text-to-speech (TTS), and the pipeline decides whose turn it is.

An agent never creates the pipeline. `run_agent_from_env()` connects to the room and to the STT and TTS services, builds an `AudioPipeline` (`stella_agent_sdk.audio.pipeline.AudioPipeline`) and gives it to the agent as `self.audio`. Most agents don't touch it at all: they implement `process()` and the default `run_audio_loop()` does the rest (see [Streaming](./streaming.md)).

## Overview

```
User mic ─▶ LiveKit ─▶ AudioPipeline ─gRPC─▶ STT service
                            │  final transcripts
                            ▼
                     agent.process() ─▶ text ─▶ AudioPipeline ─gRPC─▶ TTS service
                                                      │
User speakers ◀─ LiveKit ◀───── agent audio track ◀───┘
```

The pipeline:
- subscribes to the participants' audio and streams it to the STT service;
- publishes every transcript, partial and final, to the room so the frontend can show it, and hands only final ones to the agent;
- takes typed `user_text` messages from the chat as turns, the same as speech;
- publishes the agent's text and speaks it through the TTS service;
- handles turn-taking: the transcript gate, barge-in and take-back.

## STT and TTS services

STT and TTS are not part of the agent. They run as separate gRPC services in the cluster, and the SDK connects to them at the addresses in two environment variables, set by the session-management server:

| Variable | Default |
|----------|---------|
| `STT_SERVICE_ADDRESS` | `stt-service:50051` |
| `TTS_SERVICE_ADDRESS` | `tts-service:50052` |

Which engine runs behind them is a deployment choice, not agent code: `STT_PROVIDER` selects `sherpa` or `whisper` in `stt-service`, and `TTS_PROVIDER` selects `piper`, `kokoro`, `chatterbox` or `qwen3` in `tts-service`. See [Environment Variables](../architecture/environment-variables.md) for their settings and [TTS & Audio Pipeline](../architecture/tts-pipeline.md) for how speech timing works.

With `TTS_ENABLED=false` the agent does not connect to TTS and runs text-only.

### Qwen3-TTS (opt-in, GPU)

Local Qwen3-TTS via [faster-qwen3-tts](https://github.com/andimarafioti/faster-qwen3-tts), a CUDA-graph-optimised runtime. The Qwen3-TTS weights are **Apache-2.0**, so this is the recommended GPU option for commercial deployments.

- It runs in-process in the `tts-service` container (no sidecar). It is selected at build time with `--build-arg TTS_PROVIDER=qwen3`; the image then carries only Qwen3's dependencies.
- The model is chosen with `QWEN3_MODEL_ID`:
  - `Qwen/Qwen3-TTS-12Hz-0.6B-Base` (about 2 GB VRAM), the recommended start
  - `Qwen/Qwen3-TTS-12Hz-1.7B-Base` (about 5 GB VRAM, higher quality)
  - `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` (voice cloning from a reference clip)
  - `Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign` (instruction-based voice design)
- Every variant needs a reference clip and its transcript, in sibling files (`ref_audio.mp3` and `ref_audio.txt`). STELLA bundles a German pair in `tts-service/assets/`; the init container copies it to `/models/qwen3/` on the PVC on first deploy. To change the voice, put your own pair at that path and restart the pod.
- Optional tuning: `QWEN3_LANGUAGE` (`Auto` detects), `QWEN3_CHUNK_SIZE` (codec frames per yield; lower starts sooner) and `QWEN3_DTYPE` (`bfloat16`, `float16` or `float32`).

It is GPU-only; use Piper or Kokoro on machines without one. See `NOTICE.md` for the licence split between STELLA's code, the MIT-licensed `faster-qwen3-tts` engine and the Apache-2.0 weights.

## Turn management (transcript gate)

The pipeline keeps the conversation turn-based without any agent code. While the agent speaks, the transcript gate is closed:

```
User's final transcript ─▶ agent writes the reply ─▶ speech starts: gate CLOSES
    ─▶ reply is spoken ─▶ speech ends: gate OPENS ─▶ user's turn again
```

While the gate is closed:

| What | Effect |
|------|--------|
| Partial transcripts | Not shown (with TTS on). |
| Final transcripts | Not a turn. They are still published, marked `discarded`, so the record keeps what was said. |
| Speech-start callbacks | Not called (with `INTERRUPT_MODE=none`). |
| Typed messages | Kept and answered as the next turn. |
| STT stream | Stays open. |

When the gate opens, speech heard during the reply is dropped as stale (echo or overlap); typed messages stay. With barge-in on, the user can still take the floor while the gate is closed (see below).

`close_transcript_gate()`, `open_transcript_gate()` and `is_gate_closed` are public, for an agent that runs its own loop.

| Variable | Default | Effect |
|----------|---------|--------|
| `TTS_ENABLED` | `true` | `false` runs text-only. |
| `INTERRUPT_MODE` | `none` | `none` is strict turn-taking. |
| `TRANSCRIPT_DEBOUNCE_MS` | `0` | Joins final transcripts that arrive within this window into one turn. Off by default: both STT providers already wait for a pause before a final. |

## Barge-in

Barge-in lets the user interrupt the agent mid-reply. It is off unless the agent declares `supports_barge_in = True`; `BARGE_IN_ENABLED` overrides the declaration either way.

1. **Duck.** As soon as the user's voice is detected, the agent's volume drops (`BARGE_IN_DUCK_GAIN`, default 0.25). A cough costs nothing: the volume comes back.
2. **Suspend.** When the speech lasts long enough to count as an interruption, playback is paused. Nothing is thrown away yet.
3. **Decide.** When the user's final transcript arrives, the SDK calls `on_barge_in(session_id, transcript)`. On `BargeInDecision.RESUME` the reply carries on exactly where it paused. On `COMMIT` the rest of the reply's speech is dropped and the transcript becomes the next turn, with `is_barge_in` in its metadata.

The default `on_barge_in()` resumes on short backchannels ("mhm", "okay", "genau") and commits on anything else. Override it for a smarter check, but keep it fast: the user hears silence while it runs.

```python
from typing import AsyncIterator

from stella_agent_sdk import AgentInput, AgentOutput, BargeInDecision, BaseAgent


class InterruptibleAgent(BaseAgent):
    supports_barge_in = True

    async def on_barge_in(self, session_id: str, transcript: str) -> BargeInDecision:
        if transcript.strip().lower().rstrip(".!?") in {"mhm", "yes", "right"}:
            return BargeInDecision.RESUME
        return BargeInDecision.COMMIT

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        yield AgentOutput.text_final(input.session_id, "Here is a long answer.")

    async def on_interrupt(self, session_id: str) -> None:
        pass
```

Typed messages interrupt too: with barge-in on, a message typed while the agent is generating or speaking goes through the same decision. While it is decided, the turn pauses at the next `yield` of `process()`; on `COMMIT` the turn is abandoned there.

Tuning variables, all in milliseconds unless noted: `BARGE_IN_EVAL_TIMEOUT_MS` (how long `on_barge_in` may take, default 2000), `BARGE_IN_DUCK_TIMEOUT_MS` (1200), `BARGE_IN_SUSPEND_TIMEOUT_MS` (how long a pause waits for the transcript, 8000), and `BARGE_IN_STORM_COUNT`, `BARGE_IN_STORM_WINDOW_MS`, `BARGE_IN_STORM_COOLDOWN_MS` (barge-in switches off for a while after several false interruptions, as protection against echo).

## Take-back

A person's turn can be closed while they still have more to say. If they carry on before any of the reply was heard, the reply can simply be dropped. Take-back does that. It is off unless an agent turns it on.

```python
from typing import AsyncIterator

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent


class PatientAgent(BaseAgent):
    supports_barge_in = True
    take_back_window_ms = 6000  # window after a final; 0 is off

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        yield AgentOutput.text_final(input.session_id, "Noted.")
        if not await self.audio.wait_until_turn_is_final():
            return  # taken back: the joined turn saves everything
        # save what this turn collected here

    async def on_interrupt(self, session_id: str) -> None:
        pass
```

`run_agent_from_env` turns take-back on for an agent with a `take_back_window_ms` attribute, by calling `self.audio.enable_take_back(window_ms)`; an agent can also call that itself, for example from session config. It doesn't change how barge-in is wired, but a reply is only held while barge-in is on.

- **Hold.** If speech starts within the window after a final, while a turn is in progress and nothing of its reply has been played, the reply is held. There is no duration threshold, because nothing is audible yet. The next final is judged like a barge-in. On `COMMIT`, the held turn is dropped, and the joined-up text is answered as one turn (its metadata lists `taken_back`). On `RESUME`, the held reply plays.
- **`await self.audio.wait_until_turn_is_final(timeout_s=15)`** returns once the reply is first heard. It returns `False` if the turn was taken back. Save a turn's values after this, so a dropped reply saves nothing. A hold doesn't use up the timeout. If speech never starts, the turn counts as final after the timeout, and `take_back_no_speech` is logged.
- **Nothing played, nothing held.** With TTS off or on the text interface (`stella.interaction_mode` text), the call returns at once, and no turn is held.
- **Analytics:** `take_back_held` (`since_final_ms`), `take_back_done` (`outcome`, `held_ms`, `parts`) and `take_back_no_speech`. They carry timings and outcomes, never words.

## Using `self.audio` directly

An agent that overrides `run_audio_loop()` drives the pipeline itself. The main methods and properties:

| Member | What it does |
|--------|-------------|
| `audio_in()` | Async iterator of final transcripts (spoken and typed). Each event has `text`, `transcript_id`, `confidence`, `participant_id` and `typed`. |
| `publish_text(text, is_final=False, transcript_id=None)` | Shows text in the chat. Does not speak it. |
| `speak(text, voice=None, speed=None, language=None)` | Speaks text and waits until it has played. Does not show it. |
| `enqueue_sentence(sentence)`, `flush_speech_queue()` | Speak sentence by sentence in the background; wait for the queue at the end of the turn. |
| `stop_speaking()` | Stops speech at once and drops what is queued. |
| `is_speaking`, `has_tts` | Whether the agent is speaking; whether replies are spoken at all. |
| `on_speech_started(callback)` | Calls an async callback when the user starts speaking. |
| `interaction_mode` | `"voice"` or `"text"`, set by the screen (see [Platform Contract](./platform-contract.md#voice-or-text-stellainteraction_mode)). |
| `set_stt_language(language)` | Pins STT to a declared language; `None` or `"auto"` detects again. |
| `set_tts_language`, `set_tts_voice`, `set_tts_speed` | Voice settings for what is spoken next. |
| `enable_barge_in()`, `set_barge_in_decider(decider)`, `enable_take_back(window_ms)` | What `run_agent_from_env` calls from the agent's declarations. |
| `publish_data(payload)` | Sends a `{"type": ..., "data": ...}` message to the room. |

```python
import uuid
from typing import AsyncIterator

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent


class EchoLoopAgent(BaseAgent):
    async def run_audio_loop(self) -> None:
        self.audio.on_speech_started(self._user_started)
        async for event in self.audio.audio_in():
            reply = f"You said: {event.text}"
            transcript_id = f"response_{uuid.uuid4().hex[:8]}"
            await self.audio.publish_text(reply, is_final=True, transcript_id=transcript_id)
            await self.audio.speak(reply)

    async def _user_started(self) -> None:
        await self.audio.stop_speaking()

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        # Required by BaseAgent, but never called: this agent drives its own loop.
        yield AgentOutput.text_final(input.session_id, "")

    async def on_interrupt(self, session_id: str) -> None:
        await self.audio.stop_speaking()
```

An agent with its own loop gets the transcript gate as long as it reads from `audio_in()` and speaks through `speak()` or the sentence queue. It does not get the sentence splitting, emotion tags or held client commands of the default loop.

## Audio format

| Direction | Format |
|-----------|--------|
| In | The LiveKit track's frames (usually 48 kHz mono 16-bit PCM), streamed to STT, which resamples. |
| Out | 24 kHz mono 16-bit PCM on the agent's audio track. |

These are fixed; there is nothing to configure.

## See Also

- [Streaming](./streaming.md)
- [Base Agent](./base-agent.md)
- [Message Types](./message-types.md)
- [Platform Contract](./platform-contract.md)
- [Building Custom Agents](./building-custom-agent.md)
