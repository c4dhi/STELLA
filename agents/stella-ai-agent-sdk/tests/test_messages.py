"""Tests for message types."""

import json
import pytest
from datetime import datetime

from stella_agent_sdk.messages.types import (
    InputType,
    OutputType,
    StatusSubtype,
    MetadataSubtype,
)
from stella_agent_sdk.messages.input import AgentInput
from stella_agent_sdk.messages.output import AgentOutput


class TestInputType:
    """Tests for InputType enum."""

    def test_input_types_exist(self):
        """All expected input types exist."""
        assert InputType.TEXT == "text"
        assert InputType.INTERRUPT == "interrupt"
        assert InputType.SESSION_START == "session_start"
        assert InputType.SESSION_END == "session_end"
        assert InputType.CONFIG == "config"


class TestOutputType:
    """Tests for OutputType enum."""

    def test_output_types_exist(self):
        """All expected output types exist."""
        assert OutputType.TEXT_CHUNK == "text_chunk"
        assert OutputType.TEXT_FINAL == "text_final"
        assert OutputType.STATUS == "status"
        assert OutputType.METADATA == "metadata"
        assert OutputType.ERROR == "error"


class TestAgentInput:
    """Tests for AgentInput dataclass."""

    def test_create_text_input(self):
        """Create a text input message."""
        input_msg = AgentInput.text_input(
            session_id="test-session",
            text="Hello, world!",
            user_name="Test User",
        )
        assert input_msg.session_id == "test-session"
        assert input_msg.type == InputType.TEXT
        assert input_msg.text == "Hello, world!"
        assert input_msg.metadata.get("user_name") == "Test User"

    def test_create_interrupt(self):
        """Create an interrupt message."""
        input_msg = AgentInput.interrupt("test-session", reason="user_barge_in")
        assert input_msg.session_id == "test-session"
        assert input_msg.type == InputType.INTERRUPT
        assert input_msg.metadata.get("reason") == "user_barge_in"

    def test_create_session_start(self):
        """Create a session start message."""
        config = {"model": "gpt-4", "temperature": 0.7}
        input_msg = AgentInput.session_start("test-session", config)
        assert input_msg.session_id == "test-session"
        assert input_msg.type == InputType.SESSION_START
        assert input_msg.metadata == config

    def test_create_session_end(self):
        """Create a session end message."""
        input_msg = AgentInput.session_end("test-session")
        assert input_msg.session_id == "test-session"
        assert input_msg.type == InputType.SESSION_END


class TestAgentOutput:
    """Tests for AgentOutput dataclass."""

    def test_create_text_chunk(self):
        """Create a streaming text chunk."""
        output = AgentOutput.text_chunk(
            session_id="test-session",
            text="Hello",
            transcript_id="tx-123",
        )
        assert output.session_id == "test-session"
        assert output.type == OutputType.TEXT_CHUNK
        assert output.content == "Hello"
        assert output.transcript_id == "tx-123"
        assert output.is_final is False

    def test_create_text_chunk_final(self):
        """Create a final text chunk."""
        output = AgentOutput.text_chunk(
            session_id="test-session",
            text="!",
            transcript_id="tx-123",
            is_final=True,
        )
        assert output.is_final is True

    def test_create_text_final(self):
        """Create a complete text message."""
        output = AgentOutput.text_final(
            session_id="test-session",
            text="Hello, world!",
        )
        assert output.session_id == "test-session"
        assert output.type == OutputType.TEXT_FINAL
        assert output.content == "Hello, world!"
        assert output.is_final is True
        assert output.transcript_id is not None  # Auto-generated

    def test_create_status(self):
        """Create a status message."""
        output = AgentOutput.status(
            session_id="test-session",
            message="Processing...",
            subtype=StatusSubtype.PROCESSING,
            progress=0.5,
        )
        assert output.session_id == "test-session"
        assert output.type == OutputType.STATUS
        assert output.content == "Processing..."
        assert output.status_subtype == StatusSubtype.PROCESSING
        assert output.metadata.get("progress") == 0.5

    def test_create_thinking(self):
        """Create a thinking status message."""
        output = AgentOutput.thinking("test-session")
        assert output.type == OutputType.STATUS
        assert output.status_subtype == StatusSubtype.THINKING

    def test_create_error(self):
        """Create an error message."""
        output = AgentOutput.error(
            session_id="test-session",
            message="Something went wrong",
            error_type="processing_error",
            recoverable=True,
        )
        assert output.session_id == "test-session"
        assert output.type == OutputType.ERROR
        assert output.content == "Something went wrong"
        assert output.metadata.get("error_type") == "processing_error"
        assert output.metadata.get("recoverable") is True

    def test_create_deliverable(self):
        """Create a deliverable update."""
        output = AgentOutput.deliverable(
            session_id="test-session",
            key="user_name",
            value="John Doe",
        )
        assert output.type == OutputType.METADATA
        assert output.metadata_subtype == MetadataSubtype.DELIVERABLE
        assert output.metadata.get("key") == "user_name"
        assert output.metadata.get("value") == "John Doe"

    def test_create_progress(self):
        """Create a progress update."""
        output = AgentOutput.progress(
            session_id="test-session",
            percentage=75,
            message="Almost done",
        )
        assert output.type == OutputType.METADATA
        assert output.metadata_subtype == MetadataSubtype.PROGRESS
        assert output.metadata.get("percentage") == 0.75  # Normalized to 0-1


class TestDecisionAndToolCallOutputs:
    """Decisions and tool calls both ride the DEBUG channel deliberately.

    Reusing DEBUG means they persist, replay and transport with no new envelope
    type and no backend change — so what these tests pin down is that the extra
    structure survives ``to_data_payload`` intact, since that is the only path
    to the frontend.
    """

    def test_decision_is_a_debug_output_carrying_a_decision_block(self):
        output = AgentOutput.decision(
            "s1",
            "activity_started",
            "Started “Memory Game”",
            component="companion_router",
        )
        assert output.type == OutputType.DEBUG
        assert output.metadata["component"] == "companion_router"
        assert output.metadata["decision"] == {
            "kind": "activity_started",
            "label": "Started “Memory Game”",
        }

    def test_decision_detail_and_options_reach_the_frontend(self):
        payload = AgentOutput.decision(
            "s1",
            "activities_offered",
            "Offered 2 activities",
            detail="Ask to pick one",
            options=["Memory Game", "Fitness Check-in"],
        ).to_data_payload()

        assert payload["type"] == "debug"
        decision = payload["data"]["metadata"]["decision"]
        assert decision["options"] == ["Memory Game", "Fitness Check-in"]
        assert decision["detail"] == "Ask to pick one"
        # The message still reads correctly for anything that only knows debug.
        assert payload["data"]["content"] == "Offered 2 activities — Ask to pick one"

    def test_decision_omits_absent_optional_fields(self):
        # An empty `options: []` means "offered nothing", which is a real and
        # different statement from "this decision was not an offer at all".
        assert "options" not in AgentOutput.decision("s1", "k", "l").metadata["decision"]
        assert AgentOutput.decision("s1", "k", "l", options=[]).metadata["decision"]["options"] == []

    def test_tool_call_reports_what_the_agent_actually_did(self):
        output = AgentOutput.tool_call(
            "s1",
            "set_deliverable",
            caller="task_extraction",
            arguments={"key": "user_name", "value": "Sam"},
            data={"success": True},
        )
        assert output.type == OutputType.DEBUG
        assert output.metadata["component"] == "tool:set_deliverable"
        assert output.metadata["caller"] == "task_extraction"
        assert output.metadata["arguments"] == {"key": "user_name", "value": "Sam"}
        assert "set_deliverable(" in output.content

    def test_failed_tool_call_is_a_warning_and_says_why(self):
        output = AgentOutput.tool_call(
            "s1", "complete_task", caller="task_extraction",
            success=False, error="unknown task id",
        )
        assert output.metadata["level"] == "warn"
        assert output.metadata["error"] == "unknown task id"
        assert "unknown task id" in output.content

    def test_tool_call_argument_preview_is_bounded(self):
        # Arguments can carry a whole extracted transcript; the content line is
        # rendered in a chat list, so it must not become the message.
        output = AgentOutput.tool_call(
            "s1", "batch_update", arguments={"blob": "x" * 5000},
        )
        assert len(output.content) < 300
        # The full value is still there for anyone who opens the metadata.
        assert len(output.metadata["arguments"]["blob"]) == 5000
