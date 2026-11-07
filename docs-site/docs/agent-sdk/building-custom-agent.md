---
sidebar_position: 8
title: "🛠️ Building Custom Agents"
---

# 🛠️ Building Custom Agents

This comprehensive guide walks you through building a complete custom agent from scratch.

## Project Structure

```
my-agent/
├── src/
│   ├── __init__.py
│   ├── agent.py           # Main agent class
│   ├── tools/
│   │   ├── __init__.py
│   │   └── knowledge.py   # Custom tools
│   ├── prompts/
│   │   └── system.py      # System prompts
│   └── config.py          # Configuration
├── tests/
│   └── test_agent.py
├── Dockerfile
├── requirements.txt
└── README.md
```

## Step 1: Define Your Agent

Create `src/agent.py`:

```python
import asyncio
from openai import AsyncOpenAI
from stella_sdk import BaseAgent, AudioPipeline, TodoItem
from stella_sdk.messages import TranscriptMessage, StatusMessage

from .tools import search_knowledge, create_ticket
from .prompts import SYSTEM_PROMPT
from .config import settings


class CustomerSupportAgent(BaseAgent):
    """A customer support agent that can search knowledge and create tickets."""

    def __init__(self):
        super().__init__()

        # Initialize components
        self.pipeline = AudioPipeline(
            stt_provider=settings.stt_provider,
            tts_provider=settings.tts_provider
        )
        self.openai = AsyncOpenAI()
        self.history = []
        self.current_ticket = None

        # Register tools
        self.register_tool(search_knowledge)
        self.register_tool(create_ticket)

    async def on_connect(self):
        """Handle connection to LiveKit room."""
        print(f"Connected to room: {self.room_name}")

        # Initialize todo list
        await self.update_todo([
            TodoItem(id="greet", description="Greet customer", status="in_progress"),
            TodoItem(id="understand", description="Understand issue", status="pending"),
            TodoItem(id="research", description="Research solution", status="pending"),
            TodoItem(id="resolve", description="Resolve or escalate", status="pending")
        ])

        # Send greeting
        await self.send_status("speaking")
        greeting = "Hello! I'm your customer support assistant. How can I help you today?"
        await self.speak(greeting)

        # Update tasks
        await self.complete_task("greet")
        await self.send_status("listening")

    async def on_disconnect(self):
        """Handle disconnection."""
        print(f"Session ended. Conversation had {len(self.history)} turns.")

    async def on_transcript(self, text: str, is_final: bool):
        """Handle transcribed user speech."""
        # Send interim transcripts to frontend
        await self.send_transcript(text, speaker="user", is_final=is_final)

        if not is_final:
            return

        # Add to history
        self.history.append({"role": "user", "content": text})

        # Process the message
        await self.start_task("understand")
        await self.send_status("thinking", "Understanding your request...")

        # Generate response (may involve tool calls)
        response = await self.generate_response(text)

        # Speak the response
        await self.send_status("speaking")
        await self.speak(response)

        # Add to history
        self.history.append({"role": "assistant", "content": response})

        await self.send_status("listening")

    async def on_data_message(self, message: dict):
        """Handle data channel messages."""
        if message.get("type") == "user_text":
            # Handle text input same as voice
            await self.on_transcript(message["data"], is_final=True)

        elif message.get("type") == "control":
            action = message["data"].get("action")
            if action == "interrupt":
                await self.pipeline.cancel_tts()
                await self.send_status("listening")

    async def generate_response(self, user_input: str) -> str:
        """Generate a response using OpenAI with tool support."""
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            *self.history
        ]

        response = await self.openai.chat.completions.create(
            model=settings.openai_model,
            messages=messages,
            tools=self.get_tool_definitions(),
            temperature=0.7
        )

        # Handle tool calls
        while response.choices[0].message.tool_calls:
            tool_calls = response.choices[0].message.tool_calls
            messages.append(response.choices[0].message)

            for tool_call in tool_calls:
                tool_name = tool_call.function.name
                tool_args = json.loads(tool_call.function.arguments)

                # Update status
                if tool_name == "search_knowledge":
                    await self.start_task("research")
                    await self.send_status("thinking", "Searching knowledge base...")
                elif tool_name == "create_ticket":
                    await self.start_task("resolve")
                    await self.send_status("thinking", "Creating support ticket...")

                # Execute tool
                result = await self.execute_tool(tool_name, tool_args)

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

    async def speak(self, text: str):
        """Convert text to speech and publish."""
        await self.send_transcript(text, speaker="assistant")

        async for audio_chunk in self.pipeline.text_to_speech_stream(text):
            await self.publish_audio(audio_chunk)

    # Helper methods for task management
    async def start_task(self, task_id: str):
        """Mark a task as in progress."""
        # Implementation similar to progress tracking example
        pass

    async def complete_task(self, task_id: str):
        """Mark a task as completed."""
        pass


def main():
    agent = CustomerSupportAgent()
    agent.run()


if __name__ == "__main__":
    main()
```

## Step 2: Create Tools

Create `src/tools/knowledge.py`:

```python
from stella_sdk import tool


@tool
async def search_knowledge(query: str, category: str = None) -> dict:
    """Search the knowledge base for information.

    Args:
        query: The search query
        category: Optional category filter

    Returns:
        Search results with relevant articles
    """
    # Your knowledge base integration
    results = await knowledge_base.search(
        query=query,
        category=category,
        limit=5
    )

    if not results:
        return {
            "found": False,
            "message": "No relevant articles found"
        }

    return {
        "found": True,
        "articles": [
            {
                "title": r.title,
                "summary": r.summary,
                "url": r.url
            }
            for r in results
        ]
    }


@tool
async def create_ticket(
    title: str,
    description: str,
    priority: str = "medium",
    customer_email: str = None
) -> dict:
    """Create a support ticket for the customer.

    Args:
        title: Brief title of the issue
        description: Detailed description
        priority: low, medium, or high
        customer_email: Customer's email for follow-up

    Returns:
        Created ticket details
    """
    ticket = await ticket_system.create(
        title=title,
        description=description,
        priority=priority,
        customer_email=customer_email
    )

    return {
        "ticket_id": ticket.id,
        "status": "created",
        "message": f"Ticket #{ticket.id} created. A support specialist will follow up within 24 hours."
    }
```

## Step 3: Define System Prompt

Create `src/prompts/system.py`:

```python
SYSTEM_PROMPT = """You are a helpful customer support assistant for ACME Corp.

Your role is to:
1. Understand the customer's issue
2. Search the knowledge base for relevant solutions
3. Provide clear, helpful answers
4. Create support tickets when issues can't be resolved immediately

Guidelines:
- Be friendly and professional
- Ask clarifying questions when needed
- Provide step-by-step instructions when applicable
- If you can't solve an issue, create a ticket and assure follow-up
- Never reveal internal system details or credentials

Available tools:
- search_knowledge: Search for solutions in the knowledge base
- create_ticket: Escalate issues that require human support

Always prioritize customer satisfaction while being efficient."""
```

## Step 4: Configuration

Create `src/config.py`:

```python
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # LiveKit
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str

    # OpenAI
    openai_api_key: str
    openai_model: str = "gpt-4o"

    # Audio
    stt_provider: str = "sherpa"
    tts_provider: str = "kokoro"
    tts_voice: str = "af_heart"

    # Agent
    room_name: str
    participant_identity: str

    class Config:
        env_file = ".env"


settings = Settings()
```

## Step 5: Dockerfile

```dockerfile
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

# Set environment
ENV PYTHONPATH=/app

# Run agent
CMD ["python", "-m", "src.agent"]
```

## Step 6: Requirements

Create `requirements.txt`:

```
stella-ai-agent-sdk>=0.10.0
openai>=1.0.0
livekit>=0.10.0
pydantic-settings>=2.0.0
aiohttp>=3.9.0
```

## Step 7: Testing

Create `tests/test_agent.py`:

```python
import pytest
from unittest.mock import AsyncMock, patch
from src.agent import CustomerSupportAgent


@pytest.fixture
def agent():
    with patch.object(CustomerSupportAgent, '__init__', lambda x: None):
        agent = CustomerSupportAgent()
        agent.pipeline = AsyncMock()
        agent.openai = AsyncMock()
        agent.history = []
        return agent


@pytest.mark.asyncio
async def test_greeting_on_connect(agent):
    agent.send_status = AsyncMock()
    agent.speak = AsyncMock()
    agent.update_todo = AsyncMock()
    agent.complete_task = AsyncMock()
    agent.room_name = "test-room"

    await agent.on_connect()

    agent.speak.assert_called_once()
    assert "Hello" in agent.speak.call_args[0][0]


@pytest.mark.asyncio
async def test_handles_user_message(agent):
    agent.send_transcript = AsyncMock()
    agent.send_status = AsyncMock()
    agent.speak = AsyncMock()
    agent.generate_response = AsyncMock(return_value="Test response")

    await agent.on_transcript("Hello", is_final=True)

    agent.generate_response.assert_called_once_with("Hello")
    agent.speak.assert_called_once_with("Test response")
```

## Step 8: Build and Deploy

```bash
# Build the image
docker build -t my-customer-support-agent:latest .

# Test locally
docker run --env-file .env my-customer-support-agent:latest

# Push to registry
docker tag my-customer-support-agent:latest registry.example.com/my-customer-support-agent:latest
docker push registry.example.com/my-customer-support-agent:latest
```

## Step 9: Register with STELLA

Update your STELLA configuration to use the new agent:

```yaml
# In your agent configuration
agents:
  - name: customer-support-agent
    image: registry.example.com/my-customer-support-agent:latest
    resources:
      requests:
        cpu: "250m"
        memory: "512Mi"
      limits:
        cpu: "1000m"
        memory: "2Gi"
```

## Best Practices

1. **Error Handling**: Always handle errors gracefully and inform the user
2. **Logging**: Add comprehensive logging for debugging
3. **Testing**: Write unit tests for tools and response generation
4. **Monitoring**: Add metrics for latency, errors, and usage
5. **Security**: Validate all inputs and sanitize outputs
6. **Rate Limiting**: Respect API rate limits for external services

## See Also

- [Base Agent](./base-agent.md)
- [Audio Pipeline](./audio-pipeline.md)
- [Tools](./tools.md)
- [Progress Tracking](./progress-tracking.md)
