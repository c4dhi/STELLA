---
sidebar_position: 3
title: Message Types
description: Communication protocol between agents and frontend
---

# Message Types

STELLA uses structured messages for communication between agents and the frontend. Messages are sent over LiveKit data channels.

## Overview

All messages follow this structure:

```typescript
interface Message {
  type: string;      // Message type identifier
  timestamp: number; // Unix timestamp in milliseconds
  data: any;         // Type-specific payload
}
```

## Transcript Messages

Used for speech transcription (both interim and final).

### Schema

```typescript
interface TranscriptMessage {
  type: "transcript";
  timestamp: number;
  data: {
    speaker: "user" | "assistant";
    text: string;
    isFinal: boolean;
    confidence?: number;  // 0-1, STT confidence
    language?: string;    // ISO language code
  };
}
```

### Usage (Agent)

```python
# Send interim transcript (while user is speaking)
await self.send_transcript(
    text="Hello, I would like to",
    speaker="user",
    is_final=False
)

# Send final transcript
await self.send_transcript(
    text="Hello, I would like to order a pizza",
    speaker="user",
    is_final=True
)

# Send assistant response
await self.send_transcript(
    text="I'd be happy to help you order a pizza!",
    speaker="assistant",
    is_final=True
)
```

### Usage (Frontend)

```typescript
room.on('dataReceived', (payload) => {
  const message = JSON.parse(new TextDecoder().decode(payload));

  if (message.type === 'transcript') {
    const { speaker, text, isFinal } = message.data;

    if (speaker === 'user') {
      if (isFinal) {
        addMessage({ speaker: 'user', text });
      } else {
        updateInterimTranscript(text);
      }
    } else {
      addMessage({ speaker: 'assistant', text });
    }
  }
});
```

## Status Messages

Indicate the agent's current state.

### Schema

```typescript
interface StatusMessage {
  type: "status";
  timestamp: number;
  data: {
    status: "listening" | "thinking" | "speaking" | "idle";
    message?: string;  // Optional descriptive message
  };
}
```

### Status Values

| Status | Description | UI Indication |
|--------|-------------|---------------|
| `listening` | Waiting for user input | Microphone active |
| `thinking` | Processing user input | Loading indicator |
| `speaking` | Playing TTS audio | Speaker animation |
| `idle` | Not actively engaged | Ready state |

### Usage (Agent)

```python
# Indicate processing
await self.send_status("thinking", "Analyzing your request...")

# Indicate speaking
await self.send_status("speaking")

# Indicate listening
await self.send_status("listening")
```

### Usage (Frontend)

```typescript
function AgentStatus({ status, message }) {
  const indicators = {
    listening: { icon: <MicIcon />, label: 'Listening' },
    thinking: { icon: <Spinner />, label: message || 'Thinking' },
    speaking: { icon: <SpeakerIcon />, label: 'Speaking' },
    idle: { icon: <CheckIcon />, label: 'Ready' },
  };

  const current = indicators[status];

  return (
    <div className="agent-status">
      {current.icon}
      <span>{current.label}</span>
    </div>
  );
}
```

## Progress Messages

Show task progress with a todo list.

### Schema

```typescript
interface ProgressMessage {
  type: "progress";
  timestamp: number;
  data: {
    todos: TodoItem[];
  };
}

interface TodoItem {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed";
}
```

### Usage (Agent)

```python
from stella_agent_sdk import TodoItem

# Initialize todo list
await self.update_todo([
    TodoItem(id="1", description="Understand request", status="in_progress"),
    TodoItem(id="2", description="Search database", status="pending"),
    TodoItem(id="3", description="Generate response", status="pending"),
])

# Update progress
await self.complete_task("1")
await self.start_task("2")
```

### Usage (Frontend)

```typescript
function ProgressList({ todos }) {
  return (
    <ul className="progress-list">
      {todos.map(todo => (
        <li key={todo.id} className={`todo-${todo.status}`}>
          <StatusIcon status={todo.status} />
          <span>{todo.description}</span>
        </li>
      ))}
    </ul>
  );
}
```

## Control Messages

Commands from frontend to agent.

### Schema

```typescript
interface ControlMessage {
  type: "control";
  timestamp: number;
  data: {
    action: "interrupt" | "pause" | "resume" | "stop";
    payload?: any;
  };
}
```

### Actions

| Action | Description |
|--------|-------------|
| `interrupt` | Stop current TTS playback |
| `pause` | Pause the conversation |
| `resume` | Resume the conversation |
| `stop` | End the session |

### Usage (Frontend)

```typescript
// Interrupt agent speech
room.localParticipant.publishData(
  new TextEncoder().encode(JSON.stringify({
    type: 'control',
    data: { action: 'interrupt' }
  }))
);
```

### Usage (Agent)

```python
async def on_data_message(self, message: dict):
    if message.get("type") == "control":
        action = message["data"]["action"]

        if action == "interrupt":
            await self.pipeline.cancel_tts()
            await self.send_status("listening")

        elif action == "pause":
            self.is_paused = True

        elif action == "resume":
            self.is_paused = False
            await self.send_status("listening")
```

## User Text Messages

Text input from the user (alternative to voice).

### Schema

```typescript
interface UserTextMessage {
  type: "user_text";
  timestamp: number;
  data: string;  // The text message
}
```

### Usage (Frontend)

```typescript
function sendTextMessage(text: string) {
  room.localParticipant.publishData(
    new TextEncoder().encode(JSON.stringify({
      type: 'user_text',
      timestamp: Date.now(),
      data: text
    }))
  );
}
```

### Usage (Agent)

```python
async def on_data_message(self, message: dict):
    if message.get("type") == "user_text":
        text = message["data"]
        # Handle same as voice transcript
        await self.on_transcript(text, is_final=True)
```

## Custom Messages

You can define custom message types for application-specific needs.

### Example: Form Data

```typescript
// Frontend sends form data
interface FormDataMessage {
  type: "form_data";
  timestamp: number;
  data: {
    formId: string;
    fields: Record<string, any>;
  };
}
```

```python
# Agent handles form data
async def on_data_message(self, message: dict):
    if message.get("type") == "form_data":
        form_id = message["data"]["formId"]
        fields = message["data"]["fields"]
        await self.process_form(form_id, fields)
```

### Example: UI Updates

```typescript
// Agent sends UI update
interface UIUpdateMessage {
  type: "ui_update";
  timestamp: number;
  data: {
    component: string;
    props: Record<string, any>;
  };
}
```

## Message Encoding

Messages are serialized as JSON and encoded as UTF-8:

```typescript
// Sending
const message = { type: 'transcript', data: { ... } };
const encoded = new TextEncoder().encode(JSON.stringify(message));
room.localParticipant.publishData(encoded);

// Receiving
room.on('dataReceived', (payload) => {
  const decoded = new TextDecoder().decode(payload);
  const message = JSON.parse(decoded);
});
```

## Next Steps

- [Tools](./tools.md) - Building custom tools
- [Streaming](./streaming.md) - Audio streaming
- [Base Agent](./base-agent.md) - Full API reference
