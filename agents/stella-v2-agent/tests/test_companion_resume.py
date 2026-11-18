"""A companion resumed after an auto-pause carries on the conversation (#159).

The pod that wakes a paused session is a fresh process: the companion's
opening (greeted, offered, asleep) lived only in memory, so its first turn was
told "this is the start of the conversation" and greeted as if meeting the
user for the first time. The transcript survives the pod, and the opening is
rebuilt from it, by the same rules `Companion.note` applies live.
"""

from unittest.mock import AsyncMock

import pytest

from stella_agent_sdk.messages.types import ChatMessage
from stella_v2_agent.agent import StellaV2Agent
from stella_v2_agent.companion import (
    Change,
    Companion,
    Transition,
    decision,
    woken_tag,
    opening_from_history,
)

ACTIVITIES = [
    {
        "id": "memory",
        "title": "Memory Game",
        "description": "A shopping list game",
        "plan": {"id": "memory", "title": "Memory Game", "states": [{"id": "s1"}]},
    },
]


def _text(role: str, content: str, at: str) -> ChatMessage:
    kind = "agent_text" if role == "assistant" else "user_text"
    return ChatMessage(
        id=f"{role}-{at}", timestamp=at,
        envelope={"type": kind, "data": {"content": content}},
        role=role, content=content, message_type=kind,
    )


def _tag(output, at: str) -> ChatMessage:
    """A decision tag as persisted: the real `decision()`/`woken_tag()` output."""
    return ChatMessage(
        id=f"tag-{at}", timestamp=at,
        envelope={"type": "debug", "data": {"content": output.content, "metadata": output.metadata}},
        role="system", content=output.content, message_type="debug",
    )


HELLO = [
    _text("assistant", "Hallo! Wie geht es dir?", "2026-11-10T18:00:00Z"),
    _text("user", "Gut, danke.", "2026-11-10T18:00:05Z"),
]
OFFERED = _tag(decision("s1", Transition(Change.OFFERED, offered=ACTIVITIES)), "2026-11-10T18:00:10Z")
SLEPT = _tag(decision("s1", Transition(Change.DISMISSED)), "2026-11-10T18:05:00Z")


# ── the rule ────────────────────────────────────────────────────────────────

def test_an_empty_transcript_is_a_fresh_opening():
    assert opening_from_history([]) == (False, False)


def test_a_reply_already_given_means_she_has_greeted():
    assert opening_from_history(HELLO) == (True, False)


def test_an_offer_already_made_is_not_made_again():
    assert opening_from_history(HELLO + [OFFERED]) == (True, True)


def test_a_user_who_only_spoke_has_not_been_greeted():
    assert opening_from_history([_text("user", "Hallo?", "2026-11-10T18:00:00Z")]) == (False, False)


def test_going_to_sleep_starts_the_opening_over():
    # She said goodbye and slept before the pause: being woken is a new
    # conversation, exactly as it is without a restart in between.
    assert opening_from_history(HELLO + [OFFERED, SLEPT]) == (False, False)


def test_only_what_came_after_the_last_sleep_counts():
    after = [_text("assistant", "Schön, dass du wieder da bist.", "2026-11-10T19:00:00Z")]
    assert opening_from_history(HELLO + [OFFERED, SLEPT] + after) == (True, False)


def test_being_woken_with_no_reply_yet_is_a_fresh_opening():
    # The old pod died between the wake and her opening line.
    woke = _tag(woken_tag("s1"), "2026-11-10T19:00:00Z")
    assert opening_from_history(HELLO + [OFFERED, woke]) == (False, False)


# ── the agent applies it on joining ────────────────────────────────────────

def _agent(history):
    agent = StellaV2Agent.__new__(StellaV2Agent)
    agent._companion_mode = True
    agent.companion = Companion(activities=ACTIVITIES)
    agent._history_client = object()
    agent.get_chat_history = AsyncMock(return_value=history)
    return agent


@pytest.mark.asyncio
async def test_a_resumed_companion_does_not_greet_again():
    agent = _agent(HELLO + [OFFERED])
    await agent._rehydrate_opening()
    assert agent.companion.greeted and agent.companion.offered
    # The first thing the user says after coming back gets an answer, not
    # "this is the start of the conversation".
    assert agent.companion.decide([], said="Ich bin wieder da").change is not Change.GREETED


@pytest.mark.asyncio
async def test_a_new_session_still_greets():
    agent = _agent([])
    await agent._rehydrate_opening()
    assert agent.companion.decide([], said="Hallo").change is Change.GREETED


@pytest.mark.asyncio
async def test_unreadable_history_leaves_the_opening_as_it_was():
    agent = _agent([])
    agent.get_chat_history = AsyncMock(side_effect=RuntimeError("backend down"))
    await agent._rehydrate_opening()
    assert agent.companion.greeted is False


@pytest.mark.asyncio
async def test_plan_mode_is_left_alone():
    agent = _agent(HELLO)
    agent._companion_mode = False
    await agent._rehydrate_opening()
    agent.get_chat_history.assert_not_called()
