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
| Functions | snake_case | `on_session_start` |
| Variables | snake_case | `session_id` |
| Constants | UPPER_SNAKE | `MAX_RETRIES` |
| Private | _leading | `_internal_state` |
| Files | snake_case | `audio_pipeline.py` |

## Code Examples

These follow the SDK as it is (`stella_agent_sdk`); the example agent in the SDK, `agents/stella-ai-agent-sdk/examples/openai_agent.py`, is the full version.

### Agent

```python
"""Customer support agent."""

from typing import Any, AsyncIterator, Dict

from openai import AsyncOpenAI
from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent


class CustomerSupportAgent(BaseAgent):
    """Answers customer questions, one LLM call per turn."""

    def __init__(self) -> None:
        super().__init__()
        self.openai = AsyncOpenAI()
        self.history: list[dict[str, str]] = []

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        """Start each session with an empty history."""
        self.history = []

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        """Reply to one user turn; the SDK speaks what is yielded."""
        self.history.append({"role": "user", "content": input.text})
        result = await self.openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=self.history,
        )
        reply = result.choices[0].message.content or ""
        self.history.append({"role": "assistant", "content": reply})
        yield AgentOutput.text_final(input.session_id, reply)

    async def on_interrupt(self, session_id: str) -> None:
        """The user spoke over the agent; nothing is in flight to cancel here."""
```

### Tool

```python
"""Search tool for the agent."""

from typing import Any, Dict, Optional

from stella_agent_sdk import BaseTool, ToolResult


class SearchKnowledge(BaseTool):
    """Search the knowledge base for relevant articles."""

    def __init__(self, db: Any) -> None:
        self.db = db

    @property
    def name(self) -> str:
        return "search_knowledge"

    @property
    def description(self) -> str:
        return "Search the knowledge base for articles about the user's question."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to search for"},
                "limit": {"type": "integer", "description": "Maximum results", "default": 5},
            },
            "required": ["query"],
        }

    async def execute(self, query: str, limit: int = 5, category: Optional[str] = None) -> ToolResult:
        results = await self.db.search(query, category=category, limit=limit)
        return ToolResult(
            success=True,
            data={"articles": [{"title": r.title, "summary": r.summary} for r in results]},
        )
```

## File Organization

An agent is a package with its `agent.yaml` next to it, as STELLA V2 is laid out:

```
agents/stella-v2-agent/
├── agent.yaml
├── Dockerfile
├── pyproject.toml
├── config/
├── src/
│   └── stella_v2_agent/
│       ├── __init__.py
│       ├── __main__.py
│       ├── agent.py
│       ├── pipeline/
│       └── experts/
└── tests/
```

## Best Practices

- Use type hints for all function parameters and returns
- Write docstrings for all public functions and classes
- Use `async/await` for all I/O operations
- Keep functions focused and under 20 lines when possible
- Use dataclasses or Pydantic models for structured data
