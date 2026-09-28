"""Tests for mid-turn state re-anchoring of the response context (#304 state-sync).

When task_extraction completes a phase and advances the state machine during a
turn, the response must be authored against the state the turn LANDED in — not
the turn-start snapshot — otherwise the agent keeps talking about the phase it
just left while the progress panel shows the new one.

Detection is verdict-driven (the SM tools report transitioned/new_state_id), so
these tests drive the signal directly rather than stubbing a state-machine read.
"""

import pytest

from stella_v2_agent.agent import StellaV2Agent


def _make_agent(*, refreshed, has_sm_client=True):
    """Build a bare agent with just what _resolve_response_context needs."""
    agent = StellaV2Agent.__new__(StellaV2Agent)
    agent.sm_client = object() if has_sm_client else None
    agent._fetch_called = False

    async def _fake_fetch():
        agent._fetch_called = True
        return refreshed

    agent._fetch_sm_context = _fake_fetch  # type: ignore
    return agent


def _turn_start_ctx(state_id="state_A"):
    return {"state": {"id": state_id, "title": "Old Phase"}, "deliverables": []}


@pytest.mark.asyncio
async def test_no_transition_keeps_original_and_does_not_refetch():
    sm = _turn_start_ctx("state_A")
    agent = _make_agent(refreshed={"state": {"id": "X"}})
    out = await agent._resolve_response_context(
        sm, "en", transitioned=False, new_state_id=None, session_completed=False
    )
    assert out is sm
    assert agent._fetch_called is False  # no extra backend work on the common path


@pytest.mark.asyncio
async def test_transition_reanchors_to_new_state():
    sm = _turn_start_ctx("state_A")
    refreshed = {"state": {"id": "state_B", "title": "New Phase"}, "deliverables": []}
    agent = _make_agent(refreshed=refreshed)
    out = await agent._resolve_response_context(
        sm, "de", transitioned=True, new_state_id="state_B", session_completed=False
    )
    assert out is refreshed
    assert out["state"]["id"] == "state_B"
    assert out["state_just_changed"] is True
    assert out["language"] == "de"


@pytest.mark.asyncio
async def test_end_sentinel_does_not_reanchor_even_if_context_populated():
    # The real backend returns a POPULATED __end__ state (not {}), so guarding on
    # new_state_id is essential — a refetch would otherwise pass the .get("state")
    # check and author against the blank end sentinel. Must not even refetch.
    sm = _turn_start_ctx("state_A")
    agent = _make_agent(refreshed={"state": {"id": "__end__", "title": ""}})
    out = await agent._resolve_response_context(
        sm, "en", transitioned=True, new_state_id="__end__", session_completed=False
    )
    assert out is sm
    assert agent._fetch_called is False


@pytest.mark.asyncio
async def test_session_completed_does_not_reanchor():
    sm = _turn_start_ctx("state_A")
    agent = _make_agent(refreshed={"state": {"id": "state_B"}})
    out = await agent._resolve_response_context(
        sm, "en", transitioned=True, new_state_id="state_B", session_completed=True
    )
    assert out is sm
    assert agent._fetch_called is False


@pytest.mark.asyncio
async def test_refetch_unusable_falls_back():
    # gRPC hiccup: refetch returns empty/no-state → keep the original context.
    sm = _turn_start_ctx("state_A")
    agent = _make_agent(refreshed={})
    out = await agent._resolve_response_context(
        sm, "en", transitioned=True, new_state_id="state_B", session_completed=False
    )
    assert out is sm


@pytest.mark.asyncio
async def test_no_sm_client_keeps_original():
    sm = _turn_start_ctx("state_A")
    agent = _make_agent(refreshed={"state": {"id": "state_B"}}, has_sm_client=False)
    out = await agent._resolve_response_context(
        sm, "en", transitioned=True, new_state_id="state_B", session_completed=False
    )
    assert out is sm


@pytest.mark.asyncio
async def test_transitioned_without_new_state_id_keeps_original():
    sm = _turn_start_ctx("state_A")
    agent = _make_agent(refreshed={"state": {"id": "state_B"}})
    out = await agent._resolve_response_context(
        sm, "en", transitioned=True, new_state_id=None, session_completed=False
    )
    assert out is sm
