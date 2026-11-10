---
sidebar_position: 2
title: Build Your Own Agent
description: Build a custom conversational AI agent with the STELLA SDK
---

import {Steps, Step} from '@site/src/components/StepGuide';

# Build Your Own Agent

The Agent SDK lets you focus purely on your agent's logic. STELLA handles the infrastructure—audio pipeline, WebRTC streaming, session lifecycle, and deployment orchestration—so you can concentrate on what makes your agent unique.

**What STELLA handles:**
- Audio pipeline (STT and TTS)
- WebRTC streaming via LiveKit
- Session creation, state management, and cleanup
- Deployment and scaling
- Message recording and transcript storage

**What you implement:**
- Conversation logic and prompts
- Tool calls and integrations
- Business rules and workflows

By the end of this guide, you'll have a working agent that can handle voice conversations, use custom tools, and integrate with your own services.

## Overview

STELLA agents are Python applications that:
- Connect to LiveKit rooms for real-time audio
- Process speech-to-text (STT) and text-to-speech (TTS)
- Use LLMs to generate intelligent responses
- Execute custom tools to interact with external systems

## Project Setup

An agent is a small Python package with an `agent.yaml` next to it. The SDK owns the room connection, speech recognition, speech synthesis and the session lifecycle; your code receives what the user said and yields what the agent replies.

<Steps>

<Step number={1} title="Create the project structure">

```text title=""
my-agent/
├── agent.yaml          # what STELLA knows about the agent
├── Dockerfile          # STELLA builds the image from it
├── requirements.txt
└── my_agent/
    ├── __init__.py
    ├── __main__.py     # entry point: python -m my_agent
    ├── agent.py        # the agent class
    └── tools.py        # tools the LLM may call
```

</Step>

<Step number={2} title="Define your dependencies">

```txt title="requirements.txt"
stella-ai-agent-sdk>=0.10.0
openai>=1.0.0
```

The SDK brings LiveKit and the gRPC clients for STT and TTS with it. STELLA refuses to deploy an agent built with an SDK older than 0.10.0.

</Step>

<Step number={3} title="Describe the agent in agent.yaml">

```yaml title="agent.yaml"
version: "2.0"

metadata:
  name: "My Agent"
  slug: "my-agent"
  version: "0.1.0"
  description: "A helpful voice assistant"

capabilities: [voice, text]

env:
  required:
    - OPENAI_API_KEY

image:
  dockerfile: "Dockerfile"
```

Everything a deployer chooses is an env var declared here; there is no separate settings file. The full format is in [Agent manifest](../agent-sdk/agent-manifest.md).

</Step>

<Step number={4} title="Implement the agent" isLast>

`BaseAgent` has two abstract methods: `process()`, called once per user turn, and `on_interrupt()`. Whatever `process()` yields is shown and spoken. `on_interrupt()` must exist, but SDK 0.10.0's default loop never calls it: when the user speaks over the agent, the SDK drops what was not yet spoken itself (see [Barge-in](../agent-sdk/base-agent.md#barge-in)).

```python title="my_agent/agent.py"
import os
from typing import Any, AsyncIterator, Dict

from openai import AsyncOpenAI
from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent


class MyCustomAgent(BaseAgent):
    """A custom conversational agent."""

    def __init__(self) -> None:
        super().__init__()
        self.openai = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"])
        self.history: list[dict[str, str]] = []

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        await super().on_session_start(session_id, config)  # fills self.session and self.persona
        self.history = []

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        self.history.append({"role": "user", "content": input.text})
        response = await self.openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "system", "content": "You are a helpful assistant."}, *self.history],
        )
        reply = response.choices[0].message.content or ""
        self.history.append({"role": "assistant", "content": reply})
        yield AgentOutput.text_final(input.session_id, reply)

    async def on_interrupt(self, session_id: str) -> None:
        # Not called by SDK 0.10.0's default loop; required all the same.
        pass
```

```python title="my_agent/__main__.py"
import asyncio

from stella_agent_sdk import run_agent_from_env

from my_agent.agent import MyCustomAgent

if __name__ == "__main__":
    asyncio.run(run_agent_from_env(MyCustomAgent()))
```

`run_agent_from_env()` reads the room, the LiveKit credentials and the STT and TTS addresses from the environment, which STELLA sets on the pod. To stream a reply, yield `AgentOutput.text_chunk(...)` as it grows instead of one `text_final`. Each chunk carries the whole text so far, not only the new token: the SDK speaks the part that extends the previous chunk. [Getting started](../agent-sdk/getting-started.md) shows it.

</Step>

</Steps>

## Adding Custom Tools

A tool is a `BaseTool` subclass: a name, a description and a JSON Schema for the LLM, and an `execute()` that returns a `ToolResult`.

```python title="my_agent/tools.py"
from typing import Any, Dict

from stella_agent_sdk import BaseTool, ToolResult


class SearchDatabase(BaseTool):
    @property
    def name(self) -> str:
        return "search_database"

    @property
    def description(self) -> str:
        return "Search the database for information relevant to the user's question."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to search for"},
                "limit": {"type": "integer", "description": "Maximum results"},
            },
            "required": ["query"],
        }

    async def execute(self, query: str, limit: int = 5) -> ToolResult:
        results: list[dict] = []  # your search here
        return ToolResult(success=True, data={"found": bool(results), "results": results[:limit]})
```

Collect the tools in a `ToolRegistry`, which also gives you their schemas for the LLM:

```python title="my_agent/agent.py"
from stella_agent_sdk import BaseAgent, ToolExecutor, ToolRegistry

from my_agent.tools import SearchDatabase


class MyCustomAgent(BaseAgent):
    def __init__(self) -> None:
        super().__init__()
        self.tools = ToolRegistry()
        self.tools.register(SearchDatabase())
        self.executor = ToolExecutor(self.tools)
```

## Handling Tool Calls

Pass `self.tools.get_openai_schemas()` to the model. When it asks for tools, the executor runs them and builds the result messages to send back:

```python title=""
async def generate_response(self) -> str:
    messages = [{"role": "system", "content": "You are a helpful assistant."}, *self.history]
    while True:
        response = await self.openai.chat.completions.create(
            model="gpt-4o-mini", messages=messages, tools=self.tools.get_openai_schemas()
        )
        message = response.choices[0].message
        calls = self.executor.parse_openai_tool_calls(message)
        if not calls:
            return message.content or ""
        messages.append(message.model_dump(exclude_none=True))
        for call in calls:
            event = await self.executor.execute_single(call)
            messages.append(self.executor.build_tool_result_message_openai(call.id, event.result))
```

Outside MCP servers (an interview-question service, say) are not tools you write: they are [connectors](../agent-sdk/connectors.md) the agent declares in `agent.yaml` and reaches through `self.connectors`.

## Accessing Chat History

STELLA automatically records all messages exchanged during a session—you don't need to implement any recording logic. Your agent can retrieve this conversation history using the built-in `get_chat_history()` method.

**No setup required:** The platform handles message recording, storage, and retrieval. Your agent just calls the method.

This is useful for:
- Building context for LLM prompts
- Resuming conversations after agent restart
- Analyzing conversation patterns

### Basic Usage

```python
class MyAgent(BaseAgent):
    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        # Get recent conversation history
        history = await self.get_chat_history(limit=20)

        # Build context for LLM
        context = "\n".join([
            f"{msg.role}: {msg.content}"
            for msg in history
        ])

        # Use it in your prompt
        response = await self.openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": f"Previous conversation:\n{context}"},
                {"role": "user", "content": input.text},
            ],
        )

        yield AgentOutput.text_final(input.session_id, response.choices[0].message.content or "")
```

### Method Reference

<!-- pseudo-code -->
```python
await self.get_chat_history(
    include_debug: bool = False,  # Include debug/processing messages
    limit: int = 100,             # Max messages (up to 500)
    before: Optional[str] = None, # ISO timestamp: only messages before it (SDK 0.9.0+)
) -> List[ChatMessage]
```

### ChatMessage Structure

Each message includes:
- `id` - Unique message identifier
- `timestamp` - ISO 8601 timestamp
- `role` - Sender role ('user', 'assistant', 'system')
- `content` - Extracted text content
- `message_type` - Type ('user_text', 'transcript', 'agent_text')
- `envelope` - Full original message envelope

### Checking Availability

```python
if self.has_history:
    history = await self.get_chat_history()
```

## Building and Deploying

### Dockerfile

```dockerfile title="Dockerfile"
FROM python:3.12-slim

WORKDIR /app

# livekit-rtc needs libgobject from libglib2.0
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY my_agent/ ./my_agent/

CMD ["python", "-m", "my_agent"]
```

### Build and test locally

```bash title="terminal"
# Build the image
docker build -t my-custom-agent:latest .

# Run it against a local LiveKit (it needs LIVEKIT_URL, ROOM_NAME, AGENT_IDENTITY,
# LIVEKIT_API_KEY, LIVEKIT_API_SECRET and OPENAI_API_KEY in .env)
docker run --env-file .env my-custom-agent:latest
```

### Upload it to STELLA

STELLA builds your agent itself, from the package's own `Dockerfile`; you don't push an image anywhere.

1. Zip the package: `agent.yaml`, the `Dockerfile` and your code.
2. Upload it in **Settings → Agent Library**. STELLA validates `agent.yaml`, builds the image and reads the SDK version installed in it.
3. If **Review uploaded agents** is on (the default), a system admin approves it in **Settings → Agent Review**; until then nobody can deploy it, you included. Then share it with the projects that should use it.

Resources (CPU and memory requests and limits) come from the `resources` block of `agent.yaml`. See [Agent validation](../deployment/agent-validation.md) for review, sharing, new versions and deleting.

### Run Deployment Tests

Before deploying an agent, validate the same surfaces STELLA depends on at build and runtime:

- `agent.yaml` should parse cleanly and satisfy the canonical manifest schema
- the package should include a `Dockerfile`; STELLA builds every upload from it, and a package that points at a prebuilt image (`image.imageUrl`) is refused
- Python dependencies should include `stella-ai-agent-sdk` 0.10.0 or later (`stella-ai-agent-sdk>=0.10.0`); STELLA refuses to deploy an agent built with an older SDK
- the agent should start successfully with representative config

For built-in agents in this repository, these checks are enforced automatically in GitHub Actions:

- `npm run validate:agents` validates built-in manifests, Dockerfile presence, slug consistency, and SDK compatibility
- Python startup smoke tests install the SDK and agents, then verify they initialize with sample config

For custom agents, validation happens individually per package. When a custom agent is uploaded or built, STELLA validates that package's manifest, Dockerfile, and SDK dependency before deployment.

If you are developing your agent in this repository, run the built-in validation checks locally before opening a PR:

```bash title="terminal"
npm run validate:agents
```

## Best Practices

1. **Error Handling**: Always wrap external API calls in try/catch blocks
2. **Logging**: Add comprehensive logging for debugging production issues
3. **Timeouts**: Set appropriate timeouts for tool executions
4. **Rate Limiting**: Respect API rate limits for external services
5. **Testing**: Write unit tests for tools and response generation

## Next Steps

- [Add Custom UI](./add-custom-ui.md) - Customize the frontend
- [Base Agent Reference](../agent-sdk/base-agent.md) - Full API documentation
- [Tools Reference](../agent-sdk/tools.md) - Advanced tool patterns
