---
sidebar_position: 4
title: "💬 Message Types"
---

# 💬 Message Types

STELLA agents communicate via LiveKit's data channel using structured JSON messages. This page documents all message types.

## Message Format

All messages follow this structure:

```typescript
{
  type: string,      // Message type identifier
  data: any,         // Message payload
  timestamp?: string // ISO 8601 timestamp
}
```

## Outgoing Messages (Agent → Frontend)

### transcript_chunk

Sent when the agent generates text (response or transcription):

```typescript
{
  type: 'transcript_chunk',
  data: {
    text: string,           // The transcript text
    is_final: boolean,      // Whether this is a final or interim result
    confidence?: number,    // Confidence score (0-1)
    timestamp: string,      // When this was generated
    participant_id: string, // Speaker identity
    chunk_id: string,       // Unique ID for this chunk
    transcript_id: string   // ID grouping related chunks
  }
}
```

**Python SDK:**

```python
await agent.send_transcript(
    text="Hello, how can I help?",
    speaker="assistant",
    is_final=True
)
```

### agent_status

Sent when agent status changes:

```typescript
{
  type: 'agent_status',
  data: {
    status: 'listening' | 'thinking' | 'speaking' | 'ready' | 'error',
    message?: string  // Optional status message
  }
}
```

**Python SDK:**

```python
await agent.send_status("thinking")
await agent.send_status("error", "Failed to connect to OpenAI")
```

### todo_list

Sent when the agent's task list updates:

```typescript
{
  type: 'todo_list',
  data: {
    items: Array<{
      id: string,
      description: string,
      status: 'pending' | 'in_progress' | 'completed',
      required: boolean
    }>,
    timestamp: string
  }
}
```

**Python SDK:**

```python
from stella_agent_sdk import TodoItem

await agent.update_todo([
    TodoItem(
        id="1",
        description="Gather user information",
        status="completed"
    ),
    TodoItem(
        id="2",
        description="Process request",
        status="in_progress"
    )
])
```

### tool_call

Sent when the agent calls a tool:

```typescript
{
  type: 'tool_call',
  data: {
    tool_name: string,
    arguments: Record<string, any>,
    call_id: string
  }
}
```

### tool_result

Sent when a tool returns a result:

```typescript
{
  type: 'tool_result',
  data: {
    call_id: string,
    result: any,
    error?: string
  }
}
```

### progress_update

Sent to indicate progress on a task:

```typescript
{
  type: 'progress_update',
  data: {
    task_id: string,
    progress: number,  // 0-100
    message?: string
  }
}
```

**Python SDK:**

```python
await agent.send_progress("task-1", progress=50, message="Halfway done")
```

## Incoming Messages (Frontend → Agent)

### user_text

Text input from the user:

```typescript
{
  type: 'user_text',
  data: string  // The user's text message
}
```

**Python SDK:**

```python
async def on_data_message(self, message: dict):
    if message.get("type") == "user_text":
        text = message["data"]
        # Handle text input
```

### control

Control commands for the agent:

```typescript
{
  type: 'control',
  data: {
    action: 'pause' | 'resume' | 'stop' | 'interrupt',
    params?: Record<string, any>
  }
}
```

**Actions:**
- `pause`: Temporarily stop responding
- `resume`: Resume responding
- `stop`: Stop the agent
- `interrupt`: Stop current response and listen

### config_update

Dynamic configuration update:

```typescript
{
  type: 'config_update',
  data: {
    setting: string,
    value: any
  }
}
```

## Message Classes (Python SDK)

The SDK provides typed message classes:

```python
from stella_agent_sdk.messages import (
    TranscriptMessage,
    StatusMessage,
    TodoListMessage,
    ToolCallMessage,
    ProgressMessage
)

# Transcript
msg = TranscriptMessage(
    text="Hello!",
    is_final=True,
    participant_id="agent-1"
)

# Status
msg = StatusMessage(
    status="thinking",
    message="Processing your request"
)

# Todo list
msg = TodoListMessage(
    items=[
        TodoItem(id="1", description="Task 1", status="completed"),
        TodoItem(id="2", description="Task 2", status="pending")
    ]
)
```

## Sending Messages

Use the agent's `send` method:

```python
from stella_agent_sdk.messages import StatusMessage

async def on_connect(self):
    # Using convenience method
    await self.send_status("ready")

    # Using message class directly
    await self.send(StatusMessage(status="ready"))
```

## Receiving Messages

Override `on_data_message`:

```python
async def on_data_message(self, message: dict):
    msg_type = message.get("type")

    if msg_type == "user_text":
        await self.handle_text_input(message["data"])

    elif msg_type == "control":
        await self.handle_control(message["data"])

    elif msg_type == "config_update":
        await self.handle_config(message["data"])
```

## Custom Message Types

You can define custom messages:

```python
from stella_agent_sdk.messages import BaseMessage

class CustomMessage(BaseMessage):
    type = "custom_type"

    def __init__(self, custom_data: str):
        self.data = {"custom_data": custom_data}

# Send custom message
await agent.send(CustomMessage("my data"))
```

## See Also

- [Base Agent](./base-agent.md)
- [Progress Tracking](./progress-tracking.md)
- [Building Custom Agents](./building-custom-agent.md)
