---
sidebar_position: 2
title: "🏁 Getting Started"
---

# 🏁 Getting Started with the Agent SDK

This guide walks you through creating your first custom agent using the STELLA Agent SDK.

## Prerequisites

- Python 3.9+
- A running STELLA backend
- LiveKit server access

## Installation

```bash
pip install "stella-ai-agent-sdk>=0.10.0"
```

## Project Setup

Create a new directory for your agent:

```bash
mkdir my-custom-agent
cd my-custom-agent
```

Create the project structure:

```
my-custom-agent/
├── agent.py           # Main agent code
├── requirements.txt   # Dependencies
├── Dockerfile         # Container configuration
└── config.yaml        # Agent configuration
```

## Your First Agent

Create `agent.py`:

```python
import asyncio
from stella_sdk import BaseAgent, AudioPipeline

class MyFirstAgent(BaseAgent):
    """A simple agent that responds to user messages."""

    def __init__(self):
        super().__init__()
        self.pipeline = AudioPipeline()
        self.conversation_history = []

    async def on_connect(self):
        """Called when agent connects to the room."""
        print(f"Connected to room: {self.room_name}")
        await self.send_status("ready")

        # Optional: Send a greeting
        greeting = "Hello! I'm your AI assistant. How can I help you?"
        await self.speak(greeting)

    async def on_disconnect(self):
        """Called when agent disconnects."""
        print("Disconnected from room")

    async def on_transcript(self, text: str, is_final: bool):
        """Called when user speech is transcribed."""
        if not is_final:
            # Partial transcript - could update UI
            return

        # Final transcript - generate response
        print(f"User said: {text}")

        # Add to conversation history
        self.conversation_history.append({
            "role": "user",
            "content": text
        })

        # Generate and speak response
        response = await self.generate_response(text)
        await self.speak(response)

        # Add response to history
        self.conversation_history.append({
            "role": "assistant",
            "content": response
        })

    async def on_data_message(self, message: dict):
        """Called when receiving a data channel message."""
        if message.get("type") == "user_text":
            # Handle text input
            await self.on_transcript(message["data"], is_final=True)

    async def generate_response(self, user_input: str) -> str:
        """Generate a response using OpenAI."""
        from openai import AsyncOpenAI

        client = AsyncOpenAI()

        messages = [
            {"role": "system", "content": "You are a helpful assistant."},
            *self.conversation_history
        ]

        response = await client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            stream=False
        )

        return response.choices[0].message.content

    async def speak(self, text: str):
        """Convert text to speech and publish to room."""
        await self.send_transcript(text, speaker="assistant")
        audio = await self.pipeline.text_to_speech(text)
        await self.publish_audio(audio)


if __name__ == "__main__":
    agent = MyFirstAgent()
    agent.run()
```

## Configuration

Create `config.yaml`:

```yaml
agent:
  name: my-first-agent
  version: 1.0.0

livekit:
  url: ${LIVEKIT_URL}
  api_key: ${LIVEKIT_API_KEY}
  api_secret: ${LIVEKIT_API_SECRET}

openai:
  api_key: ${OPENAI_API_KEY}
  model: gpt-4o

audio:
  stt_provider: sherpa
  tts_provider: kokoro
```

## Dependencies

Create `requirements.txt`:

```
stella-ai-agent-sdk>=0.10.0
openai>=1.0.0
livekit>=0.10.0
```

## Dockerfile

Create `Dockerfile`:

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy agent code
COPY . .

# Run the agent
CMD ["python", "agent.py"]
```

## Running Locally

Set environment variables:

```bash
export LIVEKIT_URL=ws://localhost:7880
export LIVEKIT_API_KEY=devkey
export LIVEKIT_API_SECRET=secret
export OPENAI_API_KEY=sk-...
export ROOM_NAME=test-room
export PARTICIPANT_IDENTITY=my-agent
```

Run the agent:

```bash
python agent.py
```

## Building and Deploying

Build the Docker image:

```bash
docker build -t my-custom-agent:latest .
```

Deploy to STELLA by updating the agent image configuration:

```bash
# In your .env or ConfigMap
AGENT_IMAGE=my-custom-agent:latest
```

## Testing Your Agent

1. Start STELLA: `./scripts/start-k8s.sh`
2. Create a session in the Frontend UI
3. Deploy your custom agent
4. Interact via voice or text

## Next Steps

- [Base Agent](./base-agent.md) - Learn about all BaseAgent methods
- [Audio Pipeline](./audio-pipeline.md) - Configure STT/TTS
- [Message Types](./message-types.md) - Understand the message protocol
- [Tools](./tools.md) - Add custom tool support
