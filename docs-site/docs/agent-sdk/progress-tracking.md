---
sidebar_position: 6
title: "📊 Progress Tracking"
---

# 📊 Progress Tracking

The task panel next to the conversation shows where the session stands: its states (groups), their tasks (items), what was collected, and an overall percentage. Your agent sends it a `ProgressState`. There are two ways to build one:

- **From the state machine** (the standard setup). If your agent follows a plan through the STELLA state machine, convert its state with `progress_from_full_state`. Don't build the panel by hand.
- **By hand.** An agent that keeps its own state builds `ProgressState`, `ProgressGroup` and `ProgressItem` itself.

Either way, it is sent the same way: see [Sending progress](#sending-progress).

## From the state machine

`progress_from_full_state` is the one `get_full_state() → ProgressState` transform every first-party agent uses (#310). With it, the task list, the percentage, skipped tasks, goal states and the "branch chosen" indicator look the same whichever agent runs the plan.

:::info Single source of truth
The backend `StateMachineService.getFullState` is the source of truth for progress. The builder is a pure, deterministic adapter from its response to the `ProgressState` the frontend renders. Never re-derive group, task or percentage status in your agent. Hand-written copies drifted before and shipped bugs: a skipped state that vanished from the route view, and an `8000%` percentage.
:::

```python title="my_agent/agent.py"
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, Optional

from stella_agent_sdk import AgentOutput, BaseAgent
from stella_agent_sdk.progress import build_last_transition, progress_from_full_state


class PlanAgent(BaseAgent):
    def __init__(self) -> None:
        super().__init__()
        self._started_at: Optional[str] = None
        self._last_state_id: Optional[str] = None

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        await super().on_session_start(session_id, config)
        self._started_at = datetime.now(timezone.utc).isoformat()
        if self.plan:
            await self.plan_runtime.start(self.plan)

    async def on_ready(self, session_id: str) -> AsyncIterator[AgentOutput]:
        """First snapshot, when the agent joins the room."""
        if not self.plan_runtime.connected:
            return
        full_state = await self.plan_runtime.client.get_full_state()
        if not full_state:
            return
        # The first snapshot has no earlier state, so no transition yet.
        self._last_state_id = full_state.get("current_state_id")
        progress = progress_from_full_state(
            full_state,
            plan=self.plan_runtime.plan,          # fills "Possible Next States"
            session_started_at=self._started_at,
        )
        yield AgentOutput.progress_update(session_id, progress, update_trigger="session_start")

    async def progress_after_turn(self, session_id: str) -> Optional[AgentOutput]:
        """After each turn, with the branch taken when the state changed."""
        full_state = await self.plan_runtime.client.get_full_state()
        if not full_state:
            return None
        current = full_state.get("current_state_id")
        last_transition = build_last_transition(self.plan_runtime.plan, self._last_state_id, current)
        self._last_state_id = current
        progress = progress_from_full_state(
            full_state,
            plan=self.plan_runtime.plan,
            session_started_at=self._started_at,
            extra_metadata={"last_transition": last_transition},
        )
        return AgentOutput.progress_update(session_id, progress, update_trigger="turn_completion")
```

In `process()`, run the turn (the LLM calls the [state machine tools](./tools.md#state-machine-tools)), then yield `await self.progress_after_turn(input.session_id)` when it isn't `None`.

### `progress_from_full_state(...)`

| Parameter | Required | Purpose / when omitted |
|---|---|---|
| `full_state` | yes | The `StateMachineClient.get_full_state()` response dict. |
| `plan` | no | Raw plan config. Fills each state's "Possible Next States". Omit it and the transitions are empty. |
| `session_started_at` | no | ISO timestamp for `started_at` and `elapsed_minutes`. Omit it and they are `None` and `0`. |
| `extra_metadata` | no | Agent-specific top-level metadata merged into the result, e.g. `{"last_transition": ...}` (the "branch chosen" block). |
| `now` | no | Clock override for a deterministic `last_updated` and `elapsed_minutes` (tests). |

It returns a `ProgressState`.

`build_last_transition(plan, from_state_id, to_state_id)` returns the branch the session just took (`from_state_id`, `to_state_id`, `condition_type`, `condition_config`, `priority`). It returns `None` when the state didn't change, or when no single plan transition connects the two states (for example a skip over several states in one turn).

Both are imported from `stella_agent_sdk.progress`. They are additive: an agent that manages its own state can keep building `ProgressState` directly.

## Building progress by hand

```python
from stella_agent_sdk import (
    ExecutionMode,
    GroupStatus,
    ItemStatus,
    ProgressGroup,
    ProgressItem,
    ProgressState,
)

intake = ProgressGroup(
    id="intake",
    label="Intake",
    execution_mode=ExecutionMode.FLEXIBLE,      # any order
    status=GroupStatus.IN_PROGRESS,
    is_current=True,
    items=[
        ProgressItem(id="name", label="Name", status=ItemStatus.COMPLETED, value="Anna"),
        ProgressItem(id="goal", label="What brings you here", status=ItemStatus.IN_PROGRESS),
        ProgressItem(id="phone", label="Phone number", required=False),
    ],
)
consent = ProgressGroup(
    id="consent",
    label="Consent",
    execution_mode=ExecutionMode.SEQUENTIAL,    # strictly in order
    items=[
        ProgressItem(id="privacy", label="Privacy notice"),
        ProgressItem(id="agree", label="Agreement"),
    ],
)

state = ProgressState(groups=[intake, consent], current_group_id="intake", current_item_id="goal")
state.calculate_progress()   # sets and returns progress_percentage: 1 of 5 items done = 20.0
```

### Types

| Type | Fields |
|---|---|
| `ProgressState` | `groups`, `current_group_id`, `current_item_id`, `progress_percentage` (0 to 100), `elapsed_minutes`, `started_at`, `last_updated`, `metadata` |
| `ProgressGroup` | `id`, `label`, `execution_mode`, `status`, `items`, `is_current`, `description`, `completed_at`, `metadata` |
| `ProgressItem` | `id`, `label`, `status`, `description`, `required` (default `True`), `value`, `confidence` (0.0 to 1.0), `collected_at`, `metadata` |

| Enum | Values |
|---|---|
| `ExecutionMode` | `SEQUENTIAL`, `FLEXIBLE` |
| `GroupStatus` | `PENDING`, `IN_PROGRESS`, `COMPLETED` |
| `ItemStatus` | `PENDING`, `IN_PROGRESS`, `COMPLETED`, `SKIPPED` |

Read-only helpers:

- `ProgressState`: `current_group`, `total_items`, `completed_items`, `total_groups`, `completed_groups`, and `calculate_progress()`, which sets `progress_percentage` from the completed items.
- `ProgressGroup`: `total_items`, `completed_items`, and `required_items_completed` (every required item is completed or skipped).

The SDK doesn't change statuses for you. When a task is done, set its `status` (and the group's), call `calculate_progress()`, and send the state again.

Every type has `to_dict()` and `from_dict()`. `to_dict()` is the wire format and leaves out fields that are `None`.

`stella_agent_sdk.progress` also has small builders that use plan wording: `create_state(id, label, execution_mode=..., tasks=[...])` returns a `ProgressGroup`, `create_task(id, label, ...)` and `create_deliverable(id, label, data_type="string", enum_values=...)` return a `ProgressItem`. A deliverable keeps `data_type` and `enum_values` in its `metadata`.

```python
from stella_agent_sdk import ExecutionMode
from stella_agent_sdk.progress import create_deliverable, create_state, create_task

intake = create_state(
    "intake",
    "Intake",
    execution_mode=ExecutionMode.FLEXIBLE,
    tasks=[
        create_task("name", "Name"),
        create_deliverable("plan", "Insurance plan", data_type="enum", enum_values=["basic", "plus"]),
    ],
)
```

:::note Two `PlanState`s
`stella_agent_sdk.progress.PlanState` is an alias for `ProgressGroup`. `stella_agent_sdk.PlanState` (from `stella_agent_sdk.plan`) is the plan's own state type. They are different classes.
:::

## Sending progress

Inside a turn (`process()` or `on_ready()`), yield it:

```python
from stella_agent_sdk import AgentOutput, ProgressState

state = ProgressState()
output = AgentOutput.progress_update("session-1", state, update_trigger="item_collected")
```

`AgentOutput.progress_update(session_id, progress_state, update_trigger="turn_completion", **extra_metadata)` takes a `ProgressState` or the same shape as a dict. It adds `update_trigger` and a `timestamp`. `update_trigger` is a free label for what caused the update, such as `"session_start"`, `"turn_completion"`, `"state_change"` or `"item_collected"`.

Outside a turn (a timer, a background task, a client event), call `publish_progress` on the agent:

```python
from stella_agent_sdk import BaseAgent, ProgressState


class MyAgent(BaseAgent):
    async def on_timer(self, state: ProgressState) -> None:
        await self.publish_progress(state, update_trigger="state_change")
```

`publish_progress` takes a `ProgressState`, its dict, or a ready `AgentOutput.progress_update`. Either way, the SDK keeps the last progress update and sends it again to anyone who joins the room later.

## Status and percentage messages

Two smaller messages exist besides the task panel:

```python
from stella_agent_sdk import AgentOutput, StatusSubtype

AgentOutput.status("session-1", "Searching the knowledge base...", StatusSubtype.THINKING)
AgentOutput.thinking("session-1")                       # "Thinking..."
AgentOutput.progress("session-1", 40, "Uploading")      # a bare percentage, as metadata
```

A status message is shown, never spoken. Whether the agent is listening or speaking is tracked by the SDK itself; you don't send it. See [Message Types](./message-types.md).

## See Also

- [Tools](./tools.md)
- [Message Types](./message-types.md)
- [Base Agent](./base-agent.md)
- [Building Custom Agents](./building-custom-agent.md)
