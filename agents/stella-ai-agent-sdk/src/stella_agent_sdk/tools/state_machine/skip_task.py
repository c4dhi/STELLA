"""Tool for skipping a single task the agent judges unnecessary."""

from typing import Any, Dict

from stella_agent_sdk.tools.base import BaseTool, ToolResult
from stella_agent_sdk.tools.state_machine.guidance import STATE_MACHINE_TOOL_GUIDANCE
from stella_agent_sdk.tools.state_machine.result import state_transition_data
from stella_agent_sdk.services.state_machine_client import StateMachineClient


class SkipTaskTool(BaseTool):
    """
    Skip a single task.

    Use this when a task is not relevant or not worth pursuing in the current
    conversation. Skipping addresses the task (just like completing it) so the
    state can advance once every task has been completed or skipped. ``required``
    is advisory only — you may skip any task, including required ones, when it
    genuinely does not apply.
    """

    guidance = STATE_MACHINE_TOOL_GUIDANCE

    def __init__(self, client: StateMachineClient):
        self._client = client

    @property
    def name(self) -> str:
        return "skip_task"

    @property
    def description(self) -> str:
        return (
            "Skip a task you have decided not to pursue (not relevant, already "
            "covered, or unnecessary). Skipping counts as addressing the task, the "
            "same way completing does, so the conversation can move on. You may skip "
            "any task; 'required' is only a hint about importance, not a hard gate."
        )

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "The ID of the task to skip"
                },
                "reasoning": {
                    "type": "string",
                    "description": "Brief explanation of why the task is being skipped"
                }
            },
            "required": ["task_id", "reasoning"]
        }

    async def execute(self, task_id: str, reasoning: str) -> ToolResult:
        pending_tasks = await self._client.get_pending_tasks()
        pending_ids = {t.get("id") for t in pending_tasks if t.get("id")}
        resolved_task_id = task_id

        # The model occasionally sends a description instead of an ID; recover only
        # when it maps to exactly one pending task.
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

        result = await self._client.skip_task(resolved_task_id, reasoning)

        if not result["success"]:
            return ToolResult(
                success=False,
                error=result.get("error", "Failed to skip task")
            )

        return ToolResult(
            success=True,
            data={
                "task_id": resolved_task_id,
                "task_skipped": result.get("task_skipped"),
                **state_transition_data(result),
            }
        )
