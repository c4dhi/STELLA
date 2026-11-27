"""#223: Jev's ask-back, safety step-down and gates come from the configuration
instead of code keyed on expert names. On the shipped files and defaults the pool
must decide exactly as before: the same verdicts, the same ask-back and the same
language-model experts run, over many seeded turns."""

import asyncio
import random
from types import SimpleNamespace

from stella_v2_agent.experts.registry import ExpertRegistry
from stella_v2_agent.models.expert_verdict import ExpertVerdict

from stella_jev_agent.agent import _OWN_EXPERTS_DIR
from stella_jev_agent.ask_back import AskBack
from stella_jev_agent.pool import JevExpertPool, jev_settings

from tests import legacy_pool_223 as legacy

# Read once: the pool doesn't change the registry while it decides a turn.
REGISTRY = ExpertRegistry(experts_dir=str(_OWN_EXPERTS_DIR))
SETTINGS = jev_settings()
NAMES = ["common_sense", "medical", "legal", "probing", "capabilities", "task_extraction", "companion_router"]


class _Jev:
    def __init__(self, answers):
        self.answers = answers
        self.timeout_s = 1.5

    async def ask(self, state, questions, timeout_s=0):
        self.asked = set(questions)
        return SimpleNamespace(answers={k: v for k, v in self.answers.items() if k in questions}, latency_ms=100.0)


def _recording(base):
    class Recording(base):
        def __init__(self, jev, ask_back):
            super().__init__(
                None, REGISTRY,
                compiler_version="1.0.0", jev=jev, ask_back=ask_back, settings=SETTINGS,
            )
            self.calls = []

        async def _run_experts(self, expert_names, *args, **kwargs):
            self.calls.append(list(expert_names))
            return [ExpertVerdict(expert_name=n, verdict="none", priority=1) for n in expert_names]

    return Recording


New, Old = _recording(JevExpertPool), _recording(legacy.JevExpertPool)


def _answer(rng, options, lean=None):
    weights = [rng.random() ** 3 for _ in options]
    if lean is not None:
        weights[options.index(lean)] += rng.random() * 2
    total = sum(weights)
    probabilities = {o: w / total for o, w in zip(options, weights)}
    return SimpleNamespace(choice=max(probabilities, key=probabilities.get), probabilities=probabilities)


def _answers(rng):
    pick = lambda options: _answer(rng, options, rng.choice([None, *options]))
    return {
        "common_sense": pick(["fits", "slight_doubt", "doesnt_fit"]),
        "medical": pick(["none", "low", "high", "critical"]),
        "legal": pick(["none", "low", "high", "critical"]),
        "probing": pick(["no_probe", "needs_clarification", "gentle_redirect"]),
        "capabilities": pick(["within", "cannot_do", "off_role"]),
        "has_answer": pick(["no", "yes"]),
        "activity_intent": pick(["none", "transition"]),
    }


def _turn(cls, answers, asked_before, context):
    ask_back = AskBack()
    # How many times it asked this session, and whether it asked last turn.
    ask_back.count, ask_back._asked_last_turn = asked_before
    pool = cls(_Jev(answers), ask_back)

    async def run():
        verdicts = await pool.run(NAMES, "said", [], context)
        pool.start_held_extraction()
        return verdicts + await pool.finish_extraction()

    verdicts = asyncio.run(run())
    return (
        [(v.expert_name, v.verdict, v.recommendation, v.raw_output.get("jev_choice")) for v in verdicts],
        pool.calls,
        ask_back.now,
        sorted(pool._jev.asked),
    )


def test_the_pool_decides_as_before_on_the_shipped_files():
    rng = random.Random(223)
    stalled = {"progress": {"turns_without_deliverable": 3}}
    for i in range(3000):
        answers = _answers(rng)
        asked_before = (rng.choice([0, 0, 1, 3]), rng.random() < 0.2)
        context = stalled if i % 7 == 0 else {}
        assert _turn(New, answers, asked_before, context) == _turn(Old, answers, asked_before, context), (i, answers)
