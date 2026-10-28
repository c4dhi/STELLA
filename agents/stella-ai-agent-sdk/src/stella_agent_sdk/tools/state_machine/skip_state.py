"""Tool for skipping the remainder of the current state."""

from typing import Any, Dict

from stella_agent_sdk.tools.base import BaseTool, ToolResult
from stella_agent_sdk.tools.state_machine.guidance import STATE_MACHINE_TOOL_GUIDANCE
from stella_agent_sdk.tools.state_machine.result import state_transition_data
from stella_agent_sdk.services.state_machine_client import StateMachineClient


class SkipStateTool(BaseTool):
    """
    Skip the rest of the current state.

    Marks every not-yet-addressed task in the current state as skipped and
    advances to the next state. Use this when an entire phase is not relevant to
    this conversation and you want to move on without addressing its tasks one by
    one.
    """

    guidance = STATE_MACHINE_TOOL_GUIDANCE

    def __init__(self, client: StateMachineClient):
        self._client = client

    @property
    def name(self) -> str:
        return "skip_state"

    @property
    def description(self) -> str:
        return (
            "Skip the entire current phase/state and move on. This marks all of "
            "its remaining tasks as skipped and advances to the next state. Use it "
            "when the whole phase does not apply to this conversation — otherwise "
            "address tasks individually with complete_task / skip_task."
        )

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "reasoning": {
                    "type": "string",
                    "description": "Brief explanation of why the whole state is being skipped"
                }
            },
            "required": ["reasoning"]
        }

    async def execute(self, reasoning: str) -> ToolResult:
        # Always targets the current state (the backend rejects skipping a
        # non-current state), so no state_id needs to be passed by the model.
        result = await self._client.skip_state("", reasoning)

        if not result["success"]:
            return ToolResult(
                success=False,
                error=result.get("error", "Failed to skip state")
            )

        return ToolResult(
            success=True,
            data={
                "state_skipped": result.get("state_skipped"),
                "tasks_skipped": result.get("tasks_skipped", []),
                **state_transition_data(result),
            }
        )
