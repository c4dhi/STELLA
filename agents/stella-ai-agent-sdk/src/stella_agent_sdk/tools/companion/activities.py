"""The three companion tools and their registry factory."""

import logging
from typing import Any, Dict, List, Optional

from stella_agent_sdk.tools.base import BaseTool, ToolResult

logger = logging.getLogger(__name__)


# Appended to a companion router's prompt from the SDK, so the contract lives in
# one place rather than being hand-copied into each deployment's expert config —
# the same arrangement STATE_MACHINE_TOOL_GUIDANCE uses.
COMPANION_TOOL_GUIDANCE = """
ACTIVITY TOOLS — use them only when the user's intent is unmistakable.

- `list_activities` — the user asked what they can do, what is available, or is
  casting about for something to do. Cheap and read-only; calling it does not
  commit the user to anything.
- `start_activity` — the user has clearly CHOSEN one. A name they said, or an
  unambiguous "yes" to one you just offered. Never start an activity because it
  seemed like a good idea, and never start one they have not agreed to: it takes
  over the conversation, and taking it back costs the user a turn.
- `end_activity` — the user clearly and explicitly wants to stop, leave, change
  subject, or is plainly finished. A downbeat or ambiguous answer that is still
  on topic is not a request to leave — require an unmistakable one.

Call NO tool for ordinary conversation. That is the common case.
"""


class ListActivitiesTool(BaseTool):
    """What the user can choose from.

    Answers from the deploy-time snapshot rather than a backend call: this runs
    inside a conversational turn, and an activity list is fixed for the life of
    the deployment, so a round trip would buy nothing but latency.
    """

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
                "activities": [
                    {
                        "id": a.get("id"),
                        "title": a.get("title") or a.get("name") or "Untitled",
                        "description": a.get("description") or "",
                    }
                    for a in self._activities
                ],
                # Surfaced so the reply can name the options instead of the model
                # inventing them; see the agent's directive assembly.
                "offer_activities": True,
            },
        )


class StartActivityTool(BaseTool):
    """Load a chosen plan and hand the conversation over to it."""

    def __init__(self, activities: List[Dict[str, Any]], sm_client):
        self._activities = activities
        self._sm_client = sm_client

    @property
    def name(self) -> str:
        return "start_activity"

    @property
    def description(self) -> str:
        return (
            "Start an activity the user has explicitly chosen. Only call once "
            "they have named it or clearly agreed to one you offered."
        )

    @property
    def parameters_schema(self) -> Dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "activity_id": {
                    "type": "string",
                    "description": "id of the activity, from list_activities",
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

        plan = activity.get("plan")
        if not plan:
            return ToolResult(
                success=False,
                error=f"Activity '{activity_id}' has no plan attached",
            )

        if not self._sm_client:
            return ToolResult(success=False, error="No state machine available")

        # The router isn't reliable at telling "the user just chose this" from
        # "the user is answering the question this activity already asked"
        # (#36) — confirmed empirically, prompt wording doesn't fix it. So this
        # checks the actual running state rather than trusting the call.
        #
        # Blocks on ANY activity already being active, not just a repeat of the
        # SAME one: a same-id-only check was tried first and gave 0% protection
        # on the actual reproduction case — the model doesn't reliably repeat
        # the running activity's own id, it calls start_activity with a
        # DIFFERENT (wrong) one instead (Felix, 29 Sep — confirmed 20/20 trials
        # requested a different id, never the running one). Reloading on ANY of
        # these resets the plan to its first state and discards whatever it
        # already collected, for a call that reflects no real new choice either
        # way. To switch activities deliberately, the router has to end the
        # running one first (already gated behind its own confirmation step) —
        # not jump straight from one to another in a single call.
        full_state = await self._sm_client.get_full_state()
        running_plan_id = full_state.get("plan_id") if full_state else None
        if running_plan_id:
            running = self._find(running_plan_id) or {}
            running_title = running.get("title") or running_plan_id
            logger.info(
                "start_activity('%s') called while '%s' is already running — ignored",
                activity.get("title"), running_title,
            )
            return ToolResult(
                success=True,
                data={
                    "activity_already_running": True,
                    "activity_id": running_plan_id,
                    "activity_title": running_title,
                },
            )

        result = await self._sm_client.load_plan(plan)
        if not result or not result.get("success"):
            return ToolResult(
                success=False,
                error=(result or {}).get("error") or "Failed to load the activity",
            )

        logger.info("Started activity '%s'", activity.get("title"))
        return ToolResult(
            success=True,
            data={
                # `activity_started` is what the agent watches for to switch out of
                # free-flow; the runner already surfaces unknown data keys verbatim.
                "activity_started": True,
                "activity_id": activity.get("id"),
                "activity_title": activity.get("title"),
                "current_state_id": result.get("current_state_id"),
            },
        )


class EndActivityTool(BaseTool):
    """Propose leaving the running plan — does not clear it.

    Ending used to be immediate, which meant a single misjudged call by the
    router (a downbeat but on-topic reply, mistaken for a stop request) threw
    the user out of the activity with no way back. It now only PROPOSES
    leaving; the agent turns that into a direct yes/no question, and a
    separate, narrowly-scoped check on the reply decides whether to actually
    clear the plan. The router keeps its own judgment for deciding SOMETHING
    stop-shaped happened; it no longer gets the last word on whether it really
    was one.
    """

    @property
    def name(self) -> str:
        return "end_activity"

    @property
    def description(self) -> str:
        return (
            "Propose stopping the current activity — does not end it immediately, "
            "the user is asked to confirm first. Call ONLY on a clear, explicit "
            "request to stop, leave, or move on — not for a downbeat or ambiguous "
            "answer that is still on topic for what was just asked. Can be called "
            "mid-activity."
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
        logger.info("Proposed ending activity (%s)", reason or "no reason given")
        return ToolResult(success=True, data={"activity_end_proposed": True, "reason": reason})


def create_companion_tools(
    activities: List[Dict[str, Any]],
    sm_client,
) -> List[BaseTool]:
    """Build the companion toolset for one session."""
    return [
        ListActivitiesTool(activities),
        StartActivityTool(activities, sm_client),
        EndActivityTool(),
    ]
