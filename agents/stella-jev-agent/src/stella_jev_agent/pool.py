"""One Jev call for every expert that only has to decide something.

Jev cannot write, so anything that has to produce text or values still uses a
language model: task_extraction fills in what the person said and companion_router
calls tools. Jev runs first and decides whether they need to run at all. That order
also keeps a misheard answer from being saved: on a turn that asks back, neither runs.
"""

import asyncio
import logging
from typing import Any, Dict, List

from stella_v2_agent.models.expert_verdict import ExpertVerdict
from stella_v2_agent.pipeline.expert_pool import ExpertPool

from stella_jev_agent.ask_back import AskBack
from stella_jev_agent.jev import JevClient, JevUnavailable
from stella_jev_agent.questions import (
    ACTIVITY_INTENT, COMMON_SENSE, DOESNT_FIT, FITS, HAS_ANSWER, LEGAL, MEDICAL, PROBING,
    RECOGNISER_ARTIFACT, RECOMMENDATIONS, SLIGHT_DOUBT, TIMEKEEPER, not_believable, turn_state,
)

logger = logging.getLogger(__name__)

COMMON = "common_sense"
EXTRACTION = "task_extraction"
ROUTER = "companion_router"

JEV_EXPERTS = {
    COMMON: COMMON_SENSE,
    "medical": MEDICAL,
    "legal": LEGAL,
    "probing": PROBING,
    "timekeeper": TIMEKEEPER,
}
# A language-model expert is skipped when Jev says it has nothing to do.
GATES = {EXTRACTION: ("has_answer", HAS_ANSWER, "no"), ROUTER: ("activity_intent", ACTIVITY_INTENT, "none")}


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


class JevExpertPool(ExpertPool):
    def __init__(self, *args: Any, jev: JevClient, ask_back: AskBack, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self._jev = jev
        self._ask_back = ask_back
        self.ask_threshold = 0.45
        self.skip_threshold = 0.8

    def apply_config(self, config: dict) -> None:
        if "ask_threshold" in config:
            self.ask_threshold = float(config["ask_threshold"])
        if "skip_threshold" in config:
            self.skip_threshold = float(config["skip_threshold"])
        if "max_ask_backs" in config:
            self._ask_back.max_per_session = int(config["max_ask_backs"])
        if "jev_timeout_ms" in config:
            self._jev.timeout_s = float(config["jev_timeout_ms"]) / 1000

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

        limit = max(self._limit(COMMON), 1)
        state = turn_state(user_input, conversation_history, current_task(sm_context), limit)
        try:
            result = await self._jev.ask(state, questions)
        except (JevUnavailable, asyncio.TimeoutError) as e:
            # Slower, but the safety experts keep working during an outage.
            logger.warning(f"Jev unavailable ({e}), running every expert on the language model")
            verdicts = await super().run(expert_names, user_input, conversation_history, sm_context)
            return self._settle_llm_ask_back(verdicts)

        verdicts = self._verdicts(expert_names, result)
        medical = next((v for v in verdicts if v.expert_name == "medical"), None)
        common = next((v for v in verdicts if v.expert_name == COMMON), None)
        wanted = bool(common and common.verdict == DOESNT_FIT)
        asking = self._ask_back.decide(wanted and not (medical and medical.verdict == "critical"))
        if common and wanted and not asking:
            common.verdict = SLIGHT_DOUBT
            common.recommendation = RECOMMENDATIONS[COMMON][SLIGHT_DOUBT]

        remaining = [] if asking else self._language_model_experts(expert_names, result)
        if remaining:
            verdicts += await self._run_experts(
                remaining, user_input, conversation_history, sm_context, self._timeout_ms / 1000.0
            )
        logger.info(
            "Jev: %s in %.0fms, asking_back=%s, then language model: %s",
            {v.expert_name: v.verdict for v in verdicts}, result.latency_ms, asking, remaining,
        )
        return verdicts

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

    def _language_model_experts(self, expert_names: List[str], result: Any) -> List[str]:
        remaining = []
        for name in expert_names:
            if name in JEV_EXPERTS:
                continue
            if name in GATES:
                key, _, nothing_to_do = GATES[name]
                if result.answers[key].probabilities[nothing_to_do] >= self.skip_threshold:
                    continue
            remaining.append(name)
        return remaining

    def _settle_llm_ask_back(self, verdicts: List[ExpertVerdict]) -> List[ExpertVerdict]:
        critical = any(v.expert_name == "medical" and v.verdict == "critical" for v in verdicts)
        wanted = any(v.expert_name == COMMON and v.verdict == DOESNT_FIT for v in verdicts)
        self._ask_back.decide(wanted and not critical)
        return verdicts
