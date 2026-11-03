"""The stages this agent replaces in the V2 pipeline."""

import asyncio
import logging
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

from stella_agent_sdk.agent import BargeInEvaluator
from stella_agent_sdk.messages.types import BargeInDecision
from stella_v2_agent.models.arbitration_result import ResponseDirective
from stella_v2_agent.pipeline.bridge_generator import BridgeGenerator
from stella_v2_agent.pipeline.response_generator import ResponseGenerator

from stella_jev_agent.ask_back import AFTER_ASK_BACK_INSTRUCTION, ASK_BACK_INSTRUCTION, AskBack
from stella_jev_agent.jev import JevClient, JevUnavailable
from stella_jev_agent.questions import BARGE_IN, RESUME, barge_in_state

logger = logging.getLogger(__name__)


class NoBridge(BridgeGenerator):
    """Says nothing. The V2 turn already handles a turn with a silent bridge."""

    async def generate_stream(self, *args: Any, **kwargs: Any) -> AsyncIterator[str]:
        return
        yield


TASK_ANSWERED_INSTRUCTION = (
    "The user just answered the last question and that answer counts as confirmed; what "
    "they said is in the conversation. Don't get hung up on it or probe it further: "
    "acknowledge it naturally and focus on the current task."
)


class JevResponseGenerator(ResponseGenerator):
    """Writes the reply as V2 does, except on a turn that asks back."""

    def __init__(self, llm_service: Any, ask_back: AskBack, forecast: Callable[[], Any] = lambda: None):
        super().__init__(llm_service)
        self._ask_back = ask_back
        self._forecast = forecast

    def generate(self, *, directive: ResponseDirective, prepend: str = "", **kwargs: Any):
        forecast = self._forecast()
        sm_context = kwargs.get("sm_context")
        if forecast and forecast.keys and sm_context is not None:
            # Nothing is saved yet, so V2's before-and-after comparison finds nothing.
            sm_context["_collected_keys"] = list(sm_context.get("_collected_keys", [])) + forecast.keys
        if self._ask_back.take():
            # A "critical" never gets here: it overrides the reply, and the pool
            # does not ask back on such a turn. A health or legal note is dropped
            # on purpose, since this reply only asks what was said and advises nothing.
            directive.routing_directive = ASK_BACK_INSTRUCTION
            directive.primary_action = ""
            directive.ask_followup = False
            directive.followup_question = ""
            directive.force_redirect = False
            prepend = ""
        elif self._ask_back.take_answer():
            directive.routing_directive = "\n".join(
                filter(None, [directive.routing_directive, AFTER_ASK_BACK_INSTRUCTION])
            )
        elif forecast and forecast.done_task and not forecast.next_state:
            # V2's own line for this looks at the current task, which has moved on.
            directive.routing_directive = "\n".join(
                filter(None, [directive.routing_directive, TASK_ANSWERED_INSTRUCTION])
            )
        return super().generate(directive=directive, prepend=prepend, **kwargs)


class JevBargeInEvaluator(BargeInEvaluator):
    """Asks Jev whether an interruption counts. Commits when unsure or on failure."""

    def __init__(self, llm_service: Any, jev: JevClient):
        super().__init__(llm_service)
        self._jev = jev
        self.resume_threshold = 0.7

    def apply_config(self, config: dict) -> None:
        super().apply_config(config)
        if "resume_threshold" in config:
            self.resume_threshold = float(config["resume_threshold"])

    async def evaluate(
        self,
        transcript: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
        variables: Optional[Dict[str, Any]] = None,
    ) -> BargeInDecision:
        if not transcript or not transcript.strip():
            return BargeInDecision.RESUME
        interrupted = (variables or {}).get("interruptedReply", "")
        state = barge_in_state(transcript, conversation_history, interrupted, self.history_limit)
        try:
            result = await self._jev.ask(state, {"barge_in": BARGE_IN}, timeout_s=self.eval_timeout_s)
        except (JevUnavailable, asyncio.TimeoutError) as e:
            logger.warning(f"Barge-in: Jev unavailable ({e}), defaulting to COMMIT")
            return BargeInDecision.COMMIT
        p_resume = result.answers["barge_in"].probabilities[RESUME]
        decision = (
            BargeInDecision.RESUME if p_resume >= self.resume_threshold else BargeInDecision.COMMIT
        )
        logger.info(f"Barge-in -> {decision.value} (p_resume={p_resume:.2f}) in {result.latency_ms:.0f}ms")
        return decision
