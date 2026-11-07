"""The client channel as a protocol: declared events and commands, replies,
and the platform's own stella.interaction_mode (voice or text interface)."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent
from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.client_channel import CLIENT_CHANNEL_ENV, ClientChannel
from stella_agent_sdk.services.stt_client import TranscriptEvent

DECLARED = json.dumps({
    "events": [
        {"name": "wake"},
        {"name": "rate", "data": {"type": "object", "properties": {"stars": {"type": "integer", "minimum": 1, "maximum": 5}}, "required": ["stars"]}},
    ],
    "commands": [{"name": "sleep"}],
})


class _Agent(BaseAgent):
    def __init__(self):
        super().__init__()
        self.events = []

    async def process(self, input: AgentInput):
        return
        yield

    async def on_interrupt(self, session_id):
        pass

    async def on_client_event(self, session_id, event, data):
        self.events.append((event, data))
        if event == "rate":
            if data["stars"] == 1:
                raise RuntimeError("too harsh")
            return {"thanks": True}
        return None


def _agent(monkeypatch, declared=DECLARED):
    if declared is None:
        monkeypatch.delenv(CLIENT_CHANNEL_ENV, raising=False)
    else:
        monkeypatch.setenv(CLIENT_CHANNEL_ENV, declared)
    agent = _Agent()
    audio = MagicMock()
    audio._room.publish_data = AsyncMock()
    agent._audio_pipeline = audio
    agent._agent_id = "a1"
    return agent, audio


def _replies(audio):
    return [c.args[0]["data"] for c in audio._room.publish_data.call_args_list if c.args[0]["type"] == "client_event_reply"]


def test_nothing_declared_outside_stella_allows_everything():
    channel = ClientChannel.from_env({})
    assert not channel.declared
    assert channel.event_problem("anything", {"x": 1}) is None
    assert channel.command_problem("anything", {}) is None


def test_declared_events_are_checked_by_name_and_schema():
    channel = ClientChannel.from_env({CLIENT_CHANNEL_ENV: DECLARED})
    assert channel.event_problem("wake", {}) is None
    assert channel.event_problem("rate", {"stars": 4}) is None
    assert "not declared" in channel.event_problem("tap", {})
    assert "stars" in channel.event_problem("rate", {"stars": 9})
    assert "required" in channel.event_problem("rate", {})
    # An empty declaration (STELLA always sets one) refuses everything.
    assert "not declared" in ClientChannel.from_env({CLIENT_CHANNEL_ENV: ""}).event_problem("wake", {})


@pytest.mark.asyncio
async def test_a_request_gets_the_hooks_answer(monkeypatch):
    agent, audio = _agent(monkeypatch)
    await agent._dispatch_client_event("rate", {"event": "rate", "request_id": "r1", "stars": 4})
    assert agent.events == [("rate", {"stars": 4})]
    assert _replies(audio) == [{"request_id": "r1", "event": "rate", "ok": True, "data": {"thanks": True}, "agent_id": "a1"}]


@pytest.mark.asyncio
async def test_a_failing_hook_replies_with_its_error(monkeypatch):
    agent, audio = _agent(monkeypatch)
    await agent._dispatch_client_event("rate", {"request_id": "r2", "stars": 1})
    [reply] = _replies(audio)
    assert (reply["ok"], reply["error"]) == (False, "too harsh")


@pytest.mark.asyncio
async def test_undeclared_or_misshapen_events_are_refused_before_the_hook(monkeypatch):
    agent, audio = _agent(monkeypatch)
    await agent._dispatch_client_event("tap", {"request_id": "r3"})
    await agent._dispatch_client_event("rate", {"request_id": "r4", "stars": "five"})
    assert agent.events == []
    assert [(r["request_id"], r["ok"]) for r in _replies(audio)] == [("r3", False), ("r4", False)]
    assert "not declared" in _replies(audio)[0]["error"]


@pytest.mark.asyncio
async def test_an_event_without_a_request_id_gets_no_reply(monkeypatch):
    agent, audio = _agent(monkeypatch)
    await agent._dispatch_client_event("wake", {})
    await agent._dispatch_client_event("tap", {})
    assert agent.events == [("wake", {})]
    assert _replies(audio) == []


@pytest.mark.asyncio
async def test_interaction_mode_is_the_sdks_own_and_needs_no_declaration(monkeypatch):
    agent, audio = _agent(monkeypatch, declared=json.dumps({"events": [], "commands": []}))
    await agent._dispatch_client_event("stella.interaction_mode", {"request_id": "m1", "mode": "text"})
    audio.set_interaction_mode.assert_called_once_with("text")
    assert agent.events == []  # never reaches the agent's hook
    await agent._dispatch_client_event("stella.interaction_mode", {"request_id": "m2", "mode": "loud"})
    await agent._dispatch_client_event("stella.unknown", {"request_id": "m3"})
    assert [(r["request_id"], r["ok"]) for r in _replies(audio)] == [("m1", True), ("m2", False), ("m3", False)]
    assert _replies(audio)[0]["data"] == {"mode": "text"}


@pytest.mark.asyncio
async def test_an_undeclared_command_is_not_sent(monkeypatch):
    agent, audio = _agent(monkeypatch)
    await agent.send_client_command("sleep")
    with pytest.raises(ValueError, match="not declared"):
        await agent.send_client_command("dance")
    assert [c.args[0]["data"]["command"] for c in audio._room.publish_data.call_args_list] == ["sleep"]


# ── the text interface in the audio pipeline ────────────────────────────────


class _Room:
    def on_data_received(self, cb):
        pass

    async def publish_data(self, data, *a, **k):
        pass

    def flush_audio_queue(self):
        pass


def _pipeline():
    pipe = AudioPipeline(_Room(), stt_client=None, tts_client=MagicMock(), session_id="s")
    pipe._is_listening = True
    return pipe


def _final(text, typed=False):
    return TranscriptEvent(text=text, is_final=True, transcript_id=text, participant_id="p", confidence=1.0, timestamp_ms=0, typed=typed)


@pytest.mark.asyncio
async def test_on_the_text_interface_nothing_is_voiced_or_waited_for():
    pipe = _pipeline()
    assert pipe.has_tts
    pipe.set_interaction_mode("text")
    assert not pipe.has_tts
    pipe.enqueue_sentence("Hello there.")
    assert pipe._speech_worker_task is None and pipe._speech_queue.empty()
    await asyncio.wait_for(pipe.flush_speech_queue(), 1)  # returns at once
    assert not pipe.is_gate_closed
    pipe.set_interaction_mode("voice")
    assert pipe.has_tts


@pytest.mark.asyncio
async def test_on_the_text_interface_only_typed_messages_are_turns():
    pipe = _pipeline()
    pipe.set_interaction_mode("text")
    pipe._transcript_queue.put_nowait(_final("spoken"))
    pipe._transcript_queue.put_nowait(_final("typed", typed=True))
    turns = pipe.audio_in()
    first = await asyncio.wait_for(turns.__anext__(), 3)
    assert first.text == "typed"
    await turns.aclose()


@pytest.mark.asyncio
async def test_switching_to_text_stops_speech_that_is_playing():
    pipe = _pipeline()
    pipe._is_speaking = True
    pipe.stop_speaking = AsyncMock()
    pipe.set_interaction_mode("text")
    await asyncio.sleep(0)
    pipe.stop_speaking.assert_awaited_once()
    with pytest.raises(ValueError):
        pipe.set_interaction_mode("loud")
