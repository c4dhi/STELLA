"""The stages this agent replaces in the V2 pipeline."""

import asyncio
import logging
from typing import Any, AsyncIterator, Dict, List, Optional

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


class JevResponseGenerator(ResponseGenerator):
    """Writes the reply as V2 does, except on a turn that asks back."""

    def __init__(self, llm_service: Any, ask_back: AskBack):
        super().__init__(llm_service)
        self._ask_back = ask_back

    def generate(self, *, directive: ResponseDirective, prepend: str = "", **kwargs: Any):
        if self._ask_back.take():
            # A medical "critical" never gets here: it overrides the reply, and
            # the pool does not ask back on such a turn.
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
