"""STELLA Jev Agent: the V2 pipeline with Jev deciding and no bridge.

The turn itself is V2's. This agent swaps four stages:

- bridge: gone, so nothing is said before the experts have decided
- experts: one Jev call, with language models only where text has to be written, and
  the reply starting before task_extraction has finished
- reply: as in V2, plus the forced question when something does not fit
- barge-in: Jev instead of a language model
"""

import logging
import os
from contextlib import aclosing
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional

from stella_agent_sdk import AgentOutput

from stella_v2_agent.agent import StellaV2Agent

from stella_jev_agent.ask_back import AskBack
from stella_jev_agent.jev import JevClient
from stella_jev_agent.next_step import END, context_after, context_within
from stella_jev_agent.pool import COMMON, EXTRACTION, JevExpertPool
from stella_jev_agent.questions import DOESNT_FIT, SLIGHT_DOUBT
from stella_jev_agent.stages import JevBargeInEvaluator, JevResponseGenerator, NoBridge

logger = logging.getLogger(__name__)

_OWN_EXPERTS_DIR = Path(__file__).resolve().parent.parent.parent / "config" / "experts"
# V2's turn reports these even when nothing is said. Here they would chart a bridge
# that does not exist, finishing in a few milliseconds.
_NO_BRIDGE_STAGES = {"bridge_start", "bridge_ready", "bridge_done"}


class StellaJevAgent(StellaV2Agent):
    # Until a session's turn_taking settings say otherwise.
    take_back_window_ms = 6000

    def __init__(
        self,
        llm_config_path: Optional[str] = None,
        experts_dir: Optional[str] = None,
        state_machine_address: Optional[str] = None,
    ):
        # V2 rebuilds its registry from this variable when a session overrides experts.
        os.environ.setdefault("STELLA_EXPERTS_DIR", experts_dir or str(_OWN_EXPERTS_DIR))
        super().__init__(
            llm_config_path=llm_config_path,
            experts_dir=experts_dir or os.environ["STELLA_EXPERTS_DIR"],
            state_machine_address=state_machine_address,
        )
        self.jev = JevClient()
        self.ask_back = AskBack()
        self.bridge_generator = NoBridge(self.llm_service)
        self.expert_pool = self._jev_pool()
        self.response_generator = JevResponseGenerator(
            self.llm_service, self.ask_back, lambda: self.expert_pool.forecast
        )
        self.barge_in_evaluator = JevBargeInEvaluator(self.llm_service, self.jev)
        self._extraction_events: list = []
        self.arbitration._flagging_verdicts[COMMON] = {SLIGHT_DOUBT, DOESNT_FIT}

    def _jev_pool(self) -> JevExpertPool:
        return JevExpertPool(
            self.llm_service, self.expert_registry,
            tool_registry=self.tool_registry,
            compiler_version=self._compiler_version,
            jev=self.jev,
            ask_back=self.ask_back,
            plan=lambda: self._plan_config,
        )

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        # The language-model fallback is for an outage. Without a key it would run
        # every session on it, with no bridge and no check before saving, and look fine.
        if not os.environ.get("TYPESAFE_API_KEY"):
            raise RuntimeError("TYPESAFE_API_KEY is not set, so stella-jev-agent cannot start a session")
        await super().on_session_start(session_id, config)
        # V2 builds a plain pool when the session overrides experts.
        if not isinstance(self.expert_pool, JevExpertPool):
            self.expert_pool = self._jev_pool()
            self.expert_pool.set_compiler_version(self._compiler_version)
        nodes = (config.get("pipeline_config") or {}).get("nodes", {})
        turn_taking = nodes.get("turn_taking") or {}
        if "take_back_window_ms" in turn_taking and self.has_audio:
            self.audio.enable_take_back(int(turn_taking["take_back_window_ms"]))
        node = nodes.get("expert_pool")
        if isinstance(node, dict):
            self.expert_pool.apply_config(node)

    async def process(self, input: Any) -> AsyncIterator[AgentOutput]:
        pool_start_ms = 0.0
        turn_id = None
        await self.expert_pool.settle_extraction()
        self._taken_back = (input.metadata or {}).get("taken_back") or []
        if self._taken_back:
            # That reply was never heard, so neither was the step it moved to.
            self._last_state_id = getattr(self, "_state_before_forecast", self._last_state_id)
        async with aclosing(super().process(input)) as outputs:
            async for output in outputs:
                stage = output.metadata.get("stage") if output.type.value == "analytics" else None
                if stage in _NO_BRIDGE_STAGES:
                    continue
                if stage == "expert_pool_start":
                    pool_start_ms = output.metadata["elapsed_ms"]
                    turn_id = output.metadata["turn_id"]
                yield output
                if stage == "expert_pool_done":
                    yield self._jev_event(input.session_id, output.metadata["turn_id"], pool_start_ms)
        for stage, fields in self._extraction_events:
            yield AgentOutput.analytics_event(input.session_id, stage, turn_id, **fields)
        self._extraction_events = []

    async def _fetch_conversation_history(self, limit: int = 20) -> List[Dict[str, str]]:
        history = await super()._fetch_conversation_history(limit=limit)
        taken_back = getattr(self, "_taken_back", None)
        if not taken_back:
            return history
        # This turn's text already holds those words, and the reply after them went unheard.
        for i in range(len(history) - 1, -1, -1):
            if history[i]["role"] == "user" and history[i]["content"].strip() == taken_back[0]:
                return history[:i]
        return history

    async def _resolve_response_context(self, sm_context: Dict[str, Any], *args: Any, **kwargs: Any) -> Dict[str, Any]:
        forecast = self.expert_pool.forecast
        target = forecast.next_state
        if target and target != END and self._plan_config:
            predicted = context_after(sm_context, self._plan_config, target, forecast.keys)
            if predicted:
                # Or the next turn would ease into this state a second time.
                self._state_before_forecast = self._last_state_id
                self._last_state_id = target
                return predicted
        if not target and forecast.done_task and self._plan_config:
            # Otherwise the reply still has the answered task as current, and probes it again.
            moved_on = context_within(sm_context, self._plan_config, forecast.done_task, forecast.keys)
            if moved_on:
                return moved_on
        return await super()._resolve_response_context(sm_context, *args, **kwargs)

    async def _process_post_response(self, session_id: str, expert_verdicts: list) -> AsyncIterator[AgentOutput]:
        # V2's bookkeeping needs the outcome, and the reply has already been written by
        # now. Everything after it (deliverables, progress, the farewell) stays as it was.
        forecast = self.expert_pool.forecast
        if self.has_audio and not await self.audio.wait_until_turn_is_final():
            # Taken back: the joined turn saves it all, once, when it is heard.
            logger.info("Turn taken back, so nothing from it is saved")
            return
        self.expert_pool.start_held_extraction()
        self._extraction_started_ms = self._elapsed_ms()
        late = await self.expert_pool.finish_extraction()
        self._record_extraction(late, forecast)
        async for output in super()._process_post_response(session_id, list(expert_verdicts) + late):
            yield output

    def _record_extraction(self, late: list, forecast: Any) -> None:
        """When extraction finished, and whether the plan went where the reply said."""
        verdict = next((v for v in late if v.expert_name == EXTRACTION), None)
        if verdict is None:
            return
        raw = verdict.raw_output or {}
        reached = raw.get("new_state_id") if raw.get("transitioned") else None
        started = getattr(self, "_extraction_started_ms", 0.0)
        self._extraction_events.append(("extraction_done", {
            "elapsed_ms": started + verdict.latency_ms,
            "latency_ms": round(verdict.latency_ms, 1),
            "success": verdict.success,
        }))
        if reached != forecast.next_state:
            logger.warning(f"Next step forecast {forecast.next_state!r}, the plan went to {reached!r}")
            self._extraction_events.append(("next_step_miss", {
                "elapsed_ms": started + verdict.latency_ms,
                "forecast": forecast.next_state,
                "reached": reached,
            }))

    def _jev_event(self, session_id: str, turn_id: str, pool_start_ms: float) -> AgentOutput:
        """Whether Jev decided this turn. A session on the fallback otherwise looks normal."""
        jev = self.expert_pool.last_jev
        return AgentOutput.analytics_event(
            session_id, "jev_done" if jev.get("answered") else "jev_failed", turn_id,
            pool_start_ms + jev.get("latency_ms", 0.0),
            latency_ms=round(jev.get("latency_ms", 0.0), 1), reason=jev.get("reason"),
        )

    async def _say_unprompted(
        self, session_id: str, instruction: str, standing_in_for_user: str,
    ) -> AsyncIterator[AgentOutput]:
        self.ask_back.cancel()
        async for output in super()._say_unprompted(session_id, instruction, standing_in_for_user):
            yield output

    async def on_session_end(self, session_id: str) -> Dict[str, Any]:
        await self.expert_pool.settle_extraction()
        result = await super().on_session_end(session_id)
        await self.jev.close()
        return result
