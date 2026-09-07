#!/usr/bin/env python3
"""
Simple Echo Agent Example

The smallest agent you can build with the STELLA Agent SDK: it repeats back
whatever the user says. Start here to see the shape of an agent, then replace
the body of `process()` with your own logic.

`BaseAgent` has exactly two abstract methods — `process()` and `on_interrupt()`.
Everything else below is an optional lifecycle hook, shown here so you can see
what is available.

Running it:
    The SDK's only entry point is `run_agent_from_env()`, which reads all of its
    connection settings from the environment. Those are normally set for you by
    the session-management-server when it deploys an agent pod, so in production
    you just run the module. To run it by hand you have to supply them yourself:

        export LIVEKIT_URL=ws://localhost:7880
        export ROOM_NAME=my-room
        export AGENT_IDENTITY=agent-echo
        export LIVEKIT_API_KEY=devkey
        export LIVEKIT_API_SECRET=devsecret
        python echo_agent.py

    Those five are required. STT_SERVICE_ADDRESS, TTS_SERVICE_ADDRESS,
    SESSION_SERVER_URL and the rest are optional and documented in the README —
    they default to the in-cluster service names.
"""

import asyncio
import logging
from typing import Any, AsyncIterator, Dict

from stella_agent_sdk import BaseAgent, AgentInput, AgentOutput, run_agent_from_env

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class EchoAgent(BaseAgent):
    """Echoes user input back. The minimal BaseAgent implementation."""

    def __init__(self) -> None:
        super().__init__()
        self.message_count = 0

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        """Optional. Called once when the session opens.

        `config` is whatever the deployment put in the AGENT_CONFIG environment
        variable, parsed as JSON — plan, prompts, model settings, and so on.
        """
        logger.info(f"Session started: {session_id}")
        logger.info(f"Config: {config}")
        self.message_count = 0

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        """Required. Called for each user utterance; yields the agent's reply.

        This is an async generator, so you can yield as many outputs as you like
        for a single input — status updates first, then text. Yield
        `AgentOutput.text_chunk(...)` repeatedly to stream a reply token by token
        (see openai_agent.py); `text_final` sends it in one piece.
        """
        self.message_count += 1

        # Optional: tell the UI we're working before the real answer arrives.
        yield AgentOutput.processing(input.session_id, "Processing your message...")

        yield AgentOutput.text_final(input.session_id, f"You said: {input.text}")

        logger.info(f"Processed message {self.message_count}: {input.text[:50]}")

    async def on_interrupt(self, session_id: str) -> None:
        """Required. Called when the user barges in over the agent.

        Cancel any in-flight generation here. The echo agent produces its reply
        instantly, so there is nothing to stop.
        """
        logger.info(f"Interrupt received for session {session_id}")

    async def on_session_end(self, session_id: str) -> Dict[str, Any]:
        """Optional. Clean up and return any stats worth recording."""
        logger.info(f"Session ended: {session_id}")
        return {"messages_processed": self.message_count}


if __name__ == "__main__":
    asyncio.run(run_agent_from_env(EchoAgent()))
