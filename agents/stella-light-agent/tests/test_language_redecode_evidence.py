"""Same guarantee as stella-v2-agent's test of the same name: #57's hard rule
("a test that fails if a forced decode is counted as detection evidence")
lives in ``_resolve_language``, shared code reached through both agents'
``process()``. A doubtful turn's forced re-decode corrects the displayed
text but must never reach ``resolve()`` as a signal.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from stella_agent_sdk import AgentInput
from stella_agent_sdk.language import LanguageResolver
from stella_light_agent.agent import StellaLightAgent


def _agent_with_locked_german():
    agent = StellaLightAgent.__new__(StellaLightAgent)
    # "es" supported too, so a vote for it is a real vote, not clamped away.
    agent.language_resolver = LanguageResolver(supported=("de", "en", "es"))
    agent.language_resolver.resolve("Ich habe heute wirklich keine Motivation", signal=("de", 0.99))
    agent._audio_pipeline = MagicMock()
    return agent


@pytest.mark.asyncio
async def test_forced_redecode_text_never_becomes_detection_evidence():
    # The doubtful turn must be 4 words or more (@sable, ref b0364e6c): under
    # the length floor, resolve() never votes regardless of what signal it is
    # given, so a 1-2 word turn can't distinguish "evidence fed back" from
    # "not fed back" -- both look identical. Confidence 0.75 (< text_bar
    # 0.85) is what makes this turn doubtful here, not its length.
    agent = _agent_with_locked_german()
    agent.audio.redecode_utterance_audio = AsyncMock(return_value="hola, como estas hoy")

    doubtful_text = "ja genau das stimmt"
    doubtful = AgentInput.text_input(
        "s1", doubtful_text, turn_id="t1", detected_language="es", language_confidence=0.75,
    )

    reference = LanguageResolver(supported=("de", "en", "es"))
    reference.resolve("Ich habe heute wirklich keine Motivation", signal=("de", 0.99))
    reference_locked = reference.resolve(doubtful_text, signal=("es", 0.75))
    assert reference.challenger_lang == "es"
    assert reference.challenger_score > 0

    resolved = await agent._resolve_language(doubtful)

    assert resolved == reference_locked == "de"
    assert agent.language_resolver.challenger_lang == reference.challenger_lang
    assert agent.language_resolver.challenger_score == reference.challenger_score
    assert doubtful.text == "hola, como estas hoy"


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
