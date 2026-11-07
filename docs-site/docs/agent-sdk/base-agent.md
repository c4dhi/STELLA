---
sidebar_position: 3
title: "🧱 Base Agent"
---

# 🧱 BaseAgent Class

Every STELLA agent subclasses `BaseAgent`. You implement two methods, `process()` and `on_interrupt()`, and override whichever lifecycle hooks you need. `run_agent_from_env(agent)` connects the room, STT and TTS, and then drives the agent.

```python
from typing import AsyncIterator

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent


class MyAgent(BaseAgent):
    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        yield AgentOutput.text_final(input.session_id, "Hello!")

    async def on_interrupt(self, session_id: str) -> None:
        pass
```

If you override `__init__`, call `super().__init__()` first.

## Lifecycle

`run_agent_from_env()` calls the hooks in this order:

1. `on_session_start(session_id, config)`: once, after the room and audio pipeline are up.
2. `on_ready(session_id)`: yields outputs to send before the first turn, for example the initial task panel.
3. The agent registers with the session-management server.
4. `run_audio_loop()`: runs the conversation. The default loop calls `process()` once per user turn.
5. `on_session_ending(session_id, reason, deadline_ms)`: only when `session_end_mode()` returns `"wrap_up"`, while the room is still live.
6. `on_session_end(session_id)`: on every teardown, including an auto-pause.

How the session ends (`farewell`, `wrap_up`, `silent`) is on [Platform Contract](./platform-contract.md#when-the-session-ends).

## Methods you implement

### process

```python
async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]: ...
```

An async generator, called for each user turn. `input.text` is the transcript or typed message, `input.session_id` the session, and `input.metadata` carries the turn's details, among them:

| Key | What it is |
|-----|------------|
| `turn_id` | The STT transcript id, shared with the SDK's analytics events |
| `stt_confidence` | How far the transcript can be trusted, 0 to 1. 1.0 for typed text, 0 when the STT gave no signal |
| `detected_language`, `language_confidence` | The STT's own language detection, `""` and 0.0 when there is none |
| `is_barge_in` | The turn came from a committed interruption |
| `agent_initiated` | Present only on a turn the agent opened itself with `start_turn()` |

What it yields:

- **Text.** `AgentOutput.text_final(session_id, text)` for a reply in one piece. To stream, yield `AgentOutput.text_chunk(session_id, text, transcript_id=tid)` repeatedly with the same `transcript_id`, where `text` is the whole reply so far, then once more with `is_final=True`. The SDK publishes the text and speaks it sentence by sentence as sentences complete.
- **Everything else** (`AgentOutput.status`, `thinking`, `processing`, `progress_update`, `metadata_update`, `debug`, `error`, `analytics`, …) is published to the screen and never spoken. See [Message Types](./message-types.md).
- **Device commands** (`AgentOutput.client_command`) are held until the turn's speech has been heard.

### on_interrupt

```python
async def on_interrupt(self, session_id: str) -> None: ...
```

Abstract, so every agent has it: the place to cancel work in progress. In SDK 0.10.0 the default loop does not call it. A committed barge-in is handled by the SDK itself (see [Barge-in](#barge-in)); an agent with its own loop can call it.

## Lifecycle hooks

All optional. The defaults are shown in brackets.

| Hook | When | Default |
|------|------|---------|
| `async on_session_start(session_id, config)` | Session opens. `config` is the parsed `AGENT_CONFIG` dict | Parses `self.session`, sets the state to `READY` |
| `async on_ready(session_id)` (generator) | After `on_session_start`, before the first turn | Yields nothing |
| `async on_session_ending(session_id, reason, deadline_ms)` (generator) | `wrap_up` mode only. What it yields is spoken before lockdown | Yields nothing, so the farewell is spoken |
| `async on_session_end(session_id) -> dict` | Teardown. Return any final data | Sets the state to `SHUTTING_DOWN`, returns `{}` |
| `session_end_mode() -> str` | The platform ends the session | Reads `SESSION_END_MODE`, else `"farewell"` |
| `async on_barge_in(session_id, transcript) -> BargeInDecision` | The user spoke over the agent | Backchannel heuristic, see below |
| `async on_idle(session_id, idle_seconds)` | Nothing has happened for `idle_timeout_seconds` | Nothing |
| `async on_client_event(session_id, event, data)` | The screen sent a declared event | Returns `None` |
| `async on_config_update(session_id, config)` | Defined, but not called by SDK 0.10.0 | Nothing |

Call `super()` when you override `on_session_start`; without it `self.session`, `self.persona` and `self.plan` stay as `run_agent_from_env()` set them, and the agent state never becomes `READY`.

```python
from typing import Any, Dict

from stella_agent_sdk import AgentOutput, BaseAgent


class PlanAgent(BaseAgent):
    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        await super().on_session_start(session_id, config)
        self.name = self.persona.name if self.persona else "Assistant"
        if self.plan or self.session.is_companion:
            await self.plan_runtime.start(self.plan)
            self.tools = self.plan_runtime.tools

    async def process(self, input):
        yield AgentOutput.text_final(input.session_id, "Hello!")

    async def on_interrupt(self, session_id: str) -> None:
        pass
```

What `self.session` holds, and how `self.plan_runtime` works, is on [Platform Contract](./platform-contract.md#session-config).

## Barge-in

Barge-in (the user interrupting while the agent speaks) is off unless the agent sets the class attribute `supports_barge_in = True` and the deployment has it enabled. Then, when the user speaks over the agent, the SDK pauses playback, transcribes the user, and asks `on_barge_in(session_id, transcript)`:

- `BargeInDecision.COMMIT`: the rest of the reply is not spoken, and the transcript becomes the next turn (with `input.metadata["is_barge_in"]` set). When the interruption is a typed message, the SDK also stops reading from `process()` at its next `yield`.
- `BargeInDecision.RESUME`: playback resumes where it paused and the transcript is dropped.

The default resumes on short backchannels ("mhm", "okay", "go on", "genau") and commits on anything else. Override it for a smarter decision, but keep it fast: the user hears silence while it runs.

```python
from stella_agent_sdk import AgentOutput, BargeInDecision, BaseAgent


class PoliteAgent(BaseAgent):
    supports_barge_in = True

    async def on_barge_in(self, session_id: str, transcript: str) -> BargeInDecision:
        if "stop" in transcript.lower():
            return BargeInDecision.COMMIT
        return await super().on_barge_in(session_id, transcript)

    async def process(self, input):
        yield AgentOutput.text_final(input.session_id, "Hello!")

    async def on_interrupt(self, session_id: str) -> None:
        pass
```

## Beyond speech: the device channel

An agent can do more on the user's device than speak, and can learn about more than what the user said. Which commands and events exist is declared in the manifest's [`client` block](./agent-manifest.md#the-client-channel); the SDK refuses anything else, and checks each message's data against its declared schema. The built-in face client, for example, understands the commands `sleep` and `sleep_allowed` and reports the events `sleep` and `wake`, which stella-v2 declares. The envelopes are in [the platform contract](./platform-contract.md#the-screen-and-the-agent).

### Commands to the device

<!-- pseudo-code -->
```python
# Inside process(): delivered once this turn's speech has been heard,
# and dropped if the user interrupts the turn.
yield AgentOutput.client_command(input.session_id, "sleep")

# Outside a turn: delivered right away.
await self.send_client_command("sleep_allowed", allowed=False)
```

The client receives `{"type": "agent_command", "data": {"command": ..., ...}}`. An undeclared command raises `ValueError`.

### on_client_event

Called when the client sends a declared event, `{"type": "client_event", "data": {"event": ..., ...}}`: something the user did that is neither speech nor text. `data` is the event's own data, already checked. When the screen asked for an answer (the event carried a `request_id`), what you return is the reply, and an exception is an error reply. It may arrive while a turn is running.

<!-- pseudo-code -->
```python
async def on_client_event(self, session_id: str, event: str, data: dict) -> dict | None:
    if event == "wake":
        self.start_turn(event="wake")
    elif event == "rate_answer":
        self.ratings.append(data["stars"])
        return {"saved": True}
    return None
```

Events named `stella.…` never reach it: the SDK handles them (for example `stella.interaction_mode`, the switch between the voice and the text interface).

### start_turn

`self.start_turn(**metadata)` opens a turn nobody spoke. `process()` is called with empty text and `input.metadata["agent_initiated"]` set to what you passed; what it yields is published and spoken like any reply. The turn waits behind one that is running, and a message the user sends in the meantime replaces it.

<!-- pseudo-code -->
```python
async def process(self, input):
    if input.metadata.get("agent_initiated") is not None:
        yield AgentOutput.text_final(input.session_id, "Hello! How are you?")
        return
    ...
```

### on_idle

Set `idle_timeout_seconds` and `on_idle` is called once per quiet stretch: no turn, no speech, nothing done on the device for that long. `None` (the default) switches it off. It runs outside a turn, so to say something use `self.audio.speak()`, and to act on the device `send_client_command()`.

<!-- pseudo-code -->
```python
idle_timeout_seconds = 45

async def on_idle(self, session_id: str, idle_seconds: float) -> None:
    await self.send_client_command("sleep", reason="idle")
```

## Chat history

STELLA records every session message. `await self.get_chat_history(include_debug=False, limit=100, before=None)` returns them oldest first as `ChatMessage` objects (`role`, `content`, `message_type`, `timestamp`, `id`, and the full `envelope`). `before` is an ISO timestamp for paging back. It raises `RuntimeError` when the history client is not available (`self.has_history` is `False`).

```python
from stella_agent_sdk import AgentOutput, BaseAgent


class ContextAgent(BaseAgent):
    async def process(self, input):
        history = await self.get_chat_history(limit=20)
        context = "\n".join(f"{m.role}: {m.content}" for m in history)
        yield AgentOutput.text_final(input.session_id, f"I have {len(history)} earlier messages.")

    async def on_interrupt(self, session_id: str) -> None:
        pass
```

## Running your own loop

Override `run_audio_loop()` to drive the conversation yourself instead of through `process()`. `self.audio` is the audio pipeline; it raises `RuntimeError` outside `run_agent_from_env()` (`self.has_audio` tells you first).

```python
import uuid

from stella_agent_sdk import AgentOutput, BaseAgent


class LoopAgent(BaseAgent):
    async def run_audio_loop(self) -> None:
        async for event in self.audio.audio_in():
            if not event.is_final or not event.text.strip():
                continue
            reply = f"You said: {event.text}"
            tid = f"response_{uuid.uuid4().hex[:8]}"
            await self.audio.publish_text(reply, is_final=True, transcript_id=tid)
            await self.audio.speak(reply)
            self.record_message_processed()
            if "goodbye" in event.text.lower():
                await self.complete_session()
                return

    async def process(self, input):
        yield AgentOutput.text_final(input.session_id, "")  # not used: run_audio_loop is overridden

    async def on_interrupt(self, session_id: str) -> None:
        await self.audio.stop_speaking()
```

`publish_text()` only shows text, `speak()` only voices it; `speak_line(text)` does both and keeps the teleprompter in step. The full pipeline API is on [Audio Pipeline](./audio-pipeline.md). A custom loop still gets client events and the session-end handling; the helpers for it (`wait_for_participant`, `session_participants`, `publish_progress`, `complete_session`) are listed in [Platform Contract](./platform-contract.md#agents-that-drive-their-own-loop).

## Helpers

| Method | What it does |
|--------|--------------|
| `await get_chat_history(...)` | The session's recorded messages, see [Chat history](#chat-history) |
| `await publish_progress(progress)` | Sends the task panel state outside a turn; re-sent to anyone who joins later |
| `await complete_session(reason="completed")` | Waits for speech to finish, shows the completion overlay, stops the loop after the current turn |
| `start_turn(**metadata)` | Opens a turn the agent starts itself |
| `await send_client_command(command, **data)` | Sends a declared command to the device now |
| `await wait_for_participant(timeout=None)` | For agents that speak first: waits until the session should start |
| `human_participants()`, `session_participants()` | Identities in the room now |
| `defer_tool(name, coro)` | Runs a long tool call as a task that is cancelled if the session ends first |
| `send_turn_language(input, original_text=..., resolved_language=..., redecoded=...)` | Stores the turn's resolved language with its message |
| `set_state(state)`, `record_error(error)`, `record_message_processed()` | Health reporting |
| `get_health_status() -> dict` | What a health check returns; override to add fields |

## Properties and class attributes

| Name | What it is |
|------|------------|
| `session` | `AGENT_CONFIG`, typed (`SessionConfig`) |
| `persona` | The deployed `PersonaConfig`, or `None` |
| `plan` | The inline plan dict, or `None` |
| `plan_runtime` | The plan state machine and its tools (`PlanRuntime`) |
| `connectors` | Outside MCP servers (`ConnectorsClient`), see [Connectors](./connectors.md) |
| `audio`, `has_audio` | The audio pipeline, and whether there is one |
| `has_history` | Whether `get_chat_history()` can be used |
| `client_channel` | What `agent.yaml` declares the screen and the agent may send each other |
| `session_id`, `is_processing`, `session_completed` | Session state |
| `state` | The `AgentState` reported to health checks |
| `agent_type`, `agent_version`, `sdk_version` | What the agent registers as (from `AGENT_TYPE`, `AGENT_VERSION`) |
| `agent_name`, `agent_id` | From `AGENT_NAME`, `AGENT_ID` |
| `uptime_seconds`, `messages_processed` | Health counters |
| `supports_barge_in` | Class attribute, `False` by default. See [Barge-in](#barge-in) |
| `supports_teleprompter` | Class attribute, `True`: the screen lights the reply up word by word as it is spoken |
| `supports_emotion_tags` | Class attribute, `True`: `[tags]` in the reply are stripped before TTS and sent to the animated face as cues |
| `idle_timeout_seconds` | Seconds of quiet before `on_idle`; `None` switches it off |
| `state_machine_address` | Overrides `STATE_MACHINE_ADDRESS` for `plan_runtime`; set it before the session starts |

## See also

- [Message Types](./message-types.md)
- [Audio Pipeline](./audio-pipeline.md)
- [Platform Contract](./platform-contract.md)
- [Building Custom Agents](./building-custom-agent.md)
