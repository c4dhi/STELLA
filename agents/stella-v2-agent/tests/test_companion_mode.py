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
    # Set in __init__ in production; listed here because this harness builds the
    # agent with __new__ and so gets no initialisation. Kept explicit rather than
    # made defensive in the agent, where a missing attribute is a real init bug.
    agent._persona_config = None
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


# ---------------------------------------------------------------------------
# Decision tags: what the user sees the agent decide (#467 follow-up)
# ---------------------------------------------------------------------------

def _decision_meta(output):
    return output.metadata["decision"]


def test_offering_activities_tags_the_options_it_actually_named():
    agent = _agent()
    outcome = agent._apply_companion_tool_results(
        [_verdict(offer_activities=True, activities=ACTIVITIES)]
    )
    (tag,) = agent._companion_decisions("s1", outcome)

    assert _decision_meta(tag)["kind"] == "activities_offered"
    # The options carried on the tag ARE the options the reply was told to
    # offer, so the chat cannot show a different menu than the agent spoke.
    assert _decision_meta(tag)["options"] == ["Memory Game", "Fitness Check-in"]


def test_no_activities_available_still_produces_a_tag():
    agent = _agent()
    outcome = agent._apply_companion_tool_results(
        [_verdict(offer_activities=True, activities=[])]
    )
    (tag,) = agent._companion_decisions("s1", outcome)
    assert _decision_meta(tag)["kind"] == "activities_offered"
    assert _decision_meta(tag)["options"] == []


def test_starting_an_activity_names_it():
    agent = _agent()
    outcome = agent._apply_companion_tool_results(
        [_verdict(activity_started=True, activity_id="memory", activity_title="Memory Game")]
    )
    (tag,) = agent._companion_decisions("s1", outcome)
    assert _decision_meta(tag)["kind"] == "activity_started"
    assert "Memory Game" in _decision_meta(tag)["label"]


def test_ending_an_activity_names_what_was_left():
    # Regression: the title lives ONLY on the agent until the tool clears it, so
    # reading it after _apply_companion_tool_results would always yield "the
    # activity" and the tag would never say which one the user stopped.
    agent = _agent()
    agent._active_activity = "Memory Game"
    outcome = agent._apply_companion_tool_results([_verdict(activity_ended=True)])

    assert outcome["ended_title"] == "Memory Game"
    (tag,) = agent._companion_decisions("s1", outcome)
    assert _decision_meta(tag)["kind"] == "activity_ended"
    assert "Memory Game" in _decision_meta(tag)["label"]


def test_an_abstaining_turn_produces_no_tags():
    # The common case by far — a tag on every turn would be noise, not signal.
    assert StellaV2Agent._companion_decisions("s1", {}) == []


def test_decisions_ride_the_debug_channel():
    # They must transport and persist exactly like any other debug output; the
    # `decision` block is the ONLY thing that separates them.
    agent = _agent()
    outcome = agent._apply_companion_tool_results(
        [_verdict(activity_started=True, activity_id="memory", activity_title="Memory Game")]
    )
    (tag,) = agent._companion_decisions("s1", outcome)
    payload = tag.to_data_payload()

    assert payload["type"] == "debug"
    assert payload["data"]["component"] == "companion_router"
    assert payload["data"]["metadata"]["decision"]["kind"] == "activity_started"


# ---------------------------------------------------------------------------
# Progress metadata: what the sidebar reads to answer "is anything running?"
# ---------------------------------------------------------------------------

def test_progress_metadata_reports_the_running_activity():
    agent = _agent()
    agent._active_activity = "Memory Game"
    meta = agent._companion_progress_metadata()
    assert meta["active_activity"] == "Memory Game"
    assert [a["title"] for a in meta["activities"]] == ["Memory Game", "Fitness Check-in"]


def test_progress_metadata_offers_the_options_when_nothing_is_running():
    agent = _agent()
    meta = agent._companion_progress_metadata()
    assert meta["active_activity"] is None
    assert len(meta["activities"]) == 2


def test_plan_following_agents_send_no_companion_metadata():
    # Its absence is what tells the UI to keep rendering the plan it was
    # deployed with — a plan agent must never look like an idle companion.
    assert _agent(companion=False)._companion_progress_metadata() is None


# ---------------------------------------------------------------------------
# Authoring the reply against the plan that was JUST loaded
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_the_starting_turn_is_reanchored_to_the_loaded_plan():
    """Regression: the agent invented the activity's opening question.

    start_activity loads the plan mid-turn, but sm_context was read at turn
    START — when the session had no plan at all. Authoring against that snapshot
    left the model with nothing but the activity's NAME to go on, so it opened
    the fitness check-in with a plausible-sounding frequency question while the
    state machine sat waiting on "greet and ask for name". Observed live in
    session 9e664a34; the two never resynced because the user stopped it first.
    """
    agent = _agent()
    loaded = {"state": {"id": "greeting", "title": "Greeting"}, "deliverables": []}

    async def _fake_fetch():
        return loaded

    agent._fetch_sm_context = _fake_fetch  # type: ignore

    outcome = agent._apply_companion_tool_results([_verdict(
        activity_started=True,
        activity_id="checkin",
        activity_title="Fitness Check-in",
        current_state_id="greeting",
    )])
    assert outcome["started_state_id"] == "greeting"

    turn_start = {"state": None, "deliverables": []}
    resolved = await agent._resolve_response_context(
        turn_start,
        "de",
        transitioned=bool(outcome.get("started_state_id")),
        new_state_id=outcome.get("started_state_id"),
        session_completed=False,
    )
    assert resolved is loaded
    assert resolved["state"]["id"] == "greeting"


def test_the_start_directive_defers_to_the_plans_first_step():
    # "begin" alone is an invitation to improvise, which is exactly what went
    # wrong — the reply must be pointed at the step the plan actually specifies.
    directive = StellaV2Agent._companion_directive({"started": "Fitness Check-in"})
    assert "current step" in directive
    assert "invent" in directive


# ---------------------------------------------------------------------------
# The routing outcome must survive arbitration
# ---------------------------------------------------------------------------

def test_routing_directive_outranks_an_expert_followup():
    """Regression: the reply ignored the activity list and invented chores.

    to_prompt_section() emits ONE direction, and primary_action sat at the
    BOTTOM of that pick — below any expert follow-up question. Probing produces
    one on precisely the turns the router fires ("what can we do together?" is a
    probing cue too), so the companion directive was dropped almost every time
    it mattered. Observed live: Grace spoke probing's "Welche Aufgaben möchtest
    du zusammen machen?" and then offered to tidy a room.
    """
    from stella_v2_agent.models.arbitration_result import ResponseDirective

    directive = ResponseDirective(
        ask_followup=True,
        followup_question="Welche Aufgaben möchtest du zusammen machen?",
        primary_action="No extractions",
    )
    directive.routing_directive = StellaV2Agent._companion_directive(
        {"activities": ACTIVITIES}
    )
    section = directive.to_prompt_section()

    assert "Memory Game" in section and "Fitness Check-in" in section
    assert "Welche Aufgaben" not in section  # the stale suggestion is gone
    assert "No extractions" not in section


def test_safety_boundaries_still_outrank_a_routing_directive():
    # Routing outranks SUGGESTIONS, not safety. must_avoid is emitted
    # unconditionally and must stay that way.
    from stella_v2_agent.models.arbitration_result import ResponseDirective

    directive = ResponseDirective(must_avoid=["giving medical advice"])
    directive.routing_directive = "Start the activity."
    section = directive.to_prompt_section()

    assert "Avoid: giving medical advice" in section
    assert "Start the activity." in section


def test_plan_following_turns_are_unchanged():
    # Nothing sets routing_directive outside companion mode, so the existing
    # follow-up-wins-over-primary_action rule must still hold exactly.
    from stella_v2_agent.models.arbitration_result import ResponseDirective

    section = ResponseDirective(
        ask_followup=True,
        followup_question="How often do you exercise?",
        primary_action="Ask about exercise",
    ).to_prompt_section()

    assert "How often do you exercise?" in section
    assert "Ask about exercise" not in section


# ---------------------------------------------------------------------------
# Surviving a restart mid-activity
# ---------------------------------------------------------------------------

def _restarted_agent():
    """A companion pod that just came up: deploy config only, no memory."""
    agent = _agent()
    agent._plan_config = None
    agent._active_activity = None
    return agent


def test_a_restart_mid_activity_resumes_the_running_plan():
    # on_session_start rebuilds companion state from the DEPLOY config, which has
    # no plan — but the state-machine row outlives the pod. Without this the
    # agent wakes believing nothing is running.
    agent = _restarted_agent()
    agent._rehydrate_active_activity({"plan_id": "memory", "plan_title": "Memory Game"})

    assert agent._active_activity == "Memory Game"
    assert agent._plan_config == ACTIVITIES[0]["plan"]
    assert agent._companion_progress_metadata()["active_activity"] == "Memory Game"


def test_a_restart_with_no_activity_running_stays_in_free_flow():
    agent = _restarted_agent()
    agent._rehydrate_active_activity({})
    assert agent._active_activity is None
    assert agent._plan_config is None


def test_an_activity_dropped_from_the_allow_list_is_not_resumed():
    # Redeployed with a different selection while a session was mid-activity.
    # Running a plan the deployment no longer offers is worse than dropping back.
    agent = _restarted_agent()
    agent._rehydrate_active_activity({"plan_id": "removed-plan"})
    assert agent._active_activity is None
    assert agent._plan_config is None


def test_rehydration_never_overwrites_a_live_activity():
    # on_ready also runs on a normal join; it must not clobber state the agent
    # already holds, or a mid-session restart could resurrect a stale plan.
    agent = _agent()
    agent._plan_config = {"id": "checkin"}
    agent._active_activity = "Fitness Check-in"
    agent._rehydrate_active_activity({"plan_id": "memory"})
    assert agent._active_activity == "Fitness Check-in"


def test_plan_following_agents_are_untouched_by_rehydration():
    agent = _agent(companion=False)
    agent._rehydrate_active_activity({"plan_id": "memory"})
    assert agent._plan_config is None
    assert agent._active_activity is None


# ---------------------------------------------------------------------------
# The router is structural, not an expert you opt into
# ---------------------------------------------------------------------------

class _FakeRegistry:
    """Records apply_config calls in order, like the real expert registry."""

    def __init__(self):
        self.calls = []

    def apply_config(self, config):
        self.calls.append(config)

    def enabled_for(self, name):
        """The LAST write wins, which is what the ordering guarantee rests on."""
        state = None
        for call in self.calls:
            entry = (call.get("experts") or {}).get(name)
            if isinstance(entry, dict) and "enabled" in entry:
                state = entry["enabled"]
        return state


def _apply(companion_mode, saved_config):
    """Replay the two writes on_session_start makes, in the order it makes them."""
    registry = _FakeRegistry()
    registry.apply_config({"experts": saved_config})          # _apply_pipeline_config
    registry.apply_config(                                     # the structural write
        {"experts": {"companion_router": {"enabled": companion_mode}}}
    )
    return registry


def test_a_saved_config_cannot_disable_the_router_in_companion_mode():
    """Regression: this silently broke companion mode.

    The router ships enabled:false and appears in the Configurator like any
    other expert, so a saved configuration carrying
    `companion_router: {enabled: false}` is the NORMAL case, not an exotic one.
    Applying the pipeline config after the enable meant that config won, and the
    session became a companion that could never offer, start or stop anything —
    with no error anywhere.
    """
    registry = _apply(True, {"companion_router": {"enabled": False}})
    assert registry.enabled_for("companion_router") is True


def test_a_saved_config_cannot_enable_the_router_in_plan_mode():
    # The other direction matters too: an operator who switched it on to look at
    # it would otherwise pay for an LLM call every turn, for a router whose tools
    # are not registered outside companion mode.
    registry = _apply(False, {"companion_router": {"enabled": True}})
    assert registry.enabled_for("companion_router") is False


def test_the_structural_write_is_last():
    # The guarantee is entirely about ORDER. If _apply_pipeline_config ever moves
    # after this write, both tests above still pass on their own — so pin it.
    registry = _apply(True, {"companion_router": {"enabled": False}})
    assert registry.calls[-1] == {"experts": {"companion_router": {"enabled": True}}}


def test_other_experts_keep_honouring_their_saved_config():
    # Only the router is structural. Everything else stays operator-controlled.
    registry = _apply(True, {"probing": {"enabled": False}})
    assert registry.enabled_for("probing") is False
