---
sidebar_position: 3
title: "🧱 Base Agent"
---

# 🧱 BaseAgent Class

The `BaseAgent` class is the foundation for all STELLA agents. It handles LiveKit connectivity, audio processing, and message passing.

## Class Definition

```python
from stella_sdk import BaseAgent

class BaseAgent:
    """Base class for all STELLA agents."""

    def __init__(self, config: AgentConfig = None):
        """Initialize the agent with optional configuration."""

    async def run(self):
        """Start the agent and connect to the room."""

    async def stop(self):
        """Stop the agent and disconnect from the room."""
```

## Lifecycle Methods

Override these methods to customize agent behavior:

### on_connect

```python
async def on_connect(self):
    """Called when the agent successfully connects to the LiveKit room.

    Use this to:
    - Send initial greeting
    - Set up state
    - Start background tasks
    """
    pass
```

### on_disconnect

```python
async def on_disconnect(self):
    """Called when the agent disconnects from the room.

    Use this to:
    - Clean up resources
    - Save state
    - Log final metrics
    """
    pass
```

### on_participant_joined

```python
async def on_participant_joined(self, participant: Participant):
    """Called when a new participant joins the room.

    Args:
        participant: The participant that joined
    """
    pass
```

### on_participant_left

```python
async def on_participant_left(self, participant: Participant):
    """Called when a participant leaves the room.

    Args:
        participant: The participant that left
    """
    pass
```

## Audio Methods

### on_transcript

```python
async def on_transcript(self, text: str, is_final: bool):
    """Called when speech is transcribed.

    Args:
        text: The transcribed text
        is_final: Whether this is a final or interim transcript
    """
    pass
```

### on_audio_frame

```python
async def on_audio_frame(self, frame: AudioFrame):
    """Called for each incoming audio frame.

    Args:
        frame: The audio frame data

    Note: This is called frequently. For most use cases,
    use on_transcript instead.
    """
    pass
```

### publish_audio

```python
async def publish_audio(self, audio: bytes | AudioStream):
    """Publish audio to the room.

    Args:
        audio: Audio data as bytes or a streaming source
    """
```

## Data Channel Methods

### on_data_message

```python
async def on_data_message(self, message: dict):
    """Called when a data message is received.

    Args:
        message: The parsed JSON message

    Common message types:
    - user_text: Text input from user
    - control: Control messages (pause, resume, etc.)
    """
    pass
```

### send

```python
async def send(self, message: Message):
    """Send a message through the data channel.

    Args:
        message: A Message object to send
    """
```

## Utility Methods

### send_status

```python
async def send_status(self, status: str, message: str = None):
    """Send a status update.

    Args:
        status: Status string ('listening', 'thinking', 'speaking', etc.)
        message: Optional status message
    """
```

### send_transcript

```python
async def send_transcript(self, text: str, speaker: str = "assistant", is_final: bool = True):
    """Send a transcript message.

    Args:
        text: The transcript text
        speaker: Who is speaking ('user' or 'assistant')
        is_final: Whether this is a final transcript
    """
```

### update_todo

```python
async def update_todo(self, items: list[TodoItem]):
    """Update the todo list.

    Args:
        items: List of TodoItem objects
    """
```

## Properties

### room_name

```python
@property
def room_name(self) -> str:
    """The name of the LiveKit room."""
```

### participant_identity

```python
@property
def participant_identity(self) -> str:
    """The agent's identity in the room."""
```

### participants

```python
@property
def participants(self) -> list[Participant]:
    """List of participants in the room."""
```

### is_connected

```python
@property
def is_connected(self) -> bool:
    """Whether the agent is connected to a room."""
```

## Beyond Speech: the Device Channel

An agent can do more on the user's device than speak, and can learn about more than what the user said. The SDK carries these messages and gives them no meaning of its own: which commands and events exist is between your agent and its client. The built-in face client, for example, understands the commands `sleep` and `sleep_allowed` and reports the events `sleep` and `wake`.

### Commands to the device

```python
# Inside process(): delivered once this turn's speech has been heard,
# and dropped if the user interrupts the turn.
yield AgentOutput.client_command(session_id, "sleep")

# Outside a turn: delivered right away.
await self.send_client_command("sleep_allowed", allowed=False)
```

The client receives `{"type": "agent_command", "data": {"command": ..., ...}}`.

### on_client_event

Called when the client sends `{"type": "client_event", "data": {"event": ..., ...}}`: something the user did that is neither speech nor text.

```python
async def on_client_event(self, session_id: str, event: str, data: dict) -> None:
    if event == "wake":
        self.start_turn(event="wake")
```

### start_turn

Opens a turn nobody spoke. `process()` is called with empty text and `input.metadata["agent_initiated"]` set to what you passed; what it yields is published and spoken like any reply. The turn waits behind one that is running, and a message the user sends in the meantime replaces it.

```python
async def process(self, input):
    opened_by_me = input.metadata.get("agent_initiated")
    if opened_by_me is not None:
        yield AgentOutput.text_final(input.session_id, "Hello! How are you?")
        return
    ...
```

### on_idle

Set `idle_timeout_seconds` and `on_idle` is called once per quiet stretch: no turn, no speech, nothing done on the device for that long. `None` (the default) switches it off.

```python
self.idle_timeout_seconds = 45

async def on_idle(self, session_id: str, idle_seconds: float) -> None:
    await self.send_client_command("sleep", reason="idle")
```

### Transcript confidence

`input.metadata["stt_confidence"]` says how far a spoken transcript can be trusted, from 0 to 1. It is 1.0 for typed text and 0 when the STT provider gave no signal. Short filler that a transcriber invents over near-silence scores low, so an agent can decline to act on it.

## Configuration

The `AgentConfig` class configures agent behavior:

```python
from stella_sdk import AgentConfig

config = AgentConfig(
    # LiveKit settings
    livekit_url="wss://your-livekit-server.com",
    api_key="your-api-key",
    api_secret="your-api-secret",

    # Room settings
    room_name="my-room",
    participant_identity="my-agent",

    # Audio settings
    sample_rate=16000,
    channels=1,

    # Behavior settings
    auto_subscribe=True,
    publish_audio=True,
    publish_data=True,
)

agent = MyAgent(config)
```

## Complete Example

```python
from stella_sdk import BaseAgent, AgentConfig, AudioPipeline

class ConversationalAgent(BaseAgent):
    def __init__(self):
        super().__init__()
        self.pipeline = AudioPipeline()
        self.history = []

    async def on_connect(self):
        await self.send_status("ready")
        await self.greet()

    async def on_disconnect(self):
        print(f"Session ended. {len(self.history)} turns.")

    async def on_participant_joined(self, participant):
        print(f"Welcome {participant.identity}!")

    async def on_transcript(self, text: str, is_final: bool):
        if not is_final:
            return

        self.history.append({"role": "user", "content": text})

        await self.send_status("thinking")
        response = await self.generate_response()
        await self.send_status("speaking")

        await self.send_transcript(response, speaker="assistant")
        audio = await self.pipeline.text_to_speech(response)
        await self.publish_audio(audio)

        self.history.append({"role": "assistant", "content": response})
        await self.send_status("listening")

    async def greet(self):
        greeting = "Hello! How can I help you today?"
        await self.send_transcript(greeting, speaker="assistant")
        audio = await self.pipeline.text_to_speech(greeting)
        await self.publish_audio(audio)

    async def generate_response(self) -> str:
        # Your LLM logic here
        pass


if __name__ == "__main__":
    agent = ConversationalAgent()
    agent.run()
```

## See Also

- [Message Types](./message-types.md)
- [Audio Pipeline](./audio-pipeline.md)
- [Building Custom Agents](./building-custom-agent.md)
