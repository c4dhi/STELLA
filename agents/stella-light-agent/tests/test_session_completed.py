"""The light agent must end the session when the plan reaches __end__ (#6)."""

import asyncio
from typing import Any, List

import pytest

from stella_light_agent.tool_processor import ToolProcessorResult
from test_steering_and_skip import _FakeSMClient, _FakeToolProcessor, _make_agent


def _drive(agent) -> List[Any]:
    class _Inp:
        session_id = "sess-1"
        text = "That was everything."

    async def _go() -> List[Any]:
        return [o async for o in agent._process_with_tools(_Inp())]

    return asyncio.run(_go())


def test_completed_turn_speaks_farewell_and_flags_the_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    agent = _make_agent(monkeypatch)
    agent.sm_client = _FakeSMClient()  # type: ignore[assignment]
    agent.tool_processor = _FakeToolProcessor(  # type: ignore[assignment]
        ToolProcessorResult(
            message="Thanks!", transitioned=True, new_state_id="__end__",
            session_completed=True, farewell_message="Goodbye and thank you!",
        )
    )

    outputs = _drive(agent)

    assert agent._session_completed is True
    assert any("Goodbye and thank you!" in str(getattr(o, "content", "")) for o in outputs)


def test_ordinary_turn_does_not_end_the_session(monkeypatch: pytest.MonkeyPatch) -> None:
    agent = _make_agent(monkeypatch)
    agent.sm_client = _FakeSMClient()  # type: ignore[assignment]
    agent.tool_processor = _FakeToolProcessor(  # type: ignore[assignment]
        ToolProcessorResult(message="ok")
    )

    _drive(agent)

    assert agent._session_completed is False


def test_completed_without_farewell_still_ends(monkeypatch: pytest.MonkeyPatch) -> None:
    agent = _make_agent(monkeypatch)
    agent.sm_client = _FakeSMClient()  # type: ignore[assignment]
    agent.tool_processor = _FakeToolProcessor(  # type: ignore[assignment]
        ToolProcessorResult(message="ok", session_completed=True)
    )

    _drive(agent)

    assert agent._session_completed is True
