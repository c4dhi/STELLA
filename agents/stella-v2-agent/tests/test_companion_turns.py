"""Whole companion turns through process(), replaying the dev sessions of 29 Sep.

The contract under test: inside an activity every turn is built exactly as a
plan-mode deployment of that plan would build it. The only companion additions
are leaving (judged by the scoped exit dialogue) and handing back to free conversation when
the plan ends.

Only the LLM-backed stages are faked. The state machine is a small stateful
fake, the message store records every turn with a timestamp as the recorder
does, and the router's proposals go through the REAL companion tools.
"""

import asyncio
import json
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest

from stella_agent_sdk import AgentInput
from stella_agent_sdk.llm import LLMResponse
from stella_v2_agent.companion_tools import create_companion_tools
from stella_v2_agent.agent import StellaV2Agent
from stella_v2_agent.companion import EXIT_MODEL, Companion
from stella_v2_agent.models.expert_verdict import ExpertVerdict
from stella_v2_agent.pipeline.arbitration import Arbitration


PLAN = {
    "id": "checkin-plan",
    "title": "Extended Fitness Check-in",
    "states": [
        {
            "id": "greeting",
            "title": "Greeting",
            "tasks": [{
                "id": "t-name",
                "description": "Greet and ask for name",
                "instruction": "Greet the user and ask for their name",
                "deliverables": [{"key": "user_name", "description": "User's preferred name"}],
            }],
        },
        {
            "id": "goals",
            "title": "Goals",
            "tasks": [{
                "id": "t-goal",
                "description": "Ask about fitness goals",
                "instruction": "Ask about their fitness goals",
                "deliverables": [{"key": "fitness_goal", "description": "Fitness goal"}],
            }],
        },
    ],
}

ACTIVITIES = [
    {
        "id": "prolific",
        "title": "Prolific Study",
        "description": "A quick check in on the user and their fitness goals",
        "plan": {**PLAN, "id": "prolific-plan", "title": "Prolific Study"},
    },
    {
        "id": "extended",
        "title": "Extended Fitness Check-in",
        "description": "A comprehensive conversation covering exercise habits",
        "plan": PLAN,
    },
]


class FakeStateMachine:
    """The backend state machine, as far as the agent can observe it."""

    def __init__(self, plan: Optional[Dict[str, Any]] = None):
        self.plan = plan
        self.state = 0
        self.collected: Dict[str, Any] = {}
        self.calls: List[str] = []

    def _state(self):
        return self.plan["states"][self.state] if self.plan else None

    async def load_plan(self, plan):
        self.calls.append(f"load:{plan['id']}")
        self.plan, self.state, self.collected = plan, 0, {}
        return {"success": True, "current_state_id": plan["states"][0]["id"]}

    async def clear_plan(self):
        self.calls.append("clear")
        self.plan = None
        return {"success": True}

    async def get_full_state(self):
        if not self.plan:
            return None
        return {
            "plan_id": self.plan["id"],
            "current_state_id": self._state()["id"],
            "progress": 0,
            "states": [
                {
                    "id": s["id"],
                    "title": s["title"],
                    "tasks": [
                        {**t, "status": "pending", "deliverables": t["deliverables"]}
                        for t in s["tasks"]
                    ],
                }
                for s in self.plan["states"]
            ],
        }

    async def get_current_state(self):
        state = self._state()
        if not state:
            return None
        return {"state_id": state["id"], "state_title": state["title"], "state_type": "loose"}

    async def get_pending_tasks(self):
        state = self._state()
        return [
            {
                "id": t["id"],
                "description": t["description"],
                "instruction": t["instruction"],
                "deliverable_keys": [d["key"] for d in t["deliverables"]],
                "is_preview": False,
            }
            for t in (state["tasks"] if state else [])
        ]

    async def get_pending_deliverables(self):
        state = self._state()
        return [
            d for t in (state["tasks"] if state else []) for d in t["deliverables"]
            if d["key"] not in self.collected
        ]

    async def get_collected_deliverables(self):
        return dict(self.collected) if self.plan else {}

    async def increment_turn(self):
        self.calls.append("increment_turn")
        return 1


QUESTION = "Just to check: do you want to stop the Extended Fitness Check-in here?"
ASK = {"user_intent": "might want to stop", "decision": "ask", "say": QUESTION}
LEAVE = {"user_intent": "wants to stop now", "decision": "leave", "say": ""}
STAY = {"user_intent": "wants to carry on", "decision": "stay", "say": ""}


class Session:
    """One agent, its message store, and scripted expert behaviour per turn."""

    def __init__(self, *, companion: bool, sm: FakeStateMachine, exits=None):
        self.sm = sm
        self.messages: List[SimpleNamespace] = []
        self.pool_inputs: List[Dict[str, Any]] = []
        self.replies: List[Dict[str, Any]] = []
        self.router_calls: List[Dict[str, Any]] = []   # per turn: {tool, args}
        self.extraction: Dict[str, Any] = {}           # task_extraction's raw_output
        # What the exit dialogue answers, call by call (then: ask).
        self.exit_answers = list(exits or [])
        self.exit_calls: List[Any] = []
        self.exit_models: List[str] = []
        self.agent = self._build(companion)

    def _build(self, companion: bool) -> StellaV2Agent:
        agent = StellaV2Agent.__new__(StellaV2Agent)
        agent._audio_pipeline = None
        agent._history_client = object()
        agent._is_processing = False
        agent._turn_counter = 0
        agent._last_reply_text = ""
        agent._session_language = None
        agent._session_voice = None
        agent._session_started_at = None
        agent._session_completed = False
        agent._custom_history_limit = 20
        agent._plan_config = None if companion else self.sm.plan
        agent._persona_config = None
        agent._compiler_version = "1.0.0"
        agent._last_known_state_id = None
        agent._last_state_id = None
        agent._newest_history_at = None
        agent._companion_mode = companion
        agent.companion = Companion(activities=ACTIVITIES if companion else [])
        agent.sm_client = self.sm
        agent.language_resolver = SimpleNamespace(
            set_plan_language=lambda *_a, **_k: None,
            resolve=lambda *_a, **_k: "en",
            forced=None,
        )
        agent.expert_registry = SimpleNamespace(
            get_enabled_names=lambda: ["companion_router", "task_extraction"],
            as_map=lambda: {},
        )
        agent.arbitration = Arbitration()
        tools = {
            t.name: t
            for t in create_companion_tools(ACTIVITIES, lambda: agent.companion.running_title)
        }

        session = self

        async def get_chat_history(include_debug=False, limit=20):
            return list(session.messages)[-limit:]

        agent.get_chat_history = get_chat_history

        async def pool_run(names, user_input, history, sm_context):
            session.pool_inputs.append({"history": list(history), "sm_context": dict(sm_context)})
            verdicts = [ExpertVerdict(
                expert_name="task_extraction", verdict="no_tool_calls",
                success=True, raw_output=dict(session.extraction),
            )]
            if companion:
                results = []
                for call in session.router_calls:
                    result = await tools[call["tool"]].execute(**call.get("args", {}))
                    results.append({
                        "name": call["tool"], "success": result.success,
                        "data": result.data, "error": result.error,
                    })
                verdicts.append(ExpertVerdict(
                    expert_name="companion_router", success=True,
                    verdict="tool_calls_executed" if results else "no_tool_calls",
                    raw_output={"tool_results": results},
                ))
            return verdicts

        agent.expert_pool = SimpleNamespace(run=pool_run)

        async def bridge(text, history, language=None, variables=None):
            yield "Okay."

        agent.bridge_generator = SimpleNamespace(generate_stream=bridge, last_bridge_mode=None)

        async def generate(**kwargs):
            session.replies.append({
                "history": list(kwargs["conversation_history"]),
                "sm_context": dict(kwargs["sm_context"]),
                "guidance": kwargs["directive"].to_prompt_section(),
            })
            from stella_agent_sdk import AgentOutput
            yield AgentOutput.text_chunk(
                kwargs["session_id"], "Okay. (reply)",
                transcript_id=kwargs.get("transcript_id"), is_final=True,
            )

        agent.response_generator = SimpleNamespace(generate=generate, response_model="gpt-test")

        async def llm_generate(messages, config=None, callback=None, component_name="unknown"):
            session.exit_calls.append(messages)
            session.exit_models.append(config.model)
            answer = session.exit_answers.pop(0) if session.exit_answers else ASK
            if isinstance(answer, Exception):
                raise answer
            return LLMResponse(content=json.dumps(answer), model="t", provider="t")

        agent.llm_service = SimpleNamespace(generate=llm_generate)
        return agent

    def _record(self, role: str, content: str) -> None:
        self.messages.append(SimpleNamespace(
            role=role, content=content, timestamp=datetime.now(timezone.utc).isoformat(),
        ))

    async def turn(self, text: str, router: Optional[List[Dict[str, Any]]] = None,
                   assistant_says: str = "") -> List[Any]:
        """One user turn: recorded, processed, and the reply recorded after it."""
        self.router_calls = router or []
        self._record("user", text)
        outputs = [o async for o in self.agent.process(AgentInput.text_input("s1", text))]
        self._record("assistant", assistant_says or f"reply to: {text}")
        self.extraction = {}
        return outputs

    @property
    def reply(self) -> Dict[str, Any]:
        return self.replies[-1]


def _start(activity_id):
    return [{"tool": "start_activity", "args": {"activity_id": activity_id}}]


STOP = [{"tool": "end_activity", "args": {"reason": "user wants to stop"}}]


def _kinds(outputs):
    return [
        o.metadata["decision"]["kind"] for o in outputs
        if isinstance(o.metadata, dict) and "decision" in o.metadata
    ]


async def _companion_in_activity(**kwargs) -> Session:
    session = Session(companion=True, sm=FakeStateMachine(), **kwargs)
    await session.turn("hi Grace")
    await session.turn("what can we do?", router=[{"tool": "list_activities"}])
    await session.turn("let's do the extended one", router=_start("extended"),
                       assistant_says="Great! First, what's your name?")
    return session


# ---------------------------------------------------------------------------
# Entering: the activity's first turn is plan mode's first turn
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_the_opening_reply_sees_the_plans_first_step_and_no_free_flow():
    """Regression (sessions 0a93a942, f4cd9365): the opening reply was written
    from the free-flow history, where the user had just said "fitness goals",
    and asked about goals while the plan waited on "greet and ask for name"."""
    session = await _companion_in_activity()

    assert session.sm.calls[0] == "load:checkin-plan"
    assert session.reply["sm_context"]["state"]["title"] == "Greeting"
    assert session.reply["sm_context"]["current_task"]["description"] == "Greet and ask for name"
    # A plan-mode session has nothing before its first turn; neither does this.
    assert session.reply["history"] == []
    assert "only just begun" in session.reply["guidance"]


@pytest.mark.asyncio
async def test_the_plan_loads_after_the_pool_so_nothing_races_it():
    # task_extraction wrote into the plan-less session while start_activity
    # loaded the plan in parallel — whichever landed last won.
    session = Session(companion=True, sm=FakeStateMachine())
    seen_during_pool = []
    run = session.agent.expert_pool.run

    async def pool_run(*args):
        seen_during_pool.append(session.sm.plan)
        return await run(*args)

    session.agent.expert_pool = SimpleNamespace(run=pool_run)
    await session.turn("let's do the extended one", router=_start("extended"))
    assert seen_during_pool == [None]
    assert session.sm.plan is PLAN


def test_the_router_picks_by_the_description_it_was_offered_in():
    # The reply offered "a quick check-in on your fitness goals" (Prolific
    # Study's description) and the router, seeing titles only, started the one
    # whose TITLE had "Fitness" in it (session f4cd9365).
    tools = create_companion_tools(ACTIVITIES, lambda: None)
    start = next(t for t in tools if t.name == "start_activity")
    description = start.parameters_schema["properties"]["activity_id"]["description"]
    assert 'prolific = "Prolific Study" (A quick check in on the user and their fitness goals)' in description


# ---------------------------------------------------------------------------
# Inside: identical to plan mode
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_an_activity_turn_is_built_exactly_like_a_plan_mode_turn():
    """The contract, stated directly. Same plan, same activity transcript, same
    user input: the reply and every expert get identical inputs in companion
    mode and in a plan-mode deployment of that plan."""
    companion = await _companion_in_activity()
    await companion.turn("I'm Felix")

    plan_mode = Session(companion=False, sm=FakeStateMachine(plan=PLAN))
    # The activity's own transcript: everything after it started.
    plan_mode._record("assistant", "Great! First, what's your name?")
    await plan_mode.turn("I'm Felix")

    assert companion.reply == plan_mode.reply
    assert companion.pool_inputs[-1] == plan_mode.pool_inputs[-1]


@pytest.mark.asyncio
async def test_experts_see_no_injected_activity_line():
    # The "Activity X is currently running" line went into EVERY expert's
    # history; only the router needs it, and its tool descriptions carry it now.
    session = await _companion_in_activity()
    await session.turn("I'm Felix")
    assert all(m["role"] != "system" for m in session.pool_inputs[-1]["history"])
    tools = create_companion_tools(ACTIVITIES, lambda: session.agent.companion.running_title)
    assert "already running" in next(t for t in tools if t.name == "start_activity").description


@pytest.mark.asyncio
async def test_a_repeat_start_mid_activity_keeps_its_progress():
    """Regression (session 92ad3f90): answering the name question re-started the
    activity and reset it to its first state."""
    session = await _companion_in_activity()
    session.sm.state = 1
    outputs = await session.turn("Ich heiße Felix", router=_start("prolific"))

    assert session.sm.calls.count("load:checkin-plan") == 1
    assert not any(c.startswith("load:prolific") for c in session.sm.calls)
    assert session.sm.state == 1
    assert "activity_command_ignored" in _kinds(outputs)
    # And the reply is written as an ordinary plan turn, with no directive.
    assert "starts now" not in session.reply["guidance"]


# ---------------------------------------------------------------------------
# Leaving: asked on one turn, answered on the next
# ---------------------------------------------------------------------------

def _spoken(outputs):
    return [o.content for o in outputs if o.type.value == "text_chunk" and o.is_final]


@pytest.mark.asyncio
async def test_a_stop_is_asked_first_and_nothing_ends():
    """Regression (session f4cd9365): the stop request was judged as its own
    confirmation, so the question was never asked."""
    session = await _companion_in_activity()
    replies_before = len(session.replies)
    outputs = await session.turn("can we stop?", router=STOP)

    assert "clear" not in session.sm.calls
    assert len(session.exit_calls) == 1
    assert session.agent.companion.pending_exit is True
    # The exit dialogue's question is spoken as written — the reply model,
    # which followed the plan instead, is not asked to write this turn.
    assert _spoken(outputs) == [QUESTION]
    assert len(session.replies) == replies_before
    assert "activity_end_proposed" in _kinds(outputs)


@pytest.mark.asyncio
async def test_an_unmistakable_stop_leaves_without_asking():
    session = await _companion_in_activity(exits=[LEAVE])
    outputs = await session.turn("stop, I want to end this now", router=STOP)
    assert session.sm.calls[-1] == "clear"
    assert "has just been stopped" in session.reply["guidance"]
    assert "activity_ended" in _kinds(outputs)


@pytest.mark.asyncio
async def test_a_complaint_the_router_took_for_a_stop_changes_nothing():
    """Regression (session f4cd9365): "the first question was not what the
    activity wanted" was taken as a stop request."""
    session = await _companion_in_activity(exits=[STAY])
    outputs = await session.turn("that question was not what the activity wanted", router=STOP)
    assert "clear" not in session.sm.calls
    assert session.agent.companion.pending_exit is False
    assert "activity_command_ignored" in _kinds(outputs)
    assert session.reply["guidance"] == ""  # an ordinary plan turn


@pytest.mark.asyncio
async def test_a_failed_exit_dialogue_still_asks():
    session = await _companion_in_activity(exits=[RuntimeError("timeout")])
    replies_before = len(session.replies)
    await session.turn("can we stop?", router=STOP)
    assert session.agent.companion.pending_exit is True
    assert len(session.replies) == replies_before + 1
    assert "whether they want to stop" in session.reply["guidance"]


@pytest.mark.asyncio
async def test_the_exit_dialogue_runs_on_its_own_model_not_the_replys():
    session = await _companion_in_activity(exits=[ASK])
    await session.turn("can we stop?", router=STOP)
    assert session.exit_models == [EXIT_MODEL]


@pytest.mark.asyncio
async def test_a_deployment_can_choose_the_exit_dialogues_model():
    session = await _companion_in_activity(exits=[ASK])
    session.agent.barge_in_evaluator = None
    session.agent._apply_pipeline_config({"nodes": {"exit_dialogue": {"model": "gpt-other"}}})
    await session.turn("can we stop?", router=STOP)
    assert session.exit_models == ["gpt-other"]


@pytest.mark.asyncio
async def test_the_answer_is_judged_with_the_question_in_view():
    session = await _companion_in_activity(exits=[ASK, STAY])
    await session.turn("can we stop?", router=STOP, assistant_says=QUESTION)
    await session.turn("hm, actually no")
    system, user = session.exit_calls[-1][0].content, session.exit_calls[-1][1].content
    assert "you asked whether they want to stop" in system
    assert QUESTION in user and "hm, actually no" in user


@pytest.mark.asyncio
async def test_an_unclear_answer_is_asked_about_again():
    session = await _companion_in_activity(exits=[ASK, ASK])
    await session.turn("can we stop?", router=STOP)
    outputs = await session.turn("hmm")
    assert _spoken(outputs) == [QUESTION]
    assert session.agent.companion.pending_exit is True


@pytest.mark.asyncio
async def test_the_question_is_asked_even_when_the_plan_moved_that_turn():
    """Regression (session 5d10b334): task_extraction skipped the open task on
    "can we stop here", the plan advanced, and the reply — told only to ASK —
    followed the new phase instead: "What are your main fitness goals?"."""
    session = await _companion_in_activity()
    session.extraction = {"transitioned": True, "new_state_id": "goals"}
    session.sm.state = 1
    outputs = await session.turn("I don't know, but can we stop here", router=STOP)

    assert _spoken(outputs) == [QUESTION]
    assert not any("goals" in text.lower() for text in _spoken(outputs))


def test_the_tool_contract_says_a_stop_request_is_not_a_skip():
    from stella_agent_sdk.tools.state_machine import STATE_MACHINE_TOOL_GUIDANCE
    assert "A request to STOP or leave altogether" in STATE_MACHINE_TOOL_GUIDANCE


@pytest.mark.asyncio
async def test_yes_leaves_and_the_reply_is_written_in_free_conversation():
    """No ghost continuation: the closing reply sees no plan and the activity
    folded into one line — not the activity's next question."""
    session = await _companion_in_activity(exits=[ASK, LEAVE])
    await session.turn("can we stop?", router=STOP)
    outputs = await session.turn("yes")

    assert session.sm.calls[-1] == "clear"
    assert session.agent.companion.active is None
    assert session.agent._plan_config is None
    assert session.reply["sm_context"].get("state") is None
    assert "has just been stopped" in session.reply["guidance"]
    contents = [m["content"] for m in session.reply["history"]]
    assert 'Activity "Extended Fitness Check-in" ended.' in contents
    assert "Great! First, what's your name?" not in contents
    assert "activity_ended" in _kinds(outputs)


@pytest.mark.asyncio
async def test_no_stays_and_carries_on():
    session = await _companion_in_activity(exits=[ASK, STAY])
    await session.turn("can we stop?", router=STOP)
    outputs = await session.turn("hm, actually no")

    assert "clear" not in session.sm.calls
    assert session.agent.companion.running_title == "Extended Fitness Check-in"
    assert session.agent.companion.pending_exit is False
    assert "Stay in the activity" in session.reply["guidance"]
    assert "activity_end_declined" in _kinds(outputs)


@pytest.mark.asyncio
async def test_after_leaving_free_flow_counts_no_plan_turns():
    session = await _companion_in_activity(exits=[ASK, LEAVE])
    await session.turn("can we stop?", router=STOP)
    await session.turn("yes")
    calls_before = list(session.sm.calls)
    await session.turn("so, how's your day?")
    assert session.sm.calls == calls_before


# ---------------------------------------------------------------------------
# Finishing: the plan's end hands back, it does not hang up
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_completing_the_plan_through_a_tool_returns_to_free_flow():
    """Regression: task_extraction completing the last task reported
    session_completed, and the agent ended the WHOLE companion session."""
    session = await _companion_in_activity()

    async def full_state_at_end():
        return {"plan_id": PLAN["id"], "current_state_id": "__end__", "states": []}

    session.sm.get_full_state = full_state_at_end
    session.extraction = {"session_completed": True, "farewell_message": "Thanks, that's all!"}
    outputs = await session.turn("my goal is a 10k")

    assert session.agent._session_completed is False
    assert session.agent.companion.active is None
    assert "activity_completed" in _kinds(outputs)
    assert any(getattr(o, "content", "") == "Thanks, that's all!" for o in outputs)


@pytest.mark.asyncio
async def test_a_plan_mode_session_still_ends_at_its_end():
    session = Session(companion=False, sm=FakeStateMachine(plan=PLAN))

    async def full_state_at_end():
        return {"plan_id": PLAN["id"], "current_state_id": "__end__", "states": []}

    session.sm.get_full_state = full_state_at_end
    session.extraction = {"session_completed": True, "farewell_message": "Bye!"}
    await session.turn("my goal is a 10k")
    assert session.agent._session_completed is True


# ---------------------------------------------------------------------------
# Failure leaves the mode as it was
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_failed_load_stays_in_free_flow():
    sm = FakeStateMachine()

    async def failing_load(plan):
        return {"success": False, "error": "gRPC error"}

    sm.load_plan = failing_load
    session = Session(companion=True, sm=sm)
    await session.turn("let's do the extended one", router=_start("extended"))
    assert session.agent.companion.active is None
    assert session.agent._plan_config is None
    assert session.reply["guidance"] == ""


@pytest.mark.asyncio
async def test_a_failed_clear_stays_in_the_activity():
    session = await _companion_in_activity(exits=[ASK, LEAVE])
    await session.turn("can we stop?", router=STOP)

    async def failing_clear():
        return {"success": False, "error": "gRPC error"}

    session.sm.clear_plan = failing_clear
    await session.turn("yes")
    assert session.agent.companion.running_title == "Extended Fitness Check-in"
    assert session.agent.companion.pending_exit is False


@pytest.mark.asyncio
async def test_an_interrupted_confirmation_is_asked_again_next_turn():
    session = await _companion_in_activity(exits=[ASK, LEAVE])
    await session.turn("can we stop?", router=STOP)

    gen = session.agent.process(AgentInput.text_input("s1", "yes"))
    await gen.__anext__()          # the turn starts, the check is in flight...
    await gen.aclose()             # ...and a barge-in closes it
    await asyncio.sleep(0)
    assert session.agent.companion.pending_exit is True
    assert "clear" not in session.sm.calls
