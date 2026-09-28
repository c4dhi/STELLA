"""The emotion-tag instruction, and the two ways it can go wrong (#face-emotions).

Both failure modes here are silent in production, which is why they are pinned:

  * asking for tags that nothing strips -> the model writes "[playful]" and TTS
    reads the word "playful" out loud to the user;
  * naming a tag the parser does not know -> the tag is dropped and the face
    simply never reacts, with nothing in the logs to say why.
"""

import re

import pytest

from stella_agent_sdk.emotion.tags import EMOTION_TAGS, strip_emotion_tags
from stella_v2_agent.prompts.response_prompt import build_response_system_prompt


def _prompt(**kw):
    return build_response_system_prompt({}, None, **kw)


def test_directive_is_absent_unless_the_parser_is_active():
    # The flag tracks the parser. If it ever drifts, the model is asked for
    # markup nobody removes and the user hears the tag names.
    assert "EMOTIONAL EXPRESSION" not in _prompt(emotion_tags=False)


def test_directive_is_present_when_enabled():
    assert "EMOTIONAL EXPRESSION" in _prompt(emotion_tags=True)


def test_directive_names_exactly_the_vocabulary_the_parser_knows():
    prompt = _prompt(emotion_tags=True)
    listed = set(re.findall(r"\[([a-z_]+)\]", prompt))
    # [smiles] and [laughs] appear as counter-examples the model must avoid.
    listed -= {"smiles", "laughs"}
    assert listed == set(EMOTION_TAGS), (
        "the prompt and the parser disagree about the vocabulary"
    )


@pytest.mark.parametrize("tag", sorted(EMOTION_TAGS))
def test_every_advertised_tag_survives_a_round_trip(tag):
    # Written the way the prompt tells the model to write it.
    result = strip_emotion_tags(f"[{tag}] Something to say.")
    assert result.text == "Something to say."
    assert [c.tag for c in result.cues] == [tag]


def test_the_counter_examples_really_are_rejected():
    # The prompt tells the model never to write [smiles]. If one slips through
    # it must be dropped, not spoken.
    result = strip_emotion_tags("[smiles] Something to say.")
    assert result.text == "Something to say."
    assert result.cues == []
