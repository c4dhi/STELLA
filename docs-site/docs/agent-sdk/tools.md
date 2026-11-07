---
sidebar_position: 7
title: "🔧 Tools"
---

# 🔧 Tools

Tools allow agents to execute custom functions during conversations, enabling them to search databases, call APIs, and perform actions beyond simple text generation.

## Overview

Tools are functions that the LLM can call during a conversation. The STELLA Agent SDK integrates with OpenAI's function calling to enable this.

```
User: "What's the weather in San Francisco?"
       ↓
LLM decides to call weather tool
       ↓
Tool executes: get_weather("San Francisco")
       ↓
Result: {"temp": 65, "conditions": "sunny"}
       ↓
LLM generates: "The weather in San Francisco is 65°F and sunny."
```

## Defining Tools

### Using the @tool Decorator

```python
from stella_agent_sdk import tool

@tool
async def search_knowledge_base(query: str) -> str:
    """Search the knowledge base for relevant information.

    Args:
        query: The search query

    Returns:
        Relevant information from the knowledge base
    """
    results = await kb.search(query)
    return format_results(results)
```

### Using the Tool Class

```python
from stella_agent_sdk import Tool

class SearchKnowledgeBase(Tool):
    name = "search_knowledge_base"
    description = "Search the knowledge base for relevant information"

    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query"
            }
        },
        "required": ["query"]
    }

    async def execute(self, query: str) -> str:
        results = await kb.search(query)
        return format_results(results)
```

## Registering Tools

### In Agent Constructor

```python
from stella_agent_sdk import BaseAgent

class MyAgent(BaseAgent):
    def __init__(self):
        super().__init__()

        # Register tools
        self.register_tool(search_knowledge_base)
        self.register_tool(SearchKnowledgeBase())
        self.register_tool(get_weather)
```

### Using Tool List

```python
class MyAgent(BaseAgent):
    tools = [
        search_knowledge_base,
        get_weather,
        create_ticket
    ]
```

## Tool Parameters

Define parameters using JSON Schema:

```python
@tool
async def create_ticket(
    title: str,
    description: str,
    priority: str = "medium"
) -> dict:
    """Create a support ticket.

    Args:
        title: Ticket title
        description: Detailed description of the issue
        priority: Priority level (low, medium, high)

    Returns:
        The created ticket details
    """
    ticket = await tickets.create(
        title=title,
        description=description,
        priority=priority
    )
    return {"ticket_id": ticket.id, "status": "created"}
```

The SDK automatically generates the JSON Schema:

```json
{
  "name": "create_ticket",
  "description": "Create a support ticket.",
  "parameters": {
    "type": "object",
    "properties": {
      "title": {
        "type": "string",
        "description": "Ticket title"
      },
      "description": {
        "type": "string",
        "description": "Detailed description of the issue"
      },
      "priority": {
        "type": "string",
        "description": "Priority level (low, medium, high)",
        "default": "medium"
      }
    },
    "required": ["title", "description"]
  }
}
```

## Tool Execution Flow

```python
class MyAgent(BaseAgent):
    async def generate_response(self, user_input: str) -> str:
        messages = [
            {"role": "system", "content": self.system_prompt},
            *self.history,
            {"role": "user", "content": user_input}
        ]

        # First call - may include tool calls
        response = await openai.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            tools=self.get_tool_definitions()
        )

        # Handle tool calls
        while response.choices[0].message.tool_calls:
            tool_calls = response.choices[0].message.tool_calls

            # Add assistant message with tool calls
            messages.append(response.choices[0].message)

            # Execute each tool call
            for tool_call in tool_calls:
                # Notify frontend
                await self.send_tool_call(
                    tool_call.function.name,
                    tool_call.function.arguments
                )

                # Execute tool
                result = await self.execute_tool(
                    tool_call.function.name,
                    json.loads(tool_call.function.arguments)
                )

                # Notify frontend of result
                await self.send_tool_result(tool_call.id, result)

                # Add result to messages
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call.id,
                    "content": json.dumps(result)
                })

            # Get next response
            response = await openai.chat.completions.create(
                model="gpt-4o",
                messages=messages,
                tools=self.get_tool_definitions()
            )

        return response.choices[0].message.content
```

## Common Tool Patterns

### Database Search

```python
@tool
async def search_products(
    query: str,
    category: str = None,
    max_results: int = 5
) -> list:
    """Search for products in the catalog."""
    filters = {}
    if category:
        filters["category"] = category

    results = await db.products.search(
        query=query,
        filters=filters,
        limit=max_results
    )

    return [
        {"name": p.name, "price": p.price, "id": p.id}
        for p in results
    ]
```

### API Integration

```python
@tool
async def check_order_status(order_id: str) -> dict:
    """Check the status of an order."""
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{API_URL}/orders/{order_id}") as resp:
            if resp.status == 404:
                return {"error": "Order not found"}
            return await resp.json()
```

### Creating Records

```python
@tool
async def schedule_appointment(
    date: str,
    time: str,
    service: str,
    customer_name: str
) -> dict:
    """Schedule an appointment."""
    appointment = await appointments.create(
        date=date,
        time=time,
        service=service,
        customer_name=customer_name
    )

    return {
        "confirmation_number": appointment.id,
        "date": date,
        "time": time,
        "message": f"Appointment scheduled for {date} at {time}"
    }
```

## Error Handling

```python
@tool
async def get_account_balance(account_id: str) -> dict:
    """Get the balance of an account."""
    try:
        account = await accounts.get(account_id)
        if not account:
            return {"error": "Account not found"}

        return {
            "balance": account.balance,
            "currency": account.currency
        }
    except AuthorizationError:
        return {"error": "Not authorized to access this account"}
    except Exception as e:
        return {"error": f"Failed to retrieve balance: {str(e)}"}
```

## Tool Validation

Add validation to tool parameters:

```python
from stella_agent_sdk import tool, ValidationError

@tool
async def transfer_funds(
    from_account: str,
    to_account: str,
    amount: float
) -> dict:
    """Transfer funds between accounts."""
    # Validate amount
    if amount <= 0:
        raise ValidationError("Amount must be positive")
    if amount > 10000:
        raise ValidationError("Amount exceeds transfer limit")

    # Validate accounts exist
    from_acc = await accounts.get(from_account)
    to_acc = await accounts.get(to_account)

    if not from_acc or not to_acc:
        raise ValidationError("Invalid account")

    # Perform transfer
    result = await transfers.create(
        from_account=from_account,
        to_account=to_account,
        amount=amount
    )

    return {"transfer_id": result.id, "status": "completed"}
```

## Frontend Display

Tools can send updates to the frontend:

```python
@tool
async def search_flights(
    origin: str,
    destination: str,
    date: str
) -> list:
    """Search for available flights."""
    # This will appear in the UI
    await agent.send_status("thinking", f"Searching flights from {origin} to {destination}...")

    flights = await flight_api.search(origin, destination, date)

    return [
        {
            "flight_number": f.number,
            "departure": f.departure_time,
            "arrival": f.arrival_time,
            "price": f.price
        }
        for f in flights
    ]
```

## See Also

- [Base Agent](./base-agent.md)
- [Message Types](./message-types.md)
- [Building Custom Agents](./building-custom-agent.md)
