---
sidebar_position: 1
title: "Overview"
---

# stella-agent

The full-featured conversational AI agent with advanced capabilities for production deployments.

## Overview

`stella-agent` provides a complete voice AI pipeline with:
- High-quality speech recognition (STT)
- Advanced language model integration (LLM)
- Natural text-to-speech synthesis (TTS)
- Real-time audio streaming via LiveKit
- Tool/function calling support
- Progress tracking and todo management
- **[Expert Pool System](./expert-pool-overview.md)** for safe handling of sensitive topics

## Features

### Speech-to-Text (STT)

- **Provider**: Configurable (Sherpa, Whisper, etc.)
- **Real-time transcription**: Continuous streaming recognition
- **Interim results**: Show partial transcriptions as user speaks
- **Multi-language**: Support for multiple languages

### Language Model (LLM)

- **Provider**: OpenAI GPT models
- **Streaming responses**: Token-by-token generation
- **System prompts**: Customizable agent personality
- **Context management**: Conversation history tracking
- **Tool/function calling**: Execute custom tools during conversation

### Text-to-Speech (TTS)

- **Provider**: Configurable (Kokoro, ElevenLabs, etc.)
- **Voice selection**: Multiple voice options
- **Streaming audio**: Low-latency audio generation
- **Interruption handling**: Stop speaking when user talks

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key | Required |
| `OPENAI_MODEL` | Model to use | `gpt-4o` |
| `STT_PROVIDER` | Speech-to-text provider | `sherpa` |
| `TTS_PROVIDER` | Text-to-speech provider | `kokoro` |
| `TTS_VOICE` | Voice for TTS | Provider default |
| `SYSTEM_PROMPT` | Agent's system prompt | Default prompt |
| `ELEVENLABS_API_KEY` | ElevenLabs API key | Optional |

### Plan Templates

Plans define the conversation structure and agent behavior:

```json
{
  "name": "Customer Support",
  "systemPrompt": "You are a helpful customer support agent...",
  "tools": ["search_knowledge_base", "create_ticket"],
  "settings": {
    "maxTurns": 20,
    "timeout": 300
  }
}
```

## Pipeline Architecture

```
Audio In (LiveKit)
       │
       ▼
┌──────────────┐
│ VAD (Voice   │    Detects when user starts/stops speaking
│ Activity     │
│ Detection)   │
└──────────────┘
       │
       ▼
┌──────────────┐
│ STT Service  │    Converts speech to text (streaming)
│ (Sherpa/     │
│  Whisper)    │
└──────────────┘
       │
       ▼
┌──────────────┐
│ LLM Service  │    Generates response (streaming)
│ (OpenAI)     │    May call tools during generation
└──────────────┘
       │
       ▼
┌──────────────┐
│ TTS Service  │    Converts text to speech (streaming)
│ (Kokoro/     │
│  ElevenLabs) │
└──────────────┘
       │
       ▼
Audio Out (LiveKit)
```

## Data Channel Messages

`stella-agent` sends various messages through LiveKit's data channel:

### Transcript Updates

```typescript
{
  type: 'transcript_chunk',
  data: {
    text: string,
    is_final: boolean,
    confidence: number,
    timestamp: string,
    participant_id: string
  }
}
```

### Agent Status

```typescript
{
  type: 'agent_status',
  data: {
    status: 'listening' | 'thinking' | 'speaking',
    message?: string
  }
}
```

### Todo List Updates

```typescript
{
  type: 'todo_list',
  data: {
    items: Array<{
      id: string,
      description: string,
      status: 'pending' | 'in_progress' | 'completed'
    }>
  }
}
```

## Tool Integration

Agents can call custom tools during conversations:

```python
from typing import Any, Dict

from stella_agent_sdk import BaseTool, ToolResult


class SearchKnowledgeBase(BaseTool):
    @property
    def name(self) -> str:
        return "search_knowledge_base"

    @property
    def description(self) -> str:
        return "Search the knowledge base for relevant information"

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}

    async def execute(self, query: str) -> ToolResult:
        results: list[str] = []  # search logic here
        return ToolResult(success=True, data=results)
```

## Resource Requirements

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 250m | 1000m |
| Memory | 512Mi | 2Gi |

## Best Practices

1. **System Prompts**: Write clear, specific system prompts that define the agent's personality and constraints

2. **Error Handling**: Implement retry logic for external API calls (OpenAI, TTS providers)

3. **Monitoring**: Use the logging and metrics exposed by the agent for debugging

4. **Resource Limits**: Monitor memory usage, especially with long conversations

5. **Graceful Shutdown**: Handle SIGTERM signals properly to clean up connections

## Troubleshooting

### Agent Not Responding

1. Check STT service is receiving audio:
   ```bash
   kubectl logs <agent-pod> -n ai-agents | grep "audio"
   ```

2. Verify OpenAI API key is valid:
   ```bash
   kubectl logs <agent-pod> -n ai-agents | grep "openai"
   ```

### Poor Audio Quality

1. Check TTS service logs for errors
2. Verify network latency to TTS provider
3. Consider using a local TTS service for lower latency

### High Latency

1. Use streaming responses for faster first-token time
2. Consider `stella-light-agent` for simpler use cases
3. Check resource allocation - may need more CPU

## See Also

- [Expert Pool System](./expert-pool-overview.md) - Safe handling of sensitive queries
- [Agent SDK Overview](../../agent-sdk/overview.md)
- [Building Custom Agents](../../agent-sdk/building-custom-agent.md)
- [Audio Pipeline](../../agent-sdk/audio-pipeline.md)
