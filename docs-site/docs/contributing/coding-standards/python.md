---
sidebar_position: 3
title: Python
description: Python coding standards for STELLA agents
---

# Python (Agents)

Standards for Python agent implementations.

## Style Guide

We follow [PEP 8](https://pep8.org/) with [Black](https://black.readthedocs.io/) formatting.

## Formatting

```bash
# Format code
black src/

# Check formatting
black --check src/
```

## Linting

```bash
# Run linter
pylint src/

# Type checking
mypy src/
```

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Classes | PascalCase | `BaseAgent` |
| Functions | snake_case | `on_transcript` |
| Variables | snake_case | `session_id` |
| Constants | UPPER_SNAKE | `MAX_RETRIES` |
| Private | _leading | `_internal_state` |
| Files | snake_case | `audio_pipeline.py` |

## Code Examples

### Agent

```python
"""Customer support agent implementation."""

from typing import Optional

from openai import AsyncOpenAI
from stella_sdk import BaseAgent, AudioPipeline, tool

from .config import settings


class CustomerSupportAgent(BaseAgent):
    """Agent for handling customer support conversations."""

    def __init__(self) -> None:
        super().__init__()
        self.pipeline = AudioPipeline(
            stt_provider=settings.stt_provider,
            tts_provider=settings.tts_provider,
        )
        self.openai = AsyncOpenAI()
        self.history: list[dict] = []

    async def on_connect(self) -> None:
        """Handle connection to the LiveKit room."""
        greeting = "Hello! How can I help you today?"
        await self.speak(greeting)

    async def on_transcript(self, text: str, is_final: bool) -> None:
        """Process transcribed speech.

        Args:
            text: The transcribed text
            is_final: Whether this is a final transcription
        """
        if not is_final:
            return

        self.history.append({"role": "user", "content": text})
        response = await self._generate_response(text)
        await self.speak(response)

    async def _generate_response(self, user_input: str) -> str:
        """Generate a response using the LLM."""
        result = await self.openai.chat.completions.create(
            model=settings.openai_model,
            messages=self.history,
        )
        return result.choices[0].message.content
```

### Tool

```python
"""Search tools for the agent."""

from typing import Optional

from stella_sdk import tool

from .database import db


@tool
async def search_knowledge(
    query: str,
    category: Optional[str] = None,
    limit: int = 5,
) -> dict:
    """Search the knowledge base for relevant articles.

    Args:
        query: The search query
        category: Optional category filter
        limit: Maximum number of results

    Returns:
        dict: Search results with articles
    """
    results = await db.search(query, category=category, limit=limit)

    return {
        "found": len(results) > 0,
        "articles": [
            {"title": r.title, "summary": r.summary}
            for r in results
        ],
    }
```

## File Organization

```
agents/stella-v2-agent/
├── src/
│   └── stella_agent/
│       ├── __init__.py
│       ├── agent.py
│       ├── config.py
│       ├── pipeline/
│       │   ├── __init__.py
│       │   ├── audio.py
│       │   └── stt.py
│       ├── tools/
│       │   ├── __init__.py
│       │   └── search.py
│       └── models/
│           ├── __init__.py
│           └── session.py
├── tests/
│   ├── test_agent.py
│   └── test_tools.py
├── pyproject.toml
└── README.md
```

## Best Practices

- Use type hints for all function parameters and returns
- Write docstrings for all public functions and classes
- Use `async/await` for all I/O operations
- Keep functions focused and under 20 lines when possible
- Use dataclasses or Pydantic models for structured data
