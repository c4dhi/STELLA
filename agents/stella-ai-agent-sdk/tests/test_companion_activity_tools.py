"""EndActivityTool proposes leaving; it does not end anything (Felix, 29 Sep).

A single misjudged end_activity call used to clear the plan immediately —
this is the tool half of the fix: it no longer touches the state machine at
all. The agent turns the proposal into a confirmation question, and a
separate check on the reply decides whether to actually clear the plan (see
stella_v2_agent.agent._resolve_pending_end_confirmation).

StartActivityTool's guard (also Felix, 29 Sep, #36) is a separate fix: the
router isn't reliable at telling "the user just chose this activity" from
"the user is answering the question this activity already asked" — confirmed
empirically (80/80 trials across four prompt variants still misfired). So the
tool checks the actual running state itself rather than trusting the call.

It blocks ANY start_activity while one is already running, not just a repeat
of the same id: a same-id-only version was tried first and gave 0%
protection on the actual reproduction case — the model doesn't reliably
repeat the running activity's own id when it misfires, it calls
start_activity with a DIFFERENT (wrong) one instead (confirmed 20/20 trials).
Reloading on any of these resets the plan to its first state and discards
whatever it already collected. Switching activities deliberately has to go
through end_activity first (already gated behind its own confirmation step).
"""

from types import SimpleNamespace

from stella_agent_sdk.tools.companion.activities import (
    EndActivityTool,
    StartActivityTool,
    create_companion_tools,
)

ACTIVITIES = [
    {"id": "act-1", "title": "Fitness Check-in", "plan": {"id": "act-1", "title": "Fitness Check-in"}},
    {"id": "act-2", "title": "Memory Game", "plan": {"id": "act-2", "title": "Memory Game"}},
]


def _sm_client(full_state=None, load_plan_result=None):
    async def get_full_state():
        return full_state

    async def load_plan(plan):
        return load_plan_result or {"success": True, "current_state_id": "s1"}

    return SimpleNamespace(get_full_state=get_full_state, load_plan=load_plan)


async def test_start_activity_already_running_is_a_no_op():
    sm_client = _sm_client(full_state={"plan_id": "act-1"})
    tool = StartActivityTool(ACTIVITIES, sm_client)

    result = await tool.execute(activity_id="act-1")

    assert result.success is True
    assert result.data == {
        "activity_already_running": True,
        "activity_id": "act-1",
        "activity_title": "Fitness Check-in",
    }


async def test_start_activity_requesting_a_different_activity_while_one_runs_is_also_a_no_op():
    # The actual failure mode (#36): the router doesn't reliably repeat the
    # running activity's own id, it calls start_activity with a DIFFERENT
    # (wrong) one. A same-id-only guard gives 0% protection here — this one
    # blocks on ANY activity already running, reporting the one actually
    # running (act-1), not the wrongly-requested one (act-2).
    sm_client = _sm_client(full_state={"plan_id": "act-1"})
    tool = StartActivityTool(ACTIVITIES, sm_client)

    result = await tool.execute(activity_id="act-2")

    assert result.success is True
    assert result.data == {
        "activity_already_running": True,
        "activity_id": "act-1",
        "activity_title": "Fitness Check-in",
    }


async def test_start_activity_not_yet_running_loads_the_plan():
    sm_client = _sm_client(full_state={"plan_id": None})
    tool = StartActivityTool(ACTIVITIES, sm_client)

    result = await tool.execute(activity_id="act-1")

    assert result.success is True
    assert result.data["activity_started"] is True
    assert result.data["activity_id"] == "act-1"


async def test_start_activity_after_the_running_one_is_actually_cleared_loads_normally():
    # Once nothing is running (plan_id gone — the agent clears it via
    # end_activity's confirmation flow before adopting a new one), a start
    # call goes through normally. Switching activities is still possible,
    # just not in a single unguarded call.
    sm_client = _sm_client(full_state={"plan_id": None})
    tool = StartActivityTool(ACTIVITIES, sm_client)

    result = await tool.execute(activity_id="act-2")

    assert result.success is True
    assert result.data["activity_started"] is True
    assert result.data["activity_id"] == "act-2"


def test_start_activity_schema_labels_each_id_with_its_title():
    # The model has nothing else pairing an opaque id to what it means (#36
    # follow-up, 29 Sep) — confirmed empirically that a bare-uuid enum is why
    # it picks the wrong activity when it does call this tool. The enum
    # itself stays ids-only (still the field the tool call needs); the
    # description is where the pairing lives.
    tool = StartActivityTool(ACTIVITIES, _sm_client())
    schema = tool.parameters_schema
    description = schema["properties"]["activity_id"]["description"]
    assert 'act-1 = "Fitness Check-in"' in description
    assert 'act-2 = "Memory Game"' in description
    assert schema["properties"]["activity_id"]["enum"] == ["act-1", "act-2"]


async def test_start_activity_no_full_state_loads_the_plan():
    # get_full_state() returning None (no plan row yet) must not crash the guard.
    sm_client = _sm_client(full_state=None)
    tool = StartActivityTool(ACTIVITIES, sm_client)

    result = await tool.execute(activity_id="act-1")

    assert result.success is True
    assert result.data["activity_started"] is True


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
