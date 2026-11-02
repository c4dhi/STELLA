"""The decisions around Jev, with Jev itself replaced by fixed answers."""

import asyncio
from types import SimpleNamespace
from typing import Dict

import pytest
from stella_agent_sdk.messages.types import BargeInDecision
from stella_v2_agent.experts.registry import ExpertRegistry
from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.models.expert_verdict import ExpertVerdict
from stella_v2_agent.pipeline.arbitration import Arbitration

from stella_jev_agent.agent import _OWN_EXPERTS_DIR, COMMON
from stella_jev_agent.ask_back import AFTER_ASK_BACK_INSTRUCTION, ASK_BACK_INSTRUCTION, AskBack
from stella_jev_agent.jev import JevUnavailable
from stella_jev_agent.pool import JevExpertPool, current_task
from stella_jev_agent.questions import DOESNT_FIT, SLIGHT_DOUBT
from stella_jev_agent.stages import JevBargeInEvaluator, JevResponseGenerator, NoBridge


def _answer(**probabilities: float) -> SimpleNamespace:
    return SimpleNamespace(choice=max(probabilities, key=probabilities.get), probabilities=probabilities)


FITS_ANSWER = _answer(fits=0.97, slight_doubt=0.02, doesnt_fit=0.01)
MISFIT_ANSWER = _answer(fits=0.1, slight_doubt=0.1, doesnt_fit=0.8)
QUIET_MEDICAL = _answer(none=0.97, low=0.01, high=0.01, critical=0.01)
CRITICAL_MEDICAL = _answer(none=0.01, low=0.01, high=0.08, critical=0.9)
SPEECH = _answer(speech=0.99, artifact=0.01)


class FakeJev:
    def __init__(self, answers=None, fail=False):
        self.answers = answers or {}
        self.fail = fail
        self.asked = []
        self.timeout_s = 1.5

    async def ask(self, state, questions, timeout_s=0):
        self.asked.append((state, set(questions)))
        if self.fail:
            raise JevUnavailable("down")
        return SimpleNamespace(answers=self.answers, latency_ms=100.0)


class Pool(JevExpertPool):
    """Records the language-model experts instead of calling them."""

    def __init__(self, jev, ask_back):
        super().__init__(
            None, ExpertRegistry(experts_dir=str(_OWN_EXPERTS_DIR)),
            compiler_version="1.0.0", jev=jev, ask_back=ask_back,
        )
        self.language_model_calls = []

    async def _run_experts(self, expert_names, *args, **kwargs):
        self.language_model_calls.append(list(expert_names))
        return [ExpertVerdict(expert_name=n, verdict="fits" if n == COMMON else "none", priority=1) for n in expert_names]


NAMES = [COMMON, "medical", "legal", "task_extraction", "companion_router"]


def _answers(common=FITS_ANSWER, medical=QUIET_MEDICAL, has_answer=0.5, activity=0.99, artifact=SPEECH) -> Dict:
    return {
        COMMON: common,
        "recogniser_artifact": artifact,
        "medical": medical,
        "legal": _answer(none=0.99, low=0.0, high=0.0, critical=0.01),
        "has_answer": _answer(no=1 - has_answer, yes=has_answer),
        "activity_intent": _answer(none=activity, transition=1 - activity),
    }


def _run(pool, names=NAMES):
    return asyncio.run(pool.run(names, "Neun Liter.", [{"role": "assistant", "content": "Wie viel trinken Sie?"}], {}))


def _verdict(verdicts, name):
    return next(v for v in verdicts if v.expert_name == name)


def test_a_misfit_asks_back_and_saves_nothing():
    ask_back = AskBack()
    pool = Pool(FakeJev(_answers(common=MISFIT_ANSWER)), ask_back)

    verdicts = _run(pool)

    assert _verdict(verdicts, COMMON).verdict == DOESNT_FIT
    assert ask_back.now is True
    assert pool.language_model_calls == []


def test_a_caption_asks_back_even_when_the_first_question_passes_it():
    ask_back = AskBack()
    pool = Pool(FakeJev(_answers(artifact=_answer(speech=0.1, artifact=0.9))), ask_back)

    assert _verdict(_run(pool), COMMON).verdict == DOESNT_FIT
    assert ask_back.now is True


def test_an_emergency_is_never_asked_back():
    ask_back = AskBack()
    pool = Pool(FakeJev(_answers(common=MISFIT_ANSWER, medical=CRITICAL_MEDICAL)), ask_back)

    verdicts = _run(pool)

    assert ask_back.now is False
    assert _verdict(verdicts, "medical").verdict == "critical"
    resolved = Arbitration(compiler_version="1.0.0").resolve(
        verdicts, {}, expert_configs=pool._registry.as_map(), user_input="x"
    )
    assert resolved.directive.action == "override"
    assert resolved.directive.directive_source == "medical"


def test_never_asks_twice_in_a_row_and_stops_at_the_session_limit():
    ask_back = AskBack(max_per_session=2)
    pool = Pool(FakeJev(_answers(common=MISFIT_ANSWER)), ask_back)

    asked = []
    for _ in range(6):
        _run(pool)
        asked.append(ask_back.now)

    assert asked == [True, False, True, False, False, False]
    assert ask_back.count == 2


def test_a_misfit_past_the_limit_is_handled_as_doubt_and_extraction_runs():
    ask_back = AskBack(max_per_session=0)
    pool = Pool(FakeJev(_answers(common=MISFIT_ANSWER)), ask_back)

    verdicts = _run(pool)

    assert _verdict(verdicts, COMMON).verdict == SLIGHT_DOUBT
    assert _verdict(verdicts, COMMON).recommendation
    assert pool.language_model_calls == [["task_extraction"]]


def test_slow_experts_run_only_when_jev_is_not_sure_they_have_nothing_to_do():
    pool = Pool(FakeJev(_answers(has_answer=0.05, activity=0.99)), AskBack())
    _run(pool)
    assert pool.language_model_calls == []

    pool = Pool(FakeJev(_answers(has_answer=0.3, activity=0.5)), AskBack())
    _run(pool)
    assert pool.language_model_calls == [["task_extraction", "companion_router"]]


def test_custom_experts_still_run_on_the_language_model():
    pool = Pool(FakeJev(_answers(has_answer=0.05)), AskBack())
    _run(pool, NAMES + ["my_custom_expert"])
    assert pool.language_model_calls == [["my_custom_expert"]]


def test_a_jev_outage_runs_every_expert_on_the_language_model():
    ask_back = AskBack()
    pool = Pool(FakeJev(fail=True), ask_back)

    verdicts = _run(pool)

    assert pool.language_model_calls == [NAMES]
    assert {v.expert_name for v in verdicts} == set(NAMES)
    assert ask_back.now is False


def test_jev_reads_the_turn_and_the_task():
    jev = FakeJev(_answers())
    pool = Pool(jev, AskBack())
    asyncio.run(pool.run(NAMES, "Neun Liter.", [{"role": "assistant", "content": "Wie viel?"}], {
        "state": {"title": "Trinken"},
        "deliverables": [{"key": "menge", "description": "Trinkmenge", "status": "pending"},
                         {"key": "x", "description": "Fertig", "status": "collected"}],
    }))
    state, questions = jev.asked[0]
    assert state["latest_message"] == "Neun Liter."
    assert state["conversation"] == ["assistant: Wie viel?"]
    assert state["current_task"] == "Trinken | Still to collect: Trinkmenge"
    assert {"common_sense", "recogniser_artifact", "has_answer", "activity_intent"} <= questions


def test_current_task_is_empty_without_a_plan():
    assert current_task({}) == ""


def test_the_reply_is_told_to_ask_back_only_on_that_turn(monkeypatch: pytest.MonkeyPatch):
    seen = {}

    def fake_generate(self, *, directive, prepend="", **kwargs):
        seen.update(routing=directive.routing_directive, prepend=prepend, followup=directive.ask_followup)

    from stella_v2_agent.pipeline.response_generator import ResponseGenerator
    monkeypatch.setattr(ResponseGenerator, "generate", fake_generate)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    ask_back = AskBack()
    generator = JevResponseGenerator(None, ask_back)

    ask_back.now = True
    generator.generate(directive=ResponseDirective(ask_followup=True, primary_action="x"), prepend="Careful.")
    assert seen == {"routing": ASK_BACK_INSTRUCTION, "prepend": "", "followup": False}
    # Used up: the next reply this agent writes is an ordinary one.
    assert ask_back.now is False

    generator.generate(directive=ResponseDirective(ask_followup=True, routing_directive="free"), prepend="Careful.")
    assert seen == {"routing": "free", "prepend": "Careful.", "followup": True}


def test_the_reply_after_a_question_takes_the_answer_as_true(monkeypatch: pytest.MonkeyPatch):
    seen = []

    def fake_generate(self, *, directive, prepend="", **kwargs):
        seen.append(directive.routing_directive)

    from stella_v2_agent.pipeline.response_generator import ResponseGenerator
    monkeypatch.setattr(ResponseGenerator, "generate", fake_generate)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    ask_back = AskBack()
    generator = JevResponseGenerator(None, ask_back)

    for wanted in (True, False, False):
        ask_back.decide(wanted)
        generator.generate(directive=ResponseDirective(routing_directive="free"))

    assert seen == [ASK_BACK_INSTRUCTION, f"free\n{AFTER_ASK_BACK_INSTRUCTION}", "free"]


def test_the_bridge_says_nothing():
    async def collect():
        return [chunk async for chunk in NoBridge(None).generate_stream("hi", [], language="de")]

    assert asyncio.run(collect()) == []


@pytest.mark.parametrize("p_resume,expected", [
    (0.95, BargeInDecision.RESUME),
    (0.6, BargeInDecision.COMMIT),
])
def test_barge_in_carries_on_only_when_sure(p_resume, expected):
    jev = FakeJev({"barge_in": _answer(commit=1 - p_resume, resume=p_resume)})
    decision = asyncio.run(JevBargeInEvaluator(None, jev).evaluate("Mhm.", [], {"interruptedReply": "Also"}))
    assert decision is expected
    assert jev.asked[0][0]["assistant_was_saying"] == "Also"


def test_barge_in_stops_for_the_person_when_jev_is_down():
    decision = asyncio.run(JevBargeInEvaluator(None, FakeJev(fail=True)).evaluate("Mhm.", []))
    assert decision is BargeInDecision.COMMIT


def test_empty_barge_in_is_noise():
    jev = FakeJev()
    assert asyncio.run(JevBargeInEvaluator(None, jev).evaluate("  ")) is BargeInDecision.RESUME
    assert jev.asked == []
