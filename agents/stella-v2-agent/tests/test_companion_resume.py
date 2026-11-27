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


def _debug(metadata, at: str) -> ChatMessage:
    """A debug note that is not a companion decision, as persisted."""
    return ChatMessage(
        id=f"debug-{at}", timestamp=at,
        envelope={"type": "debug", "data": {"content": "note", "metadata": metadata}},
        role="system", content="note", message_type="debug",
    )


def test_other_notes_with_a_decision_field_are_ignored():
    # Live run, 24 Nov: a text barge-in persists `decision: "commit"` (a
    # string). Reading it as a companion decision crashed every resumed pod
    # whose conversation had ever been interrupted, so she never came back.
    barge_in = _debug({"channel": "text", "decision": "commit", "transcript": "Ja"}, "2026-11-10T18:00:06Z")
    assert opening_from_history(HELLO + [barge_in]) == (True, False)
    assert opening_from_history(HELLO + [barge_in, OFFERED]) == (True, True)


def test_malformed_entries_do_not_break_the_opening():
    odd = [
        _debug("just text", "2026-11-10T18:00:06Z"),
        _debug({"decision": {"kind": 7}}, "2026-11-10T18:00:07Z"),
        ChatMessage(id="x", timestamp="2026-11-10T18:00:08Z", envelope={"type": "debug", "data": "text"},
                    role="system", content="", message_type="debug"),
    ]
    assert opening_from_history(HELLO + odd) == (True, False)


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


# ── the wake opening speaks the conversation's language (#159, 23 Nov) ─────
# On production 2.1.0, waking Grace after a pause greeted a German speaker in
# English: a fresh pod resolves its language only on the first user turn, and
# the wake opening comes before any.

from stella_agent_sdk.language import LanguageResolver
from stella_v2_agent.companion import language_from_history

GERMAN = [
    {"role": "assistant", "content": "Hallo! Wie geht es dir?"},
    {"role": "user", "content": "Mir geht es gut, ich habe heute schön im Garten gearbeitet."},
]


def test_the_users_last_words_give_the_language():
    assert language_from_history(GERMAN) == "de"


def test_only_the_users_words_count():
    assert language_from_history([{"role": "assistant", "content": "Wie geht es dir? Schön!"}]) is None


def test_too_little_to_go_on_gives_no_language():
    assert language_from_history([{"role": "user", "content": "ok"}]) is None
    assert language_from_history([]) is None


def _waking_agent(history, persona_language=None):
    agent = StellaV2Agent.__new__(StellaV2Agent)
    agent._companion_mode = True
    agent.companion = Companion(activities=ACTIVITIES)
    agent._audio_pipeline = None
    agent.sm_client = None
    agent._custom_history_limit = 20
    agent._persona_config = {"language": persona_language} if persona_language else {}
    agent.language_resolver = LanguageResolver(forced="")
    agent._session_language = None
    agent._fetch_conversation_history = AsyncMock(return_value=history)
    seen = {}

    async def generate(**kwargs):
        seen.update(kwargs["sm_context"])
        if False:
            yield None

    agent.response_generator = type("G", (), {"generate": staticmethod(generate)})()
    return agent, seen


async def _wake(agent):
    return [o async for o in agent._say_unprompted("s1", "Greet them.", "They have not said anything yet.")]


@pytest.mark.asyncio
async def test_waking_a_fresh_pod_greets_in_the_transcripts_language():
    agent, seen = _waking_agent(GERMAN)
    await _wake(agent)
    assert seen["language"] == "de"


@pytest.mark.asyncio
async def test_the_personas_language_wins_over_the_transcript():
    agent, seen = _waking_agent([{"role": "user", "content": "I am fine thanks, how are you today?"}], persona_language="de")
    await _wake(agent)
    assert seen["language"] == "de"


@pytest.mark.asyncio
async def test_a_new_session_with_no_transcript_has_no_language_as_before():
    agent, seen = _waking_agent([])
    await _wake(agent)
    assert seen["language"] is None


@pytest.mark.asyncio
async def test_the_wake_uses_the_sessions_own_languages_and_bar():
    # A deployment that tunes the resolver gets the same on wake (sable, PR 1024).
    agent, seen = _waking_agent(GERMAN)
    agent.language_resolver.supported = {"en"}
    await _wake(agent)
    assert seen["language"] is None

    agent, seen = _waking_agent([{"role": "user", "content": "Ja, gut."}])
    agent.language_resolver.text_bar = 0.1
    await _wake(agent)
    assert seen["language"] == "de"
