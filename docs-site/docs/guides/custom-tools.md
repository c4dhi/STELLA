---
sidebar_position: 5
title: Custom Tools
description: Add custom tools to extend agent capabilities
---

import {Steps, Step} from '@site/src/components/StepGuide';

# Custom Tools

Tools extend agent capabilities by allowing them to perform actions beyond conversation - calling APIs, querying databases, sending notifications, and more. This guide explains how to create and register custom tools using the STELLA SDK.

## Overview

Tools in STELLA are:
- **Class-based** - Extend `BaseTool` with typed parameters
- **Async** - All tool execution is asynchronous
- **Provider-agnostic** - Automatically convert to OpenAI or Anthropic schemas
- **Composable** - Register any combination of tools per agent

## Architecture

```
agents/your-agent/
├── src/
│   └── your_agent/
│       ├── agent.py           # Main agent class
│       └── tools/             # Custom tools directory
│           ├── __init__.py    # Tool exports
│           ├── weather.py     # Example tool
│           └── database.py    # Another tool
```

The SDK provides the tool infrastructure:

```
stella_agent_sdk/tools/
├── base.py      # BaseTool, ToolResult, ToolCall
├── registry.py  # ToolRegistry for managing tools
└── executor.py  # ToolExecutor for LLM tool loop
```

## Creating a Custom Tool

<Steps>

<Step number={1} title="Create the tool class">

Create a new file in your agent's `tools/` directory:

```python title="tools/weather.py"
from typing import Any, Dict

from stella_agent_sdk.tools import BaseTool, ToolResult


class GetWeatherTool(BaseTool):
    """Fetch current weather for a location."""

    @property
    def name(self) -> str:
        return "get_weather"

    @property
    def description(self) -> str:
        return (
            "Get the current weather for a city. "
            "Returns temperature, conditions, and humidity."
        )

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "city": {
                    "type": "string",
                    "description": "City name (e.g., 'San Francisco')"
                },
                "units": {
                    "type": "string",
                    "enum": ["celsius", "fahrenheit"],
                    "description": "Temperature units (default: celsius)"
                }
            },
            "required": ["city"]
        }

    async def execute(
        self,
        city: str,
        units: str = "celsius"
    ) -> ToolResult:
        """Execute the weather lookup."""
        try:
            # Call your weather API
            response = await self._fetch_weather(city, units)

            return ToolResult(
                success=True,
                data={
                    "city": city,
                    "temperature": response["temp"],
                    "units": units,
                    "conditions": response["conditions"],
                    "humidity": response["humidity"]
                }
            )
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Failed to fetch weather: {str(e)}"
            )

    async def _fetch_weather(
        self,
        city: str,
        units: str
    ) -> dict:
        """Internal method to call weather API."""
        import httpx

        async with httpx.AsyncClient() as client:
            resp = await client.get(
                "https://api.weather.example/current",
                params={"city": city, "units": units}
            )
            resp.raise_for_status()
            return resp.json()
```

</Step>

<Step number={2} title="Export from tools module">

Create or update `tools/__init__.py`:

```python title="tools/__init__.py"
from .weather import GetWeatherTool
from .database import QueryDatabaseTool, InsertRecordTool

# List of all tools for easy registration
ALL_TOOLS = [
    GetWeatherTool,
    QueryDatabaseTool,
    InsertRecordTool,
]

__all__ = [
    "GetWeatherTool",
    "QueryDatabaseTool",
    "InsertRecordTool",
    "ALL_TOOLS",
]
```

</Step>

<Step number={3} title="Register tools in your agent">

In your agent's initialization, register the tools:

```python title="agent.py"
from stella_agent_sdk.tools import ToolRegistry
from .tools import GetWeatherTool, QueryDatabaseTool


class MyAgent:
    def __init__(self):
        # Create tool registry
        self.tool_registry = ToolRegistry()

        # Register individual tools
        self.tool_registry.register(GetWeatherTool())
        self.tool_registry.register(QueryDatabaseTool(self.db_client))

    def get_tools_for_llm(self):
        """Get tool schemas for LLM call."""
        return self.tool_registry.get_openai_schemas()
```

Or register multiple tools at once:

```python
from .tools import ALL_TOOLS

class MyAgent:
    def __init__(self):
        self.tool_registry = ToolRegistry()

        # Register all tools
        for tool_class in ALL_TOOLS:
            self.tool_registry.register(tool_class())
```

</Step>

<Step number={4} title="Execute tools from LLM responses" isLast>

Use the `ToolExecutor` to handle the tool calling loop:

```python title="agent.py"
from stella_agent_sdk.tools import ToolExecutor, ToolCall


class MyAgent:
    def __init__(self):
        self.tool_registry = ToolRegistry()
        self.tool_executor = ToolExecutor(self.tool_registry)
        # ... register tools

    async def process_llm_response(self, response):
        """Process LLM response and execute any tool calls."""

        # Parse tool calls from response
        tool_calls = self.tool_executor.parse_openai_tool_calls(response)

        if not tool_calls:
            # No tools called, return text response
            return response.choices[0].message.content

        # Execute each tool
        tool_results = []
        async for event in self.tool_executor.execute_tool_calls(tool_calls):
            if event.type.value == "tool_result":
                tool_results.append(
                    self.tool_executor.build_tool_result_message_openai(
                        event.tool_call_id,
                        event.result
                    )
                )

        return tool_results
```

</Step>

</Steps>

## Passing Tools to the LLM

For the AI to call your tools, you need to pass tool schemas when making LLM requests. The `ToolRegistry` converts your tools to the format required by OpenAI or Anthropic.

### How Tool Calling Works

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Tool Calling Flow                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. Agent prepares LLM request                                      │
│     ┌──────────────────────────────────────────────────────────┐    │
│     │  messages = [system_prompt, user_message]                │    │
│     │  tools = tool_registry.get_openai_schemas()  ◄── Tools   │    │
│     └──────────────────────────────────────────────────────────┘    │
│                              │                                      │
│                              ▼                                      │
│  2. LLM decides to call tools                                       │
│     ┌──────────────────────────────────────────────────────────┐    │
│     │  Response: tool_calls=[                                  │    │
│     │    {name: "get_weather", args: {city: "Paris"}}          │    │
│     │  ]                                                       │    │
│     └──────────────────────────────────────────────────────────┘    │
│                              │                                      │
│                              ▼                                      │
│  3. Agent executes tools                                            │
│     ┌──────────────────────────────────────────────────────────┐    │
│     │  tool = registry.get("get_weather")                      │    │
│     │  result = await tool.execute(city="Paris")               │    │
│     └──────────────────────────────────────────────────────────┘    │
│                              │                                      │
│                              ▼                                      │
│  4. Results sent back to LLM                                        │
│     ┌──────────────────────────────────────────────────────────┐    │
│     │  messages.append(tool_result_message)                    │    │
│     │  response = await llm.generate(messages, tools)          │    │
│     └──────────────────────────────────────────────────────────┘    │
│                              │                                      │
│                              ▼                                      │
│  5. LLM generates final response (or calls more tools)              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Getting Tool Schemas

The `ToolRegistry` provides methods to get tool schemas in different formats:

```python
from stella_agent_sdk.tools import ToolRegistry

registry = ToolRegistry()
registry.register(GetWeatherTool())
registry.register(QueryDatabaseTool())

# Get schemas for OpenAI
openai_tools = registry.get_openai_schemas()
# Returns: [{"type": "function", "function": {"name": ..., "parameters": ...}}, ...]

# Get schemas for Anthropic
anthropic_tools = registry.get_anthropic_schemas()
# Returns: [{"name": ..., "input_schema": ...}, ...]
```

### Complete LLM Integration Example

Here's a complete example showing how to pass tools to an LLM and handle the response:

```python title="agent.py"
from stella_agent_sdk.tools import ToolRegistry, ToolExecutor
from openai import AsyncOpenAI


class MyAgent:
    def __init__(self):
        self.client = AsyncOpenAI()
        self.tool_registry = ToolRegistry()
        self.tool_executor = ToolExecutor(self.tool_registry)

        # Register your custom tools
        self.tool_registry.register(GetWeatherTool())
        self.tool_registry.register(SearchProductsTool())

    async def generate_response(
        self,
        system_prompt: str,
        user_message: str
    ) -> str:
        """Generate a response, handling any tool calls."""

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_message}
        ]

        # Get tool schemas from registry
        tools = self.tool_registry.get_openai_schemas()

        # Loop until LLM responds without tool calls
        max_iterations = 10
        for _ in range(max_iterations):
            # Call LLM with tools
            response = await self.client.chat.completions.create(
                model="gpt-4o",
                messages=messages,
                tools=tools,        # Pass tools here
                tool_choice="auto"  # Let LLM decide when to use tools
            )

            choice = response.choices[0]

            # If no tool calls, return the text response
            if not choice.message.tool_calls:
                return choice.message.content

            # Add assistant message with tool calls to history
            messages.append(choice.message)

            # Execute each tool call
            for tool_call in choice.message.tool_calls:
                tool_name = tool_call.function.name
                tool_args = json.loads(tool_call.function.arguments)

                print(f"Executing tool: {tool_name}({tool_args})")

                # Look up and execute the tool
                tool = self.tool_registry.get(tool_name)
                if tool:
                    result = await tool.execute(**tool_args)
                else:
                    result = ToolResult(
                        success=False,
                        error=f"Unknown tool: {tool_name}"
                    )

                # Add tool result to messages
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": json.dumps(result.to_dict())
                })

        return "Max tool iterations reached"
```

### Using LLMService (Recommended)

The STELLA agent SDK provides `LLMService` which handles tool calling automatically:

```python title="Using LLMService"
from stella_light_agent.llm.service import (
    LLMService,
    LLMConfig,
    LLMProvider,
    LLMMessage
)

class MyAgent:
    def __init__(self):
        self.llm_service = LLMService()
        self.tool_registry = ToolRegistry()

        # Register tools
        self.tool_registry.register(GetWeatherTool())

    async def process(self, user_input: str) -> str:
        messages = [
            LLMMessage(role="system", content="You are a helpful assistant."),
            LLMMessage(role="user", content=user_input)
        ]

        # Configure LLM with tools
        config = LLMConfig(
            provider=LLMProvider.OPENAI_DIRECT,
            model="gpt-4o",
            tools=self.tool_registry.get_openai_schemas(),
            tool_choice="auto"  # "auto", "none", or "required"
        )

        response = await self.llm_service.generate(
            messages=messages,
            config=config
        )

        # Check if LLM made tool calls
        if response.tool_calls:
            for tc in response.tool_calls:
                print(f"LLM called: {tc.name}({tc.arguments})")
                tool = self.tool_registry.get(tc.name)
                result = await tool.execute(**tc.arguments)
                # ... handle result

        return response.content
```

### Tool Choice Options

Control when the LLM uses tools with `tool_choice`:

| Value | Behavior |
|-------|----------|
| `"auto"` | LLM decides whether to use tools (default) |
| `"none"` | LLM won't use any tools |
| `"required"` | LLM must use at least one tool |
| `{"type": "function", "function": {"name": "specific_tool"}}` | Force a specific tool |

```python
# Force the LLM to always use tools
config = LLMConfig(
    tools=tools,
    tool_choice="required"
)

# Prevent tool usage for this request
config = LLMConfig(
    tools=tools,
    tool_choice="none"
)
```

### Parallel Tool Execution

When the LLM requests multiple tools, execute them in parallel for better performance:

```python
import asyncio

async def execute_tools_parallel(
    self,
    tool_calls: list
) -> list:
    """Execute multiple tool calls in parallel."""

    async def execute_single(tc):
        tool = self.tool_registry.get(tc.name)
        if not tool:
            return ToolResult(success=False, error=f"Unknown: {tc.name}")
        return await tool.execute(**tc.arguments)

    results = await asyncio.gather(
        *[execute_single(tc) for tc in tool_calls]
    )

    return [
        {
            "role": "tool",
            "tool_call_id": tc.id,
            "content": json.dumps(result.to_dict())
        }
        for tc, result in zip(tool_calls, results)
    ]
```

## Tool Components

### BaseTool Properties

Every tool must implement these properties:

| Property | Type | Description |
|----------|------|-------------|
| `name` | `str` | Unique identifier (snake_case) |
| `description` | `str` | Description for the LLM |
| `parameters_schema` | `Dict` | JSON Schema for parameters |

### ToolResult

Return a `ToolResult` from every `execute()` call:

```python
from stella_agent_sdk.tools import ToolResult

# Success with data
return ToolResult(
    success=True,
    data={"key": "value", "count": 42}
)

# Failure with error message
return ToolResult(
    success=False,
    error="Database connection failed"
)
```

### Parameters Schema

Use JSON Schema format for parameters:

```python
@property
def parameters_schema(self) -> Dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "required_param": {
                "type": "string",
                "description": "This parameter is required"
            },
            "optional_param": {
                "type": "integer",
                "description": "Optional with default"
            },
            "enum_param": {
                "type": "string",
                "enum": ["option1", "option2", "option3"],
                "description": "Must be one of the options"
            },
            "array_param": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of strings"
            }
        },
        "required": ["required_param"]
    }
```

## Example: Database Tool

A tool that queries a database:

```python title="tools/database.py"
from typing import Any, Dict, List

from stella_agent_sdk.tools import BaseTool, ToolResult


class QueryDatabaseTool(BaseTool):
    """Query the application database."""

    def __init__(self, db_client):
        self._db = db_client

    @property
    def name(self) -> str:
        return "query_database"

    @property
    def description(self) -> str:
        return (
            "Query the database for records. Supports filtering "
            "by field values and limiting results."
        )

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "table": {
                    "type": "string",
                    "enum": ["users", "orders", "products"],
                    "description": "Table to query"
                },
                "filters": {
                    "type": "object",
                    "description": "Field-value pairs to filter by"
                },
                "limit": {
                    "type": "integer",
                    "description": "Max records to return (default: 10)"
                }
            },
            "required": ["table"]
        }

    async def execute(
        self,
        table: str,
        filters: Dict[str, Any] = None,
        limit: int = 10
    ) -> ToolResult:
        try:
            query = self._db.table(table)

            if filters:
                for field, value in filters.items():
                    query = query.where(field, "==", value)

            results = await query.limit(limit).get()

            return ToolResult(
                success=True,
                data={
                    "table": table,
                    "count": len(results),
                    "records": [r.to_dict() for r in results]
                }
            )
        except Exception as e:
            return ToolResult(
                success=False,
                error=f"Query failed: {str(e)}"
            )
```

## Example: External API Tool

A tool that calls an external API with authentication:

```python title="tools/crm.py"
import os
from typing import Any, Dict

import httpx
from stella_agent_sdk.tools import BaseTool, ToolResult


class CreateCRMContactTool(BaseTool):
    """Create a contact in the CRM system."""

    def __init__(self):
        self._api_key = os.environ.get("CRM_API_KEY")
        self._base_url = os.environ.get("CRM_API_URL")

    @property
    def name(self) -> str:
        return "create_crm_contact"

    @property
    def description(self) -> str:
        return "Create a new contact in the CRM with name and email."

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Contact's full name"
                },
                "email": {
                    "type": "string",
                    "description": "Contact's email address"
                },
                "phone": {
                    "type": "string",
                    "description": "Contact's phone number (optional)"
                },
                "notes": {
                    "type": "string",
                    "description": "Additional notes about the contact"
                }
            },
            "required": ["name", "email"]
        }

    async def execute(
        self,
        name: str,
        email: str,
        phone: str = None,
        notes: str = None
    ) -> ToolResult:
        if not self._api_key:
            return ToolResult(
                success=False,
                error="CRM_API_KEY not configured"
            )

        payload = {
            "name": name,
            "email": email,
        }
        if phone:
            payload["phone"] = phone
        if notes:
            payload["notes"] = notes

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self._base_url}/contacts",
                    json=payload,
                    headers={"Authorization": f"Bearer {self._api_key}"},
                    timeout=30.0
                )
                response.raise_for_status()
                data = response.json()

            return ToolResult(
                success=True,
                data={
                    "contact_id": data["id"],
                    "message": f"Contact '{name}' created successfully"
                }
            )
        except httpx.TimeoutException:
            return ToolResult(
                success=False,
                error="CRM API request timed out"
            )
        except httpx.HTTPStatusError as e:
            return ToolResult(
                success=False,
                error=f"CRM API error: {e.response.status_code}"
            )
```

## Best Practices

### Error Handling

Always return `ToolResult` - never raise exceptions:

```python
async def execute(self, **kwargs) -> ToolResult:
    try:
        result = await self._do_work(**kwargs)
        return ToolResult(success=True, data=result)
    except ValidationError as e:
        return ToolResult(success=False, error=f"Invalid input: {e}")
    except ConnectionError as e:
        return ToolResult(success=False, error=f"Connection failed: {e}")
    except Exception as e:
        return ToolResult(success=False, error=f"Unexpected error: {e}")
```

### Timeouts

Add timeouts for external calls:

```python
import asyncio

async def execute(self, query: str) -> ToolResult:
    try:
        result = await asyncio.wait_for(
            self._external_api.call(query),
            timeout=30.0
        )
        return ToolResult(success=True, data=result)
    except asyncio.TimeoutError:
        return ToolResult(
            success=False,
            error="Operation timed out after 30 seconds"
        )
```

### Descriptive Names and Descriptions

The LLM uses your tool's name and description to decide when to call it:

```python
# Good - clear and specific
@property
def name(self) -> str:
    return "search_knowledge_base"

@property
def description(self) -> str:
    return (
        "Search the company knowledge base for articles matching a query. "
        "Use this when the user asks questions about company policies, "
        "procedures, or product documentation."
    )

# Bad - vague
@property
def name(self) -> str:
    return "search"

@property
def description(self) -> str:
    return "Searches for stuff"
```

### Dependency Injection

Pass dependencies through the constructor:

```python
class MyTool(BaseTool):
    def __init__(self, db_client, api_client, config):
        self._db = db_client
        self._api = api_client
        self._config = config

# In agent.py
tool = MyTool(
    db_client=self.database,
    api_client=self.http_client,
    config=self.tool_config
)
self.tool_registry.register(tool)
```

## Testing Tools

```python
import pytest
from unittest.mock import AsyncMock, patch

from your_agent.tools import GetWeatherTool


@pytest.mark.asyncio
async def test_get_weather_success():
    tool = GetWeatherTool()

    with patch.object(tool, '_fetch_weather', new_callable=AsyncMock) as mock:
        mock.return_value = {
            "temp": 72,
            "conditions": "sunny",
            "humidity": 45
        }

        result = await tool.execute(city="San Francisco")

        assert result.success is True
        assert result.data["temperature"] == 72
        assert result.data["conditions"] == "sunny"
        mock.assert_called_once_with("San Francisco", "celsius")


@pytest.mark.asyncio
async def test_get_weather_api_error():
    tool = GetWeatherTool()

    with patch.object(tool, '_fetch_weather', new_callable=AsyncMock) as mock:
        mock.side_effect = Exception("API unavailable")

        result = await tool.execute(city="Unknown City")

        assert result.success is False
        assert "Failed to fetch weather" in result.error
```

## Built-in Tools

The SDK includes tools for state machine integration:

| Tool | Purpose |
|------|---------|
| `CompleteTaskTool` | Mark conversation tasks as completed |
| `SetDeliverableTool` | Set collected values from conversation |
| `GetCurrentStateTool` | Query current conversation state |
| `GetPendingTasksTool` | List pending tasks |
| `GetPendingDeliverablesTool` | List uncollected deliverables |

Use the factory function to create them:

```python
from stella_agent_sdk.tools.state_machine import create_state_machine_tools

tools = create_state_machine_tools(state_machine_client)
for tool in tools:
    self.tool_registry.register(tool)
```

## Next Steps

- [SDK Tools Reference](../agent-sdk/tools.md) - API documentation
- [Base Agent](../agent-sdk/base-agent.md) - Full agent API
- [Build Your Own Agent](./build-your-own-agent.md) - Complete agent tutorial
