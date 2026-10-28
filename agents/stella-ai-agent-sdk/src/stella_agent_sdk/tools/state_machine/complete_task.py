"""Tool for marking tasks as completed."""

from typing import Any, Dict

from stella_agent_sdk.tools.base import BaseTool, ToolResult
from stella_agent_sdk.tools.state_machine.guidance import STATE_MACHINE_TOOL_GUIDANCE
from stella_agent_sdk.tools.state_machine.result import state_transition_data
from stella_agent_sdk.services.state_machine_client import StateMachineClient


class CompleteTaskTool(BaseTool):
    """
    Mark a task as completed.

    Completion is always an EXPLICIT action you take. Use this whenever you have
    accomplished a task — whether or not it had deliverables. For a task with
    deliverables, record the values with set_deliverable first, then call
    complete_task to tick it off (or use the combined set-and-complete batch tool).
    Nothing completes on its own.
    """

    guidance = STATE_MACHINE_TOOL_GUIDANCE

    def __init__(self, client: StateMachineClient):
        """
        Initialize the tool.

        Args:
            client: StateMachineClient instance
        """
        self._client = client

    @property
    def name(self) -> str:
        return "complete_task"

    @property
    def description(self) -> str:
        return (
            "Mark a task as completed. Call this whenever you have accomplished a "
            "task — with or without deliverables. Tasks never complete on their own; "
            "you must explicitly complete (or skip) each one for the conversation to "
            "advance. For a task with deliverables, set the values first, then "
            "complete it. Use skip_task instead if a task is not needed."
        )

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "The ID of the task to mark as completed"
                },
                "reasoning": {
                    "type": "string",
                    "description": "Brief explanation of how/why the task was completed"
                }
            },
            "required": ["task_id", "reasoning"]
        }

    async def execute(self, task_id: str, reasoning: str) -> ToolResult:
        """
        Execute the tool to complete a task.

        Args:
            task_id: The task ID to complete
            reasoning: Explanation for completion

        Returns:
            ToolResult with success status and any state changes
        """
        pending_tasks = await self._client.get_pending_tasks()
        pending_ids = {t.get("id") for t in pending_tasks if t.get("id")}
        resolved_task_id = task_id

        # The model occasionally sends task descriptions instead of IDs.
        # Recover safely only when the description maps to exactly one pending task.
        if resolved_task_id not in pending_ids:
            matches = [t for t in pending_tasks if t.get("description") == task_id]
            if len(matches) == 1 and matches[0].get("id"):
                resolved_task_id = matches[0]["id"]
            else:
                return ToolResult(
                    success=False,
                    error=(
                        f"Invalid task_id '{task_id}'. Use an exact task ID from pending tasks."
                    ),
                )

        result = await self._client.complete_task(resolved_task_id, reasoning)

        if not result["success"]:
            return ToolResult(
                success=False,
                error=result.get("error", "Failed to complete task")
            )

        return ToolResult(
            success=True,
            data={
                "task_id": resolved_task_id,
                "task_completed": result.get("task_completed"),
                **state_transition_data(result),
            }
        )
