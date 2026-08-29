"""Where emotion tags meet the teleprompter (#face-emotions).

The parser is tested on its own in test_emotion_tags.py. What is tested here is
the seam, which is where the real risk sits: the SAME stripped string has to
feed the published agent_text, the sentence splitter, TTS, and the cue offsets.
If stripping a tag moved any one of them relative to the others, the symptom
would not be a wrong emotion — it would be the word highlight drifting out of
sync with the voice for the rest of the reply, which is much harder to trace
back to here.
"""

from typing import AsyncIterator

import pytest

from stella_agent_sdk.agent.base import BaseAgent
from stella_agent_sdk.emotion.tags import EMOTION_TAGS
from stella_agent_sdk.messages.input import AgentInput
from stella_agent_sdk.messages.output import AgentOutput


class StubPipeline:
    """Records what the agent hands to TTS."""

    emotion_tags_enabled = True

    def __init__(self):
        self.sentences = []

    def enqueue_sentence(self, sentence, source="response", **spans):
        self.sentences.append({"text": sentence, **spans})


class TagAgent(BaseAgent):
    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        yield AgentOutput.text_chunk(input.session_id, "", "t")

    async def on_interrupt(self, input: AgentInput) -> None:
        pass


def _agent():
    agent = TagAgent()
    agent._audio_pipeline = StubPipeline()
    return agent


def _stream(agent, raw, *, chunk=7):
    """Drive the agent's own text path the way run_audio_loop does.

    Accumulated text in, stripped text published, sentences dispatched off the
    stripped text — the same order and the same values as the real loop.
    """
    agent._tp_transcript_id = "t1"
    agent._tp_cursor = 0
    published, cues = "", []
    tts_buffer = ""
    for end in range(chunk, len(raw) + chunk, chunk):
        accumulated = raw[:end]
        is_final = end >= len(raw)
        published, cues = agent._parse_emotion_tags(accumulated, is_final=is_final)
        agent._tp_text = published
        # The real loop treats a non-extending update as a new turn and resets
        # its sentence buffer. Assert instead of mirroring it: reaching that
        # branch mid-reply means the published text shrank, which is a bug, and
        # a harness that quietly recovered would hide it.
        assert published.startswith(tts_buffer), (
            f"published text shrank: {tts_buffer!r} -> {published!r}"
        )
        new_text = published[len(tts_buffer):]
        tts_buffer = published
        agent._dispatch_sentences(new_text)
    remaining = agent._flush_sentence_buffer()
    if remaining:
        agent._enqueue_sentence(remaining)
    return published, cues, agent._audio_pipeline.sentences


REPLY = (
    "[playful] That is a good question. [thinking] Let me work through it. "
    "[happy] The answer is yes. [nod] Definitely."
)


def test_nothing_bracketed_ever_reaches_the_screen_or_the_voice():
    agent = _agent()
    published, _, sentences = _stream(agent, REPLY)
    assert "[" not in published and "]" not in published
    for sentence in sentences:
        assert "[" not in sentence["text"], sentence


def test_no_tag_name_is_ever_spoken():
    agent = _agent()
    _, _, sentences = _stream(agent, REPLY)
    spoken = " ".join(s["text"] for s in sentences).lower()
    for tag in EMOTION_TAGS:
        assert tag.replace("_", " ") not in spoken


def test_cue_offsets_index_the_published_text():
    agent = _agent()
    published, cues, _ = _stream(agent, REPLY)
    assert [c.tag for c in cues] == ["playful", "thinking", "happy", "nod"]
    # Each cue must land on the first word it is meant to colour.
    assert published[cues[0].char:].startswith("That is a good question.")
    assert published[cues[1].char:].startswith("Let me work through it.")
    assert published[cues[2].char:].startswith("The answer is yes.")
    assert published[cues[3].char:].startswith("Definitely.")


def test_sentence_spans_still_tile_the_published_text():
    # The teleprompter's own invariant, re-checked with tags in play: sentence
    # spans are located in _tp_text and must still resolve, in order, to the
    # exact substring being spoken. This is what would silently break.
    agent = _agent()
    published, _, sentences = _stream(agent, REPLY)
    located = [s for s in sentences if "char_start" in s]
    assert len(located) == len(sentences), "a sentence failed to locate itself"
    previous_end = 0
    for s in located:
        assert published[s["char_start"]:s["char_end"]] == s["text"]
        assert s["char_start"] >= previous_end
        previous_end = s["char_end"]


def test_cues_and_sentence_spans_agree_on_the_same_coordinates():
    # The frontend advances one cursor across this text and fires cues off it,
    # so a cue must fall inside the sentence whose words it belongs to.
    agent = _agent()
    _, cues, sentences = _stream(agent, REPLY)
    located = [s for s in sentences if "char_start" in s]
    for cue in cues:
        owner = [s for s in located if s["char_start"] <= cue.char < s["char_end"]]
        assert owner, f"cue {cue.tag} at {cue.char} falls outside every sentence"


@pytest.mark.parametrize("chunk", [1, 2, 3, 5, 11, 40, 500])
def test_result_is_the_same_however_the_stream_is_chunked(chunk):
    # Tags land on chunk boundaries at some size or other; the withhold is what
    # makes the outcome independent of where the boundary falls.
    baseline_agent = _agent()
    baseline, baseline_cues, _ = _stream(baseline_agent, REPLY, chunk=500)
    agent = _agent()
    published, cues, _ = _stream(agent, REPLY, chunk=chunk)
    assert published == baseline
    assert [(c.char, c.tag) for c in cues] == [(c.char, c.tag) for c in baseline_cues]


def test_disabled_agent_passes_text_through_untouched():
    agent = _agent()
    agent.supports_emotion_tags = False
    published, cues, _ = _stream(agent, REPLY)
    assert published == REPLY
    assert cues == []
