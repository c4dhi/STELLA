---
sidebar_position: 1
title: "📚 Overview"
---

# 📚 Agent SDK Overview

The STELLA Agent SDK lets you build custom voice agents without rebuilding infrastructure. Focus on your agent's logic—STELLA handles everything else.

## Why Use the Agent SDK?

| STELLA Handles | You Build |
|----------------|-----------|
| Audio pipeline (STT → TTS) | Conversation logic |
| WebRTC streaming | Custom tools |
| Session lifecycle | Business rules |
| Deployment & scaling | Prompts & workflows |

**The result:** Deploy production-ready voice agents in hours, not weeks. No infrastructure maintenance, no audio engineering—just your agent logic.

## What is the Agent SDK?

The Agent SDK is a Python framework that provides:

- **LiveKit Integration**: Connect to rooms, publish/subscribe audio
- **Audio Pipeline**: STT, LLM, and TTS orchestration
- **Message Protocol**: Structured data channel communication
- **Progress Tracking**: Todo lists and status updates
- **Tool Execution**: Custom function/tool support
- **Chat History**: Access conversation transcripts for context building

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Your Custom Agent                       │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    Business Logic                       │ │
│  │         (Custom handlers, tools, prompts)              │ │
│  └────────────────────────────────────────────────────────┘ │
│                            │                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                     Agent SDK                           │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐             │ │
│  │  │ BaseAgent│  │ Audio    │  │ Message  │             │ │
│  │  │          │  │ Pipeline │  │ Protocol │             │ │
│  │  └──────────┘  └──────────┘  └──────────┘             │ │
│  └────────────────────────────────────────────────────────┘ │
│                            │                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                   LiveKit Client                        │ │
│  │        (Audio tracks, Data channels, RTC)              │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Key Components

### BaseAgent

The foundation class that all agents extend:

```python
from stella_sdk import BaseAgent

class MyAgent(BaseAgent):
    async def on_message(self, message):
        # Handle incoming messages
        pass

    async def on_audio(self, audio_data):
        # Handle incoming audio
        pass
```

### Audio Pipeline

Manages the STT → LLM → TTS flow:

```python
from stella_sdk import AudioPipeline, STTProvider, TTSProvider

pipeline = AudioPipeline(
    stt=STTProvider.SHERPA,
    tts=TTSProvider.KOKORO
)
```

### Message Types

Structured messages for data channel communication:

```python
from stella_sdk import TranscriptMessage, StatusMessage

# Send transcript update
await agent.send(TranscriptMessage(
    text="Hello!",
    is_final=True
))

# Send status update
await agent.send(StatusMessage(
    status="thinking"
))
```

### Tools

Custom functions the agent can call:

```python
from stella_sdk import Tool

@tool
async def search_database(query: str) -> str:
    """Search the database for information."""
    results = await db.search(query)
    return results
```

### Chat History

Access conversation transcripts for context building. STELLA automatically records all session messages—your agent can retrieve them without any setup:

```python
# Get recent conversation history
history = await self.get_chat_history(limit=20)

# Use for LLM context
for msg in history:
    print(f"{msg.role}: {msg.content}")
```

See [Accessing Chat History](../guides/build-your-own-agent.md#accessing-chat-history) for the full API.

## Quick Example

```python
from stella_sdk import BaseAgent, AudioPipeline

class SimpleAgent(BaseAgent):
    def __init__(self):
        super().__init__()
        self.pipeline = AudioPipeline()

    async def on_connect(self):
        await self.send_status("ready")

    async def on_transcript(self, text: str, is_final: bool):
        if is_final:
            response = await self.generate_response(text)
            await self.speak(response)

    async def generate_response(self, user_input: str) -> str:
        # Your LLM logic here
        return f"You said: {user_input}"

# Run the agent
if __name__ == "__main__":
    agent = SimpleAgent()
    agent.run()
```

## Installation

```bash
pip install "stella-ai-agent-sdk>=0.10.0"
```

Or add to your `requirements.txt`:

```
stella-ai-agent-sdk>=0.10.0
```

## Next Steps

- [Getting Started](./getting-started.md) - Create your first custom agent
- [Base Agent](./base-agent.md) - Deep dive into the BaseAgent class
- [Message Types](./message-types.md) - All available message types
- [Audio Pipeline](./audio-pipeline.md) - Configure STT/TTS providers
- [Building Custom Agents](./building-custom-agent.md) - Complete tutorial
