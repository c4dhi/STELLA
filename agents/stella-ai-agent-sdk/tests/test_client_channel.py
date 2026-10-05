"""The agent's channel to the device beyond speech: commands out, events in, idle.

An agent used to have one way to act on the device — writing a tag into its
reply — and no way to learn what the user did on it. These are the three
openings: ``AgentOutput.client_command``, ``on_client_event`` and ``on_idle``.
"""

import asyncio
import json
from types import SimpleNamespace
from typing import AsyncIterator
from unittest.mock import AsyncMock, MagicMock

import pytest

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent
from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.messages.types import OutputType


class _Agent(BaseAgent):
    def __init__(self):
        super().__init__()
        self.events = []
        self.idles = []

    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        yield AgentOutput.client_command(input.session_id, "sleep")
        yield AgentOutput.text_final(input.session_id, "Good night.")

    async def on_interrupt(self, session_id: str) -> None:
        pass

    async def on_client_event(self, session_id, event, data):
        self.events.append((event, data))

    async def on_idle(self, session_id, idle_seconds):
        self.idles.append(idle_seconds)


# ── commands out ─────────────────────────────────────────────────────────────

def test_a_client_command_is_its_own_envelope():
    output = AgentOutput.client_command("s1", "sleep", reason="idle")
    assert output.type == OutputType.CLIENT_COMMAND
    assert output.to_data_payload() == {
        "type": "agent_command",
        "data": {"command": "sleep", "reason": "idle"},
    }


def _audio(final_text="good night"):
    """The parts of the audio pipeline run_audio_loop touches, recording order."""
    order = []
    audio = MagicMock()
    audio.is_closing = False
    audio.is_speaking = False
    audio.is_turn_suspended = False
    audio.is_turn_aborted = False
    audio.emotion_tags_enabled = False

    async def audio_in():
        yield SimpleNamespace(
            text=final_text, is_final=True, transcript_id="t1",
            detected_language="", language_confidence=0.0, confidence=0.9,
            is_barge_in=False,
        )

    audio.audio_in = audio_in
    for name in ("publish_text", "publish_emotion_cues", "speak", "await_turn_release"):
        setattr(audio, name, AsyncMock())
    audio.flush_speech_queue = AsyncMock(side_effect=lambda: order.append("speech flushed"))
    audio.wait_for_playout_drain = AsyncMock(side_effect=lambda: order.append("playout drained"))
    audio._room.publish_data = AsyncMock(
        side_effect=lambda payload: order.append(payload["type"])
    )
    return audio, order


@pytest.mark.asyncio
async def test_a_command_yielded_in_a_turn_waits_for_the_speech_to_be_heard():
    agent = _Agent()
    agent._audio_pipeline, order = _audio()
    agent._session_id = "s1"
    agent._enqueue_sentence = lambda *_a, **_k: None

    await agent.run_audio_loop()

    assert order.index("agent_command") > order.index("playout drained") > order.index("speech flushed")
    sent = agent.audio._room.publish_data.call_args_list[-1].args[0]
    assert sent["data"]["command"] == "sleep"


@pytest.mark.asyncio
async def test_an_interrupted_turn_drops_its_commands():
    agent = _Agent()
    agent._audio_pipeline, order = _audio()
    agent._session_id = "s1"
    agent._enqueue_sentence = lambda *_a, **_k: None
    agent.audio.flush_speech_queue = AsyncMock(
        side_effect=lambda: setattr(agent.audio, "is_turn_aborted", True)
    )

    await agent.run_audio_loop()

    assert "agent_command" not in order


# ── events in ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_client_event_reaches_the_registered_handler():
    pipeline = AudioPipeline.__new__(AudioPipeline)  # bypass heavy __init__
    seen = []

    async def handler(event, data):
        seen.append((event, data))

    pipeline.on_client_event(handler)
    pipeline._handle_data_message(
        "human", json.dumps({"type": "client_event", "data": {"event": "tap", "x": 1}}).encode()
    )
    await asyncio.sleep(0)

    assert seen == [("tap", {"event": "tap", "x": 1})]


@pytest.mark.asyncio
async def test_a_client_event_without_a_handler_or_a_name_is_dropped():
    pipeline = AudioPipeline.__new__(AudioPipeline)
    pipeline._handle_data_message("human", json.dumps({"type": "client_event"}).encode())
    pipeline._handle_data_message(
        "human", json.dumps({"type": "client_event", "data": {"event": "tap"}}).encode()
    )
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_the_agent_hook_gets_the_event_and_a_failure_in_it_is_contained():
    agent = _Agent()
    await agent._dispatch_client_event("wake", {"event": "wake"})
    assert agent.events == [("wake", {"event": "wake"})]

    async def broken(*_a):
        raise RuntimeError("agent bug")

    agent.on_client_event = broken
    await agent._dispatch_client_event("tap", {})  # must not raise


# ── idle ─────────────────────────────────────────────────────────────────────

async def _watch(agent, seconds):
    task = asyncio.create_task(agent._idle_watchdog())
    await asyncio.sleep(seconds)
    task.cancel()


@pytest.mark.asyncio
async def test_idle_fires_once_per_quiet_stretch_and_activity_arms_it_again():
    agent = _Agent()
    agent._audio_pipeline = SimpleNamespace(is_closing=False, is_speaking=False)
    agent.idle_timeout_seconds = 0.2
    agent._note_activity()

    await _watch(agent, 1.7)
    assert len(agent.idles) == 1

    agent._note_activity()
    await _watch(agent, 1.2)
    assert len(agent.idles) == 2


@pytest.mark.asyncio
async def test_idle_is_off_by_default_and_never_fires_while_the_agent_speaks():
    quiet = _Agent()
    quiet._audio_pipeline = SimpleNamespace(is_closing=False, is_speaking=False)
    await _watch(quiet, 0.8)
    assert quiet.idles == []

    speaking = _Agent()
    speaking._audio_pipeline = SimpleNamespace(is_closing=False, is_speaking=True)
    speaking.idle_timeout_seconds = 0.1
    await _watch(speaking, 1.2)
    assert speaking.idles == []
