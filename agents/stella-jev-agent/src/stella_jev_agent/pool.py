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
import copy
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from stella_v2_agent.models.expert_verdict import ExpertVerdict
from stella_v2_agent.pipeline.expert_pool import ExpertPool

from stella_jev_agent.ask_back import AskBack
from stella_jev_agent.jev import JevClient, JevUnavailable
from stella_jev_agent.next_step import (
    OTHERWISE, Branch, also_questions, branch_question, collected_tasks, finishes, has_choice, open_required_keys, pending_tasks, predict,
    read_also, read_pick, required_tasks, route, task_question,
)
from stella_jev_agent.scope import Scope, scoped
from stella_v2_agent.companion import commands_from
from stella_jev_agent.questions import (
    ACTIVITY_INTENT, COMMON_SENSE, DOESNT_FIT, FITS, HAS_ANSWER, LEGAL, MEDICAL, PROBING,
    RECOGNISER_ARTIFACT, RECOMMENDATIONS, SLIGHT_DOUBT, TIMEKEEPER, not_believable, settle_safety, turn_state,
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
# Carries Jev's pick to the extraction run, and is taken out before extraction reads the context.
SCOPE = "_jev_scope"

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
    # Every task the reply can treat as done: the one answered and those mentioned in passing.
    done_tasks: List[str] = field(default_factory=list)
    # What the message mentioned in passing, and which earlier answers it corrected, by description.
    mentioned: List[str] = field(default_factory=list)
    corrected: List[str] = field(default_factory=list)


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
        # Stricter, since nobody asked: a wrong one saves what was not said, or overwrites an answer.
        self.also_threshold = 0.8
        # How sure Jev must be of a medical or legal "low" or "high".
        self.safety_threshold = 0.6
        # What kind of conversation this is, for every question Jev answers.
        self.expert_context = ""
        self.forecast = TurnForecast()
        # The extraction this turn holds back until arbitration, and the one running.
        self._held: Optional[Callable[[], Any]] = None
        self._running: Optional[asyncio.Task] = None
        self._unreported: List[ExpertVerdict] = []
        # What Jev did on the latest turn, for the analytics.
        self.last_jev: Dict[str, Any] = {}
        # The task Jev picked this turn (task_id, p, correction), or None, and how sure it was of its choice.
        self.last_pick: Optional[Dict[str, Any]] = None
        # The main pick and every other task Jev is sure the message mentioned or corrected.
        self.last_picks: List[Dict[str, Any]] = []
        self.last_answer: Optional[Dict[str, Any]] = None
        # What the held extraction was allowed to write, and what it did.
        self.last_scope: Optional[Scope] = None

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
        if "also_threshold" in config:
            self.also_threshold = float(config["also_threshold"])
        if "safety_threshold" in config:
            self.safety_threshold = float(config["safety_threshold"])
        if "expert_context" in config:
            self.expert_context = str(config["expert_context"] or "")

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
        self.last_pick = self.last_answer = self.last_scope = None
        self.last_picks = []
        plan = self._plan()
        state_id = (sm_context.get("state") or {}).get("id")
        tasks = pending_tasks(sm_context)
        fixes = collected_tasks(sm_context)
        branches = route(plan, state_id)
        if tasks or fixes:
            collected = sm_context.get("collected_deliverables")
            questions[ANSWERED_TASK] = task_question(tasks, fixes, collected)
            questions.update(also_questions(tasks, fixes, collected))
        if has_choice(branches):
            questions[NEXT_STEP] = branch_question(branches)

        limit = max(self._limit(COMMON), 1)
        state = turn_state(user_input, conversation_history, current_task(sm_context), limit, self.expert_context)
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
        answer = result.answers.get(ANSWERED_TASK)
        if answer is not None:
            self.last_answer = {"choice": answer.choice, "p": round(float(answer.probabilities[answer.choice]), 2)}
        self.last_pick = read_pick(answer, tasks, fixes, self.forecast_threshold, result.answers)
        also = read_also(result.answers, tasks, fixes, self.also_threshold, self.last_pick)
        self.last_picks = ([self.last_pick] if self.last_pick else []) + also
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
            self._held = self._hold_extraction(user_input, conversation_history, sm_context)
            self.forecast = self._forecast(result, tasks, branches, plan, state_id, sm_context)
        logger.info(
            "Jev: %s in %.0fms, asking_back=%s, then language model: %s",
            {v.expert_name: v.verdict for v in verdicts}, result.latency_ms, asking, remaining,
        )
        return verdicts

    def _hold_extraction(
        self, user_input: str, conversation_history: List[Dict[str, str]], sm_context: Dict[str, Any],
    ) -> Callable[[], Any]:
        """Extraction for after the reply, kept to the task Jev picked when it picked one."""
        context = sm_context
        # The answer to an ask-back keeps the old, unscoped extraction, and on a stalled
        # plan extraction may skip the stuck task, which a scope would refuse.
        if self.last_picks and not (self._ask_back.answering or is_stalled(sm_context)):
            self.last_scope = Scope.of(self.last_picks)
            context = {**sm_context, SCOPE: self.last_scope}
            if self.last_pick is not None and not self.last_pick["correction"]:
                # So {{current_focus}} names the task the reply has already moved past.
                task = self.last_pick["task"]
                context["current_task"] = {
                    "id": task.get("id"), "description": task.get("description"),
                    "instruction": task.get("instruction"),
                    "has_deliverables": bool(task.get("deliverables")),
                    "deliverable_keys": [d.get("key") for d in task.get("deliverables", [])],
                }
        return lambda: self._run_experts(
            [EXTRACTION], user_input, conversation_history, context, self._timeout_ms / 1000.0
        )

    async def _run_with_timeout(
        self, config: Any, user_input: str, conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any], timeout_seconds: float,
    ) -> ExpertVerdict:
        scope = sm_context.get(SCOPE)
        if scope is None:
            return await super()._run_with_timeout(config, user_input, conversation_history, sm_context, timeout_seconds)
        context = {k: v for k, v in sm_context.items() if k != SCOPE}
        # A copy, so the scope cannot leak into an expert running at the same time.
        view = copy.copy(self)
        view._tool_registry = _Scoped(self._tool_registry, scope) if self._tool_registry else None
        return await ExpertPool._run_with_timeout(view, config, user_input, conversation_history, context, timeout_seconds)

    def _forecast(
        self, result: Any, tasks: List[Dict[str, Any]], branches: Optional[List[Branch]],
        plan: Optional[Dict[str, Any]], state_id: Any, sm_context: Dict[str, Any],
    ) -> TurnForecast:
        extra = [p for p in self.last_picks if p is not self.last_pick]
        # Jev cannot say which of several open values a mention gave, so only a single one is marked.
        mentioned = [p["task"] for p in extra if not p["correction"] and finishes(p["task"])]
        notes = dict(
            mentioned=[str(t.get("description")) for t in mentioned],
            corrected=[str(p["task"].get("description")) for p in self.last_picks if p["correction"]],
        )
        also_keys = [k for t in mentioned for k in open_required_keys(t)]
        also_done = [t.get("id") for t in mentioned]
        if self.last_pick is None or self.last_pick["correction"]:
            # A correction changes an answer behind the conversation, so the reply stays where it is.
            return TurnForecast(also_keys, done_tasks=also_done, **notes)
        picked = self.last_pick["task"]
        if not finishes(picked):
            # Jev cannot say which of the values this answer gave, so none is marked.
            return TurnForecast(also_keys, done_tasks=also_done, **notes)
        keys = open_required_keys(picked) + also_keys
        done = picked.get("id")
        done_tasks = [done] + also_done
        way = OTHERWISE
        if has_choice(branches):
            pick = result.answers[NEXT_STEP]
            if pick.probabilities[pick.choice] < self.forecast_threshold:
                return TurnForecast(keys, done_task=done, done_tasks=done_tasks, **notes)
            way = pick.choice
        target = predict(branches, tasks, picked, way, required_tasks(plan, state_id), also_done)
        return TurnForecast(keys, target, done, done_tasks, **notes)

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
            raw: Dict[str, Any] = {"provider": "jev", "probabilities": probabilities}
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
            elif name in OVERRIDING_EXPERTS:
                settled = settle_safety(probabilities, choice, self.safety_threshold)
                if settled != choice:
                    logger.info(f"Jev {name}: {choice} ({probabilities.get(choice, 0):.2f}) is below "
                                f"{self.safety_threshold}, taken as {settled}")
                    raw["jev_choice"] = choice
                    choice = settled
            config = self._registry.get(name)
            verdicts.append(ExpertVerdict(
                expert_name=name,
                verdict=choice,
                confidence=float(answer.probabilities.get(choice, max(answer.probabilities.values()))),
                recommendation=RECOMMENDATIONS.get(name, {}).get(choice, ""),
                priority=config.priority if config else 0,
                latency_ms=result.latency_ms,
                raw_output=raw,
            ))
        return verdicts

    def _language_model_experts(
        self, expert_names: List[str], result: Any, sm_context: Dict[str, Any]
    ) -> List[str]:
        # A plain "Ja" to the question asked back is the only place that answer gets saved.
        always_extract = self._ask_back.answering or is_stalled(sm_context)
        # Where Jev said which task was answered, that decides: extraction saves only that task,
        # so it runs exactly when there is one. The other two questions can disagree with it.
        follows_pick = ANSWERED_TASK in result.answers
        # Too vague to record, by the definition of the answer. The reply probes, and the
        # value is still in the history when the person says it properly.
        unclear = "probing" in result.answers and result.answers["probing"].choice == NEEDS_CLARIFICATION
        remaining = []
        for name in expert_names:
            if name in JEV_EXPERTS:
                continue
            if name == EXTRACTION and follows_pick and not always_extract:
                if not self.last_picks:
                    continue
            elif name in GATES and not (name == EXTRACTION and always_extract):
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


class _Scoped:
    """The registry as the base pool reads it, with every tool kept to the scope."""

    def __init__(self, registry: Any, scope: Scope):
        self._registry = registry
        self._scope = scope

    def list_tools(self) -> List[Any]:
        return scoped(self._registry.list_tools(), self._scope)
