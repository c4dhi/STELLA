"""The card's hard rule, at the level it actually lives: #57 says "a test
that fails if a forced decode is counted as detection evidence." The
guarantee isn't in LanguageResolver (it never sees the forced text at all) —
it's in ``_resolve_language``, which decides ``needs_redecode`` from the
ORIGINAL free decode BEFORE calling ``resolve()``, and only ever substitutes
``input.text`` for display AFTER (@sable, PR 750 review).

So this constructs a doubtful turn, fakes ``audio.redecode_utterance_audio``
to return text in a DIFFERENT language than what was forced, and checks the
resolver ends up in exactly the state a free-decode-only run would reach —
while the turn's displayed text was still corrected.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from stella_agent_sdk import AgentInput
from stella_agent_sdk.language import LanguageResolver
from stella_v2_agent.agent import StellaV2Agent


def _agent_with_locked_german():
    agent = StellaV2Agent.__new__(StellaV2Agent)
    agent.language_resolver = LanguageResolver()
    agent.language_resolver.resolve("Ich habe heute wirklich keine Motivation", signal=("de", 0.99))
    agent._audio_pipeline = MagicMock()
    return agent


@pytest.mark.asyncio
async def test_forced_redecode_text_never_becomes_detection_evidence():
    agent = _agent_with_locked_german()
    # If this ever reached resolve() as evidence, the lock would move toward
    # "es" -- it's a different language than the one it was forced into,
    # which is exactly what a self-confirming forced decode could never do,
    # and exactly what a bug feeding it back in WOULD do.
    agent.audio.redecode_utterance_audio = AsyncMock(return_value="hola, que tal")

    doubtful = AgentInput.text_input(
        "s1", "ja", turn_id="t1", detected_language="es", language_confidence=0.75,
    )

    # Reference: what the free decode ALONE (no redecode at all) does to an
    # identical, freshly-locked resolver.
    reference = LanguageResolver()
    reference.resolve("Ich habe heute wirklich keine Motivation", signal=("de", 0.99))
    reference_locked = reference.resolve("ja", signal=("es", 0.75))

    resolved = await agent._resolve_language(doubtful)

    assert resolved == reference_locked == "de"
    assert agent.language_resolver.locked == reference.locked
    assert agent.language_resolver.challenger_lang == reference.challenger_lang
    assert agent.language_resolver.challenger_score == reference.challenger_score
    # The display text WAS corrected -- the point is that this never leaked
    # into the comparison above.
    assert doubtful.text == "hola, que tal"


@pytest.mark.asyncio
async def test_a_confident_turn_is_never_sent_for_redecode_at_all():
    agent = _agent_with_locked_german()
    agent.audio.redecode_utterance_audio = AsyncMock(return_value="should never be called")

    confident = AgentInput.text_input(
        "s1", "ich bin heute ganz gut drauf", turn_id="t1",
        detected_language="de", language_confidence=0.95,
    )
    await agent._resolve_language(confident)
    agent.audio.redecode_utterance_audio.assert_not_called()
    assert confident.text == "ich bin heute ganz gut drauf"


@pytest.mark.asyncio
async def test_redecode_result_only_replaces_text_when_non_empty():
    agent = _agent_with_locked_german()
    # The provider could not force-decode it (e.g. the lightweight dev
    # provider) -- the turn's own text must survive untouched.
    agent.audio.redecode_utterance_audio = AsyncMock(return_value=None)

    doubtful = AgentInput.text_input(
        "s1", "ja", turn_id="t1", detected_language="es", language_confidence=0.75,
    )
    await agent._resolve_language(doubtful)
    assert doubtful.text == "ja"
