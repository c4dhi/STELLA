"""One Jev call for every expert that only has to decide something.

Jev cannot write, so anything that has to produce text or values still uses a
language model: task_extraction fills in what the person said and companion_router
calls tools. Jev runs first and decides whether they need to run at all. That order
also keeps a misheard answer from being saved: on a turn that asks back, neither runs.

The reply does not wait for task_extraction. It starts once arbitration has settled the
turn, and Jev says what the reply needs to know: which task was answered and where the
plan goes next. Extraction then saves the value alongside the reply. It still runs first
where only the state machine can tell where the plan goes, or when it may skip a task.
"""

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from stella_v2_agent.models.expert_verdict import ExpertVerdict
from stella_v2_agent.pipeline.expert_pool import ExpertPool

from stella_jev_agent.ask_back import AskBack
from stella_jev_agent.jev import JevClient, JevUnavailable
from stella_jev_agent.next_step import (
    NOTHING, OTHERWISE, Branch, branch_question, finishes, has_choice, open_required_keys, pending_tasks, predict, required_tasks,
    route, task_question,
)
from stella_v2_agent.companion import commands_from
from stella_jev_agent.questions import (
    ACTIVITY_INTENT, COMMON_SENSE, DOESNT_FIT, FITS, HAS_ANSWER, LEGAL, MEDICAL, PROBING,
    RECOGNISER_ARTIFACT, RECOMMENDATIONS, SLIGHT_DOUBT, TIMEKEEPER, not_believable, turn_state,
)

logger = logging.getLogger(__name__)

COMMON = "common_sense"
# These verdicts speak a fixed template instead of the reply, so nothing could ask back.
OVERRIDING_EXPERTS = {"medical", "legal"}
# Extraction is where V2 skips a stalled optional task, so it must run on a stalled plan.
STALLED_AFTER_TURNS = 3
EXTRACTION = "task_extraction"
ROUTER = "companion_router"
NEEDS_CLARIFICATION = "needs_clarification"
ANSWERED_TASK = "answered_task"
NEXT_STEP = "next_step"

JEV_EXPERTS = {
    COMMON: COMMON_SENSE,
    "medical": MEDICAL,
    "legal": LEGAL,
    "probing": PROBING,
    "timekeeper": TIMEKEEPER,
}
# A language-model expert is skipped when Jev says it has nothing to do.
GATES = {EXTRACTION: ("has_answer", HAS_ANSWER, "no"), ROUTER: ("activity_intent", ACTIVITY_INTENT, "none")}


@dataclass
class TurnForecast:
    """What the reply is told about an answer nothing has saved yet."""

    keys: List[str] = field(default_factory=list)
    next_state: Optional[str] = None
    done_task: Optional[str] = None


def is_stalled(sm_context: Dict[str, Any]) -> bool:
    progress = sm_context.get("progress")
    return isinstance(progress, dict) and progress.get("turns_without_deliverable", 0) >= STALLED_AFTER_TURNS


def overridden(verdicts: List[ExpertVerdict]) -> bool:
    return any(v.expert_name in OVERRIDING_EXPERTS and v.verdict == "critical" for v in verdicts)


def current_task(sm_context: Dict[str, Any]) -> str:
    """The step of the plan the conversation is on, in plain words."""
    parts = []
    state = sm_context.get("state")
    if isinstance(state, dict) and state.get("title"):
        parts.append(str(state["title"]))
    task = sm_context.get("current_task")
    if isinstance(task, dict):
        parts.append(str(task.get("description") or task.get("title") or task.get("id") or ""))
    elif task:
        parts.append(str(task))
    pending = [
        str(d.get("description") or d.get("key"))
        for d in sm_context.get("deliverables") or []
        if isinstance(d, dict) and d.get("status") == "pending"
    ]
    if pending:
        parts.append("Still to collect: " + "; ".join(pending))
    return " | ".join(p for p in parts if p)


def _started_after(verdicts: List[ExpertVerdict], waited_ms: float) -> List[ExpertVerdict]:
    """These experts started once Jev was done, and the timeline counts from the pool's start."""
    for verdict in verdicts:
        verdict.latency_ms += waited_ms
    return verdicts


class JevExpertPool(ExpertPool):
    def __init__(
        self, *args: Any, jev: JevClient, ask_back: AskBack,
        plan: Callable[[], Optional[Dict[str, Any]]] = lambda: None, **kwargs: Any,
    ):
        super().__init__(*args, **kwargs)
        self._jev = jev
        self._ask_back = ask_back
        self._plan = plan
        self.ask_threshold = 0.45
        self.skip_threshold = 0.8
        self.forecast_threshold = 0.7
        self.forecast = TurnForecast()
        # The extraction this turn holds back until arbitration, and the one running.
        self._held: Optional[Callable[[], Any]] = None
        self._running: Optional[asyncio.Task] = None
        self._unreported: List[ExpertVerdict] = []
        # What Jev did on the latest turn, for the analytics.
        self.last_jev: Dict[str, Any] = {}

    def apply_config(self, config: dict) -> None:
        if "ask_threshold" in config:
            self.ask_threshold = float(config["ask_threshold"])
        if "skip_threshold" in config:
            self.skip_threshold = float(config["skip_threshold"])
        if "max_ask_backs" in config:
            self._ask_back.max_per_session = int(config["max_ask_backs"])
        if "jev_timeout_ms" in config:
            self._jev.timeout_s = float(config["jev_timeout_ms"]) / 1000
        if "forecast_threshold" in config:
            self.forecast_threshold = float(config["forecast_threshold"])

    async def run(
        self,
        expert_names: List[str],
        user_input: str,
        conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any],
    ) -> List[ExpertVerdict]:
        questions = {name: JEV_EXPERTS[name] for name in expert_names if name in JEV_EXPERTS}
        if COMMON in questions:
            questions["recogniser_artifact"] = RECOGNISER_ARTIFACT
        for name, (key, question, _) in GATES.items():
            if name in expert_names:
                questions[key] = question

        self.forecast = TurnForecast()
        self._held = None
        plan = self._plan()
        state_id = (sm_context.get("state") or {}).get("id")
        tasks = pending_tasks(sm_context)
        branches = route(plan, state_id)
        if tasks:
            questions[ANSWERED_TASK] = task_question(tasks)
        if has_choice(branches):
            questions[NEXT_STEP] = branch_question(branches)

        limit = max(self._limit(COMMON), 1)
        state = turn_state(user_input, conversation_history, current_task(sm_context), limit)
        started = time.monotonic()
        try:
            result = await self._jev.ask(state, questions)
        except (JevUnavailable, asyncio.TimeoutError) as e:
            waited_ms = (time.monotonic() - started) * 1000
            self.last_jev = {"answered": False, "latency_ms": waited_ms, "reason": str(e)}
            # Slower, but the safety experts keep working during an outage.
            logger.warning(f"Jev unavailable ({e}), running every expert on the language model")
            verdicts = await super().run(expert_names, user_input, conversation_history, sm_context)
            return self._settle_llm_ask_back(_started_after(verdicts, waited_ms))

        self.last_jev = {"answered": True, "latency_ms": result.latency_ms}
        verdicts = self._verdicts(expert_names, result)
        common = next((v for v in verdicts if v.expert_name == COMMON), None)
        wanted = bool(common and common.verdict == DOESNT_FIT)
        asking = self._ask_back.decide(wanted and not overridden(verdicts))
        if common and wanted and not asking:
            common.verdict = SLIGHT_DOUBT
            common.recommendation = RECOMMENDATIONS[COMMON][SLIGHT_DOUBT]

        remaining = [] if asking else self._language_model_experts(expert_names, result, sm_context)
        run_llm = lambda names: self._run_experts(
            names, user_input, conversation_history, sm_context, self._timeout_ms / 1000.0
        )
        extraction = EXTRACTION in remaining
        if extraction:
            remaining.remove(EXTRACTION)
        if remaining:
            verdicts += _started_after(await run_llm(remaining), result.latency_ms)
        if extraction and commands_from(verdicts):
            # An activity starts or ends this turn, and it swaps the plan underneath.
            verdicts += _started_after(await run_llm([EXTRACTION]), result.latency_ms)
        elif extraction:
            self._held = lambda: run_llm([EXTRACTION])
            self.forecast = self._forecast(result, tasks, branches, plan, state_id, sm_context)
        logger.info(
            "Jev: %s in %.0fms, asking_back=%s, then language model: %s",
            {v.expert_name: v.verdict for v in verdicts}, result.latency_ms, asking, remaining,
        )
        return verdicts

    def _forecast(
        self, result: Any, tasks: List[Dict[str, Any]], branches: Optional[List[Branch]],
        plan: Optional[Dict[str, Any]], state_id: Any, sm_context: Dict[str, Any],
    ) -> TurnForecast:
        answer = result.answers.get(ANSWERED_TASK)
        if answer is None or answer.choice == NOTHING:
            return TurnForecast()
        if answer.probabilities[answer.choice] < self.forecast_threshold:
            return TurnForecast()
        picked = tasks[int(answer.choice.split("_")[1])]
        if not finishes(picked):
            # Jev cannot say which of the values this answer gave, so none is marked.
            return TurnForecast()
        keys = open_required_keys(picked)
        done = picked.get("id")
        way = OTHERWISE
        if has_choice(branches):
            pick = result.answers[NEXT_STEP]
            if pick.probabilities[pick.choice] < self.forecast_threshold:
                return TurnForecast(keys, done_task=done)
            way = pick.choice
        return TurnForecast(keys, predict(branches, tasks, picked, way, required_tasks(plan, state_id)), done)

    def start_held_extraction(self) -> None:
        """Called once arbitration has settled the turn."""
        if self._held is not None:
            self._running = asyncio.create_task(self._held())
            self._held = None

    async def finish_extraction(self) -> List[ExpertVerdict]:
        """Waits for what is running, and hands over every result not yet reported.

        Shielded: an interruption closes the turn, but must not lose what was said.
        """
        await self.settle_extraction()
        reported, self._unreported = self._unreported, []
        return reported

    async def settle_extraction(self) -> None:
        """Before a turn reads the plan, so it sees what the last one saved."""
        running, self._running = self._running, None
        if running is not None:
            self._unreported = await self._collect(running)

    async def _collect(self, running: asyncio.Task) -> List[ExpertVerdict]:
        try:
            return self._unreported + list(await asyncio.shield(running))
        except asyncio.CancelledError:
            self._running = running
            raise
        except Exception as e:
            logger.warning(f"Extraction failed after the reply: {e}")
            return self._unreported

    def _limit(self, name: str) -> int:
        config = self._registry.get(name)
        return config.history_limit if config and config.history_limit > 0 else 12

    def _verdicts(self, expert_names: List[str], result: Any) -> List[ExpertVerdict]:
        verdicts = []
        for name in expert_names:
            if name not in JEV_EXPERTS or name not in result.answers:
                continue
            answer = result.answers[name]
            choice = answer.choice
            probabilities = dict(answer.probabilities)
            if name == COMMON:
                artifact = result.answers["recogniser_artifact"].probabilities
                p_bad = not_believable(probabilities, artifact)
                probabilities["recogniser_artifact"] = artifact["artifact"]
                if p_bad >= self.ask_threshold:
                    choice = DOESNT_FIT
                elif p_bad + probabilities[SLIGHT_DOUBT] >= self.ask_threshold:
                    choice = SLIGHT_DOUBT
                else:
                    choice = FITS
            config = self._registry.get(name)
            verdicts.append(ExpertVerdict(
                expert_name=name,
                verdict=choice,
                confidence=float(answer.probabilities.get(choice, max(answer.probabilities.values()))),
                recommendation=RECOMMENDATIONS.get(name, {}).get(choice, ""),
                priority=config.priority if config else 0,
                latency_ms=result.latency_ms,
                raw_output={"provider": "jev", "probabilities": probabilities},
            ))
        return verdicts

    def _language_model_experts(
        self, expert_names: List[str], result: Any, sm_context: Dict[str, Any]
    ) -> List[str]:
        # A plain "Ja" to the question asked back is the only place that answer gets saved.
        always_extract = self._ask_back.answering or is_stalled(sm_context)
        # Too vague to record, by the definition of the answer. The reply probes, and the
        # value is still in the history when the person says it properly.
        unclear = "probing" in result.answers and result.answers["probing"].choice == NEEDS_CLARIFICATION
        remaining = []
        for name in expert_names:
            if name in JEV_EXPERTS:
                continue
            if name in GATES and not (name == EXTRACTION and always_extract):
                key, _, nothing_to_do = GATES[name]
                if result.answers[key].probabilities[nothing_to_do] >= self.skip_threshold:
                    continue
                if name == EXTRACTION and unclear:
                    continue
            remaining.append(name)
        return remaining

    def _settle_llm_ask_back(self, verdicts: List[ExpertVerdict]) -> List[ExpertVerdict]:
        wanted = any(v.expert_name == COMMON and v.verdict == DOESNT_FIT for v in verdicts)
        self._ask_back.decide(wanted and not overridden(verdicts))
        return verdicts
