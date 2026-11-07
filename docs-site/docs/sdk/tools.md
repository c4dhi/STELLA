---
sidebar_position: 4
title: Tools
description: Building custom tools for STELLA agents
---

# Tools

Tools extend agent capabilities by allowing them to perform actions beyond conversation. This guide covers creating, registering, and executing tools.

## Overview

Tools are async Python functions that:
- Have typed parameters with descriptions
- Return structured results
- Are automatically converted to OpenAI tool schemas

## Creating Tools

### Basic Tool

```python
from stella_agent_sdk import tool


@tool
async def get_weather(city: str) -> dict:
    """Get the current weather for a city.

    Args:
        city: The city name to get weather for

    Returns:
        Weather data including temperature and conditions
    """
    # Call weather API
    response = await weather_api.get(city)

    return {
        "temperature": response.temp,
        "conditions": response.conditions,
        "humidity": response.humidity
    }
```

### Tool with Multiple Parameters

```python
@tool
async def search_products(
    query: str,
    category: str = None,
    max_results: int = 10,
    min_price: float = None,
    max_price: float = None
) -> dict:
    """Search for products in the catalog.

    Args:
        query: Search query
        category: Optional category filter
        max_results: Maximum number of results (default: 10)
        min_price: Minimum price filter
        max_price: Maximum price filter

    Returns:
        List of matching products
    """
    products = await catalog.search(
        query=query,
        category=category,
        limit=max_results,
        price_range=(min_price, max_price)
    )

    return {
        "count": len(products),
        "products": [
            {"id": p.id, "name": p.name, "price": p.price}
            for p in products
        ]
    }
```

## Registering Tools

### In Agent Constructor

```python
class MyAgent(BaseAgent):
    def __init__(self):
        super().__init__()

        # Register tools
        self.register_tool(get_weather)
        self.register_tool(search_products)
        self.register_tool(create_order)
```

### From a Module

```python
# tools/__init__.py
from .weather import get_weather
from .products import search_products, create_order

ALL_TOOLS = [get_weather, search_products, create_order]

# agent.py
from tools import ALL_TOOLS

class MyAgent(BaseAgent):
    def __init__(self):
        super().__init__()
        for tool in ALL_TOOLS:
            self.register_tool(tool)
```

## Executing Tools

### With OpenAI

```python
async def generate_response(self, user_input: str) -> str:
    messages = [
        {"role": "system", "content": self.system_prompt},
        *self.history,
        {"role": "user", "content": user_input}
    ]

    # Get tool definitions
    tools = self.get_tool_definitions()

    # First LLM call
    response = await self.openai.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        tools=tools
    )

    # Handle tool calls
    while response.choices[0].message.tool_calls:
        tool_calls = response.choices[0].message.tool_calls
        messages.append(response.choices[0].message)

        for tool_call in tool_calls:
            name = tool_call.function.name
            args = json.loads(tool_call.function.arguments)

            # Show status
            await self.send_status("thinking", f"Running {name}...")

            # Execute
            result = await self.execute_tool(name, args)

            # Add result to messages
            messages.append({
                "role": "tool",
                "tool_call_id": tool_call.id,
                "content": json.dumps(result)
            })

        # Next LLM call with tool results
        response = await self.openai.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            tools=tools
        )

    return response.choices[0].message.content
```

## Advanced Patterns

### Tool with Side Effects

```python
@tool
async def send_email(
    to: str,
    subject: str,
    body: str,
    cc: str = None
) -> dict:
    """Send an email to the specified recipient.

    Args:
        to: Recipient email address
        subject: Email subject
        body: Email body content
        cc: Optional CC recipient

    Returns:
        Confirmation with message ID
    """
    try:
        result = await email_service.send(
            to=to,
            subject=subject,
            body=body,
            cc=cc
        )
        return {
            "success": True,
            "message_id": result.id,
            "message": f"Email sent to {to}"
        }
    except EmailError as e:
        return {
            "success": False,
            "error": str(e)
        }
```

### Tool with Database Access

```python
@tool
async def create_ticket(
    title: str,
    description: str,
    priority: str = "medium",
    assignee: str = None
) -> dict:
    """Create a support ticket in the system.

    Args:
        title: Brief ticket title
        description: Detailed description
        priority: low, medium, or high
        assignee: Optional assignee email

    Returns:
        Created ticket details
    """
    ticket = await db.tickets.create(
        title=title,
        description=description,
        priority=priority,
        assignee=assignee,
        status="open",
        created_at=datetime.utcnow()
    )

    # Notify assignee if specified
    if assignee:
        await notify_assignee(ticket, assignee)

    return {
        "ticket_id": ticket.id,
        "url": f"https://support.example.com/tickets/{ticket.id}",
        "status": "created"
    }
```

### Tool with Validation

```python
from pydantic import BaseModel, validator

class OrderInput(BaseModel):
    product_id: str
    quantity: int
    shipping_address: str

    @validator('quantity')
    def quantity_positive(cls, v):
        if v <= 0:
            raise ValueError('Quantity must be positive')
        return v


@tool
async def place_order(
    product_id: str,
    quantity: int,
    shipping_address: str
) -> dict:
    """Place an order for a product.

    Args:
        product_id: Product identifier
        quantity: Number of items (must be positive)
        shipping_address: Delivery address

    Returns:
        Order confirmation
    """
    # Validate input
    try:
        validated = OrderInput(
            product_id=product_id,
            quantity=quantity,
            shipping_address=shipping_address
        )
    except ValueError as e:
        return {"success": False, "error": str(e)}

    # Process order
    order = await orders.create(
        product_id=validated.product_id,
        quantity=validated.quantity,
        address=validated.shipping_address
    )

    return {
        "success": True,
        "order_id": order.id,
        "estimated_delivery": order.estimated_delivery.isoformat()
    }
```

### Parallel Tool Execution

When the LLM requests multiple tools, execute them in parallel:

```python
async def execute_tools_parallel(self, tool_calls):
    tasks = []
    for tool_call in tool_calls:
        name = tool_call.function.name
        args = json.loads(tool_call.function.arguments)
        tasks.append(self.execute_tool(name, args))

    results = await asyncio.gather(*tasks)

    return [
        {
            "role": "tool",
            "tool_call_id": tool_call.id,
            "content": json.dumps(result)
        }
        for tool_call, result in zip(tool_calls, results)
    ]
```

## Error Handling

### Graceful Error Returns

```python
@tool
async def risky_operation(param: str) -> dict:
    """Perform an operation that might fail."""
    try:
        result = await external_service.call(param)
        return {"success": True, "data": result}
    except ServiceError as e:
        # Return error for LLM to handle
        return {
            "success": False,
            "error": str(e),
            "suggestion": "Try again with different parameters"
        }
```

### Timeout Handling

```python
import asyncio

@tool
async def slow_operation(query: str) -> dict:
    """Operation with timeout."""
    try:
        result = await asyncio.wait_for(
            external_api.call(query),
            timeout=30.0
        )
        return {"success": True, "data": result}
    except asyncio.TimeoutError:
        return {
            "success": False,
            "error": "Operation timed out",
            "suggestion": "Try a simpler query"
        }
```

## Testing Tools

```python
import pytest
from unittest.mock import AsyncMock

@pytest.mark.asyncio
async def test_get_weather():
    # Mock the API
    with patch('tools.weather_api') as mock_api:
        mock_api.get = AsyncMock(return_value=MockResponse(
            temp=72,
            conditions="sunny",
            humidity=45
        ))

        result = await get_weather("San Francisco")

        assert result["temperature"] == 72
        assert result["conditions"] == "sunny"
        mock_api.get.assert_called_once_with("San Francisco")
```

## Next Steps

- [Custom Tools Guide](../guides/custom-tools.md) - Step-by-step guide to creating tools
- [Streaming](./streaming.md) - Audio streaming
- [Base Agent](./base-agent.md) - Full API reference
- [Build Your Own Agent](../guides/build-your-own-agent.md) - Complete tutorial
