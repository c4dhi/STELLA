---
sidebar_position: 6
title: "📊 Progress Tracking"
---

# 📊 Progress Tracking

STELLA agents can track and display progress through todo lists and progress updates, keeping users informed about ongoing tasks.

## State machine–backed progress (recommended)

Agents that drive their plan through the STELLA **state machine** (the standard setup) should **not** hand-build progress payloads. Instead, fetch the authoritative state and convert it with the SDK's single canonical builder, `progress_from_full_state`. This is the **one** `get_full_state() → ProgressState` transform shared by every first-party agent (#310), so the to-do list, percentage, skip handling, goal states, and the "branch chosen" indicator render identically no matter which agent runs the plan.

:::info Single source of truth
The backend `StateMachineService.getFullState` is the source of truth for progress. The builder is a pure, deterministic adapter from its response to the `ProgressState` the frontend renders. **Never re-derive group/task/percentage status in your agent** — that hand-maintained drift is exactly what `progress_from_full_state` exists to prevent (it previously produced bugs like a skipped state disappearing from the route view and an `8000%` percentage).
:::

### Emitting progress

```python
from stella_agent_sdk.agent.base import BaseAgent
from stella_agent_sdk.messages.output import AgentOutput
from stella_agent_sdk.progress import progress_from_full_state, build_last_transition


class MyAgent(BaseAgent):
    async def on_ready(self, session_id: str):
        """Initial snapshot when the agent joins the room."""
        full_state = await self.sm_client.get_full_state()
        if full_state:
            # Anchor the transition tracker; the first snapshot has no prior state.
            self._last_known_state_id = full_state.get("current_state_id")
            progress = progress_from_full_state(
                full_state,
                plan=self._plan_config,                      # → "Possible Next States"
                session_started_at=self._session_started_at,
            )
            yield AgentOutput.progress_update(
                session_id, progress,
                update_trigger="session_start",
                agent_name="my-agent", agent_icon="🤖",
            )

    async def _emit_progress(self, session_id: str):
        """After each turn — include the 'branch chosen' when the state changed."""
        full_state = await self.sm_client.get_full_state()
        if not full_state:
            return
        current = full_state.get("current_state_id")
        last_transition = build_last_transition(
            self._plan_config, self._last_known_state_id, current
        )
        self._last_known_state_id = current
        progress = progress_from_full_state(
            full_state,
            plan=self._plan_config,
            session_started_at=self._session_started_at,
            extra_metadata={"last_transition": last_transition},
        )
        yield AgentOutput.progress_update(
            session_id, progress,
            update_trigger="turn_completion",
            agent_name="my-agent", agent_icon="🤖",
        )
```

### `progress_from_full_state(...)`

| Parameter | Required | Purpose / when omitted |
|---|---|---|
| `full_state` | **yes** | The `StateMachineClient.get_full_state()` response dict. |
| `plan` | no | Raw plan config — populates each state's **"Possible Next States"** preview. Omit → empty transitions. |
| `session_started_at` | no | ISO timestamp → `started_at` + `elapsed_minutes`. Omit → `None` / `0`. |
| `extra_metadata` | no | Agent-specific top-level metadata merged into the payload, e.g. `{"last_transition": ...}` (the **"branch chosen"** block) or your own architecture tag. |
| `now` | no | Clock override for deterministic `last_updated` / `elapsed_minutes` (tests). |

It returns a `ProgressState`; pass it straight to `AgentOutput.progress_update`, which accepts a `ProgressState` **or** an equivalent dict.

`build_last_transition(plan, from_state_id, to_state_id)` returns the branch the session just took (`{from_state_id, to_state_id, condition_type, condition_config, priority}`), or `None` when nothing changed or no single plan transition directly connects the two states (e.g. a multi-state skip in one turn).

### Do existing custom agents need to change?

**No.** `progress_from_full_state` and `build_last_transition` are additive exports — nothing in the SDK forces them, and the `ProgressState` / `ProgressGroup` / `ProgressItem` models are unchanged. Adopt the builder only if your agent uses the STELLA state machine and you want the canonical behaviour (correct skip rendering, 0–100 percentage, goal-state handling, the branch indicator) for free. An agent that manages its **own** state can keep constructing `ProgressState` directly.

## Todo Lists

Todo lists help structure conversations and show users what tasks the agent is working on.

### TodoItem Structure

```python
from stella_agent_sdk import TodoItem

item = TodoItem(
    id="task-1",                    # Unique identifier
    description="Gather user info", # What the task is
    status="in_progress",           # pending | in_progress | completed
    required=True                   # Whether task is required
)
```

### Sending Todo Updates

```python
from stella_agent_sdk import TodoItem

async def update_tasks(self):
    await self.update_todo([
        TodoItem(
            id="1",
            description="Understand user request",
            status="completed"
        ),
        TodoItem(
            id="2",
            description="Search knowledge base",
            status="in_progress"
        ),
        TodoItem(
            id="3",
            description="Provide solution",
            status="pending"
        )
    ])
```

### Status Transitions

```python
async def process_request(self, user_input: str):
    # Mark task as in progress
    await self.update_task_status("search", "in_progress")

    # Do the work
    results = await self.search(user_input)

    # Mark complete, start next
    await self.update_task_status("search", "completed")
    await self.update_task_status("respond", "in_progress")

    # Generate response
    response = await self.generate_response(results)

    await self.update_task_status("respond", "completed")
    return response
```

### Helper Class

```python
from stella_agent_sdk import TodoList

class TaskTracker:
    def __init__(self, agent):
        self.agent = agent
        self.tasks = TodoList()

    async def add_task(self, task_id: str, description: str, required: bool = False):
        self.tasks.add(TodoItem(
            id=task_id,
            description=description,
            status="pending",
            required=required
        ))
        await self.agent.update_todo(self.tasks.items)

    async def start_task(self, task_id: str):
        self.tasks.update_status(task_id, "in_progress")
        await self.agent.update_todo(self.tasks.items)

    async def complete_task(self, task_id: str):
        self.tasks.update_status(task_id, "completed")
        await self.agent.update_todo(self.tasks.items)

    @property
    def all_required_complete(self) -> bool:
        return self.tasks.all_required_complete
```

## Progress Updates

For long-running tasks, send progress updates:

```python
async def process_large_file(self, file_data: bytes):
    total_chunks = len(file_data) // CHUNK_SIZE

    for i, chunk in enumerate(chunks(file_data, CHUNK_SIZE)):
        # Process chunk
        await self.process_chunk(chunk)

        # Send progress
        progress = ((i + 1) / total_chunks) * 100
        await self.send_progress(
            task_id="file-processing",
            progress=progress,
            message=f"Processing chunk {i + 1} of {total_chunks}"
        )
```

### Progress Message Format

```typescript
{
  type: 'progress_update',
  data: {
    task_id: string,    // Matches a todo item ID
    progress: number,   // 0-100
    message?: string    // Optional status message
  }
}
```

## Agent Status

Keep users informed of what the agent is doing:

```python
async def handle_request(self, text: str):
    # Show we're processing
    await self.send_status("thinking", "Analyzing your request...")

    # Search phase
    await self.send_status("thinking", "Searching knowledge base...")
    results = await self.search(text)

    # Generate response
    await self.send_status("thinking", "Generating response...")
    response = await self.generate_response(results)

    # Speaking
    await self.send_status("speaking")
    await self.speak(response)

    # Back to listening
    await self.send_status("listening")
```

### Status Types

| Status | Description |
|--------|-------------|
| `ready` | Agent is ready but not yet engaged |
| `listening` | Agent is listening for user input |
| `thinking` | Agent is processing/generating |
| `speaking` | Agent is speaking a response |
| `error` | An error occurred |

## Complete Example

```python
from stella_agent_sdk import BaseAgent, TodoItem

class TaskAgent(BaseAgent):
    def __init__(self):
        super().__init__()
        self.tasks = []

    async def on_connect(self):
        # Set up initial tasks
        self.tasks = [
            TodoItem(id="greet", description="Greet user", status="in_progress"),
            TodoItem(id="gather", description="Gather requirements", status="pending"),
            TodoItem(id="process", description="Process request", status="pending"),
            TodoItem(id="respond", description="Provide solution", status="pending")
        ]
        await self.update_todo(self.tasks)

        # Complete greeting
        await self.speak("Hello! I'm here to help you today.")
        await self.complete_task("greet")

        await self.send_status("listening")

    async def on_transcript(self, text: str, is_final: bool):
        if not is_final:
            return

        # Gathering requirements
        await self.start_task("gather")
        await self.send_status("thinking", "Understanding your request...")

        # Analyze the request
        intent = await self.analyze_intent(text)
        await self.complete_task("gather")

        # Process the request
        await self.start_task("process")
        await self.send_status("thinking", "Working on your request...")

        result = await self.process_intent(intent)
        await self.complete_task("process")

        # Provide response
        await self.start_task("respond")
        await self.send_status("speaking")

        await self.speak(result)
        await self.complete_task("respond")

        await self.send_status("listening")

    async def start_task(self, task_id: str):
        for task in self.tasks:
            if task.id == task_id:
                task.status = "in_progress"
        await self.update_todo(self.tasks)

    async def complete_task(self, task_id: str):
        for task in self.tasks:
            if task.id == task_id:
                task.status = "completed"
        await self.update_todo(self.tasks)

    async def analyze_intent(self, text: str) -> dict:
        # Your intent analysis logic
        pass

    async def process_intent(self, intent: dict) -> str:
        # Your processing logic
        pass
```

## Frontend Integration

The frontend displays progress information:

```typescript
// React example
function AgentProgress({ todos, status }) {
  return (
    <div className="agent-progress">
      <div className="status">
        {status.status === 'thinking' && <Spinner />}
        {status.message}
      </div>

      <ul className="todo-list">
        {todos.map(item => (
          <li key={item.id} className={item.status}>
            {item.status === 'completed' && '✓'}
            {item.status === 'in_progress' && <Spinner small />}
            {item.description}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

## See Also

- [Message Types](./message-types.md)
- [Base Agent](./base-agent.md)
- [Building Custom Agents](./building-custom-agent.md)
