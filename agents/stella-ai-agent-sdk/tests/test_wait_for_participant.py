"""What starts an agent that speaks first (wait_for_participant).

A session participant joining starts it. An organiser on the session page
(LiveKit identity ``human``) does not start it by being there, only by writing
or speaking. These run a real AudioPipeline; only the room is faked.
"""

import asyncio
import json
from typing import Any, AsyncIterator

import pytest

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent
from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.services.stt_client import TranscriptEvent


class _Participants:
    def __init__(self, identities):
        self.remote_participants = {i: object() for i in identities}


class FakeRoom:
    """Just enough of RoomManager for a pipeline that receives chat messages."""

    audio_sample_rate = 48000
    current_audio_speaker = None

    def __init__(self, identities):
        self.room = _Participants(identities)
        self.captured = []

    def on_data_received(self, cb):
        pass

    async def publish_data(self, data, *a, **k):
        self.captured.append(data)

    def publish_data_ordered(self, data, *a, **k):
        self.captured.append(data)

    def get_participant_name(self, identity):
        return identity

    def join(self, identity):
        self.room.remote_participants[identity] = object()


class SpeaksFirst(BaseAgent):
    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        return
        yield

    async def on_interrupt(self, session_id: str) -> None:
        return None


def _agent(identities):
    room = FakeRoom(identities)
    pipe = AudioPipeline(room, stt_client=None, tts_client=None, session_id="s")
    agent = SpeaksFirst()
    agent._audio_pipeline = pipe
    return agent, pipe, room


def _user_text(text: str, participant_id: str = "human") -> bytes:
    return json.dumps({"type": "user_text", "data": {"text": text}, "participant_id": participant_id}).encode()


async def _settle():
    for _ in range(5):
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_an_organiser_opening_the_page_does_not_start_it():
    agent, _, _ = _agent(["agent-me", "message-recorder", "human"])
    with pytest.raises(asyncio.TimeoutError):
        await agent.wait_for_participant(timeout=0.05, poll_interval=0.01)


@pytest.mark.asyncio
async def test_an_organiser_typing_starts_it_and_the_message_is_the_trigger():
    agent, pipe, _ = _agent(["agent-me", "human"])
    waiting = asyncio.ensure_future(agent.wait_for_participant(timeout=2, poll_interval=0.01))
    await asyncio.sleep(0.03)
    assert not waiting.done()

    pipe._handle_data_message("human", _user_text("hello"))
    await _settle()
    assert await waiting == "human"
    # Taken as the trigger: not left for audio_in() to answer as a reply.
    assert pipe._transcript_queue.empty()


@pytest.mark.asyncio
async def test_a_participant_joining_starts_it():
    agent, _, room = _agent(["agent-me", "human"])
    waiting = asyncio.ensure_future(agent.wait_for_participant(timeout=2, poll_interval=0.01))
    await asyncio.sleep(0.03)
    room.join("participant-7")
    assert await waiting == "participant-7"


@pytest.mark.asyncio
async def test_an_empty_message_does_not_start_it():
    agent, pipe, _ = _agent(["agent-me", "human"])
    pipe._handle_data_message("human", _user_text("   "))
    await _settle()
    with pytest.raises(asyncio.TimeoutError):
        await agent.wait_for_participant(timeout=0.05, poll_interval=0.01)


def _event(text: str, participant_id: str = "human") -> TranscriptEvent:
    return TranscriptEvent(
        text=text, is_final=True, transcript_id="t", participant_id=participant_id,
        confidence=1.0, timestamp_ms=0,
    )


@pytest.mark.asyncio
async def test_what_is_not_a_trigger_stays_on_the_queue_in_order():
    agent, pipe, _ = _agent(["agent-me", "human"])
    turn = _event("")  # an agent-initiated turn, queued before anyone wrote
    pipe._transcript_queue.put_nowait(turn)
    pipe._transcript_queue.put_nowait(_event("hello"))
    later = _event("second")
    pipe._transcript_queue.put_nowait(later)

    assert await agent.wait_for_participant(timeout=1, poll_interval=0.01) == "human"
    assert pipe._transcript_queue.get_nowait() is turn
    assert pipe._transcript_queue.get_nowait() is later
    assert pipe._transcript_queue.empty()


@pytest.mark.asyncio
async def test_an_empty_event_alone_stays_and_does_not_start_it():
    agent, pipe, _ = _agent(["agent-me", "human"])
    turn = _event("")
    pipe._transcript_queue.put_nowait(turn)
    with pytest.raises(asyncio.TimeoutError):
        await agent.wait_for_participant(timeout=0.05, poll_interval=0.01)
    assert pipe._transcript_queue.get_nowait() is turn
