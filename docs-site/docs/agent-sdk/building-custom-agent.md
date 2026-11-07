---
sidebar_position: 8
title: "🛠️ Building Custom Agents"
---

# 🛠️ Building Custom Agents

This guide builds a complete agent: a customer support assistant that searches a knowledge base, opens tickets, and shows its progress in the task panel. It assumes you've read [Getting Started](./getting-started.md), which covers a minimal agent and running it locally.

The SDK handles the room, speech to text, text to speech, barge-in and the session lifecycle. Your agent implements `process()`: it gets the user's text and yields what to say and show.

## Project structure

```
my-agent/
├── agent.yaml             # the manifest: what STELLA knows about the agent
├── Dockerfile
├── requirements.txt
├── my_agent/
│   ├── __init__.py        # empty
│   ├── agent.py           # the agent class and entry point
│   ├── tools.py           # the LLM's tools
│   └── prompts.py         # the system prompt
└── tests/
    └── test_tools.py
```

## Step 1: Tools

Each tool is a `BaseTool` subclass (see [Tools](./tools.md)). These two talk to a support API whose address comes from the `SUPPORT_API_URL` env var, which the manifest declares in step 4.

```python title="my_agent/tools.py"
import os
from typing import Any, Dict, Optional

import aiohttp

from stella_agent_sdk import BaseTool, ToolResult


class SupportApi:
    """A thin client for your own support backend."""

    def __init__(self, base_url: Optional[str] = None) -> None:
        self.base_url = (base_url or os.environ["SUPPORT_API_URL"]).rstrip("/")

    async def get(self, path: str, **params: Any) -> Any:
        async with aiohttp.ClientSession() as http:
            async with http.get(self.base_url + path, params=params, timeout=10) as resp:
                resp.raise_for_status()
                return await resp.json()

    async def post(self, path: str, body: Dict[str, Any]) -> Any:
        async with aiohttp.ClientSession() as http:
            async with http.post(self.base_url + path, json=body, timeout=10) as resp:
                resp.raise_for_status()
                return await resp.json()


class SearchKnowledgeTool(BaseTool):
    def __init__(self, api: SupportApi) -> None:
        self._api = api

    @property
    def name(self) -> str:
        return "search_knowledge"

    @property
    def description(self) -> str:
        return "Search the help articles for an answer to the customer's problem."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "What to search for"}},
            "required": ["query"],
        }

    async def execute(self, query: str, **_kwargs) -> ToolResult:
        articles = await self._api.get("/articles", q=query, limit=3)
        if not articles:
            return ToolResult(success=False, error="No article matches. Ask for more detail or open a ticket.")
        return ToolResult(
            success=True,
            data={"articles": [{"title": a["title"], "summary": a["summary"]} for a in articles]},
        )


class CreateTicketTool(BaseTool):
    def __init__(self, api: SupportApi) -> None:
        self._api = api

    @property
    def name(self) -> str:
        return "create_ticket"

    @property
    def description(self) -> str:
        return "Open a ticket for a person to follow up, when the articles don't solve the problem."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "description": {"type": "string"},
                "priority": {"type": "string", "enum": ["low", "medium", "high"]},
            },
            "required": ["title", "description"],
        }

    async def execute(self, title: str, description: str, priority: str = "medium", **_kwargs) -> ToolResult:
        ticket = await self._api.post(
            "/tickets", {"title": title, "description": description, "priority": priority}
        )
        return ToolResult(success=True, data={"ticket_id": ticket["id"]})
```

A tool that raises is not a crash: `ToolExecutor` turns the exception into a failed `ToolResult` for the model to see.

## Step 2: The system prompt

```python title="my_agent/prompts.py"
SYSTEM_PROMPT = """You are a friendly customer support assistant for ACME.

Find out what the customer's problem is. Search the help articles with
search_knowledge and explain the answer in short, spoken sentences. If the
articles don't solve it, open a ticket with create_ticket and tell the customer
someone will follow up.

Your replies are spoken aloud: no lists, no markdown, no links."""
```

If the deployment comes with a persona, the agent below uses the persona's system prompt instead.

## Step 3: The agent

The agent keeps its own task list (understand the problem, look it up, resolve it) and sends it to the task panel. For agents that follow a plan through the STELLA state machine, use the state machine's progress instead; see [Progress Tracking](./progress-tracking.md#from-the-state-machine).

```python title="my_agent/agent.py"
import asyncio
import logging
from typing import Any, AsyncIterator, Dict, List

from openai import AsyncOpenAI

from stella_agent_sdk import (
    AgentInput,
    AgentOutput,
    BaseAgent,
    ExecutionMode,
    GroupStatus,
    ItemStatus,
    ProgressGroup,
    ProgressItem,
    ProgressState,
    ToolExecutor,
    ToolRegistry,
    run_agent_from_env,
)

from .prompts import SYSTEM_PROMPT
from .tools import CreateTicketTool, SearchKnowledgeTool, SupportApi

logger = logging.getLogger(__name__)

MODEL = "gpt-4o-mini"
MAX_TOOL_ROUNDS = 4
TASKS = {"understand": "Understand the problem", "research": "Look it up", "resolve": "Resolve or escalate"}
# Which tool, when it succeeds, completes which task.
TOOL_TASKS = {"search_knowledge": "research", "create_ticket": "resolve"}


class SupportAgent(BaseAgent):
    def __init__(self) -> None:
        super().__init__()
        self.client = AsyncOpenAI()            # reads OPENAI_API_KEY
        self.registry = ToolRegistry()
        self.executor = ToolExecutor(self.registry)
        self.history: List[Dict[str, Any]] = []
        self.task_status: Dict[str, ItemStatus] = {}
        self._cancelled = False

    # ── lifecycle ────────────────────────────────────────────────────

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        await super().on_session_start(session_id, config)   # sets self.session and self.persona
        api = SupportApi()
        self.registry.clear()
        self.registry.register_all([SearchKnowledgeTool(api), CreateTicketTool(api)])
        self.history = []
        self.task_status = {task_id: ItemStatus.PENDING for task_id in TASKS}

    async def on_ready(self, session_id: str) -> AsyncIterator[AgentOutput]:
        # Side-channel outputs only: text yielded here is not spoken.
        yield AgentOutput.progress_update(session_id, self._progress(), update_trigger="session_start")

    async def on_interrupt(self, session_id: str) -> None:
        # The user started talking: stop after the current model call.
        self._cancelled = True

    async def on_session_end(self, session_id: str) -> Dict[str, Any]:
        result = await super().on_session_end(session_id)
        result["turns"] = sum(1 for m in self.history if m["role"] == "user")
        return result

    # ── a turn ───────────────────────────────────────────────────────

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        self._cancelled = False
        self.history.append({"role": "user", "content": input.text})
        if self.task_status["understand"] != ItemStatus.COMPLETED:
            self.task_status["understand"] = ItemStatus.COMPLETED
            yield AgentOutput.progress_update(input.session_id, self._progress())

        prompt = (self.persona.system_prompt if self.persona else None) or SYSTEM_PROMPT
        messages: List[Dict[str, Any]] = [{"role": "system", "content": prompt}, *self.history]

        for _ in range(MAX_TOOL_ROUNDS):
            try:
                response = await self.client.chat.completions.create(
                    model=MODEL, messages=messages, tools=self.registry.get_openai_schemas()
                )
            except Exception as e:
                logger.exception("LLM call failed")
                yield AgentOutput.error(input.session_id, f"LLM error: {e}", error_type="llm_error")
                return
            if self._cancelled:
                return

            message = response.choices[0].message
            calls = self.executor.parse_openai_tool_calls(message)
            if not calls:
                reply = message.content or ""
                self.history.append({"role": "assistant", "content": reply})
                yield AgentOutput.text_final(input.session_id, reply)
                return

            yield AgentOutput.thinking(input.session_id, "Looking into it...")
            messages.append(message.model_dump(exclude_none=True))
            for call in calls:
                event = await self.executor.execute_single(call)
                result = event.result
                yield AgentOutput.tool_call(
                    input.session_id, call.name, arguments=call.arguments,
                    success=result.success, data=result.data, error=result.error,
                )
                messages.append(self.executor.build_tool_result_message_openai(call.id, result))
                task_id = TOOL_TASKS.get(call.name)
                if result.success and task_id:
                    self.task_status[task_id] = ItemStatus.COMPLETED
                    yield AgentOutput.progress_update(
                        input.session_id, self._progress(), update_trigger="item_collected"
                    )

        yield AgentOutput.text_final(input.session_id, "Sorry, that took too long. Could you say it again?")

    # ── progress ─────────────────────────────────────────────────────

    def _progress(self) -> ProgressState:
        items = [
            ProgressItem(id=task_id, label=label, status=self.task_status[task_id])
            for task_id, label in TASKS.items()
        ]
        done = all(item.status == ItemStatus.COMPLETED for item in items)
        group = ProgressGroup(
            id="support",
            label="Support request",
            execution_mode=ExecutionMode.FLEXIBLE,
            status=GroupStatus.COMPLETED if done else GroupStatus.IN_PROGRESS,
            is_current=True,
            items=items,
        )
        state = ProgressState(groups=[group], current_group_id="support")
        state.calculate_progress()
        return state


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_agent_from_env(SupportAgent()))
```

What the SDK does with what `process()` yields:

- `text_final` is shown in the chat and spoken. To speak while the model is still writing, stream `text_chunk`s instead; see [Streaming](./streaming.md).
- `progress_update` goes to the task panel, and the last one is sent again to anyone who joins later.
- `thinking` is a status message: shown, never spoken.
- `tool_call` goes to the debug panel, so you can see which tools ran.

The full list is in [Message Types](./message-types.md), and every hook (`on_barge_in`, `on_idle`, `on_client_event`, ...) is in [Base Agent](./base-agent.md).

## Step 4: The manifest

`agent.yaml` is the only thing STELLA reads about your agent. It declares the env vars a deployer must provide, the resources and the SDK version. The fields are explained in [The agent manifest](./agent-manifest.md).

```yaml title="agent.yaml"
# yaml-language-server: $schema=https://stella.c4dhi.org/schemas/agent-manifest.v2.json
version: "2.0"

metadata:
  name: "ACME Support"
  slug: "acme-support"
  version: "0.1.0"
  description: "Answers support questions from the help articles and opens tickets"
  icon: "🛟"
  tags: [support]

capabilities: [voice, text, progress]

env:
  required:
    - OPENAI_API_KEY
    - SUPPORT_API_URL

image:
  dockerfile: "Dockerfile"
  command: [python, -m, my_agent.agent]

resources:
  memory: { request: "256Mi", limit: "512Mi" }
  cpu: { request: "100m", limit: "500m" }

sdk:
  minVersion: "0.10.0"
```

## Step 5: Dependencies and Dockerfile

```text title="requirements.txt"
stella-ai-agent-sdk>=0.10.0
openai>=1.0.0
aiohttp>=3.9.0
```

```dockerfile title="Dockerfile"
FROM python:3.11-slim

# livekit-rtc needs libgobject from libglib2.0
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY my_agent/ ./my_agent/

ENV PYTHONUNBUFFERED=1
CMD ["python", "-m", "my_agent.agent"]
```

Run the agent as a module (`python -m my_agent.agent`) so its relative imports work.

## Step 6: Tests

Tools are plain objects, so test them without a room. Pass a fake API in place of `SupportApi`:

```python title="tests/test_tools.py"
import pytest

from my_agent.tools import CreateTicketTool, SearchKnowledgeTool


class FakeApi:
    def __init__(self, articles):
        self.articles = articles
        self.posted = []

    async def get(self, path, **params):
        return self.articles

    async def post(self, path, body):
        self.posted.append(body)
        return {"id": "T-1"}


@pytest.mark.asyncio
async def test_search_without_results_fails():
    result = await SearchKnowledgeTool(FakeApi([])).execute(query="printer")
    assert not result.success


@pytest.mark.asyncio
async def test_create_ticket_defaults_to_medium():
    api = FakeApi([])
    result = await CreateTicketTool(api).execute(title="Printer", description="Won't print")
    assert result.data == {"ticket_id": "T-1"}
    assert api.posted[0]["priority"] == "medium"
```

`pytest-asyncio` runs the async tests.

## Step 7: Run it locally

Set the connection variables from [Getting Started](./getting-started.md#run-it-locally), plus this agent's own two:

```bash
export OPENAI_API_KEY=sk-...
export SUPPORT_API_URL=http://localhost:8080
python -m my_agent.agent
```

## Step 8: Put it on STELLA

You don't build or push an image: STELLA builds it from your `Dockerfile`. Zip the package (`agent.yaml`, `Dockerfile`, `requirements.txt` and `my_agent/`) and upload it in **Settings → Agent Library**. The steps, review and sharing are in [Build your own agent](../guides/build-your-own-agent.md#upload-it-to-stella) and [Agent validation](../deployment/agent-validation.md).

## Best practices

1. **Return failures, don't raise them.** A `ToolResult(success=False, error=...)` lets the model recover.
2. **Cap the tool loop.** The executor never loops on its own; stop after a few rounds.
3. **Keep replies speakable.** Short sentences, no markdown: they go to TTS.
4. **Stop on interrupt.** Check a flag set in `on_interrupt` between model calls.
5. **Declare every env var** in `agent.yaml`. STELLA refuses a deploy that is missing a required one.

## See Also

- [Getting Started](./getting-started.md)
- [Base Agent](./base-agent.md)
- [Tools](./tools.md)
- [Progress Tracking](./progress-tracking.md)
- [The agent manifest](./agent-manifest.md)
- [Connectors](./connectors.md)
