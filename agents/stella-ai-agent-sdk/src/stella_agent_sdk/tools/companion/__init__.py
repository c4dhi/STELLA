"""Companion-mode tools — how a free-flow agent offers and runs activities.

In companion mode the agent has no plan of its own. It talks freely and, when the
user wants to do something, loads one of the plans the operator allow-listed at
deploy time. It can also drop a running plan at any point and go back to talking.

Three tools, deliberately small, and all three only PROPOSE:

  list_activities()          what can we do?
  start_activity(id)         run that plan
  end_activity()             stop the running one (the user confirms first)

Each returns a ``command``; the agent applies it against the session's mode. No
tool touches the state machine.
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
