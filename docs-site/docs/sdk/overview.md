---
sidebar_position: 1
title: SDK Overview
description: Introduction to the STELLA Agent SDK
---

# SDK Overview

The STELLA Agent SDK is a Python library for building conversational AI agents. It provides a high-level API for handling real-time voice communication, LLM integration, and tool execution.

## Installation

```bash
pip install "stella-ai-agent-sdk>=0.10.0"
```

## Quick Start

```python
from stella_sdk import BaseAgent, AudioPipeline
from openai import AsyncOpenAI


class MyAgent(BaseAgent):
    def __init__(self):
        super().__init__()
        self.pipeline = AudioPipeline()
        self.openai = AsyncOpenAI()

    async def on_connect(self):
        await self.speak("Hello! How can I help you?")

    async def on_transcript(self, text: str, is_final: bool):
        if not is_final:
            return

        response = await self.generate_response(text)
        await self.speak(response)

    async def generate_response(self, text: str) -> str:
        result = await self.openai.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": text}]
        )
        return result.choices[0].message.content

    async def speak(self, text: str):
        async for chunk in self.pipeline.text_to_speech_stream(text):
            await self.publish_audio(chunk)


if __name__ == "__main__":
    agent = MyAgent()
    agent.run()
```

## Core Concepts

### BaseAgent

The foundation of all STELLA agents. Handles:
- LiveKit room connection
- Audio stream management
- Event dispatching

See [Base Agent Reference](./base-agent.md) for full API.

### AudioPipeline

Manages speech processing:
- Speech-to-Text (STT)
- Text-to-Speech (TTS)
- Audio format conversion

### Tools

Extend agent capabilities with custom functions:

```python
from stella_sdk import tool

@tool
async def search(query: str) -> dict:
    """Search the knowledge base."""
    results = await db.search(query)
    return {"results": results}
```

See [Tools Reference](./tools.md) for patterns.

### Message Types

Structured communication with the frontend:
- `TranscriptMessage`: Speech transcription
- `StatusMessage`: Agent status updates
- `ProgressMessage`: Task progress

See [Message Types](./message-types.md) for details.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                    Your Agent                          │
│  ┌──────────────────────────────────────────────────┐ │
│  │                 BaseAgent                         │ │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐ │ │
│  │  │  LiveKit   │  │   Audio    │  │   Tools    │ │ │
│  │  │  Client    │  │  Pipeline  │  │  Registry  │ │ │
│  │  └────────────┘  └────────────┘  └────────────┘ │ │
│  └──────────────────────────────────────────────────┘ │
│                         │                             │
│  ┌──────────────────────┴───────────────────────────┐ │
│  │              Your Implementation                  │ │
│  │  • on_connect()                                  │ │
│  │  • on_transcript()                               │ │
│  │  • generate_response()                           │ │
│  │  • Custom tools                                  │ │
│  └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

## Configuration

Agents are configured via environment variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `LIVEKIT_URL` | Yes | LiveKit server URL |
| `LIVEKIT_API_KEY` | Without `LIVEKIT_TOKEN` | LiveKit API key |
| `LIVEKIT_API_SECRET` | Without `LIVEKIT_TOKEN` | LiveKit API secret |
| `LIVEKIT_TOKEN` | No | A ready-made token for the agent's room. When set, the agent joins with it and needs no key or secret. Uploaded agents get only this. |
| `ROOM_NAME` | Yes | LiveKit room to join |
| `OPENAI_API_KEY` | Yes | OpenAI API key |
| `STT_PROVIDER` | No | STT provider (default: sherpa) |
| `TTS_PROVIDER` | No | TTS provider (default: kokoro) |

## Supported Providers

### Speech-to-Text

| Provider | Local | Notes |
|----------|-------|-------|
| `sherpa` | Yes | Fast, CPU-friendly |
| `whisper` | Yes | Higher accuracy |
| `google` | No | Google Cloud STT |
| `azure` | No | Azure Speech |

### Text-to-Speech

| Provider | Local | Notes |
|----------|-------|-------|
| `kokoro` | Yes | Fast, good quality |
| `piper` | Yes | Multiple voices |
| `elevenlabs` | No | Very natural |
| `openai` | No | Simple integration |

### LLM

The SDK is LLM-agnostic. Use any provider:
- OpenAI (GPT-4, GPT-4o)
- Anthropic (Claude)
- Local models (Ollama, vLLM)
- Azure OpenAI

## Next Steps

- [Base Agent](./base-agent.md) - Full BaseAgent API
- [Message Types](./message-types.md) - Communication protocol
- [Tools](./tools.md) - Building custom tools
- [Streaming](./streaming.md) - Real-time audio handling
