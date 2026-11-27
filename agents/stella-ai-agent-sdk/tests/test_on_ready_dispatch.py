"""Tests for the on_ready() output dispatch (issue #903).

TEXT_CHUNK / TEXT_FINAL used to be silently dropped: AgentOutput.to_data_payload()
returns None for them (the audio loop handles those itself), and the old
on_ready loop in run_agent_from_env() just logged and skipped whatever came
back None. A welcome message yielded from on_ready() never reached the
participant. _dispatch_on_ready_output is the extracted, unit-testable piece
of that loop.
"""

import pytest

from stella_agent_sdk.messages.output import AgentOutput
from stella_agent_sdk.progress import ProgressState
from stella_agent_sdk.run import _dispatch_on_ready_output

IDENTITY = {"agent_id": "a1", "agent_name": "Agent", "agent_icon": "🤖"}


class _FakeAgent:
    def __init__(self):
        self._last_progress_payload = None


class _FakeRoom:
    def __init__(self, outer):
        self._outer = outer

    async def publish_data(self, payload):
        self._outer.room_payloads.append(payload)


class _FakeAudioPipeline:
    def __init__(self):
        self.published_text = []
        self.spoken = []
        self.room_payloads = []
        self._room = _FakeRoom(self)

    async def publish_text(self, text, is_final=False, transcript_id=None):
        self.published_text.append((text, is_final, transcript_id))

    async def speak(self, text):
        self.spoken.append(text)


class TestTextDispatch:
    @pytest.mark.asyncio
    async def test_text_final_is_published_and_spoken(self):
        pipeline = _FakeAudioPipeline()
        output = AgentOutput.text_final("s1", "Welcome!")

        await _dispatch_on_ready_output(output, pipeline, _FakeAgent(), IDENTITY)

        assert pipeline.published_text == [("Welcome!", True, output.transcript_id)]
        assert pipeline.spoken == ["Welcome!"]
        assert pipeline.room_payloads == []

    @pytest.mark.asyncio
    async def test_non_final_text_chunk_is_published_but_not_spoken(self):
        pipeline = _FakeAudioPipeline()
        output = AgentOutput.text_chunk("s1", "Wel", transcript_id="tx")

        await _dispatch_on_ready_output(output, pipeline, _FakeAgent(), IDENTITY)

        assert pipeline.published_text == [("Wel", False, "tx")]
        assert pipeline.spoken == []

    @pytest.mark.asyncio
    async def test_empty_final_text_is_not_spoken(self):
        """is_final with no content (e.g. a no-op override) must not call speak('')."""
        pipeline = _FakeAudioPipeline()
        output = AgentOutput.text_final("s1", "")

        await _dispatch_on_ready_output(output, pipeline, _FakeAgent(), IDENTITY)

        assert pipeline.published_text == [("", True, output.transcript_id)]
        assert pipeline.spoken == []


class TestSideChannelDispatch:
    """Everything that isn't text still goes through to_data_payload, unchanged."""

    @pytest.mark.asyncio
    async def test_progress_update_goes_to_room_and_is_remembered(self):
        pipeline = _FakeAudioPipeline()
        agent = _FakeAgent()
        output = AgentOutput.progress_update("s1", ProgressState(groups=[]))

        await _dispatch_on_ready_output(output, pipeline, agent, IDENTITY)

        assert len(pipeline.room_payloads) == 1
        assert pipeline.room_payloads[0]["type"] == "progress_update"
        assert agent._last_progress_payload == pipeline.room_payloads[0]
        assert pipeline.published_text == []
        assert pipeline.spoken == []

    @pytest.mark.asyncio
    async def test_debug_output_goes_to_room(self):
        pipeline = _FakeAudioPipeline()
        output = AgentOutput.debug("s1", "hello")

        await _dispatch_on_ready_output(output, pipeline, _FakeAgent(), IDENTITY)

        assert len(pipeline.room_payloads) == 1
        assert pipeline.room_payloads[0]["type"] == "debug"
        assert pipeline.published_text == []
