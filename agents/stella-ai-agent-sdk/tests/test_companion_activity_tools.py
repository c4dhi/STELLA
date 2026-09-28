"""EndActivityTool proposes leaving; it does not end anything (Felix, 29 Sep).

A single misjudged end_activity call used to clear the plan immediately —
this is the tool half of the fix: it no longer touches the state machine at
all. The agent turns the proposal into a confirmation question, and a
separate check on the reply decides whether to actually clear the plan (see
stella_v2_agent.agent._resolve_pending_end_confirmation).
"""

from stella_agent_sdk.tools.companion.activities import (
    EndActivityTool,
    create_companion_tools,
)


async def test_end_activity_only_proposes_it():
    tool = EndActivityTool()
    result = await tool.execute(reason="user seems done")

    assert result.success is True
    assert result.data == {"activity_end_proposed": True, "reason": "user seems done"}


async def test_end_activity_needs_no_state_machine_client():
    # Unlike before, there is nothing to call — clearing the plan happens
    # later, deterministically, once the user has confirmed.
    tool = EndActivityTool()
    result = await tool.execute()
    assert result.success is True


def test_create_companion_tools_end_activity_takes_no_sm_client():
    tools = create_companion_tools(activities=[], sm_client=object())
    end_tool = next(t for t in tools if t.name == "end_activity")
    assert isinstance(end_tool, EndActivityTool)
