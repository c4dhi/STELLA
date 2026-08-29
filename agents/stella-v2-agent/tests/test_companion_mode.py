"""Companion mode: free-flow conversation that can load and drop activities (#467).

The risky part is not the tools — those are small and independently tested — but
the agent's LIFECYCLE around them: what happens to the plan, the session, and the
reply when an activity starts, finishes, or is abandoned mid-way.
"""

import pytest

from stella_v2_agent.agent import StellaV2Agent
from stella_v2_agent.models.expert_verdict import ExpertVerdict


ACTIVITIES = [
    {
        "id": "memory",
        "title": "Memory Game",
        "description": "A shopping list game",
        "plan": {"id": "memory", "title": "Memory Game", "states": [{"id": "s1"}]},
    },
    {
        "id": "checkin",
        "title": "Fitness Check-in",
        "description": "",
        "plan": {"id": "checkin", "title": "Fitness Check-in", "states": [{"id": "s1"}]},
    },
]


class _FakeSM:
    def __init__(self):
        self.cleared = False

    async def clear_plan(self):
        self.cleared = True
        return {"success": True}


def _agent(companion=True):
    agent = StellaV2Agent.__new__(StellaV2Agent)
    agent._companion_mode = companion
    agent._available_plans = ACTIVITIES
    agent._active_activity = None
    agent._plan_config = None
    agent._last_known_state_id = None
    agent.sm_client = _FakeSM()
    return agent


def _verdict(**data):
    return ExpertVerdict(
        expert_name="companion_router",
        raw_output={"tool_results": [{"name": "t", "success": True, "data": data}]},
    )


# ---------------------------------------------------------------------------
# Reconciling the agent to what the router's tools did
# ---------------------------------------------------------------------------

def test_starting_an_activity_adopts_its_plan():
    # The tool loaded the plan backend-side; the agent must adopt it locally or
    # farewell/voice/language lookups resolve against nothing.
    agent = _agent()
    out = agent._apply_companion_tool_results(
        [_verdict(activity_started=True, activity_id="memory", activity_title="Memory Game")]
    )
    assert out["started"] == "Memory Game"
    assert agent._plan_config["id"] == "memory"
    assert agent._active_activity == "Memory Game"


def test_ending_an_activity_drops_the_plan():
    agent = _agent()
    agent._plan_config = ACTIVITIES[0]["plan"]
    agent._active_activity = "Memory Game"

    out = agent._apply_companion_tool_results([_verdict(activity_ended=True)])

    assert out["ended"] is True
    assert agent._plan_config is None
    assert agent._active_activity is None


def test_listing_activities_surfaces_them_for_the_reply():
    agent = _agent()
    out = agent._apply_companion_tool_results(
        [_verdict(offer_activities=True, activities=[{"title": "Memory Game"}])]
    )
    assert out["activities"] == [{"title": "Memory Game"}]


def test_an_abstaining_router_changes_nothing():
    # The common turn: ordinary conversation, no tool called.
    agent = _agent()
    agent._plan_config = ACTIVITIES[0]["plan"]
    assert agent._apply_companion_tool_results([]) == {}
    assert agent._plan_config is not None


def test_other_experts_tool_results_are_ignored():
    # task_extraction calls tools every turn; its results must not be mistaken
    # for routing decisions.
    agent = _agent()
    agent._plan_config = ACTIVITIES[0]["plan"]
    other = ExpertVerdict(
        expert_name="task_extraction",
        raw_output={"tool_results": [{"name": "x", "data": {"activity_ended": True}}]},
    )
    assert agent._apply_companion_tool_results([other]) == {}
    assert agent._plan_config is not None


# ---------------------------------------------------------------------------
# Returning to free flow
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_returning_to_companion_clears_the_state_machine():
    # Clearing rather than blanking means every existing "no plan" path applies,
    # which is exactly the state a free-flow turn should be in.
    agent = _agent()
    agent._plan_config = ACTIVITIES[0]["plan"]
    agent._active_activity = "Memory Game"

    await agent._return_to_companion(reason="test")

    assert agent.sm_client.cleared is True
    assert agent._plan_config is None
    assert agent._active_activity is None


# ---------------------------------------------------------------------------
# What the reply is told
# ---------------------------------------------------------------------------

def test_offer_directive_names_the_real_activities():
    # Without the names in the directive the model invents plausible ones, which
    # reads as a broken promise the moment the user picks one.
    directive = StellaV2Agent._companion_directive(
        {"activities": [{"title": "Memory Game", "description": "A shopping list game"}]}
    )
    assert "Memory Game" in directive
    assert "A shopping list game" in directive
    assert "Do not invent" in directive


def test_offer_directive_handles_having_nothing_to_offer():
    # A companion deployed with an empty allow-list must say so, not stall.
    directive = StellaV2Agent._companion_directive({"activities": []})
    assert "no activities are available" in directive


def test_started_directive_tells_the_reply_not_to_re_ask():
    directive = StellaV2Agent._companion_directive({"started": "Memory Game"})
    assert "Memory Game" in directive
    assert "do not re-ask" in directive.lower()


def test_ended_directive_forbids_resuming():
    directive = StellaV2Agent._companion_directive({"ended": True})
    assert "do not try to resume" in directive.lower()


def test_no_routing_produces_no_directive():
    assert StellaV2Agent._companion_directive({}) == ""
