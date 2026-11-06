"""A whole interview through the agent, with fakes for everything outside it."""

import pytest

from elias_interviewer.agent import DEFAULT_MESSAGES, EliasInterviewerAgent
from elias_interviewer.guide import TRANSCRIPT_ID_KEY

from fakes import GUIDE, ConnectorError, FakeAudio, FakeConnectors, FakeStateMachine, ScriptedChecker

CONFIG = {}  # the platform's session config; ELIAS's own settings are env vars

ELIAS_ENV = ("ELIAS_PROJECT_ID", "ELIAS_MAX_ATTEMPTS", "ELIAS_OPENING", "ELIAS_REASK_PREFIX",
             "ELIAS_CLOSING", "ELIAS_ERROR", "ANSWER_CHECK_MODEL", "ANSWER_CHECK_TIMEOUT_S",
             "SESSION_END_MODE")


@pytest.fixture(autouse=True)
def elias_env(monkeypatch):
    """Each test starts from a deployment that set only the project id."""
    for name in ELIAS_ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ELIAS_PROJECT_ID", "p1")
    return monkeypatch
Q1, Q2, Q3 = (q["question"] for q in GUIDE["questions"])


class _TestAgent(EliasInterviewerAgent):
    # The SDK exposes `connectors` as a read-only property; a plain class
    # attribute here lets each test hand in its own fake.
    connectors = None


def make_agent(connectors, audio, sm=None, checker=None):
    agent = _TestAgent(checker=checker or ScriptedChecker(), sm_client=sm or FakeStateMachine())
    agent.connectors = connectors
    agent._audio_pipeline = audio
    agent._participant_poll_s = 0.01
    agent._completion_delay_s = 0
    return agent


async def run(agent, session_id="sess-1", config=CONFIG):
    await agent.on_session_start(session_id, config)
    [o async for o in agent.on_ready(session_id)]
    await agent.run_audio_loop()
    return await agent.on_session_end(session_id)


@pytest.mark.asyncio
async def test_asks_every_question_verbatim_and_writes_each_turn_to_elias():
    conn, audio, sm = FakeConnectors(), FakeAudio(["I was shocked.", "I walk more.", "My wife."]), FakeStateMachine()
    summary = await run(make_agent(conn, audio, sm))

    assert audio.spoken == [DEFAULT_MESSAGES["opening"], Q1, Q2, Q3, DEFAULT_MESSAGES["closing"]]

    start = conn.tools("start_interview")
    assert start == [{"project_id": "p1", "participant_id": "participant-42", "session_id": "sess-1"}]
    turns = [(a["speaker"], a["content"]) for a in conn.tools("record_interview_message")]
    assert turns == [
        ("interviewer", DEFAULT_MESSAGES["opening"]),
        ("interviewer", Q1), ("participant", "I was shocked."),
        ("interviewer", Q2), ("participant", "I walk more."),
        ("interviewer", Q3), ("participant", "My wife."),
        ("interviewer", DEFAULT_MESSAGES["closing"]),
    ]
    assert all(a["transcript_id"] == "t-new" for a in conn.tools("record_interview_message"))
    assert len({a["message_id"] for a in conn.tools("record_interview_message")}) == len(turns)
    assert conn.tools("end_interview") == [{"transcript_id": "t-new"}]
    # end_interview comes after every write
    tools = [t for (_, t, _) in conn.calls]
    assert tools.index("end_interview") > max(i for i, t in enumerate(tools) if t == "record_interview_message")

    assert sm.deliverables["q1_answer"] == "I was shocked."
    assert sm.deliverables[TRANSCRIPT_ID_KEY] == "t-new"
    assert sm.completed == ["q1", "q2", "q3"]
    assert summary["finished"] is True and summary["turns_failed"] == 0
    assert any(p.get("type") == "session_completed" for p in audio.published)


@pytest.mark.asyncio
async def test_unclear_reply_is_reasked_verbatim_and_skipped_after_three_asks():
    conn, sm = FakeConnectors(), FakeStateMachine()
    audio = FakeAudio(["hm", "what?", "banana", "I walk more.", "My wife."])
    await run(make_agent(conn, audio, sm))

    prefix = DEFAULT_MESSAGES["reask_prefix"]
    assert audio.spoken[1:7] == [Q1, prefix, Q1, prefix, Q1, Q2]
    assert sm.skipped == ["q1"]
    assert "q1_answer" not in sm.deliverables
    assert sm.completed == ["q2", "q3"]


@pytest.mark.asyncio
async def test_answer_given_on_second_ask_keeps_both_replies():
    sm = FakeStateMachine()
    audio = FakeAudio(["hm", "I was scared.", "I walk more.", "My wife."])
    await run(make_agent(FakeConnectors(), audio, sm))
    assert sm.deliverables["q1_answer"] == "hm\nI was scared."
    assert sm.completed == ["q1", "q2", "q3"]


@pytest.mark.asyncio
async def test_declined_question_is_skipped_without_reasking():
    sm = FakeStateMachine()
    audio = FakeAudio(["pass", "I walk more.", "My wife."])
    await run(make_agent(FakeConnectors(), audio, sm))
    assert audio.spoken[1:3] == [Q1, Q2]
    assert sm.skipped == ["q1"]


@pytest.mark.asyncio
async def test_guide_failure_says_the_error_line_and_opens_no_interview():
    conn = FakeConnectors(fail={"get_interview_guide": ConnectorError("401 from ELIAS", retryable=False)})
    audio = FakeAudio([])
    agent = make_agent(conn, audio)
    await agent.on_session_start("sess-1", CONFIG)
    ready = [o async for o in agent.on_ready("sess-1")]
    await agent.run_audio_loop()

    assert "interview guide" in agent._startup_error
    assert ready and ready[0].type.value == "error"
    assert audio.spoken == [DEFAULT_MESSAGES["error"]]
    assert conn.tools("start_interview") == [] and conn.tools("record_interview_message") == []
    assert agent.get_health_status()  # still reports health instead of crashing


@pytest.mark.asyncio
async def test_missing_project_id_and_missing_connectors_are_startup_errors(elias_env):
    elias_env.delenv("ELIAS_PROJECT_ID")
    agent = make_agent(FakeConnectors(), FakeAudio([]))
    await agent.on_session_start("s", CONFIG)
    assert "ELIAS_PROJECT_ID" in agent._startup_error
    elias_env.setenv("ELIAS_PROJECT_ID", "p1")

    agent = _TestAgent(checker=ScriptedChecker(), sm_client=FakeStateMachine())  # SDK without connectors
    await agent.on_session_start("s", CONFIG)
    assert "connectors" in agent._startup_error


@pytest.mark.asyncio
async def test_start_interview_failure_is_reported_not_retried():
    conn = FakeConnectors(fail={"start_interview": ConnectorError("timeout", retryable=True)})
    audio = FakeAudio([])
    await run(make_agent(conn, audio))
    assert len(conn.tools("start_interview")) == 1  # not idempotent, so one try
    assert audio.spoken == [DEFAULT_MESSAGES["error"]]


@pytest.mark.asyncio
async def test_wake_after_auto_pause_continues_the_same_elias_interview():
    sm = FakeStateMachine()
    first = make_agent(FakeConnectors(), FakeAudio(["I was shocked."]), sm)
    await run(first)  # pod stopped after one answer (audio ran out = auto-pause)
    assert first._finished is False

    conn = FakeConnectors()
    audio = FakeAudio(["I walk more.", "My wife."])
    await run(make_agent(conn, audio, sm))

    assert conn.tools("start_interview") == []  # reused t-new
    assert audio.spoken == [Q2, Q3, DEFAULT_MESSAGES["closing"]]  # no second opening
    assert {a["transcript_id"] for a in conn.tools("record_interview_message")} == {"t-new"}
    assert conn.tools("end_interview") == [{"transcript_id": "t-new"}]


@pytest.mark.asyncio
async def test_teardown_alone_never_ends_the_elias_interview():
    conn = FakeConnectors()
    await run(make_agent(conn, FakeAudio(["I was shocked."])))
    assert conn.tools("end_interview") == []


@pytest.mark.asyncio
async def test_real_session_end_finalises_a_partial_interview():
    conn = FakeConnectors()
    agent = make_agent(conn, FakeAudio(["I was shocked."]))
    await agent.on_session_start("s", CONFIG)
    await agent.run_audio_loop()
    [o async for o in agent.on_session_ending("s", "session_end", 5000)]
    assert conn.tools("end_interview") == [{"transcript_id": "t-new"}]


@pytest.mark.parametrize("platform_default", [None, "farewell", "silent"])
def test_the_sdk_runs_the_wrap_up_hook_whatever_the_platform_default(elias_env, platform_default):
    # The time cap or the organiser ending the session must reach
    # on_session_ending (which closes the ELIAS interview). run.py calls it only
    # in 'wrap_up' mode, so this goes through the SDK's own resolver.
    from stella_agent_sdk.run import _resolve_session_end_mode

    if platform_default:
        elias_env.setenv("SESSION_END_MODE", platform_default)
    agent = make_agent(FakeConnectors(), FakeAudio([]))
    assert _resolve_session_end_mode(agent) == "wrap_up"


@pytest.mark.asyncio
async def test_answer_check_timeout_from_env_is_read_once_and_clamped(elias_env):
    for raw, expected in (("3", 3.0), ("2.5", 2.5), ("0", 1.0), ("600", 60.0), ("soon", 8.0), ("", 8.0)):
        elias_env.setenv("ANSWER_CHECK_TIMEOUT_S", raw)
        agent = _TestAgent(sm_client=FakeStateMachine())  # no checker: the agent builds its own
        agent.connectors = FakeConnectors()
        await agent.on_session_start("s", CONFIG)
        assert agent._checker._completer._timeout_s == expected, raw


@pytest.mark.asyncio
async def test_custom_lines_from_env_and_calls_through_the_elias_slot(elias_env):
    elias_env.setenv("ELIAS_CLOSING", "Bye.")
    elias_env.setenv("ELIAS_OPENING", "Welcome.")
    conn = FakeConnectors()
    audio = FakeAudio(["a", "b", "c"])
    await run(make_agent(conn, audio))
    assert audio.spoken == ["Welcome.", Q1, Q2, Q3, "Bye."]
    assert {h for (h, _, _) in conn.calls} == {"elias"}


@pytest.mark.asyncio
async def test_max_attempts_from_env_is_clamped(elias_env):
    for raw, expected in (("1", 1), ("9", 5), ("0", 1), ("lots", 3), ("", 3)):
        elias_env.setenv("ELIAS_MAX_ATTEMPTS", raw)
        agent = make_agent(FakeConnectors(), FakeAudio([]))
        await agent.on_session_start("s", CONFIG)
        assert agent._interview.max_attempts == expected, raw


@pytest.mark.asyncio
async def test_failed_elias_writes_do_not_stop_the_interview():
    conn = FakeConnectors(fail={"record_interview_message": ConnectorError("bad", retryable=False)})
    audio = FakeAudio(["a", "b", "c"])
    summary = await run(make_agent(conn, audio))
    assert audio.spoken[-1] == DEFAULT_MESSAGES["closing"]
    assert summary["turns_failed"] == 8


def test_registers_under_the_type_the_platform_injects(monkeypatch):
    # The platform waits for the slug it deployed; the agent never hardcodes it.
    monkeypatch.setenv("AGENT_TYPE", "elias-interviewer")
    monkeypatch.setenv("AGENT_VERSION", "0.1.0")
    agent = _TestAgent(checker=ScriptedChecker(), sm_client=FakeStateMachine())
    assert (agent.agent_type, agent.agent_version) == ("elias-interviewer", "0.1.0")


def test_wrap_up_budget_leaves_room_for_the_sdk_farewell():
    from elias_interviewer.agent import wrap_up_budget_s

    assert wrap_up_budget_s(30_000) == 13.0
    assert wrap_up_budget_s(5_000) == 1.0  # never zero
    assert wrap_up_budget_s(0) == 1.0


@pytest.mark.asyncio
async def test_real_session_end_never_outlives_its_deadline(monkeypatch):
    import asyncio
    import time

    import elias_interviewer.agent as agent_mod

    monkeypatch.setattr(agent_mod, "_SDK_END_RESERVE_S", 0.0)
    conn = FakeConnectors()
    agent = make_agent(conn, FakeAudio(["I was shocked."]))
    await agent.on_session_start("s", CONFIG)
    await agent.run_audio_loop()

    async def hang(_tid):
        await asyncio.sleep(30)

    agent._elias.end_interview = hang
    start = time.monotonic()
    [o async for o in agent.on_session_ending("s", "session_end", 1500)]
    assert time.monotonic() - start < 3


def _debug_lines(audio):
    return [p["data"] for p in audio.published if p.get("type") == "debug" and p["data"]["component"] == "elias"]


@pytest.mark.asyncio
async def test_debug_feed_follows_the_elias_calls_and_each_decision():
    conn = FakeConnectors()
    audio = FakeAudio(["hm", "I was shocked.", "pass", "My sister."])
    await run(make_agent(conn, audio))
    text = [d["content"] for d in _debug_lines(audio)]

    def first(prefix):
        return next(i for i, t in enumerate(text) if t.startswith(prefix))

    assert first("Connecting to ELIAS project") < first("ELIAS get_interview_guide ok") < first("Interview guide loaded: 3 questions")
    assert first("ELIAS start_interview ok") < first("ELIAS interview t-new started") < first("Asking question 1 of 3")
    assert any(t.startswith("Question 1 of 3: not accepted, re-asking (ask 2 of 3)") for t in text)
    assert any(t.startswith("Asking question 1 of 3 again (ask 2 of 3)") for t in text)
    assert any(t.startswith("Question 1 of 3: answer accepted") for t in text)
    assert any(t.startswith("Question 2 of 3: skipped") for t in text)
    assert any(t.startswith("ELIAS record_interview_message ok (participant turn)") for t in text)
    assert any(t.startswith("ELIAS record_interview_message ok (interviewer turn)") for t in text)
    assert "ELIAS interview t-new ended" in text
    by_text = {d["content"]: d["level"] for d in _debug_lines(audio)}
    assert {lvl for t, lvl in by_text.items() if "re-asking" in t or "skipped" in t} == {"warn"}
    # The reply itself is never copied (the checker's reason may paraphrase it).
    assert not any("shocked" in str(d) or "sister" in str(d) for d in _debug_lines(audio))


@pytest.mark.asyncio
async def test_debug_feed_reports_retries_and_failures():
    conn = FakeConnectors(fail={"get_interview_guide": ConnectorError("ELIAS down", retryable=True)})
    audio = FakeAudio([])
    agent = make_agent(conn, audio)
    import elias_interviewer.elias as elias_mod

    async def no_sleep(_s):
        return None

    orig = elias_mod.asyncio.sleep
    elias_mod.asyncio.sleep = no_sleep
    try:
        await agent.on_session_start("s", CONFIG)
    finally:
        elias_mod.asyncio.sleep = orig
    await agent._close_debug()
    lines = _debug_lines(audio)
    assert [d["level"] for d in lines if "retry" in d["content"]] == ["warn", "warn"]
    assert any(d["level"] == "error" and d["content"].startswith("ELIAS get_interview_guide failed after") for d in lines)
    assert any(d["level"] == "error" and d["content"].startswith("Startup failed") for d in lines)


@pytest.mark.asyncio
async def test_startup_debug_lines_wait_for_the_participant():
    audio = FakeAudio(["I was shocked."], identities=["agent-x"])  # nobody in the room yet
    agent = make_agent(FakeConnectors(), audio)
    await agent.on_session_start("s", CONFIG)
    import asyncio

    await asyncio.sleep(0.05)
    assert _debug_lines(audio) == []  # held back
    audio.identities.append("participant-42")
    await agent.run_audio_loop()
    await agent.on_session_end("s")
    text = [d["content"] for d in _debug_lines(audio)]
    assert text[0].startswith("Connecting to ELIAS project")
    assert text.index("Interview guide loaded: 3 questions") < text.index("ELIAS interview t-new started")
