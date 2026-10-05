"""The companion tools only PROPOSE a transition; the agent applies it.

They used to act: start_activity loaded the plan from inside the Expert Pool,
racing the other experts' writes, and needed its own guard against restarting a
running activity. Now each returns a ``command`` and touches nothing, so whether
a start or stop is valid is decided in one place, against the session's actual
mode (stella_v2_agent.companion).
"""

import pytest

from stella_v2_agent.companion_tools import (
    COMPANION_TOOL_GUIDANCE,
    EndActivityTool,
    ListActivitiesTool,
    StartActivityTool,
    create_companion_tools,
)

ACTIVITIES = [
    {
        "id": "act-1",
        "title": "Fitness Check-in",
        "description": "A quick check-in on your fitness goals",
        "plan": {"id": "act-1"},
    },
    {"id": "act-2", "title": "Memory Game", "description": "", "plan": {"id": "act-2"}},
]


def _idle():
    return None


def _running():
    return "Fitness Check-in"


@pytest.mark.asyncio
async def test_list_activities_proposes_offering_them():
    result = await ListActivitiesTool(ACTIVITIES).execute()
    assert result.data["command"] == "list"
    assert [a["id"] for a in result.data["activities"]] == ["act-1", "act-2"]


@pytest.mark.asyncio
async def test_start_activity_proposes_the_chosen_one_and_loads_nothing():
    result = await StartActivityTool(ACTIVITIES, _idle).execute(activity_id="act-2")
    assert result.success is True
    assert result.data == {
        "command": "start",
        "activity_id": "act-2",
        "activity_title": "Memory Game",
    }


@pytest.mark.asyncio
async def test_start_activity_accepts_a_title_for_an_id():
    result = await StartActivityTool(ACTIVITIES, _idle).execute(activity_id="memory game")
    assert result.data["activity_id"] == "act-2"


@pytest.mark.asyncio
async def test_start_activity_rejects_an_unknown_id():
    result = await StartActivityTool(ACTIVITIES, _idle).execute(activity_id="nope")
    assert result.success is False
    assert "act-1" in result.error


def test_start_activity_schema_pairs_ids_with_titles_and_descriptions():
    # The reply offers activities by description ("a quick check-in on your
    # fitness goals"), so the user picks by description. Titles alone sent
    # "the fitness goals" to the wrong activity (Felix, 29 Sep).
    schema = StartActivityTool(ACTIVITIES, _idle).parameters_schema
    description = schema["properties"]["activity_id"]["description"]
    assert 'act-1 = "Fitness Check-in" (A quick check-in on your fitness goals)' in description
    assert 'act-2 = "Memory Game"' in description
    assert schema["properties"]["activity_id"]["enum"] == ["act-1", "act-2"]


def test_descriptions_state_whether_an_activity_is_running():
    # Only the router carries these tools, so this is how it learns an activity
    # is running without that fact entering any other expert's history.
    idle_start = StartActivityTool(ACTIVITIES, _idle).description
    busy_start = StartActivityTool(ACTIVITIES, _running).description
    assert "already running" not in idle_start
    assert '"Fitness Check-in" is already running' in busy_start

    assert "nothing to stop" in EndActivityTool(_idle).description
    assert '"Fitness Check-in"' in EndActivityTool(_running).description


@pytest.mark.asyncio
async def test_end_activity_only_proposes_stopping():
    result = await EndActivityTool(_running).execute(reason="user said stop")
    assert result.data == {"command": "stop", "reason": "user said stop"}


def test_every_companion_tool_carries_the_companion_guidance():
    tools = create_companion_tools(ACTIVITIES, _idle)
    assert {t.name for t in tools} == {"list_activities", "start_activity", "end_activity"}
    assert all(t.guidance == COMPANION_TOOL_GUIDANCE for t in tools)


def test_the_guidance_does_not_treat_a_change_of_subject_as_stopping():
    # It used to list "change subject" as a reason to end — the opposite of what
    # the router's own prompt said, and a cause of unprovoked exits.
    assert "change subject" not in COMPANION_TOOL_GUIDANCE
