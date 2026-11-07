---
sidebar_position: 7
title: "🔧 Tools"
---

# 🔧 Tools

Tools are functions the LLM can ask your agent to run: look something up, call an API, record an answer. The SDK gives you the building blocks. It does not call an LLM for you: your agent sends the tool schemas to the model it uses, reads the tool calls back, runs them, and returns the results.

```
User: "What's the weather in Bern?"
       ↓
LLM asks for get_weather(city="Bern")
       ↓
Your agent runs the tool → ToolResult(success=True, data={"temp_c": 18, ...})
       ↓
LLM gets the result and replies: "It's 18 degrees and sunny in Bern."
```

Everything on this page is exported from `stella_agent_sdk`:

| Name | What it is |
|---|---|
| `BaseTool` | Abstract base class for a tool. |
| `ToolResult` | What a tool returns: `success`, `data`, `error`. |
| `ToolCall` | One call the LLM asked for: `id`, `name`, `arguments`. |
| `ToolRegistry` | Holds the tools of a session and builds their schemas. |
| `ToolExecutor` | Runs tool calls against a registry and builds the result messages. |

## Defining a tool

Subclass `BaseTool` and implement four members: `name`, `description`, `parameters_schema` (a JSON Schema object) and the async `execute`. The LLM's arguments arrive as keyword arguments.

```python title="my_agent/tools.py"
from typing import Any, Dict

import aiohttp

from stella_agent_sdk import BaseTool, ToolResult


class GetWeatherTool(BaseTool):
    """Current weather for a city."""

    @property
    def name(self) -> str:
        return "get_weather"

    @property
    def description(self) -> str:
        return "Get the current weather for a city."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "city": {"type": "string", "description": "City name, e.g. 'Bern'"},
            },
            "required": ["city"],
        }

    async def execute(self, city: str, **_kwargs) -> ToolResult:
        async with aiohttp.ClientSession() as http:
            async with http.get("https://wttr.in/" + city, params={"format": "j1"}) as resp:
                if resp.status != 200:
                    return ToolResult(success=False, error=f"No weather for {city}")
                body = await resp.json(content_type=None)
        current = body["current_condition"][0]
        return ToolResult(
            success=True,
            data={"temp_c": current["temp_C"], "conditions": current["weatherDesc"][0]["value"]},
        )
```

A tool that needs something from your agent (a client, a list of activities) takes it in `__init__`. The SDK's own state machine tools take a `StateMachineClient` that way.

### Schemas

`to_openai_schema()` and `to_anthropic_schema()` turn a tool into the format each provider expects:

```python
tool = GetWeatherTool()   # the tool defined above
tool.to_openai_schema()
# {"type": "function", "function": {"name": "get_weather", "description": ..., "parameters": {...}}}
tool.to_anthropic_schema()
# {"name": "get_weather", "description": ..., "input_schema": {...}}
```

### Guidance

`BaseTool.guidance` is a class attribute (empty by default) for how to use the tool beyond what its schema says. When you hand a model a set of tools, add the guidance of exactly those tools to the prompt, each distinct text once. That way the instructions travel with the tool and never reach a model that can't call it:

```python
from typing import List

from stella_agent_sdk import BaseTool


def tool_guidance(tools: List[BaseTool]) -> str:
    return "\n\n".join(dict.fromkeys(t.guidance for t in tools if t.guidance))
```

### `ToolResult`

```python
from stella_agent_sdk import ToolResult

ok = ToolResult(success=True, data={"ticket_id": "T-123"})
failed = ToolResult(success=False, error="Ticket system is down")

ok.to_dict()       # {"success": True, "data": {"ticket_id": "T-123"}}
failed.to_dict()   # {"success": False, "error": "Ticket system is down"}
```

`to_dict()` leaves out `data` and `error` when they are `None`. It is what goes back to the LLM.

## Registering tools

`ToolRegistry` holds one session's tools by name.

```python
from stella_agent_sdk import ToolRegistry

registry = ToolRegistry()
registry.register(GetWeatherTool())     # the tool above; ValueError if the name is taken
# registry.register_all([...])          # several at once

registry.get("get_weather")             # the tool, or None
registry.has("get_weather")             # also: "get_weather" in registry
registry.list_names()                   # ["get_weather"]
registry.list_tools()                   # the tool instances; also: for tool in registry
len(registry)

openai_tools = registry.get_openai_schemas()
anthropic_tools = registry.get_anthropic_schemas()

registry.unregister("get_weather")      # True if it was there
registry.clear()
```

## Running tool calls

`ToolExecutor` does the per-call work: it looks the tool up, runs it, and turns any exception into `ToolResult(success=False, error=...)`, so one failing tool never breaks the turn. An unknown tool name comes back the same way, listing the tools that exist. The loop around the LLM is yours to write.

| Method | What it does |
|---|---|
| `parse_openai_tool_calls(message)` | `ToolCall`s from an OpenAI message object, or from a response dict with `choices`. |
| `parse_anthropic_tool_calls(response)` | `ToolCall`s from the `tool_use` blocks of an Anthropic response. |
| `await execute_single(call)` | Runs one call and returns an `ExecutorEvent` with `type=TOOL_RESULT` and `result`. |
| `execute_tool_calls(calls)` | Async iterator: a `TOOL_CALL` event, then its `TOOL_RESULT` event, for each call in order. |
| `build_tool_result_message_openai(call_id, result)` | The `role: "tool"` message for OpenAI. |
| `build_tool_result_message_anthropic(tool_use_id, result)` | The `tool_result` user message for Anthropic. |

`ToolExecutor(registry, on_tool_call=..., on_tool_result=...)` also takes two optional plain (not async) callbacks, called with the tool name and the arguments or the result. `ToolCall.from_openai(...)` and `ToolCall.from_anthropic(...)` build a single call by hand. `ExecutorEvent` and `EventType` live in `stella_agent_sdk.tools.executor`.

### A tool loop with OpenAI

This agent answers each turn with OpenAI, runs the tools it asks for, and reports every call to the debug panel with `AgentOutput.tool_call`:

```python title="my_agent/agent.py"
import asyncio
import json
from typing import Any, AsyncIterator, Dict, List

from openai import AsyncOpenAI

from stella_agent_sdk import (
    AgentInput,
    AgentOutput,
    BaseAgent,
    ToolExecutor,
    ToolRegistry,
    run_agent_from_env,
)

from .tools import GetWeatherTool

MAX_ROUNDS = 5


class WeatherAgent(BaseAgent):
    def __init__(self) -> None:
        super().__init__()
        self.client = AsyncOpenAI()
        self.registry = ToolRegistry()
        self.registry.register(GetWeatherTool())
        self.executor = ToolExecutor(self.registry)
        self.history: List[Dict[str, Any]] = []

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        await super().on_session_start(session_id, config)
        self.history = []

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        self.history.append({"role": "user", "content": input.text})
        messages = [{"role": "system", "content": "You are a helpful assistant."}, *self.history]

        for _ in range(MAX_ROUNDS):
            response = await self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=messages,
                tools=self.registry.get_openai_schemas(),
            )
            message = response.choices[0].message
            calls = self.executor.parse_openai_tool_calls(message)
            if not calls:
                reply = message.content or ""
                self.history.append({"role": "assistant", "content": reply})
                yield AgentOutput.text_final(input.session_id, reply)
                return

            messages.append(message.model_dump(exclude_none=True))
            for call in calls:
                event = await self.executor.execute_single(call)
                yield AgentOutput.tool_call(
                    input.session_id,
                    call.name,
                    arguments=call.arguments,
                    success=event.result.success,
                    data=event.result.data if isinstance(event.result.data, dict) else None,
                    error=event.result.error,
                )
                messages.append(self.executor.build_tool_result_message_openai(call.id, event.result))

        yield AgentOutput.text_final(input.session_id, "Sorry, I couldn't finish that.")


if __name__ == "__main__":
    asyncio.run(run_agent_from_env(WeatherAgent()))
```

Run it as a module (`python -m my_agent.agent`) so the relative import works.

The cap on rounds is yours: the executor doesn't loop on its own, so it is up to you when to stop asking the model.

### Running calls in parallel

When the model asks for several independent calls in one turn, run them together:

```python
import asyncio
from typing import Any, Dict, List

from stella_agent_sdk import ToolCall, ToolExecutor


async def run_parallel(executor: ToolExecutor, calls: List[ToolCall]) -> List[Dict[str, Any]]:
    events = await asyncio.gather(*(executor.execute_single(c) for c in calls))
    return [
        executor.build_tool_result_message_openai(call.id, event.result)
        for call, event in zip(calls, events)
    ]
```

## Errors and timeouts

Return a failure instead of raising when the model can do something with it: retry, ask the user, or explain. `error` is what the model reads.

```python title="my_agent/tools.py"
import asyncio
from typing import Any, Dict

from stella_agent_sdk import BaseTool, ToolResult


class LookupOrderTool(BaseTool):
    def __init__(self, orders) -> None:
        self._orders = orders   # your own order service

    @property
    def name(self) -> str:
        return "lookup_order"

    @property
    def description(self) -> str:
        return "Look up an order by its number."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {"order_id": {"type": "string"}},
            "required": ["order_id"],
        }

    async def execute(self, order_id: str, **_kwargs) -> ToolResult:
        if not order_id.isdigit():
            return ToolResult(success=False, error="Order numbers are digits only. Ask the user again.")
        try:
            order = await asyncio.wait_for(self._orders.get(order_id), timeout=10.0)
        except asyncio.TimeoutError:
            return ToolResult(success=False, error="The order system timed out. Try again later.")
        if order is None:
            return ToolResult(success=False, error=f"No order {order_id}")
        return ToolResult(success=True, data={"status": order["status"]})
```

Validate arguments inside `execute` and return a failure for bad ones. There is no separate validation layer: the schema tells the model what to send, `execute` checks what it got.

A tool that keeps running after the turn (a long upload, a slow write) can be registered with `self.defer_tool(name, coro)` on `BaseAgent`. It returns the scheduled task, and the SDK waits for pending tools when the session ends.

## State machine tools

An agent that follows a plan doesn't write its own task tools. `self.plan_runtime` connects to the STELLA state machine, loads the plan and builds a `ToolRegistry` with the SDK's state machine tools:

| Tool | What it does |
|---|---|
| `set_deliverable` | Record one value the user gave. |
| `batch_update` | Record many deliverables and complete or skip many tasks in one call. |
| `complete_task` | Mark a task done. |
| `skip_task` | Skip one task. |
| `skip_state` | Skip the whole current state and move on. |
| `get_current_state`, `get_pending_tasks`, `get_pending_deliverables` | Read-only queries. |

```python title="my_agent/agent.py"
from typing import Any, Dict

from stella_agent_sdk import BaseAgent

from .tools import GetWeatherTool


class PlanAgent(BaseAgent):
    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        await super().on_session_start(session_id, config)
        if self.plan:
            await self.plan_runtime.start(self.plan)
            self.registry = self.plan_runtime.tools     # state machine tools
            self.registry.register(GetWeatherTool())    # plus your own
```

These tools are the only way the conversation advances: nothing is completed implicitly. Their usage contract is `STATE_MACHINE_TOOL_GUIDANCE`, which is also each tool's `guidance`. Append it to the prompt of any model that gets these tools; don't write your own version:

```python
from stella_agent_sdk.tools.state_machine import STATE_MACHINE_TOOL_GUIDANCE, create_state_machine_tools
```

`create_state_machine_tools(client)` builds the same list for a `StateMachineClient` you manage yourself. To show the state machine's progress in the task panel, see [Progress Tracking](./progress-tracking.md).

## Connector tools

Tools on an outside MCP server (a Connector) are called through `self.connectors`, not through `BaseTool`. See [Connectors](./connectors.md). To offer them to your LLM, wrap each `ConnectorTool` in a small `BaseTool` subclass whose `execute` calls `self.connectors.call_tool(...)`.

## Testing tools

A tool is a plain object, so test it by calling `execute`:

```python title="tests/test_tools.py"
import pytest

from my_agent.tools import LookupOrderTool


class FakeOrders:
    async def get(self, order_id):
        return {"status": "shipped"} if order_id == "42" else None


@pytest.mark.asyncio
async def test_lookup_order():
    tool = LookupOrderTool(FakeOrders())

    found = await tool.execute(order_id="42")
    assert found.success and found.data == {"status": "shipped"}

    missing = await tool.execute(order_id="7")
    assert not missing.success

    bad = await tool.execute(order_id="abc")
    assert "digits" in bad.error
```

## See Also

- [Base Agent](./base-agent.md)
- [Message Types](./message-types.md)
- [Connectors](./connectors.md)
- [Progress Tracking](./progress-tracking.md)
- [Building Custom Agents](./building-custom-agent.md)
