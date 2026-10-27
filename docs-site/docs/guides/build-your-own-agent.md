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

<Steps>

<Step number={1} title="Create the project structure">

Set up your agent project with the following structure:

```text title=""
my-agent/
├── src/
│   ├── __init__.py
│   ├── agent.py           # Main agent class
│   ├── tools.py           # Custom tools
│   └── config.py          # Configuration
├── Dockerfile
├── requirements.txt
└── .env
```

```bash title="terminal"
mkdir -p my-agent/src
cd my-agent
touch src/__init__.py src/agent.py src/tools.py src/config.py
touch Dockerfile requirements.txt .env
```

</Step>

<Step number={2} title="Define your dependencies">

Create your `requirements.txt` with the necessary packages:

```txt title="requirements.txt"
stella-agent-sdk>=1.0.0
openai>=1.0.0
livekit>=0.10.0
pydantic-settings>=2.0.0
```

</Step>

<Step number={3} title="Configure the agent">

Create your configuration in `src/config.py`:

```python title="src/config.py"
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # LiveKit connection
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str

    # OpenAI
    openai_api_key: str
    openai_model: str = "gpt-4o"

    # Audio pipeline
    stt_provider: str = "sherpa"
    tts_provider: str = "kokoro"

    # Session
    room_name: str
    participant_identity: str = "agent"

    class Config:
        env_file = ".env"


settings = Settings()
```

</Step>

<Step number={4} title="Implement the agent" isLast>

Create your main agent class in `src/agent.py`:

```python title="src/agent.py"
from openai import AsyncOpenAI
from stella_sdk import BaseAgent, AudioPipeline

from .config import settings


class MyCustomAgent(BaseAgent):
    """A custom conversational AI agent."""

    def __init__(self):
        super().__init__()
        self.pipeline = AudioPipeline(
            stt_provider=settings.stt_provider,
            tts_provider=settings.tts_provider
        )
        self.openai = AsyncOpenAI()
        self.history = []

    async def on_connect(self):
        """Called when the agent connects to the LiveKit room."""
        print(f"Connected to room: {self.room_name}")

        # Send a greeting
        greeting = "Hello! How can I help you today?"
        await self.speak(greeting)

    async def on_transcript(self, text: str, is_final: bool):
        """Handle transcribed user speech."""
        if not is_final:
            return

        # Add to history
        self.history.append({"role": "user", "content": text})

        # Generate response
        response = await self.generate_response(text)

        # Speak the response
        await self.speak(response)

        # Add to history
        self.history.append({"role": "assistant", "content": response})

    async def generate_response(self, user_input: str) -> str:
        """Generate a response using OpenAI."""
        response = await self.openai.chat.completions.create(
            model=settings.openai_model,
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                *self.history
            ]
        )
        return response.choices[0].message.content

    async def speak(self, text: str):
        """Convert text to speech and publish to the room."""
        async for audio_chunk in self.pipeline.text_to_speech_stream(text):
            await self.publish_audio(audio_chunk)


def main():
    agent = MyCustomAgent()
    agent.run()


if __name__ == "__main__":
    main()
```

</Step>

</Steps>

## Adding Custom Tools

Tools allow your agent to perform actions beyond conversation. Here's how to add a search tool:

```python title="src/tools.py"
from stella_sdk import tool


@tool
async def search_database(query: str, limit: int = 5) -> dict:
    """Search the database for relevant information.

    Args:
        query: The search query
        limit: Maximum number of results

    Returns:
        Search results
    """
    # Your database search logic here
    results = await db.search(query, limit=limit)

    return {
        "found": len(results) > 0,
        "results": [
            {"title": r.title, "content": r.content}
            for r in results
        ]
    }


@tool
async def create_task(title: str, description: str) -> dict:
    """Create a new task in the task management system.

    Args:
        title: Task title
        description: Task description

    Returns:
        Created task details
    """
    task = await task_service.create(title=title, description=description)

    return {
        "task_id": task.id,
        "status": "created",
        "message": f"Task '{title}' created successfully"
    }
```

Register tools in your agent:

```python title="src/agent.py"
from .tools import search_database, create_task


class MyCustomAgent(BaseAgent):
    def __init__(self):
        super().__init__()
        # ... other initialization

        # Register tools
        self.register_tool(search_database)
        self.register_tool(create_task)
```

## Handling Tool Calls

When the LLM wants to use a tool, handle it in your response generation:

```python title=""
async def generate_response(self, user_input: str) -> str:
    messages = [
        {"role": "system", "content": self.system_prompt},
        *self.history
    ]

    response = await self.openai.chat.completions.create(
        model=settings.openai_model,
        messages=messages,
        tools=self.get_tool_definitions()
    )

    # Handle tool calls
    while response.choices[0].message.tool_calls:
        tool_calls = response.choices[0].message.tool_calls
        messages.append(response.choices[0].message)

        for tool_call in tool_calls:
            # Execute the tool
            result = await self.execute_tool(
                tool_call.function.name,
                json.loads(tool_call.function.arguments)
            )

            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": json.dumps(result)
            })

        # Get next response
        response = await self.openai.chat.completions.create(
            model=settings.openai_model,
            messages=messages,
            tools=self.get_tool_definitions()
        )

    return response.choices[0].message.content
```

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

        # Use in your prompt
        response = await self.llm.chat([
            {"role": "system", "content": f"Previous conversation:\n{context}"},
            {"role": "user", "content": input.text}
        ])

        yield AgentOutput.text_final(input.session_id, response)
```

### Method Reference

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
FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY src/ ./src/

ENV PYTHONPATH=/app

CMD ["python", "-m", "src.agent"]
```

### Build and Push

```bash title="terminal"
# Build the image
docker build -t my-custom-agent:latest .

# Test locally
docker run --env-file .env my-custom-agent:latest

# Push to registry
docker tag my-custom-agent:latest registry.example.com/my-custom-agent:latest
docker push registry.example.com/my-custom-agent:latest
```

### Register with STELLA

Add your agent to the STELLA configuration so it can be deployed:

```yaml title="agents-config.yaml"
agents:
  - name: my-custom-agent
    image: registry.example.com/my-custom-agent:latest
    resources:
      requests:
        cpu: "250m"
        memory: "512Mi"
      limits:
        cpu: "1000m"
        memory: "2Gi"
```

### Run Deployment Tests

Before deploying an agent, validate the same surfaces STELLA depends on at build and runtime:

- `agent.yaml` should parse cleanly and satisfy the canonical manifest schema
- the package should include a `Dockerfile` or point to a published image
- Python dependencies should include `stella-ai-agent-sdk`
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
- [Base Agent Reference](../sdk/base-agent.md) - Full API documentation
- [Tools Reference](../sdk/tools.md) - Advanced tool patterns
