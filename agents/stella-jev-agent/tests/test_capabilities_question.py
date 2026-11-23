"""The capabilities expert in the one Jev call (#992), asked like any other expert.

Jev reads its configured prompt, with STELLA's list filled in through
{{capabilities}}, and its configured verdicts. No code names it.
"""

from stella_v2_agent.experts.registry import ExpertRegistry

from stella_jev_agent.agent import _OWN_EXPERTS_DIR
from stella_jev_agent.ask_back import AskBack
from stella_jev_agent.pool import JevExpertPool

from test_turn_decisions import NAMES, FakeJev, _answer, _answers, _run, _verdict

CAPABILITIES = "capabilities"
COMPANION = {
    "mode": "companion",
    "capabilities": [
        {"id": "activity.quiz", "kind": "activity", "title": "Memory quiz", "description": "Ten questions"},
        {"id": "go_to_sleep", "kind": "action", "title": "Go to sleep", "description": ""},
    ],
}
WITH = NAMES + [CAPABILITIES]


class Pool(JevExpertPool):
    """Compiler 1.2.0, the first that fills {{capabilities}}; no language model."""

    def __init__(self, jev):
        super().__init__(
            None, ExpertRegistry(experts_dir=str(_OWN_EXPERTS_DIR)),
            compiler_version="1.2.0", jev=jev, ask_back=AskBack(),
        )

    async def _run_experts(self, expert_names, *args, **kwargs):
        return []


def _with(**probabilities):
    answers = _answers()
    answers[CAPABILITIES] = _answer(**probabilities)
    return answers


def test_it_is_asked_from_its_configured_prompt_with_the_list_filled_in():
    jev = FakeJev(_with(within=0.95, cannot_do=0.04, off_role=0.01))
    pool = Pool(jev)
    _run(pool, WITH, {"capabilities": COMPANION})

    assert len(jev.asked) == 1
    question = jev.questions[CAPABILITIES]
    assert "Memory quiz" in question.instructions and "Go to sleep" in question.instructions
    assert "{{capabilities}}" not in question.instructions
    assert dict(question.criteria) == pool._registry.get(CAPABILITIES).verdict_descriptions()
    assert "what_the_assistant_can_do" not in jev.asked[0][0]


def test_without_stellas_list_it_is_still_asked_as_configured():
    # The prompt treats an empty list as "within"; nothing in code drops it.
    jev = FakeJev(_with(within=0.97, cannot_do=0.02, off_role=0.01))
    verdict = _verdict(_run(Pool(jev), WITH, {}), CAPABILITIES)
    assert CAPABILITIES in jev.questions
    assert verdict.verdict == "within"


def test_the_reply_is_told_what_the_configuration_says_the_verdict_means():
    pool = Pool(FakeJev(_with(within=0.1, cannot_do=0.85, off_role=0.05)))
    verdict = _verdict(_run(pool, WITH, {"capabilities": COMPANION}), CAPABILITIES)
    assert verdict.verdict == "cannot_do"
    assert verdict.recommendation == pool._registry.get(CAPABILITIES).verdict_descriptions()["cannot_do"]


def test_switched_off_it_is_not_asked():
    jev = FakeJev(_answers())
    pool = Pool(jev)
    pool._registry.get(CAPABILITIES).enabled = False
    verdicts = _run(pool, WITH, {"capabilities": COMPANION})
    assert CAPABILITIES not in jev.questions
    assert all(v.expert_name != CAPABILITIES for v in verdicts)


def _default(key):
    from stella_jev_agent.pool import jev_settings

    return jev_settings().get(key)


def test_both_default_reply_prompts_carry_the_list():
    # The verdict tells the reply to name things from the list, so the reply
    # has to see it; it comes through the configured guidelines (#192 review).
    from stella_v2_agent.models.arbitration_result import ResponseDirective
    from stella_v2_agent.prompts.response_prompt import build_response_system_prompt

    for key in ("response_generator.conversation_guidelines", "companion.free_conversation_guidelines"):
        prompt = build_response_system_prompt(
            sm_context={"capabilities": COMPANION},
            directive=ResponseDirective(),
            conversation_history=[],
            custom_guidelines=_default(key),
        )
        assert "- Memory quiz: Ten questions" in prompt and "- Go to sleep" in prompt, key
        empty = build_response_system_prompt(
            sm_context={}, directive=ResponseDirective(), conversation_history=[], custom_guidelines=_default(key),
        )
        assert "What you can do in this conversation" not in empty, key
