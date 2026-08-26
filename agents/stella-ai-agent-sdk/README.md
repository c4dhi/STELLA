# STELLA Agent SDK

A communication SDK for building agents that integrate with the STELLA platform.

## Overview

The SDK defines the communication protocol - agents implement whatever logic they want internally. It provides:

- **Message types** (`AgentInput`, `AgentOutput`) - Standardized formats for agent communication
- **`BaseAgent`** - Abstract class that agents implement
- **gRPC client** - Handles connection to session-management server

**What the SDK does NOT include:** LLM services, RAG, expert pools, or any processing logic. Those are your agent's implementation details.

## Installation

```bash
pip install stella-ai-agent-sdk
```

Or install from source:

```bash
cd stella-ai-agent-sdk
pip install -e .
```

## Quick Start

```python
import asyncio
from typing import AsyncIterator
from stella_agent_sdk import BaseAgent, AgentInput, AgentOutput, run_agent_from_env

class MyAgent(BaseAgent):
    async def on_session_start(self, session_id: str, config: dict) -> None:
        # Initialize your agent with configuration
        self.model = config.get("model", "gpt-4")

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        # Process user input and yield responses
        yield AgentOutput.thinking(input.session_id)

        # Your LLM/processing logic here
        response = await my_llm_call(input.text)

        yield AgentOutput.text_final(input.session_id, response)

    async def on_interrupt(self, session_id: str) -> None:
        # Handle user interrupt (barge-in)
        self.cancel_current_task()

    async def on_session_end(self, session_id: str) -> dict:
        # Cleanup and return final data
        return {"messages": self.message_count}

# run_agent_from_env() is the ONLY entry point. It reads all connection config
# (LiveKit room, STT/TTS addresses, AGENT_CONFIG, ...) from environment variables
# set by the session-management-server, connects everything, and runs the agent.
if __name__ == "__main__":
    asyncio.run(run_agent_from_env(MyAgent()))
```

## Architecture

```
LiveKit Server (WebRTC audio/video)
        │
        │ Audio tracks
        │
        ▼
    Your Agent (uses SDK)
        │
        ├─ STT Service ← Transcribes user speech
        ├─ TTS Service ← Synthesizes agent responses
        ├─ Receives: AgentInput (text from user)
        └─ Sends: AgentOutput (text responses)
        │
        │ gRPC (SDK protocol)
        │
        ▼
Session-Management-Server (session state, plans, deliverables)
```

The agent is a **black box** from session-management's perspective:
1. Agent joins a LiveKit room and subscribes to user audio
2. STT service transcribes user speech into text
3. Agent processes input (using whatever LLM/logic you want)
4. Agent streams text responses back
5. TTS service synthesizes agent text into audio (unless disabled)

## Message Types

### Input (from server to agent)

| Type | Description |
|------|-------------|
| `TEXT` | Transcribed user speech or typed text |
| `INTERRUPT` | User interrupted (barge-in) |
| `SESSION_START` | Session starting with configuration |
| `SESSION_END` | Session ending |
| `CONFIG` | Runtime configuration update |

### Output (from agent to server)

| Type | Description | TTS? |
|------|-------------|------|
| `TEXT_CHUNK` | Streaming text chunk | Buffered |
| `TEXT_FINAL` | Complete text response | Yes |
| `STATUS` | Processing status update | No |
| `METADATA` | Plan/deliverable update | No |
| `ERROR` | Error message | No |

## Prompt Compiler

The SDK ships a shared, **versioned** prompt compiler that resolves
`{{placeholder}}` tokens in an authored prompt (from the Configurator or a plan)
against live runtime state. Agents call one entry point:

```python
from stella_agent_sdk import prompts

final = prompts.compile(
    "Helping with: {{current_focus}}\n\n{{history_8}}\n\n{{user_message}}",
    version="1.0.0",                 # required — no implicit "latest"
    sm_context=sm_context,
    conversation_history=history,
    user_input=text,
)
```

The `version` is **mandatory** so an SDK upgrade can never silently change how an
agent's prompts compile. Pin the version your agent was tested against
(`PROMPT_COMPILER_VERSION`), and let a deployment override it via
`config["compiler_version"]`.

Add a new version by subclassing `PlaceholderPromptCompiler` (or `PromptCompiler`),
bumping `VERSION`, and calling `register_compiler` — older versions stay registered
so existing prompts keep compiling.

See the full guide — placeholders, versioning, manifest declaration, and adding a
compiler — in **[SDK Reference → Prompt Compiler](../../docs-site/docs/sdk/prompt-compiler.md)**.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `LIVEKIT_URL` | LiveKit server WebSocket URL |
| `ROOM_NAME` | LiveKit room to join |
| `AGENT_IDENTITY` | Agent participant identity |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `STT_SERVICE_ADDRESS` | `stt-service:50051` | STT gRPC service address |
| `TTS_SERVICE_ADDRESS` | `tts-service:50052` | TTS gRPC service address |
| `TTS_ENABLED` | `true` | Set to `false` to disable TTS entirely. The agent will still receive speech input and send text responses, but no audio will be synthesized — effectively turning it into a text chatbot. |
| `STT_WARMUP_ENABLED` | `true` | Warm up STT model before first utterance |
| `SESSION_SERVER_URL` | `http://session-management-server:3000` | Session management HTTP URL |
| `GRPC_SERVER` | `session-management-server:50051` | Session management gRPC address |
| `SESSION_ID` | *(falls back to ROOM_NAME)* | Database session UUID |
| `AGENT_NAME` | `Agent` | Display name for the agent |
| `AGENT_ID` | *(falls back to AGENT_IDENTITY)* | Unique agent identifier |
| `AGENT_ICON` | `🤖` | Display icon for the agent |
| `AGENT_CONFIG` | | JSON string with agent-specific configuration |
| `TRANSCRIPT_DEBOUNCE_MS` | `0` | Aggregate rapid successive finals within this window (ms). Off by default: STT endpointing already guarantees a &gt;1s gap between finals, so any window this size is unreachable. Set it only for an STT provider that can fragment faster than that. |
| `INTERRUPT_MODE` | `none` | Barge-in behavior: `none` (strict gating) or `smart` |

## Examples

See the `examples/` directory:

- `echo_agent.py` - Simplest possible agent (echoes input)
- `openai_agent.py` - Integration with OpenAI GPT models

## Development

```bash
# Install dev dependencies
pip install -e ".[dev]"

# Run tests
pytest

# Generate gRPC stubs
python -m grpc_tools.protoc \
    -I proto \
    --python_out=src/stella_agent_sdk/_grpc/generated \
    --grpc_python_out=src/stella_agent_sdk/_grpc/generated \
    proto/agent.proto
```

## License

MIT
