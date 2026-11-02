"""STELLA Jev Agent: the V2 pipeline with Jev deciding and no bridge.

The turn itself is V2's. This agent swaps four stages:

- bridge: gone, so nothing is said before the experts have decided
- experts: one Jev call, with language models only where text has to be written
- reply: as in V2, plus the forced question when something does not fit
- barge-in: Jev instead of a language model
"""

import logging
import os
from pathlib import Path
from typing import Any, AsyncIterator, Dict, Optional

from stella_agent_sdk import AgentOutput

from stella_v2_agent.agent import StellaV2Agent

from stella_jev_agent.ask_back import AskBack
from stella_jev_agent.jev import JevClient
from stella_jev_agent.pool import COMMON, JevExpertPool
from stella_jev_agent.questions import DOESNT_FIT, SLIGHT_DOUBT
from stella_jev_agent.stages import JevBargeInEvaluator, JevResponseGenerator, NoBridge

logger = logging.getLogger(__name__)

_OWN_EXPERTS_DIR = Path(__file__).resolve().parent.parent.parent / "config" / "experts"


class StellaJevAgent(StellaV2Agent):
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
        self._agent_type = "stella-jev-agent"
        self.jev = JevClient()
        self.ask_back = AskBack()
        self.bridge_generator = NoBridge(self.llm_service)
        self.expert_pool = self._jev_pool()
        self.response_generator = JevResponseGenerator(self.llm_service, self.ask_back)
        self.barge_in_evaluator = JevBargeInEvaluator(self.llm_service, self.jev)
        self.arbitration._flagging_verdicts[COMMON] = {SLIGHT_DOUBT, DOESNT_FIT}

    def _jev_pool(self) -> JevExpertPool:
        return JevExpertPool(
            self.llm_service, self.expert_registry,
            tool_registry=self.tool_registry,
            compiler_version=self._compiler_version,
            jev=self.jev,
            ask_back=self.ask_back,
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
        node = (config.get("pipeline_config") or {}).get("nodes", {}).get("expert_pool")
        if isinstance(node, dict):
            self.expert_pool.apply_config(node)

    async def _say_unprompted(
        self, session_id: str, instruction: str, standing_in_for_user: str,
    ) -> AsyncIterator[AgentOutput]:
        self.ask_back.cancel()
        async for output in super()._say_unprompted(session_id, instruction, standing_in_for_user):
            yield output

    async def on_session_end(self, session_id: str) -> Dict[str, Any]:
        result = await super().on_session_end(session_id)
        await self.jev.close()
        return result
