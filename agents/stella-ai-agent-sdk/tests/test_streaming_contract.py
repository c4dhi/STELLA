"""Pins the streaming contract run_audio_loop actually expects (issue #903).

`process()` must yield the WHOLE reply so far on every text_chunk, not the new
token, and must not close with an empty final chunk — see
docs-site/docs/agent-sdk/streaming.md. examples/openai_agent.py and
BaseAgent.process's own docstring used to violate both rules (yielding a raw
per-token delta, then an empty is_final chunk), which is exactly the
DeltaAgent below: the first test shows the contract honored, the second
documents what happens when it isn't.
"""

from types import SimpleNamespace
from typing import AsyncIterator
from unittest.mock import AsyncMock, MagicMock

import pytest

from stella_agent_sdk.agent.base import BaseAgent
from stella_agent_sdk.messages.input import AgentInput
from stella_agent_sdk.messages.output import AgentOutput

TOKENS = ["Hello ", "there. ", "Good ", "bye."]
FULL_REPLY = "".join(TOKENS)


class AccumulatingAgent(BaseAgent):
    """Follows the contract: every chunk carries the whole reply so far."""

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        transcript_id = "tx"
        reply = ""
        for token in TOKENS:
            reply += token
            yield AgentOutput.text_chunk(input.session_id, reply, transcript_id=transcript_id)
        yield AgentOutput.text_chunk(input.session_id, reply, transcript_id=transcript_id, is_final=True)

    async def on_interrupt(self, session_id: str) -> None:
        pass


class DeltaAgent(BaseAgent):
    """The anti-pattern the docs warn against: each chunk is just the new
    token, and the stream closes with an empty final chunk."""

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        transcript_id = "tx"
        for token in TOKENS:
            yield AgentOutput.text_chunk(input.session_id, token, transcript_id=transcript_id)
        yield AgentOutput.text_chunk(input.session_id, "", transcript_id=transcript_id, is_final=True)

    async def on_interrupt(self, session_id: str) -> None:
        pass


def _audio_harness():
    """The parts of the audio pipeline run_audio_loop touches, recording
    every publish_text call in order."""
    audio = MagicMock()
    audio.is_closing = False
    audio.is_speaking = False
    audio.is_turn_suspended = False
    audio.is_turn_aborted = False
    audio.emotion_tags_enabled = False

    async def audio_in():
        yield SimpleNamespace(
            text="go", is_final=True, transcript_id="t1",
            detected_language="", language_confidence=0.0, confidence=0.9,
            is_barge_in=False,
        )

    audio.audio_in = audio_in
    for name in ("publish_emotion_cues", "speak", "await_turn_release", "flush_speech_queue", "wait_for_playout_drain"):
        setattr(audio, name, AsyncMock())

    publishes = []
    audio.publish_text = AsyncMock(
        side_effect=lambda text, is_final=False, transcript_id=None: publishes.append((text, is_final))
    )
    audio._room.publish_data = AsyncMock()
    return audio, publishes


@pytest.mark.asyncio
async def test_accumulated_chunks_reach_the_screen_whole():
    agent = AccumulatingAgent()
    agent._audio_pipeline, publishes = _audio_harness()
    agent._session_id = "s1"

    await agent.run_audio_loop()

    last_text, last_is_final = publishes[-1]
    assert last_text == FULL_REPLY
    assert last_is_final is True


@pytest.mark.asyncio
async def test_per_token_deltas_with_an_empty_final_chunk_corrupt_the_screen():
    """Characterizes the bug, not the desired behaviour: this is exactly why
    streaming.md tells authors not to yield deltas or close on an empty
    chunk. A chunk that doesn't extend the previous one is treated as a new
    text (the frontend bubble resets to it), and the empty final chunk then
    replaces the bubble with nothing."""
    agent = DeltaAgent()
    agent._audio_pipeline, publishes = _audio_harness()
    agent._session_id = "s1"

    await agent.run_audio_loop()

    last_text, last_is_final = publishes[-1]
    assert last_is_final is True
    assert last_text == ""  # the full reply never reached the screen
    assert last_text != FULL_REPLY
