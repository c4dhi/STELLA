"""Companion-mode tools — how a free-flow agent offers and runs activities.

In companion mode the agent has no plan of its own. It talks freely and, when the
user wants to do something, loads one of the plans the operator allow-listed at
deploy time. It can also drop a running plan at any point and go back to talking.

Three tools, deliberately small:

  list_activities()          what can we do?
  start_activity(id)         load that plan and run it
  end_activity()             stop, whatever we were doing, and talk again

The allow-list is snapshotted into the deploy config, so ``list_activities``
answers locally with no round trip — it runs on the same turn as the reply and
must not add latency. Only starting and ending touch the state machine.
"""

from stella_agent_sdk.tools.companion.activities import (
    ListActivitiesTool,
    StartActivityTool,
    EndActivityTool,
    create_companion_tools,
    COMPANION_TOOL_GUIDANCE,
)

__all__ = [
    "ListActivitiesTool",
    "StartActivityTool",
    "EndActivityTool",
    "create_companion_tools",
    "COMPANION_TOOL_GUIDANCE",
]
