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
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from stella_agent_sdk.experts.verdict_rules import DEFAULT_NEVER_STEP_DOWN, Gate, settle_verdict
from stella_agent_sdk.prompts import history_turns
from stella_agent_sdk.settings import AgentSettings

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
from typesafe_sdk import Choice

from stella_jev_agent.questions import OWN_QUESTIONS, turn_state

logger = logging.getLogger(__name__)

# How much conversation Jev's own questions read when no expert prompt it answers asks for any.
OWN_QUESTIONS_TURNS = 1
# A verdict with one of these actions speaks a fixed template instead of the reply,
# so nothing could ask back.
REPLACING_ACTIONS = ("override", "short_circuit")
# Extraction is where V2 skips a stalled optional task, so it must run on a stalled plan.
STALLED_AFTER_TURNS = 3
EXTRACTION = "task_extraction"
ANSWERED_TASK = "answered_task"
NEXT_STEP = "next_step"
# Carries Jev's pick to the extraction run, and is taken out before extraction reads the context.
SCOPE = "_jev_scope"
# The pipeline node whose settings (agent.yaml, expert_pool slots) this pool reads.
NODE = "expert_pool"
# In a checkout and in tests; an image finds ./agent.yaml in its working directory.
_OWN_MANIFEST = Path(__file__).resolve().parents[2] / "agent.yaml"


def jev_settings() -> AgentSettings:
    """Jev's declared settings, defaults from its agent.yaml."""
    return AgentSettings.from_manifest(_OWN_MANIFEST)


def answered_by_jev(config: Any) -> bool:
    """Jev answers every expert that only picks one of its verdicts. One that writes
    or calls tools, such as task_extraction, needs a language model."""
    return bool(config and config.enabled and config.verdict_directives and not config.can_call_functions)

ASK_BACK = "ask_back"


def read_gates(value: Any) -> List[Gate]:
    """The expert_pool's ``gates`` setting: when a language-model expert is skipped."""
    gates = [Gate.parse(g) for g in value] if isinstance(value, list) else []
    return [g for g in gates if g is not None]


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


def overridden(verdicts: List[ExpertVerdict], registry: Any) -> bool:
    """Whether a verdict this turn replaces the reply with its template."""
    return any(_rule(registry, v.expert_name, v.verdict).get("action") in REPLACING_ACTIONS for v in verdicts)


def _rule(registry: Any, name: str, verdict: str) -> Dict[str, Any]:
    config = registry.get(name) if registry is not None else None
    directive = config.verdict_directives.get(verdict) if config is not None else None
    return directive.to_dict() if directive is not None else {}


def _asks_back(registry: Any, verdict: ExpertVerdict) -> bool:
    return _rule(registry, verdict.expert_name, verdict.verdict).get("reaction") == ASK_BACK


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
        plan: Callable[[], Optional[Dict[str, Any]]] = lambda: None,
        settings: Optional[AgentSettings] = None, **kwargs: Any,
    ):
        super().__init__(*args, **kwargs)
        self._jev = jev
        self._ask_back = ask_back
        self._plan = plan
        # Thresholds and context: agent.yaml's defaults, then the configuration's values.
        self.settings = settings or jev_settings()
        self._read_settings()
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
        """The configuration's expert_pool node. Replaces what an earlier call set."""
        self.settings.apply({"nodes": {NODE: config}})
        self._read_settings()

    def _read_settings(self) -> None:
        def get(name: str) -> Any:
            return self.settings.get(f"{NODE}.{name}")

        self.ask_threshold = get("ask_threshold")
        self.skip_threshold = get("skip_threshold")
        self.forecast_threshold = get("forecast_threshold")
        # Stricter, since nobody asked: a wrong one saves what was not said, or overwrites an answer.
        self.also_threshold = get("also_threshold")
        # How sure Jev must be of a safety expert's verdict that can step down
        # (medical or legal "low" or "high"), when the verdict doesn't say.
        self.safety_threshold = get("safety_threshold")
        # When a language-model expert is skipped because Jev says it has nothing to do.
        self.gates = read_gates(get("gates"))
        # What kind of conversation this is, for every question Jev answers.
        self.expert_context = str(get("expert_context") or "")
        # These two belong to objects with their own defaults (JEV_TIMEOUT_MS sets the
        # client's), so only a configured value changes them.
        if self.settings.is_set(f"{NODE}.max_ask_backs"):
            self._ask_back.max_per_session = int(get("max_ask_backs"))
        if self.settings.is_set(f"{NODE}.jev_timeout_ms"):
            self._jev.timeout_s = float(get("jev_timeout_ms")) / 1000

    async def run(
        self,
        expert_names: List[str],
        user_input: str,
        conversation_history: List[Dict[str, str]],
        sm_context: Dict[str, Any],
    ) -> List[ExpertVerdict]:
        questions: Dict[str, Any] = self.expert_questions(expert_names, user_input, conversation_history, sm_context)
        for gate in self.gates:
            if gate.skip in expert_names and gate.when in OWN_QUESTIONS:
                questions[gate.when] = OWN_QUESTIONS[gate.when]

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

        limit = self._history_turns(expert_names)
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
        asker = next((v for v in verdicts if _asks_back(self._registry, v)), None)
        asking = self._ask_back.decide(asker is not None and not overridden(verdicts, self._registry))
        if asker is not None and not asking:
            # Not asking back after all: the verdict one level down.
            below = _rule(self._registry, asker.expert_name, asker.verdict).get("below")
            if below:
                asker.verdict = below
                asker.recommendation = self._guidance(asker.expert_name, below)

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

    def _jev_experts(self, expert_names: List[str]) -> List[str]:
        return [name for name in expert_names if answered_by_jev(self._registry.get(name))]

    def expert_questions(
        self, expert_names: List[str], user_input: str,
        conversation_history: List[Dict[str, str]], sm_context: Dict[str, Any],
    ) -> Dict[str, Choice]:
        """Each expert Jev answers, asked as its configuration says: the prompt as the
        Configurator shows it, compiled as for a language model, and its verdicts with
        their descriptions. The JSON output format is left out, since Jev answers with
        a choice. Nothing else is added, so what is optimized is what runs."""
        questions = {}
        for name in self._jev_experts(expert_names):
            config = self._registry.get(name)
            questions[name] = Choice(
                instructions=self._runner.compile_prompt(config, user_input, conversation_history, sm_context),
                criteria=config.verdict_descriptions(),
            )
        return questions

    def _guidance(self, name: str, verdict: str) -> str:
        """What the reply is told about a verdict Jev gave: its configured description,
        as a language model's own recommendation would be."""
        config = self._registry.get(name)
        return config.verdict_descriptions().get(verdict, "") if config else ""

    def _history_turns(self, expert_names: List[str]) -> int:
        """How much conversation Jev reads: as much as the longest {{history_N}} in
        the prompts of the experts it answers for. A prompt says what its expert
        sees, whether a language model or Jev answers it.

        At least the last message, even when no such prompt reads any: Jev's own
        questions (has_answer, activity_intent, the next step) read the
        conversation too, and a "yes" means nothing without what it answers.
        """
        configs = (self._registry.get(name) for name in self._jev_experts(expert_names))
        return max((history_turns(c.system_prompt) for c in configs if c), default=0) or OWN_QUESTIONS_TURNS

    def _verdicts(self, expert_names: List[str], result: Any) -> List[ExpertVerdict]:
        verdicts = []
        for name in self._jev_experts(expert_names):
            if name not in result.answers:
                continue
            answer = result.answers[name]
            choice = answer.choice
            probabilities = dict(answer.probabilities)
            raw: Dict[str, Any] = {"provider": "jev", "probabilities": probabilities}
            config = self._registry.get(name)
            settled = self._settle(config, choice, probabilities)
            if settled != choice and config.step_down_from == "choice":
                # Stepped down from Jev's own choice: kept for the analytics. (An expert
                # weighed from its most severe verdict has no single choice to step from.)
                logger.info(f"Jev {name}: {choice} ({probabilities.get(choice, 0):.2f}) is not sure enough, "
                            f"taken as {settled}")
                raw["jev_choice"] = choice
            choice = settled
            verdicts.append(ExpertVerdict(
                expert_name=name,
                verdict=choice,
                confidence=float(answer.probabilities.get(choice, max(answer.probabilities.values()))),
                recommendation=self._guidance(name, choice),
                priority=config.priority if config else 0,
                latency_ms=result.latency_ms,
                raw_output=raw,
            ))
        return verdicts

    def _settle(self, config: Any, choice: str, probabilities: Dict[str, float]) -> str:
        """The verdict to act on, from the expert's step-down rules (``below``,
        ``min_confidence``). A verdict without its own ``min_confidence`` uses the
        node's safety_threshold on a safety expert and its ask_threshold otherwise."""
        if config is None:
            return choice
        chain = {v: d for v, d in config.verdict_directives.items() if d.below}
        if not chain:
            return choice
        default = self.safety_threshold if config.safety else self.ask_threshold
        directives = {
            v: {"below": d.below, "min_confidence": d.min_confidence if d.min_confidence is not None else default}
            for v, d in chain.items()
        }
        keep = (config.never_step_down if config.never_step_down is not None else DEFAULT_NEVER_STEP_DOWN) if config.safety else ()
        start = choice
        if config.step_down_from == "most_severe":
            # The top of the chain: a verdict nothing steps down to.
            targets = {d.below for d in chain.values()}
            start = next((v for v in chain if v not in targets), choice)
        return settle_verdict(start, probabilities, directives, keep)

    def _gated(self, name: str, result: Any) -> bool:
        """Whether a gate skips this expert. A gate on one of Jev's own questions holds
        when the gate's answers are at least min_confidence likely (skip_threshold when it
        names none); a gate on an expert Jev answered, when that is its choice."""
        for gate in self.gates:
            answer = result.answers.get(gate.when) if gate.skip == name else None
            if answer is None:
                continue
            if gate.when in OWN_QUESTIONS:
                p = sum(float(answer.probabilities.get(v, 0.0)) for v in gate.verdicts)
                if p >= (gate.min_confidence or self.skip_threshold):
                    return True
            elif answer.choice in gate.verdicts and float(answer.probabilities.get(answer.choice, 0.0)) >= gate.min_confidence:
                return True
        return False

    def _language_model_experts(
        self, expert_names: List[str], result: Any, sm_context: Dict[str, Any]
    ) -> List[str]:
        # A plain "Ja" to the question asked back is the only place that answer gets saved.
        always_extract = self._ask_back.answering or is_stalled(sm_context)
        # Where Jev said which task was answered, that decides: extraction saves only that task,
        # so it runs exactly when there is one. The other two questions can disagree with it.
        follows_pick = ANSWERED_TASK in result.answers
        remaining = []
        answered = set(self._jev_experts(expert_names))
        for name in expert_names:
            if name in answered:
                continue
            if name == EXTRACTION and follows_pick and not always_extract:
                if not self.last_picks:
                    continue
            elif not (name == EXTRACTION and always_extract) and self._gated(name, result):
                # Jev says it has nothing to do (the configuration's gates).
                continue
            remaining.append(name)
        return remaining

    def _settle_llm_ask_back(self, verdicts: List[ExpertVerdict]) -> List[ExpertVerdict]:
        wanted = any(_asks_back(self._registry, v) for v in verdicts)
        self._ask_back.decide(wanted and not overridden(verdicts, self._registry))
        return verdicts


class _Scoped:
    """The registry as the base pool reads it, with every tool kept to the scope."""

    def __init__(self, registry: Any, scope: Scope):
        self._registry = registry
        self._scope = scope

    def list_tools(self) -> List[Any]:
        return scoped(self._registry.list_tools(), self._scope)
