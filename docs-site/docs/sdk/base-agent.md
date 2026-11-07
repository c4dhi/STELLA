---
sidebar_position: 2
title: Base Agent
description: BaseAgent class reference
---

# Base Agent

The `BaseAgent` class is the foundation for all STELLA agents. It handles LiveKit connection, audio streaming, and provides hooks for implementing conversation logic.

## Class Definition

```python
from stella_agent_sdk import BaseAgent

class MyAgent(BaseAgent):
    async def on_connect(self):
        """Called when connected to the LiveKit room."""
        pass

    async def on_transcript(self, text: str, is_final: bool):
        """Called when speech is transcribed."""
        pass

    async def on_disconnect(self):
        """Called when disconnecting from the room."""
        pass
```

## Lifecycle Methods

### `on_connect()`

Called when the agent successfully connects to the LiveKit room.

```python
async def on_connect(self):
    print(f"Connected to room: {self.room_name}")

    # Send initial greeting
    await self.speak("Hello! How can I help you today?")

    # Initialize conversation state
    self.history = []
    self.context = await self.load_context()
```

### `on_disconnect()`

Called when the agent is disconnecting. Use for cleanup.

```python
async def on_disconnect(self):
    # Save conversation state
    await self.save_conversation()

    # Clean up resources
    await self.pipeline.close()

    print("Session ended")
```

### `on_shutdown()`

Called when the agent receives a shutdown signal (SIGTERM).

```python
async def on_shutdown(self):
    # Graceful shutdown logic
    await self.send_status("ending", "Session ending...")
    await self.save_state()
```

## Audio Methods

### `on_transcript(text, is_final)`

Called when the STT engine produces transcription.

| Parameter | Type | Description |
|-----------|------|-------------|
| `text` | `str` | Transcribed text |
| `is_final` | `bool` | Whether this is a final result |

```python
async def on_transcript(self, text: str, is_final: bool):
    # Send interim transcripts to frontend
    await self.send_transcript(text, speaker="user", is_final=is_final)

    # Only process final transcripts
    if not is_final:
        return

    # Process the user's input
    response = await self.generate_response(text)
    await self.speak(response)
```

### `on_audio_frame(frame)`

Called for each audio frame received. Rarely needed - use `on_transcript` instead.

```python
async def on_audio_frame(self, frame: AudioFrame):
    # Raw audio processing (advanced usage)
    self.audio_buffer.append(frame)
```

### `publish_audio(chunk)`

Publish audio to the LiveKit room.

```python
async def publish_audio(self, chunk: bytes):
    # Publish raw audio bytes
    await self.room.local_participant.publish_data(chunk)
```

### `speak(text)`

Convenience method for TTS and publishing. Override to customize.

```python
async def speak(self, text: str):
    # Send transcript to frontend
    await self.send_transcript(text, speaker="assistant")

    # Convert to speech and publish
    async for chunk in self.pipeline.text_to_speech_stream(text):
        await self.publish_audio(chunk)
```

## Data Channel Methods

### `on_data_message(message)`

Called when a data channel message is received.

```python
async def on_data_message(self, message: dict):
    msg_type = message.get("type")

    if msg_type == "user_text":
        # Handle text input like voice
        await self.on_transcript(message["data"], is_final=True)

    elif msg_type == "control":
        action = message["data"].get("action")
        if action == "interrupt":
            await self.handle_interrupt()
        elif action == "pause":
            await self.handle_pause()
```

### `send_data(data)`

Send data to all participants in the room.

```python
await self.send_data({
    "type": "custom",
    "data": {"key": "value"}
})
```

## Status Methods

### `send_status(status, message?)`

Send a status update to the frontend.

| Status | Description |
|--------|-------------|
| `listening` | Waiting for user input |
| `thinking` | Processing/generating response |
| `speaking` | Playing TTS audio |
| `idle` | Not actively processing |

```python
await self.send_status("thinking", "Searching the database...")
await self.send_status("speaking")
await self.send_status("listening")
```

### `send_transcript(text, speaker, is_final?)`

Send a transcript message.

```python
await self.send_transcript(
    text="Hello, how can I help?",
    speaker="assistant",
    is_final=True
)
```

## Participant Methods

### `on_participant_joined(participant)`

Called when a user joins the room.

```python
async def on_participant_joined(self, participant: Participant):
    print(f"User joined: {participant.identity}")

    if participant.identity != "agent":
        await self.greet_user(participant)
```

### `on_participant_left(participant)`

Called when a user leaves the room.

```python
async def on_participant_left(self, participant: Participant):
    print(f"User left: {participant.identity}")

    # Check if room is empty
    if len(self.room.participants) == 1:  # Only agent left
        await self.handle_empty_room()
```

## Tool Methods

### `register_tool(func)`

Register a function as a tool.

```python
from stella_agent_sdk import tool

@tool
async def search(query: str) -> dict:
    """Search the database."""
    return {"results": [...]}

class MyAgent(BaseAgent):
    def __init__(self):
        super().__init__()
        self.register_tool(search)
```

### `get_tool_definitions()`

Get OpenAI-compatible tool definitions.

```python
tools = self.get_tool_definitions()
# Returns list of tool schemas for LLM
```

### `execute_tool(name, args)`

Execute a registered tool.

```python
result = await self.execute_tool("search", {"query": "STELLA docs"})
```

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `room` | `Room` | LiveKit room instance |
| `room_name` | `str` | Name of the room |
| `session_id` | `str` | Session identifier |
| `participant_identity` | `str` | Agent's identity |
| `is_connected` | `bool` | Connection status |

## Configuration

BaseAgent reads configuration from environment variables:

```python
class BaseAgent:
    def __init__(self):
        self.livekit_url = os.getenv("LIVEKIT_URL")
        self.room_name = os.getenv("ROOM_NAME")
        self.session_id = os.getenv("SESSION_ID")
        # ...
```

## Running the Agent

```python
if __name__ == "__main__":
    agent = MyAgent()
    agent.run()  # Blocking call
```

The `run()` method:
1. Connects to LiveKit
2. Starts audio processing
3. Handles events until disconnection
4. Cleans up resources

## Next Steps

- [Message Types](./message-types.md) - Communication protocol
- [Tools](./tools.md) - Building tools
- [Streaming](./streaming.md) - Audio streaming details
