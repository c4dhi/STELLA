"""Companion mode: free-flow conversation that can load and drop activities (#467).

The risky part is not the tools — those are small and independently tested — but
the agent's LIFECYCLE around them: what happens to the plan, the session, and the
reply when an activity starts, finishes, or is abandoned mid-way.
"""

import pytest

from stella_v2_agent.agent import StellaV2Agent, _with_active_activity_fact
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
    agent._pending_end_confirmation = None
    agent._plan_config = None
    agent._last_known_state_id = None
    agent._activity_started_at = None
    agent._activity_segments = []
    agent._activity_collected = {}
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


def test_ending_an_activity_proposes_it_without_dropping_the_plan():
    # end_activity no longer ends immediately (Felix, 29 Sep): a single
    # misjudged call used to throw the user out with no way back. It now only
    # proposes leaving; the plan stays until a separate, narrow check confirms
    # the user's answer to "shall we stop X?" (see _resolve_pending_end_confirmation).
    agent = _agent()
    agent._plan_config = ACTIVITIES[0]["plan"]
    agent._active_activity = "Memory Game"

    out = agent._apply_companion_tool_results([_verdict(activity_end_proposed=True)])

    assert out["confirm_end"] is True
    assert out["confirm_end_title"] == "Memory Game"
    assert agent._plan_config is not None
    assert agent._active_activity == "Memory Game"
    assert agent._pending_end_confirmation == "Memory Game"


def test_ending_when_nothing_is_running_is_a_no_op():
    # Regression (local test, 26 Sep): the router called end_activity again after
    # the activity was already left, and the user saw "Left the activity" twice.
    agent = _agent()
    assert agent._active_activity is None and agent._plan_config is None

    out = agent._apply_companion_tool_results([_verdict(activity_end_proposed=True)])

    assert "confirm_end" not in out
    assert agent._companion_decisions("s1", out) == []


def test_proposing_to_end_again_while_one_is_already_pending_is_a_no_op():
    # The router does not run at all while a confirmation is pending (see
    # process()), but this guards the method itself against a stray second call.
    agent = _agent()
    agent._plan_config = ACTIVITIES[0]["plan"]
    agent._active_activity = "Memory Game"
    agent._pending_end_confirmation = "Memory Game"

    out = agent._apply_companion_tool_results([_verdict(activity_end_proposed=True)])

    assert "confirm_end" not in out


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
        raw_output={"tool_results": [{"name": "x", "data": {"activity_end_proposed": True}}]},
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


def test_confirm_end_directive_asks_a_direct_question_and_nothing_else():
    directive = StellaV2Agent._companion_directive(
        {"confirm_end": True, "confirm_end_title": "Memory Game"}
    )
    assert "Memory Game" in directive
    assert "do nothing else this turn" in directive.lower()
    assert "do not end it yet" in directive.lower()


def test_ended_directive_forbids_resuming():
    directive = StellaV2Agent._companion_directive({"ended": True})
    assert "do not try to resume" in directive.lower()


def test_end_declined_directive_says_to_stay():
    directive = StellaV2Agent._companion_directive({"end_declined": True})
    assert "did not confirm" in directive.lower()
    assert "do not ask again" in directive.lower()


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


def test_proposing_to_end_an_activity_names_it():
    # Regression: the title lives ONLY on the agent until confirmed, so reading
    # it after _apply_companion_tool_results would always yield "the activity"
    # and the tag would never say which one is up for leaving.
    agent = _agent()
    agent._active_activity = "Memory Game"
    outcome = agent._apply_companion_tool_results([_verdict(activity_end_proposed=True)])

    assert outcome["confirm_end_title"] == "Memory Game"
    (tag,) = agent._companion_decisions("s1", outcome)
    assert _decision_meta(tag)["kind"] == "activity_end_proposed"
    assert "Memory Game" in _decision_meta(tag)["label"]


def test_ended_and_end_declined_tags():
    agent = _agent()
    (tag,) = agent._companion_decisions("s1", {"ended": True, "ended_title": "Memory Game"})
    assert _decision_meta(tag)["kind"] == "activity_ended"
    assert "Memory Game" in _decision_meta(tag)["label"]

    (tag,) = agent._companion_decisions(
        "s1", {"end_declined": True, "declined_title": "Memory Game"}
    )
    assert _decision_meta(tag)["kind"] == "activity_end_declined"
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


# ---------------------------------------------------------------------------
# History scoped to the current mode
# ---------------------------------------------------------------------------

def _with_history(agent, messages):
    """Serve `messages` (role, content, iso timestamp) as the session's chat history."""
    from types import SimpleNamespace

    agent._history_client = object()

    async def get_chat_history(include_debug=False, limit=20):
        return [SimpleNamespace(role=r, content=c, timestamp=t) for r, c, t in messages]

    agent.get_chat_history = get_chat_history


@pytest.mark.asyncio
async def test_history_after_leaving_an_activity_is_one_line():
    from datetime import datetime, timedelta, timezone

    agent = _agent()
    agent._apply_companion_tool_results(
        [_verdict(activity_started=True, activity_id="memory", activity_title="Memory Game")]
    )
    agent._activity_collected = {"nickname": "Fee"}
    started = agent._activity_started_at
    # Propose, then confirm — leaving is a two-step now (Felix, 29 Sep).
    agent._apply_companion_tool_results([_verdict(activity_end_proposed=True)])
    agent.llm_service = _FixedLLMService("YES")
    await agent._resolve_pending_end_confirmation("yes")
    ended = agent._activity_segments[-1].ended_at

    def iso(dt):
        return dt.isoformat()

    _with_history(agent, [
        ("user", "hi", iso(started - timedelta(seconds=5))),
        ("assistant", "what is your nickname?", iso(started + timedelta(microseconds=1))),
        ("user", "Fee", iso(started + timedelta(microseconds=2))),
        ("assistant", "back to chatting", iso(ended + timedelta(seconds=1))),
    ])
    history, full = await agent._fetch_conversation_history()

    assert [m["content"] for m in history] == [
        "hi",
        'Activity "Memory Game" ended. Collected: nickname = Fee.',
        "back to chatting",
    ]
    # The Expert Pool's copy is never scoped — a router deciding what happens
    # NEXT needs the actual turns, not the collapsed summary line (#627).
    assert [m["content"] for m in full] == [
        "hi",
        "what is your nickname?",
        "Fee",
        "back to chatting",
    ]


def test_history_inside_an_activity_starts_at_the_activity():
    import asyncio
    from datetime import timedelta

    agent = _agent()
    agent._apply_companion_tool_results(
        [_verdict(activity_started=True, activity_id="memory", activity_title="Memory Game")]
    )
    started = agent._activity_started_at
    _with_history(agent, [
        ("user", "earlier chat", (started - timedelta(minutes=1)).isoformat()),
        ("assistant", "step one question", (started + timedelta(seconds=1)).isoformat()),
    ])
    history, full = asyncio.run(agent._fetch_conversation_history())
    assert [m["content"] for m in history] == ["step one question"]
    # Unscoped copy for the Expert Pool keeps the turn before the activity
    # started too — that's exactly the context the router lost (#627).
    assert [m["content"] for m in full] == ["earlier chat", "step one question"]


# ---------------------------------------------------------------------------
# _with_active_activity_fact() — companion_router gets told an activity is
# running as a FACT, not left to infer it from a (possibly short) history
# window (#36 follow-up: it kept re-offering/re-starting an already-running
# activity even with the full, unscoped history).
# ---------------------------------------------------------------------------

def test_active_activity_is_stated_as_a_fact_appended_last():
    history = [{"role": "user", "content": "twice a week"}]
    result = _with_active_activity_fact(history, "Prolific Fitness Check-in")
    assert result == [
        {"role": "user", "content": "twice a week"},
        {"role": "system", "content": 'Activity "Prolific Fitness Check-in" is currently running.'},
    ]


def test_no_active_activity_is_a_no_op():
    history = [{"role": "user", "content": "hi"}]
    assert _with_active_activity_fact(history, None) == history
    assert _with_active_activity_fact(history, "") == history


def test_active_activity_fact_does_not_mutate_the_input_list():
    history = [{"role": "user", "content": "hi"}]
    _with_active_activity_fact(history, "Memory Game")
    assert history == [{"role": "user", "content": "hi"}]


# ---------------------------------------------------------------------------
# Confirming before actually leaving (Felix, 29 Sep): a single misjudged
# end_activity call used to throw the user out of an activity with no way
# back — a downbeat but on-topic reply (e.g. a physical complaint) mistaken
# for a stop request. end_activity now only proposes leaving; a separate,
# narrow yes/no check on the NEXT reply decides whether to actually clear the
# plan, deliberately not trusting companion_router's own broad judgment to
# also grade its own question.
# ---------------------------------------------------------------------------

class _FixedLLMService:
    """Returns ``content`` for every generate() call, regardless of input."""

    def __init__(self, content: str):
        self._content = content
        self.last_messages = None

    async def generate(self, messages, config=None, callback=None, component_name="unknown"):
        from stella_agent_sdk.llm import LLMResponse
        self.last_messages = messages
        return LLMResponse(content=self._content, model="test", provider="test")


@pytest.mark.asyncio
async def test_confirm_pending_end_true_on_a_clear_yes():
    agent = _agent()
    agent.llm_service = _FixedLLMService("YES")
    assert await agent._confirm_pending_end("yes, let's stop") is True


@pytest.mark.asyncio
async def test_confirm_pending_end_false_on_anything_else():
    agent = _agent()
    for reply in ["no", "not really", "my knees hurt", "what were we doing again?"]:
        agent.llm_service = _FixedLLMService("NO")
        assert await agent._confirm_pending_end(reply) is False


@pytest.mark.asyncio
async def test_confirm_pending_end_defaults_to_false_on_failure():
    # A parse/network failure must never accidentally end the activity.
    agent = _agent()

    class _BrokenLLMService:
        async def generate(self, *a, **k):
            raise RuntimeError("boom")

    agent.llm_service = _BrokenLLMService()
    assert await agent._confirm_pending_end("yes") is False


@pytest.mark.asyncio
async def test_resolve_pending_end_confirmation_clears_the_plan_on_yes():
    agent = _agent()
    agent._plan_config = ACTIVITIES[0]["plan"]
    agent._active_activity = "Memory Game"
    agent._pending_end_confirmation = "Memory Game"
    agent.llm_service = _FixedLLMService("YES")

    outcome = await agent._resolve_pending_end_confirmation("yes please")

    assert outcome == {"ended": True, "ended_title": "Memory Game"}
    assert agent.sm_client.cleared is True
    assert agent._plan_config is None
    assert agent._active_activity is None
    assert agent._pending_end_confirmation is None


@pytest.mark.asyncio
async def test_resolve_pending_end_confirmation_stays_on_no():
    agent = _agent()
    agent._plan_config = ACTIVITIES[0]["plan"]
    agent._active_activity = "Memory Game"
    agent._pending_end_confirmation = "Memory Game"
    agent.llm_service = _FixedLLMService("NO")

    outcome = await agent._resolve_pending_end_confirmation("no, keep going")

    assert outcome == {"end_declined": True, "declined_title": "Memory Game"}
    assert agent.sm_client.cleared is False
    assert agent._plan_config is not None
    assert agent._active_activity == "Memory Game"
    assert agent._pending_end_confirmation is None
