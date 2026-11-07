---
sidebar_position: 4
title: "💬 Message Types"
---

# 💬 Message Types

An agent talks to STELLA through two Python types. It receives an `AgentInput` in `process()` and yields `AgentOutput` objects back. The SDK turns each output into speech, a chat bubble, or a JSON message on the LiveKit data channel. Agents never build data-channel messages for normal replies themselves.

All of these names are exported from the top-level package:

```python
from stella_agent_sdk import (
    AgentInput,
    AgentOutput,
    AgentState,
    BargeInDecision,
    ChatMessage,
    InputType,
    MetadataSubtype,
    OutputType,
    StatusSubtype,
)
```

## AgentInput

What `process()` receives. A dataclass with these fields:

| Field | Type | Meaning |
|-------|------|---------|
| `session_id` | `str` | The session this turn belongs to. |
| `type` | `InputType` | What kind of input this is. |
| `text` | `str` | What the user said or typed. Empty for a turn the agent opened itself. |
| `conversation_history` | `list[dict] \| None` | Previous turns, when the caller supplies them. The audio loop does not. |
| `metadata` | `dict` | Extra context about the turn (see below). |
| `timestamp` | `datetime` | When the input was created (UTC). |

When the agent runs in a LiveKit room, the default `run_audio_loop()` builds every turn with `AgentInput.text_input()`, so `type` is always `InputType.TEXT`. It fills `metadata` with:

| Key | Meaning |
|-----|---------|
| `turn_id` | The STT transcript id. Analytics from the audio side and the agent side share it. |
| `detected_language`, `language_confidence` | The STT's own language detection. `""` and `0.0` when it gave none. |
| `stt_confidence` | How far the transcript can be trusted, 0 to 1. Typed text is `1.0`; `0.0` means no signal. |
| `is_barge_in` | `True` when this turn interrupted the agent mid-reply. |
| `taken_back` | Present after a [take-back](./audio-pipeline.md#take-back): the earlier parts that were joined into this turn. |
| `agent_initiated` | Present only on a turn the agent opened with `self.start_turn(...)`: whatever it passed. |

Session start, session end, configuration and interrupts do not arrive as inputs. They reach the agent through hooks on `BaseAgent` (`on_session_start`, `on_session_end`, `on_session_ending`, `on_barge_in`, and so on); see [Base Agent](./base-agent.md).

`AgentInput` has constructors for each `InputType`, mainly useful in tests:

```python
from stella_agent_sdk import AgentInput, InputType

turn = AgentInput.text_input("session-1", "Hello", turn_id="t-1")
assert turn.type == InputType.TEXT
assert turn.metadata == {"turn_id": "t-1"}

stop = AgentInput.interrupt("session-1")
start = AgentInput.session_start("session-1", {"system_prompt": "Be brief."})
end = AgentInput.session_end("session-1")
update = AgentInput.config_update("session-1", {"temperature": 0.3})
```

### InputType

| Value | Wire value |
|-------|-----------|
| `InputType.TEXT` | `"text"` |
| `InputType.INTERRUPT` | `"interrupt"` |
| `InputType.SESSION_START` | `"session_start"` |
| `InputType.SESSION_END` | `"session_end"` |
| `InputType.CONFIG` | `"config"` |
| `InputType.HEALTH_CHECK` | `"health_check"` |

## AgentOutput

What `process()` yields. A dataclass:

| Field | Type | Meaning |
|-------|------|---------|
| `session_id` | `str` | The session. |
| `type` | `OutputType` | What kind of output this is. |
| `content` | `str` | The text, status line, or JSON body. |
| `is_final` | `bool` | For `TEXT_CHUNK`: this chunk ends the reply. |
| `transcript_id` | `str \| None` | Groups the chunks of one reply. |
| `status_subtype` | `StatusSubtype \| None` | For `STATUS`. |
| `metadata_subtype` | `MetadataSubtype \| None` | For `METADATA`. |
| `metadata` | `dict` | Extra data for the output. |
| `timestamp` | `datetime` | When the output was created (UTC). |

Build outputs with the class methods rather than the constructor:

| Constructor | Type | What happens to it |
|-------------|------|--------------------|
| `text_chunk(session_id, text, transcript_id=None, is_final=False)` | `TEXT_CHUNK` | Shown in the chat and spoken sentence by sentence. `text` is the **whole reply so far**, not the new tokens. See [Streaming](./streaming.md). |
| `text_final(session_id, text, transcript_id=None)` | `TEXT_FINAL` | A complete reply: shown and spoken in one go. |
| `status(session_id, message, subtype=StatusSubtype.PROCESSING, progress=None, **extra)` | `STATUS` | Shown in the debug feed. Not spoken. |
| `thinking(session_id, message="Thinking...")` | `STATUS` | `status()` with `StatusSubtype.THINKING`. |
| `processing(session_id, message="Processing...")` | `STATUS` | `status()` with `StatusSubtype.PROCESSING`. |
| `metadata_update(session_id, subtype, data)` | `METADATA` | `data` is sent as JSON. Not spoken. |
| `deliverable(session_id, key, value, **extra)` | `METADATA` | A collected plan deliverable. |
| `progress(session_id, percentage, message="")` | `METADATA` | Overall progress. Values above 1 are read as percent and divided by 100. |
| `error(session_id, message, error_type="processing_error", recoverable=True, **extra)` | `ERROR` | Shown in the debug feed at level `error`. |
| `progress_update(session_id, progress_state, update_trigger="turn_completion", **extra)` | `PROGRESS_UPDATE` | The task panel. Takes a `ProgressState` or a dict; see [Progress Tracking](./progress-tracking.md). |
| `debug(session_id, message, component="agent", level="info", **extra)` | `DEBUG` | Shown in the debug feed. |
| `tool_call(session_id, tool, *, caller="agent", arguments=None, success=True, data=None, error=None)` | `DEBUG` | One executed function call, in a shape the UI knows. |
| `decision(session_id, kind, label, *, detail=None, options=None, component="agent", **extra)` | `DEBUG` | A routing decision, shown as a tag. |
| `analytics(session_id, stage, timing_ms, **extra)` | `ANALYTICS` | A timing, stored for the analytics dashboard. Not shown. |
| `analytics_event(session_id, stage, turn_id, elapsed_ms, **extra)` | `ANALYTICS` | A timestamped event, `elapsed_ms` after the end of the user's speech. |
| `client_command(session_id, command, **data)` | `CLIENT_COMMAND` | A command for the user's device, sent once this turn's speech has played. Dropped if the turn is interrupted. |
| `health_status(...)` | `HEALTH_STATUS` | Answer to a health check. The SDK sends these; agents don't. |

A turn that uses several of them:

```python
from typing import AsyncIterator

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent


class IntakeAgent(BaseAgent):
    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        sid = input.session_id
        yield AgentOutput.thinking(sid)
        yield AgentOutput.debug(sid, f"heard {len(input.text)} characters", component="intake")

        if "born" in input.text:
            yield AgentOutput.deliverable(sid, "date_of_birth", input.text, confidence=0.8)
            yield AgentOutput.progress(sid, 50, "Halfway there")

        yield AgentOutput.text_final(sid, "Thank you. What brings you here today?")

    async def on_interrupt(self, session_id: str) -> None:
        pass
```

### OutputType

| Value | Wire value |
|-------|-----------|
| `OutputType.TEXT_CHUNK` | `"text_chunk"` |
| `OutputType.TEXT_FINAL` | `"text_final"` |
| `OutputType.STATUS` | `"status"` |
| `OutputType.METADATA` | `"metadata"` |
| `OutputType.ERROR` | `"error"` |
| `OutputType.HEALTH_STATUS` | `"health_status"` |
| `OutputType.DEBUG` | `"debug"` |
| `OutputType.PROGRESS_UPDATE` | `"progress_update"` |
| `OutputType.ANALYTICS` | `"analytics"` |
| `OutputType.CLIENT_COMMAND` | `"client_command"` |

### StatusSubtype and MetadataSubtype

`StatusSubtype`: `PROCESSING`, `THINKING`, `AGGREGATING`.

`MetadataSubtype`: `PLAN_UPDATE`, `TASK_UPDATE`, `DELIVERABLE`, `PROGRESS`, `STATE_TRANSITION`.

## Other types

### AgentState

The health state an agent reports: `UNKNOWN`, `INITIALIZING`, `READY`, `PROCESSING`, `INTERRUPTED`, `ERROR`, `SHUTTING_DOWN`. Read it from `self.state`; set it with `self.set_state(...)`.

### BargeInDecision

What `on_barge_in()` returns when the user interrupts the agent mid-reply:

- `BargeInDecision.COMMIT`: the interruption counts. The rest of the reply is dropped and the transcript becomes a new turn.
- `BargeInDecision.RESUME`: it was a backchannel or noise. Playback carries on where it stopped and the transcript is discarded.

```python
from typing import AsyncIterator

from stella_agent_sdk import AgentInput, AgentOutput, BargeInDecision, BaseAgent


class PoliteAgent(BaseAgent):
    supports_barge_in = True

    async def on_barge_in(self, session_id: str, transcript: str) -> BargeInDecision:
        if transcript.strip().lower() in {"mhm", "yes", "okay"}:
            return BargeInDecision.RESUME
        return BargeInDecision.COMMIT

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        yield AgentOutput.text_final(input.session_id, "Let me tell you a long story.")

    async def on_interrupt(self, session_id: str) -> None:
        pass
```

### ChatMessage

One message from the session's stored history, returned by `await self.get_chat_history()`. Fields: `id`, `timestamp`, `envelope` (the original data-channel message), `role` (`"user"`, `"assistant"` or `"system"`), `content` and `message_type` (`"user_text"`, `"transcript"`, `"agent_text"` or `"debug"`).

## On the data channel

The SDK sends JSON envelopes of the form `{"type": ..., "data": {...}}` to everyone in the room. This is what a frontend sees; an agent produces them by yielding outputs.

| Envelope `type` | Comes from |
|-----------------|-----------|
| `agent_text` | `TEXT_CHUNK` / `TEXT_FINAL`. `data`: `text` (the whole reply so far), `is_final`, `transcript_id`, `agent_id`, `agent_name`, `source: "agent_response"`. The frontend replaces the bubble with the same `transcript_id`. |
| `transcript` | The user's speech (partial and final) and typed text, echoed back. `data`: `text`, `is_final`, `transcript_id`, `speaker_id`, `speaker_name`, `source` (`"user_speech"` or `"user_text"`), and `discarded` for speech that was heard but not taken as a turn. |
| `debug` | `DEBUG`, `STATUS` (level `info`), `ERROR` (level `error`) and every `METADATA` except deliverables. `data`: `content`, `component`, `level`, `metadata`. |
| `plan_deliverable_update` | `AgentOutput.deliverable(...)`. |
| `progress_update` | `PROGRESS_UPDATE`, with the agent's id, name and icon added to its `metadata`. |
| `analytics` | `ANALYTICS`. |
| `agent_command` | `CLIENT_COMMAND`. |
| `agent_speech_progress`, `agent_playback`, `agent_emotion_cues` | The pipeline itself: word-by-word highlighting, playback state and face cues. |
| `session_completed`, `session_ended` | The session ended (the plan finished, or the session was closed). |

The SDK reads these envelopes coming from the room:

| Envelope `type` | Effect |
|-----------------|--------|
| `user_text` | A typed message. `data` is `{"text": ..., "correlation_id"?: ...}` (a bare string also works); an optional top-level `participant_id` names the sender. It becomes a turn like speech does, and is echoed back as a `transcript` carrying the same `correlation_id`. |
| `client_event` | Something the user did on the device; passed to `on_client_event()`. |
| `audio_stream_mute`, `audio_stream_unmute` | The user muted or unmuted the microphone. |
| `session_end` | Sent by the backend to close the session gracefully; runs `on_session_ending()`. |

Envelopes are JSON, UTF-8 encoded. On the frontend, with `livekit-client`:

```typescript
// Send a typed message to the agent
room.localParticipant.publishData(
  new TextEncoder().encode(JSON.stringify({
    type: 'user_text',
    data: { text: 'Hello', correlation_id: crypto.randomUUID() },
    participant_id: 'Anna', // optional: the name the message is attributed to
  })),
  { reliable: true },
);

// Show the agent's reply as it streams
room.on('dataReceived', (payload) => {
  const message = JSON.parse(new TextDecoder().decode(payload));
  if (message.type === 'agent_text') {
    const { transcript_id, text, is_final } = message.data;
    upsertBubble(transcript_id, text, is_final); // replace, don't append
  }
});
```

To send an envelope of your own outside a turn, use `await self.audio.publish_data({"type": ..., "data": {...}})`. A client ignores types it does not know.

## See Also

- [Streaming](./streaming.md)
- [Audio Pipeline](./audio-pipeline.md)
- [Base Agent](./base-agent.md)
- [Platform Contract](./platform-contract.md)
- [Progress Tracking](./progress-tracking.md)
