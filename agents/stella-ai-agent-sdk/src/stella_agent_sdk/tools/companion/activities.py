"""The three companion tools and their registry factory.

They only PROPOSE. Each returns a ``command`` in its result data and touches
nothing; the agent decides, against the session's actual mode, whether to act on
it. So the tools cannot race the other experts in the same turn, cannot restart
a running activity, and cannot leave a half-applied transition behind — the
agent applies at most one transition per turn, after every expert has finished.
"""

import logging
from typing import Any, Callable, Dict, List, Optional

from stella_agent_sdk.tools.base import BaseTool, ToolResult

logger = logging.getLogger(__name__)


COMPANION_TOOL_GUIDANCE = """
ACTIVITY TOOLS — use them only when the user's intent is unmistakable. Call NO
tool for ordinary conversation: that is the common case.

- `list_activities` — the user asked what they can do, or is looking for
  something to do. Read-only; it commits them to nothing.
- `start_activity` — the user has clearly CHOSEN one: named it, described it, or
  said an unambiguous yes to one just offered. Unsure which one they meant? Call
  no tool, and let the reply ask.
- `end_activity` — the user clearly wants to stop the running activity. Answering
  its questions — briefly, reluctantly, or with a complaint about how it is going
  — is taking part, not stopping. The user is asked to confirm before anything
  ends.

Call no more than one tool per turn.
"""

# Who is running right now, as the title of the running activity or None.
RunningActivity = Callable[[], Optional[str]]


def _activity_view(activity: Dict[str, Any]) -> Dict[str, str]:
    return {
        "id": activity.get("id") or "",
        "title": activity.get("title") or activity.get("name") or "Untitled",
        "description": activity.get("description") or "",
    }


class ListActivitiesTool(BaseTool):
    """What the user can choose from, answered from the deploy-time snapshot."""

    guidance = COMPANION_TOOL_GUIDANCE

    def __init__(self, activities: List[Dict[str, Any]]):
        self._activities = activities

    @property
    def name(self) -> str:
        return "list_activities"

    @property
    def description(self) -> str:
        return (
            "List the activities available to the user. Call when they ask what "
            "you can do together, or are looking for something to do."
        )

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(self, **_kwargs) -> ToolResult:
        return ToolResult(
            success=True,
            data={
                "command": "list",
                "activities": [_activity_view(a) for a in self._activities],
            },
        )


class StartActivityTool(BaseTool):
    """Propose starting the activity the user chose."""

    guidance = COMPANION_TOOL_GUIDANCE

    def __init__(self, activities: List[Dict[str, Any]], running: RunningActivity):
        self._activities = activities
        self._running = running

    @property
    def name(self) -> str:
        return "start_activity"

    @property
    def description(self) -> str:
        running = self._running()
        if running:
            return (
                f'"{running}" is already running, so there is nothing to start: '
                "the user is taking part in it. Do not call this."
            )
        return (
            "Start the activity the user has explicitly chosen — named, described, "
            "or clearly agreed to when offered."
        )

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        # Titles AND descriptions: the reply offers activities in its own words,
        # usually from their descriptions ("a quick check-in on your fitness
        # goals"), so the user picks by description too. With titles alone the
        # router matched "fitness goals" to the only title containing "Fitness",
        # which was the other activity (Felix, 29 Sep).
        options = "; ".join(
            f'{v["id"]} = "{v["title"]}"' + (f' ({v["description"]})' if v["description"] else "")
            for v in map(_activity_view, self._activities)
            if v["id"]
        )
        return {
            "type": "object",
            "properties": {
                "activity_id": {
                    "type": "string",
                    "description": f"id of the activity the user chose. The options: {options}",
                    "enum": [a.get("id") for a in self._activities if a.get("id")],
                },
            },
            "required": ["activity_id"],
        }

    def _find(self, activity_id: str) -> Optional[Dict[str, Any]]:
        for a in self._activities:
            if a.get("id") == activity_id:
                return a
        # Tolerate a title where an id was asked for: the model has both in
        # context and confusing them is a likelier failure than a wrong choice.
        for a in self._activities:
            if (a.get("title") or "").lower() == (activity_id or "").lower():
                return a
        return None

    async def execute(self, activity_id: str = "", **_kwargs) -> ToolResult:
        activity = self._find(activity_id)
        if not activity:
            known = ", ".join(a.get("id", "?") for a in self._activities)
            return ToolResult(
                success=False,
                error=f"Unknown activity '{activity_id}'. Available: {known}",
            )
        return ToolResult(
            success=True,
            data={
                "command": "start",
                "activity_id": activity.get("id"),
                "activity_title": activity.get("title"),
            },
        )


class EndActivityTool(BaseTool):
    """Propose stopping the running activity; the user confirms before it ends."""

    guidance = COMPANION_TOOL_GUIDANCE

    def __init__(self, running: RunningActivity):
        self._running = running

    @property
    def name(self) -> str:
        return "end_activity"

    @property
    def description(self) -> str:
        running = self._running()
        if not running:
            return "No activity is running, so there is nothing to stop. Do not call this."
        return (
            f'Propose stopping "{running}", which is running right now. Call ONLY on '
            "a clear, explicit request to stop or leave it — not for a short, "
            "downbeat, or critical answer that is still taking part. The user is "
            "asked to confirm before it ends."
        )

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Brief note on why, for the log",
                },
            },
        }

    async def execute(self, reason: str = "", **_kwargs) -> ToolResult:
        return ToolResult(success=True, data={"command": "stop", "reason": reason})


def create_companion_tools(
    activities: List[Dict[str, Any]],
    running: RunningActivity,
) -> List[BaseTool]:
    """Build the companion toolset for one session.

    ``running`` is read each time a schema is built, so the tool descriptions
    always state whether an activity is running — only the router carries these
    tools, which keeps that fact out of every other expert's context.
    """
    return [
        ListActivitiesTool(activities),
        StartActivityTool(activities, running),
        EndActivityTool(running),
    ]
