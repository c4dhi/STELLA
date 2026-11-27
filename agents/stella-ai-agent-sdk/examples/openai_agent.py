#!/usr/bin/env python3
"""
OpenAI Agent Example

Shows how to drive an agent with an LLM and stream the reply back token by
token, which is what you want for voice: TTS starts speaking the first sentence
while the model is still writing the rest.

NOTE: This is an EXAMPLE of how to implement an agent, NOT part of the SDK.
      The SDK provides the communication layer only — which LLM you use, and how,
      is entirely your choice.

Running it:
    pip install "stella-ai-agent-sdk[examples]"      # or: pip install openai

    export OPENAI_API_KEY=sk-...
    # Plus the five connection variables run_agent_from_env() requires:
    export LIVEKIT_URL=ws://localhost:7880
    export ROOM_NAME=my-room
    export AGENT_IDENTITY=agent-openai
    export LIVEKIT_API_KEY=devkey
    export LIVEKIT_API_SECRET=devsecret
    python openai_agent.py

    In production the session-management-server sets all of those on the agent
    pod. See the README for the full list, including the optional ones.
"""

import asyncio
import logging
import os
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional

from stella_agent_sdk import BaseAgent, AgentInput, AgentOutput, run_agent_from_env
from stella_agent_sdk.messages.types import StatusSubtype

# Try to import OpenAI - it's optional for the SDK
try:
    from openai import AsyncOpenAI
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    AsyncOpenAI = None

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class OpenAIAgent(BaseAgent):
    """
    Agent that uses OpenAI's GPT models for conversation.

    This demonstrates:
    - Streaming responses from an LLM
    - Maintaining conversation history
    - Proper interrupt handling
    - Using configuration from session-management
    """

    def __init__(self, api_key: Optional[str] = None) -> None:
        super().__init__()

        if not OPENAI_AVAILABLE:
            raise ImportError(
                "OpenAI package is not installed. "
                "Install it with: pip install openai"
            )

        self.api_key = api_key or os.getenv("OPENAI_API_KEY")
        if not self.api_key:
            raise ValueError(
                "OpenAI API key not provided. "
                "Set OPENAI_API_KEY environment variable or pass api_key parameter."
            )

        self.client: Optional[AsyncOpenAI] = None
        self.model = "gpt-4o-mini"
        self.temperature = 0.7
        self.system_prompt = "You are a helpful assistant."
        self.conversation_history: List[Dict[str, str]] = []
        self._cancelled = False

    async def on_session_start(self, session_id: str, config: Dict[str, Any]) -> None:
        """Initialize the OpenAI client with session configuration.

        `config` is the parsed AGENT_CONFIG environment variable, so a deployment
        can change the model or the system prompt without a code change.
        """
        logger.info(f"Session started: {session_id}")

        # Initialize OpenAI client
        self.client = AsyncOpenAI(api_key=self.api_key)

        # Apply configuration from session-management
        self.model = config.get("llm_model", self.model)
        self.temperature = config.get("temperature", self.temperature)
        self.system_prompt = config.get("system_prompt", self.system_prompt)

        # Reset conversation history
        self.conversation_history = []

        logger.info(f"Using model: {self.model}, temperature: {self.temperature}")

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        """Process user input and stream response from OpenAI."""
        self._cancelled = False

        # Show thinking status
        yield AgentOutput.status(
            input.session_id,
            "Thinking...",
            StatusSubtype.THINKING,
        )

        # Add user message to history
        self.conversation_history.append({
            "role": "user",
            "content": input.text,
        })

        # Build messages for OpenAI
        messages = [
            {"role": "system", "content": self.system_prompt},
            *self.conversation_history,
        ]

        # All chunks of one reply share a transcript_id so the client can
        # assemble them into a single message.
        transcript_id = str(uuid.uuid4())
        full_response = ""

        try:
            # Stream from OpenAI
            stream = await self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                temperature=self.temperature,
                stream=True,
            )

            async for chunk in stream:
                # Stops as soon as something sets self._cancelled - see
                # on_interrupt below (not called by the default audio loop).
                if self._cancelled:
                    logger.info("Generation cancelled")
                    break

                # Extract content from chunk. text_chunk carries the whole
                # reply so far, not just this token - the SDK finds the new
                # text by comparing with the previous chunk (see
                # docs-site/docs/agent-sdk/streaming.md).
                if chunk.choices and chunk.choices[0].delta.content:
                    full_response += chunk.choices[0].delta.content

                    yield AgentOutput.text_chunk(
                        input.session_id,
                        full_response,
                        transcript_id=transcript_id,
                    )

            # The final chunk repeats the full text with is_final=True - an
            # empty final chunk would replace the bubble on screen with nothing.
            if not self._cancelled and full_response:
                yield AgentOutput.text_chunk(
                    input.session_id,
                    full_response,
                    transcript_id=transcript_id,
                    is_final=True,
                )

                # Add assistant response to history
                self.conversation_history.append({
                    "role": "assistant",
                    "content": full_response,
                })

        except Exception as e:
            logger.error(f"OpenAI error: {e}")
            yield AgentOutput.error(
                input.session_id,
                f"Error generating response: {e}",
                error_type="llm_error",
            )

    async def on_interrupt(self, session_id: str) -> None:
        """Required (abstract), but the default run_audio_loop() never calls it -
        a committed barge-in is handled by the SDK itself (this agent does not
        set `supports_barge_in`, so none is enabled here).

        Left as a cancellation point for an agent that writes its own
        run_audio_loop(): `process()` checks `self._cancelled` on every
        streamed token, so setting it here would stop generation within a
        token or two.
        """
        logger.info(f"Interrupt received for session {session_id}")
        self._cancelled = True

    async def on_session_end(self, session_id: str) -> Dict[str, Any]:
        """Cleanup and return session stats."""
        logger.info(f"Session ended: {session_id}")
        return {
            "messages_processed": len(self.conversation_history),
            "model_used": self.model,
        }


if __name__ == "__main__":
    asyncio.run(run_agent_from_env(OpenAIAgent()))
