"""Companion mode: free-flow conversation that can run activities (#467, #36).

These pin the RULES — which transition a turn makes from which mode, what the
reply and the log are told, and how the history is scoped. Whole turns through
process() are in test_companion_turns.py.
"""

from datetime import datetime, timedelta, timezone

import pytest

from stella_v2_agent.agent import StellaV2Agent
from stella_v2_agent.companion import (
    Change,
    Companion,
    NO_CHANGE,
    Transition,
    ASK,
    LEAVE,
    STAY,
    ExitStep,
    commands_from,
    decision,
    directive,
    exit_dialogue,
)
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
        # A plan whose content carries its own id, as generated plans do.
        "plan": {"id": "plan-content-id", "title": "Fitness Check-in", "states": [{"id": "s1"}]},
    },
]

START_MEMORY = {"command": "start", "activity_id": "memory", "activity_title": "Memory Game"}
START_CHECKIN = {"command": "start", "activity_id": "checkin", "activity_title": "Fitness Check-in"}
STOP = {"command": "stop", "reason": "user said stop"}
LIST = {"command": "list", "activities": [{"id": "memory", "title": "Memory Game"}]}


def _free(woken=False):
    """Free conversation; past the opening unless a test is about it."""
    companion = Companion(activities=ACTIVITIES)
    companion.greeted = companion.offered = not woken
    return companion


def _running(activity=ACTIVITIES[0], pending_exit=False):
    companion = Companion(activities=ACTIVITIES)
    companion.enter(activity)
    companion.pending_exit = pending_exit
    return companion


# ---------------------------------------------------------------------------
# decide(): one transition per turn, judged against the mode the turn started in
# ---------------------------------------------------------------------------

def test_free_flow_offers_starts_and_ignores_a_stop():
    assert _free().decide([LIST]).change is Change.OFFERED
    started = _free().decide([START_MEMORY], said="let's play the memory game")
    assert started.change is Change.STARTED and started.activity is ACTIVITIES[0]
    assert _free().decide([STOP]).change is Change.NONE


def test_being_done_for_now_is_a_dismissal_and_only_in_free_conversation():
    dismissed = _free().decide([{"command": "sleep"}])
    assert dismissed.change is Change.DISMISSED
    assert "wake you whenever they want to talk again" in directive(dismissed)
    assert decision("s1", dismissed).metadata["decision"]["kind"] == "going_to_sleep"
    # She never sleeps mid-activity, whatever was proposed.
    assert _running().decide([{"command": "sleep"}], ExitStep(STAY)) is NO_CHANGE


# ---------------------------------------------------------------------------
# A doubtful transcript never changes the mode; it can only make her ask
# ---------------------------------------------------------------------------

def test_what_counts_as_doubtful():
    companion = _free()
    assert companion.doubtful(0.2) is True
    assert companion.doubtful(0.9) is False
    assert companion.doubtful(0.0) is False     # no signal from the STT is not doubt
    assert companion.doubtful(1.0) is False     # typed text
    companion.settings.min_confidence = 0.0              # switched off
    assert companion.doubtful(0.01) is False


def test_a_doubtful_yes_is_asked_again_not_left_on():
    """"Thank you." invented over silence, or a misheard "Nein", used to end the
    activity once the stop question was open."""
    companion = _running()
    companion.ask_exit()
    asked = companion.decide([], ExitStep(LEAVE, say="Stop here?", user_intent="yes"), doubtful=True)
    assert asked.change is Change.EXIT_ASKED and asked.say == "Stop here?"
    assert "low confidence" in asked.understood
    # Heard clearly, the same answer leaves.
    assert companion.decide([], ExitStep(LEAVE, say="Stop here?")).change is Change.EXITED


def test_a_doubtful_stop_is_asked_about_even_without_a_written_question():
    asked = _running().decide([], ExitStep(LEAVE), doubtful=True)
    assert asked.change is Change.EXIT_ASKED and asked.say == ""
    assert "Ask clearly and briefly" in directive(asked)


def test_doubt_alone_never_asks_about_stopping():
    assert _running().decide([], ExitStep(STAY), doubtful=True) is NO_CHANGE


def test_a_doubtful_no_still_stays():
    companion = _running()
    companion.ask_exit()
    assert companion.decide([], ExitStep(STAY), doubtful=True).change is Change.EXIT_DECLINED


def test_asking_again_on_doubt_does_not_loop_forever():
    companion = _running()
    companion.ask_exit()
    companion.ask_exit()
    declined = companion.decide([], ExitStep(LEAVE, say="Stop here?"), doubtful=True)
    assert declined.change is Change.EXIT_DECLINED


def test_a_doubtful_goodbye_is_not_acted_on():
    unheard = _free().decide([{"command": "sleep"}], doubtful=True)
    assert unheard.change is Change.UNHEARD
    assert "ask them to say it again" in directive(unheard)
    assert decision("s1", unheard).metadata["decision"]["kind"] == "not_heard_clearly"


# ---------------------------------------------------------------------------
# Starting is never a guess: named outright, or asked about first
# ---------------------------------------------------------------------------

def test_an_activity_named_outright_starts_at_once():
    for said in ("the Memory Game please", "memory game", "Let's do the MEMORY-GAME."):
        assert _free().decide([START_MEMORY], said=said).change is Change.STARTED


def test_an_activity_not_named_is_asked_about_first():
    """"The fitness one" with two fitness activities: the router picks one, and
    used to start it."""
    asked = _free().decide([START_CHECKIN], said="the fitness one")
    assert asked.change is Change.START_ASKED and asked.activity is ACTIVITIES[1]
    assert '"Fitness Check-in"' in directive(asked)
    assert decision("s1", asked).metadata["decision"]["kind"] == "activity_start_proposed"


def test_a_yes_to_an_offer_is_still_asked_about():
    # Her offer may have listed several by informal names, so only the user's
    # own words settle which one: "yes" names none.
    assert _free().decide([START_MEMORY], said="yes please").change is Change.START_ASKED


def test_a_no_to_the_question_is_not_a_goodbye():
    """"No, never mind" was taken for being done, and she went to sleep."""
    declined = _asked().decide([{"command": "sleep"}], start_confirmed=False, said="no, never mind")
    assert declined.change is Change.START_DECLINED


def test_asking_what_there_is_instead_of_answering_lists_them():
    assert _asked().decide([LIST], start_confirmed=False, said="what else is there?").change is Change.OFFERED


def test_a_named_activity_heard_poorly_is_still_asked_about():
    asked = _free().decide([START_MEMORY], doubtful=True, said="the memory game")
    assert asked.change is Change.START_ASKED


def _asked():
    companion = _free()
    companion.ask_start(ACTIVITIES[1])
    return companion


def test_a_yes_to_the_question_starts_what_was_asked_about():
    started = _asked().decide([], start_confirmed=True, said="yes")
    assert started.change is Change.STARTED and started.activity is ACTIVITIES[1]


def test_anything_but_a_yes_does_not_start_it():
    for confirmed in (False, None):   # a no, or the judgment failed
        declined = _asked().decide([], start_confirmed=confirmed, said="no")
        assert declined.change is Change.START_DECLINED
        assert "does not start" in directive(declined)


def test_naming_another_one_instead_starts_that_one():
    started = _asked().decide([START_MEMORY], start_confirmed=False, said="no, the memory game")
    assert started.change is Change.STARTED and started.activity is ACTIVITIES[0]


def test_a_poorly_heard_yes_is_asked_again_then_dropped():
    companion = _asked()
    again = companion.decide([], doubtful=True, start_confirmed=True, said="Yes.")
    assert again.change is Change.START_ASKED
    companion.ask_start(ACTIVITIES[1])
    dropped = companion.decide([], doubtful=True, start_confirmed=True, said="Yes.")
    assert dropped.change is Change.START_DECLINED


def test_a_doubtful_no_is_asked_again_not_closed():
    """Symmetric with a doubtful yes above: a transcript too poorly heard to
    trust is not evidence of "no" either — it asks again rather than closing
    the question (#50/#52: a mistranscribed turn used to drop it outright, so
    a clear "yes" the very next turn had nothing left to confirm)."""
    again = _asked().decide([], doubtful=True, start_confirmed=False, said="??")
    assert again.change is Change.START_ASKED and again.activity is ACTIVITIES[1]


def test_a_doubtful_no_is_asked_again_then_dropped():
    companion = _asked()
    companion.decide([], doubtful=True, start_confirmed=False, said="??")
    companion.ask_start(ACTIVITIES[1])
    dropped = companion.decide([], doubtful=True, start_confirmed=False, said="??")
    assert dropped.change is Change.START_DECLINED


def test_a_leading_qualifier_in_the_title_is_not_required():
    """"the Fitness Check-in" clearly means "Prolific Fitness Check-in" even
    without the brand word (#50/#52 — the shape of the turn that failed to
    start)."""
    activity = {**ACTIVITIES[1], "title": "Prolific Fitness Check-in"}
    companion = Companion(activities=[ACTIVITIES[0], activity])
    started = companion.decide(
        [{"command": "start", "activity_id": activity["id"]}],
        said="I'd like to do the Fitness Check-in, please.",
    )
    assert started.change is Change.STARTED and started.activity is activity


def test_dropping_only_the_titles_own_word_is_not_enough():
    """"Memory" minus "Game" is one common word, too weak to start on alone."""
    asked = _free().decide([START_MEMORY], said="let's play a game")
    assert asked.change is Change.START_ASKED


def test_the_router_proposing_it_again_does_not_ask_without_end():
    # Not a yes, and the router proposes the same one again: asked once more,
    # then the question is dropped like any other.
    companion = _asked()
    again = companion.decide([START_CHECKIN], start_confirmed=False, said="maybe that one")
    assert again.change is Change.START_ASKED
    companion.ask_start(ACTIVITIES[1])
    dropped = companion.decide([START_CHECKIN], start_confirmed=False, said="maybe that one")
    assert dropped.change is Change.START_DECLINED


def test_entering_an_activity_closes_the_open_question():
    companion = _asked()
    companion.enter(ACTIVITIES[1])
    assert companion.pending_start is None and companion.start_asks == 0


def test_a_doubtful_question_about_activities_is_still_answered():
    # Offering commits to nothing.
    assert _free().decide([LIST], doubtful=True).change is Change.OFFERED


def test_an_abstaining_router_changes_nothing():
    assert _free().decide([]).change is Change.NONE
    assert _running().decide([]).change is Change.NONE


def test_an_unknown_activity_does_not_start():
    transition = _free().decide([{"command": "start", "activity_id": "nope"}])
    assert transition.change is Change.NONE
    assert transition.ignored == "start"


@pytest.mark.parametrize("command", [START_MEMORY, START_CHECKIN, LIST, STOP])
def test_inside_an_activity_only_the_exit_dialogue_counts(command):
    """Regression (session 92ad3f90): the user answered the activity's name
    question and the router started the activity AGAIN, resetting its progress.
    Whatever a router might propose mid-activity, it decides nothing there."""
    assert _running().decide([command], ExitStep(STAY)) is NO_CHANGE
    assert _running().decide([command], ExitStep(LEAVE)).change is Change.EXITED


def test_the_exit_dialogue_decides_every_activity_turn():
    asked = _running().decide([], ExitStep(ASK, say="Shall we stop here?"))
    assert asked.change is Change.EXIT_ASKED and asked.say == "Shall we stop here?"
    assert _running().decide([], ExitStep(LEAVE)).change is Change.EXITED
    # An ordinary answer, or a complaint: nothing happens, and nothing is logged.
    stayed = _running().decide([], ExitStep(STAY, user_intent="complains about the question"))
    assert stayed is NO_CHANGE


def test_a_failed_exit_dialogue_changes_nothing():
    # It runs on every activity turn: asking "shall we stop?" whenever the call
    # fails would interrupt the activity for no reason.
    assert _running().decide([], None) is NO_CHANGE


def test_an_ask_without_a_question_to_speak_changes_nothing():
    assert _running().decide([], ExitStep(ASK, say="")) is NO_CHANGE


def test_the_turn_that_asks_is_never_the_turn_that_answers():
    """Regression (session f4cd9365): the proposal was set and then judged in
    the SAME turn, against the stop request itself — so the question was never
    asked, and anything short of "yes stop" was silently declined."""
    companion = _running()
    assert companion.pending_exit is False
    assert companion.decide([], ExitStep(ASK, say="?")).change is Change.EXIT_ASKED
    assert companion.pending_exit is False  # decide() is pure; the caller records the ask


def test_the_next_turn_answers_the_open_question():
    yes = _running(pending_exit=True).decide([], ExitStep(LEAVE))
    no = _running(pending_exit=True).decide([], ExitStep(STAY))
    assert yes.change is Change.EXITED and yes.title == "Memory Game"
    assert no.change is Change.EXIT_DECLINED


def test_an_unclear_answer_is_asked_about_again_but_not_forever():
    companion = _running(pending_exit=True)
    companion.exit_asks = 1
    assert companion.decide([], ExitStep(ASK, say="So, stop?")).change is Change.EXIT_ASKED
    companion.exit_asks = 2
    assert companion.decide([], ExitStep(ASK, say="So, stop?")).change is Change.EXIT_DECLINED


def test_a_failed_judgment_of_the_answer_stays():
    # Ending on a guess costs the whole activity.
    assert _running(pending_exit=True).decide([], None).change is Change.EXIT_DECLINED


def test_router_proposals_while_the_question_is_open_do_not_count():
    # The router ran without knowing a question was open; its view does not
    # override the user's answer to it.
    assert _running(pending_exit=True).decide([STOP], ExitStep(STAY)).change is Change.EXIT_DECLINED
    assert _running(pending_exit=True).decide([START_CHECKIN], ExitStep(LEAVE)).change is Change.EXITED


def test_only_the_first_proposal_counts():
    assert _free().decide([START_MEMORY, START_CHECKIN]).activity is ACTIVITIES[0]


# ---------------------------------------------------------------------------
# Recording what was applied
# ---------------------------------------------------------------------------

def test_an_activity_is_found_by_its_own_id_or_its_plans():
    # The backend records the PLAN's id, which generated plans set themselves.
    companion = _free()
    assert companion.find("checkin") is ACTIVITIES[1]
    assert companion.find("plan-content-id") is ACTIVITIES[1]
    assert companion.find(None) is None


def test_entering_never_starts_before_a_message_already_seen():
    # A pod clock behind the message store must not pull the choosing turn into
    # the activity's history.
    future = datetime.now(timezone.utc) + timedelta(seconds=30)
    companion = _free()
    companion.enter(ACTIVITIES[0], not_before=future)
    assert companion.started_at > future


def test_leaving_folds_the_run_into_one_segment():
    companion = _running()
    companion.collected = {"nickname": "Fee"}
    companion.leave()
    assert companion.active is None and companion.pending_exit is False
    assert companion.segments[-1].title == "Memory Game"
    assert companion.segments[-1].collected == {"nickname": "Fee"}


def test_a_resumed_activity_has_no_known_start():
    companion = _free()
    companion.resume(ACTIVITIES[0])
    assert companion.running_title == "Memory Game" and companion.started_at is None


# ---------------------------------------------------------------------------
# Reading the router's proposals
# ---------------------------------------------------------------------------

def _router(*results):
    return ExpertVerdict(
        expert_name="companion_router",
        raw_output={"tool_results": list(results)},
    )


def test_commands_come_from_the_router_only_and_only_when_they_succeeded():
    verdicts = [
        _router(
            {"name": "start_activity", "success": False, "error": "Unknown activity"},
            {"name": "start_activity", "success": True, "data": START_MEMORY},
        ),
        ExpertVerdict(
            expert_name="task_extraction",
            raw_output={"tool_results": [{"success": True, "data": STOP}]},
        ),
    ]
    assert commands_from(verdicts) == [START_MEMORY]


# ---------------------------------------------------------------------------
# What the reply is told
# ---------------------------------------------------------------------------

def test_the_offer_names_the_real_activities_and_forbids_others():
    text = directive(Transition(Change.OFFERED, offered=ACTIVITIES))
    assert "Memory Game (A shopping list game)" in text
    assert "Fitness Check-in" in text
    assert "Do not invent" in text


def test_an_empty_offer_says_so():
    assert "no activities are available" in directive(Transition(Change.OFFERED))


def test_the_start_opens_the_plans_first_step_as_a_fresh_conversation():
    text = directive(Transition(Change.STARTED, activity=ACTIVITIES[0]))
    assert "current step" in text
    assert "only just begun" in text
    assert "invent" in text


def test_asking_falls_back_to_a_directive_only_when_the_dialogue_failed():
    text = directive(Transition(Change.EXIT_ASKED, activity=ACTIVITIES[0]))
    assert "whether they want to stop" in text and "do nothing else" in text


def test_leaving_forbids_continuing():
    said = directive(Transition(Change.EXITED, activity=ACTIVITIES[0]))
    assert "do not continue" in said
    # With nothing else to offer she stops talking too.
    assert "no question" in said


def test_after_an_activity_she_offers_the_other_ones_by_name():
    """The off-boarding: stopped or finished, she asks once whether they want
    to do something else. A no to that is the router's cue to wind down."""
    companion = _free()
    for change in (Change.EXITED, Change.FINISHED):
        said = companion.instruction(Transition(change, activity=ACTIVITIES[0]))
        assert "something else" in said
        assert ACTIVITIES[1]["title"] in said
        assert f'name what there is by title: {ACTIVITIES[0]["title"]}' not in said


def test_declining_stays_in_the_activity():
    assert "Stay in the activity" in directive(Transition(Change.EXIT_DECLINED))


def test_no_change_and_mid_activity_turns_add_no_directive():
    # Inside an activity the plan alone steers, exactly as in plan mode.
    assert directive(Transition(Change.NONE)) == ""
    assert directive(Transition(Change.NONE, ignored="start")) == ""


def test_routing_directive_outranks_an_expert_followup():
    """Regression: the reply ignored the activity list and invented chores —
    probing's follow-up won over the offer on exactly the turns it mattered."""
    from stella_v2_agent.models.arbitration_result import ResponseDirective

    rd = ResponseDirective(
        ask_followup=True,
        followup_question="Welche Aufgaben möchtest du zusammen machen?",
        primary_action="No extractions",
    )
    rd.routing_directive = directive(Transition(Change.OFFERED, offered=ACTIVITIES))
    section = rd.to_prompt_section()

    assert "Memory Game" in section and "Fitness Check-in" in section
    assert "Welche Aufgaben" not in section
    assert "No extractions" not in section


def test_safety_boundaries_still_outrank_a_routing_directive():
    from stella_v2_agent.models.arbitration_result import ResponseDirective

    rd = ResponseDirective(must_avoid=["giving medical advice"])
    rd.routing_directive = "Start the activity."
    section = rd.to_prompt_section()
    assert "Avoid: giving medical advice" in section
    assert "Start the activity." in section


# ---------------------------------------------------------------------------
# What the log shows
# ---------------------------------------------------------------------------

def _meta(output):
    return output.metadata["decision"]


@pytest.mark.parametrize("change,kind,label", [
    (Change.STARTED, "activity_started", "Started “Memory Game”"),
    (Change.EXIT_ASKED, "activity_end_proposed", "Asked to confirm leaving “Memory Game”"),
    (Change.EXITED, "activity_ended", "Left “Memory Game”"),
    (Change.EXIT_DECLINED, "activity_end_declined", "Staying in “Memory Game”"),
    (Change.FINISHED, "activity_completed", "Finished “Memory Game”"),
])
def test_each_transition_has_one_tag(change, kind, label):
    tag = decision("s1", Transition(change, activity=ACTIVITIES[0]))
    assert _meta(tag)["kind"] == kind
    assert _meta(tag)["label"] == label


def test_an_offer_tags_the_options_it_named():
    tag = decision("s1", Transition(Change.OFFERED, offered=ACTIVITIES))
    assert _meta(tag)["kind"] == "activities_offered"
    assert _meta(tag)["options"] == ["Memory Game", "Fitness Check-in"]


def test_an_ignored_proposal_is_visible():
    tag = decision("s1", Transition(Change.NONE, ignored="start"))
    assert _meta(tag)["kind"] == "activity_command_ignored"


def test_the_exit_dialogues_reading_is_on_the_tag():
    # Pod logs are gone by the time a session is reviewed; the tag is not.
    tag = decision("s1", Transition(Change.EXIT_DECLINED, activity=ACTIVITIES[0], understood="wants to carry on"))
    assert _meta(tag)["detail"] == "wants to carry on"


def test_an_ordinary_turn_has_no_tag():
    assert decision("s1", Transition(Change.NONE)) is None


# ---------------------------------------------------------------------------
# The yes/no check on "shall we stop?"
# ---------------------------------------------------------------------------

class _ScriptedLLM:
    """Answers every call with ``content`` and remembers what it was sent."""

    def __init__(self, content):
        self._content = content
        self.messages = None
        self.config = None

    async def generate(self, messages, config=None, callback=None, component_name="unknown"):
        from stella_agent_sdk.llm import LLMResponse
        self.messages, self.config = messages, config
        return LLMResponse(content=self._content, model="test", provider="test")


def _dialogue(llm, **overrides):
    kwargs = dict(
        model="gpt-test", title="Memory Game", user_input="can we stop here?",
        history=[{"role": "assistant", "content": "What's on the list?"}],
        awaiting_answer=False, language="fr", bridge="D'accord.", persona="You are Grace.",
    )
    kwargs.update(overrides)
    return exit_dialogue(llm, **kwargs)


@pytest.mark.asyncio
async def test_the_exit_dialogue_writes_its_own_question():
    llm = _ScriptedLLM(
        '{"user_intent": "wants to stop", "decision": "ask", '
        '"say": "Tu veux qu\'on arrête le Memory Game ?"}'
    )
    step = await _dialogue(llm)
    assert step == ExitStep(ASK, say="Tu veux qu'on arrête le Memory Game ?", user_intent="wants to stop")


@pytest.mark.asyncio
async def test_the_exit_dialogue_is_scoped_to_the_stop_question():
    llm = _ScriptedLLM('{"user_intent": "x", "decision": "stay", "say": ""}')
    await _dialogue(llm)
    system, user = llm.messages[0].content, llm.messages[1].content
    assert system.startswith("You are Grace.")          # the persona's voice
    assert '"Memory Game"' in system and "'fr'" in system
    assert "D'accord." in system                        # continues the bridge
    assert "nearly all of them are simply taking" in system  # sees every turn
    assert "What's on the list?" in user and "can we stop here?" in user
    assert llm.config.json_mode is True and llm.config.model == "gpt-test"


@pytest.mark.asyncio
async def test_answering_the_question_says_so():
    llm = _ScriptedLLM('{"user_intent": "yes", "decision": "leave", "say": "Stop here?"}')
    step = await _dialogue(llm, awaiting_answer=True)
    # The question comes with a "leave" too: it is spoken if they were heard
    # too poorly to leave on their word alone.
    assert step == ExitStep(LEAVE, say="Stop here?", user_intent="yes")
    assert "you asked whether they want to stop" in llm.messages[0].content


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["not json", '{"decision": "maybe"}'])
async def test_an_unusable_answer_is_none(content):
    assert await _dialogue(_ScriptedLLM(content)) is None


@pytest.mark.asyncio
async def test_a_failed_call_is_none():
    class _Broken:
        async def generate(self, *a, **k):
            raise RuntimeError("boom")

    assert await _dialogue(_Broken()) is None


# ---------------------------------------------------------------------------
# Surviving a restart mid-activity
# ---------------------------------------------------------------------------

class _FakeSM:
    def __init__(self):
        self.cleared = False

    async def clear_plan(self):
        self.cleared = True
        return {"success": True}


def _agent(companion=True):
    agent = StellaV2Agent.__new__(StellaV2Agent)
    agent._companion_mode = companion
    agent.companion = Companion(activities=ACTIVITIES)
    agent._plan_config = None
    agent._last_known_state_id = None
    agent._newest_history_at = None
    agent._persona_config = None
    agent.sm_client = _FakeSM()
    return agent


@pytest.mark.asyncio
async def test_a_restart_mid_activity_resumes_the_running_plan():
    # on_session_start rebuilds companion state from the DEPLOY config, which has
    # no plan — but the state-machine row outlives the pod.
    agent = _agent()
    await agent._rehydrate_active_activity({"plan_id": "memory"})
    assert agent.companion.running_title == "Memory Game"
    assert agent._plan_config == ACTIVITIES[0]["plan"]


@pytest.mark.asyncio
async def test_a_restart_recognises_a_plan_by_its_own_id():
    agent = _agent()
    await agent._rehydrate_active_activity({"plan_id": "plan-content-id"})
    assert agent.companion.running_title == "Fitness Check-in"


@pytest.mark.asyncio
async def test_a_restart_with_nothing_running_stays_in_free_flow():
    agent = _agent()
    await agent._rehydrate_active_activity({})
    assert agent.companion.active is None and agent.sm_client.cleared is False


@pytest.mark.asyncio
async def test_an_activity_no_longer_offered_is_cleared_not_left_running():
    # Left in place it blocked every later start and swallowed every stop,
    # while the agent believed it was in free conversation.
    agent = _agent()
    await agent._rehydrate_active_activity({"plan_id": "removed-plan"})
    assert agent.companion.active is None
    assert agent.sm_client.cleared is True


@pytest.mark.asyncio
async def test_rehydration_never_overwrites_a_live_activity():
    agent = _agent()
    agent.companion.enter(ACTIVITIES[1])
    await agent._rehydrate_active_activity({"plan_id": "memory"})
    assert agent.companion.running_title == "Fitness Check-in"


@pytest.mark.asyncio
async def test_plan_following_agents_are_untouched_by_rehydration():
    agent = _agent(companion=False)
    await agent._rehydrate_active_activity({"plan_id": "memory"})
    assert agent._plan_config is None and agent.companion.active is None


def test_progress_metadata_reports_what_runs_and_what_can_be_picked():
    agent = _agent()
    assert agent._companion_progress_metadata()["active_activity"] is None
    assert [a["id"] for a in agent._companion_progress_metadata()["activities"]] == ["memory", "checkin"]
    agent.companion.enter(ACTIVITIES[0])
    assert agent._companion_progress_metadata()["active_activity"] == "Memory Game"


def test_plan_following_agents_send_no_companion_metadata():
    assert _agent(companion=False)._companion_progress_metadata() is None


# ---------------------------------------------------------------------------
# History scoped to the current mode
# ---------------------------------------------------------------------------

def _with_history(agent, messages):
    from types import SimpleNamespace

    agent._history_client = object()

    async def get_chat_history(include_debug=False, limit=20):
        return [SimpleNamespace(role=r, content=c, timestamp=t) for r, c, t in messages]

    agent.get_chat_history = get_chat_history


@pytest.mark.asyncio
async def test_history_inside_an_activity_starts_at_the_activity():
    agent = _agent()
    agent.companion.enter(ACTIVITIES[0])
    started = agent.companion.started_at
    _with_history(agent, [
        ("user", "earlier chat", (started - timedelta(minutes=1)).isoformat()),
        ("assistant", "step one question", (started + timedelta(seconds=1)).isoformat()),
    ])
    assert [m["content"] for m in await agent._fetch_conversation_history()] == ["step one question"]


@pytest.mark.asyncio
async def test_history_after_leaving_an_activity_is_one_line():
    agent = _agent()
    agent.companion.enter(ACTIVITIES[0])
    agent.companion.collected = {"nickname": "Fee"}
    started = agent.companion.started_at
    agent.companion.leave()
    # enter() and leave() run microseconds apart here; a real activity lasts
    # long enough to contain its own messages.
    agent.companion.segments[-1].ended_at = ended = started + timedelta(seconds=10)

    _with_history(agent, [
        ("user", "hi", (started - timedelta(seconds=5)).isoformat()),
        ("assistant", "what is your nickname?", (started + timedelta(microseconds=1)).isoformat()),
        ("user", "Fee", (started + timedelta(microseconds=2)).isoformat()),
        ("assistant", "back to chatting", (ended + timedelta(seconds=1)).isoformat()),
    ])
    assert [m["content"] for m in await agent._fetch_conversation_history()] == [
        "hi",
        'Activity "Memory Game" ended. Collected: nickname = Fee.',
        "back to chatting",
    ]


@pytest.mark.asyncio
async def test_the_newest_message_seen_is_remembered():
    agent = _agent()
    stamp = datetime(2026, 9, 29, 13, 30, tzinfo=timezone.utc)
    _with_history(agent, [("user", "hi", stamp.isoformat())])
    await agent._fetch_conversation_history()
    assert agent._newest_history_at == stamp


# ---------------------------------------------------------------------------
# The router is structural, not an expert you opt into
# ---------------------------------------------------------------------------

class _FakeRegistry:
    def __init__(self):
        self.calls = []

    def apply_config(self, config):
        self.calls.append(config)

    def enabled_for(self, name):
        state = None
        for call in self.calls:
            entry = (call.get("experts") or {}).get(name)
            if isinstance(entry, dict) and "enabled" in entry:
                state = entry["enabled"]
        return state


def _apply(companion_mode, saved_config):
    """Replay the two writes on_session_start makes, in the order it makes them."""
    registry = _FakeRegistry()
    registry.apply_config({"experts": saved_config})
    registry.apply_config({"experts": {"companion_router": {"enabled": companion_mode}}})
    return registry


def test_a_saved_config_cannot_disable_the_router_in_companion_mode():
    # The Configurator saves `companion_router: {enabled: false}` by default.
    assert _apply(True, {"companion_router": {"enabled": False}}).enabled_for("companion_router") is True


def test_a_saved_config_cannot_enable_the_router_in_plan_mode():
    assert _apply(False, {"companion_router": {"enabled": True}}).enabled_for("companion_router") is False


def test_other_experts_keep_honouring_their_saved_config():
    assert _apply(True, {"probing": {"enabled": False}}).enabled_for("probing") is False


# ---------------------------------------------------------------------------
# The opening: woken, she asks how they are, offers once, then only answers
# ---------------------------------------------------------------------------

def _turn(companion, commands=()):
    transition = companion.decide(list(commands))
    companion.note(transition)
    return transition


def test_woken_she_asks_how_they_are_then_offers_then_only_answers():
    companion = _free(woken=True)

    assert _turn(companion).change is Change.GREETED
    offer = _turn(companion)
    assert (offer.change, offer.unasked, offer.offered) == (Change.OFFERED, True, ACTIVITIES)
    assert _turn(companion) == NO_CHANGE
    assert _turn(companion) == NO_CHANGE


def test_what_the_user_asks_for_comes_before_her_own_routine():
    companion = _free(woken=True)

    asked = _turn(companion, [{"command": "list", "activities": ACTIVITIES}])
    assert (asked.change, asked.unasked) == (Change.OFFERED, False)
    # They have seen the activities, so nothing is left of the opening.
    assert _turn(companion) == NO_CHANGE


def test_going_to_sleep_starts_the_opening_over():
    companion = _free()
    assert _turn(companion, [{"command": "sleep"}]).change is Change.DISMISSED
    assert _turn(companion).change is Change.GREETED

    companion.rest()                            # idle sleep, nothing said
    assert _turn(companion).change is Change.GREETED


def test_an_empty_instruction_switches_that_step_off():
    companion = _free(woken=True)
    companion.settings.apply({"reply_instructions": {"greeting": ""}})
    assert _turn(companion).change is Change.OFFERED

    companion = _free(woken=True)
    companion.settings.apply({"reply_instructions": {"offered_unasked": ""}})
    assert _turn(companion).change is Change.GREETED
    assert _turn(companion) == NO_CHANGE


def test_with_nothing_to_offer_she_only_greets():
    companion = Companion(activities=[])
    assert _turn(companion).change is Change.GREETED
    assert _turn(companion) == NO_CHANGE


def test_the_opening_does_not_run_inside_an_activity():
    companion = _running()
    companion.greeted = companion.offered = False
    assert companion.decide([], ExitStep(STAY)) == NO_CHANGE


def test_in_free_conversation_the_reply_is_always_told_something():
    companion = _free()
    assert "no question" in companion.instruction(NO_CHANGE)
    assert "how they are doing" in companion.instruction(Transition(Change.GREETED))
    unasked = companion.instruction(Transition(Change.OFFERED, offered=ACTIVITIES, unasked=True))
    assert ACTIVITIES[0]["title"] in unasked and "how they are" in unasked

    assert _running().instruction(NO_CHANGE) == ""
