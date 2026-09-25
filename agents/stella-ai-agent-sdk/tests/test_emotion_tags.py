"""Emotion-tag parsing (#face-emotions).

The offsets these produce are shared with the teleprompter cursor, so an error
of one character here does not show up as a wrong emotion — it shows up as the
word highlight drifting out of sync with the voice for the rest of the message.
That is why the arithmetic is tested this thoroughly for a parser this small.
"""

import pytest

from stella_agent_sdk.emotion.tags import (
    EMOTION_TAGS,
    EXPRESSION_TAGS,
    GESTURE_TAGS,
    STATE_TAGS,
    strip_emotion_tags,
)


def cues(text, **kw):
    result = strip_emotion_tags(text, **kw)
    return result.text, [(c.char, c.tag, c.kind) for c in result.cues]


class TestVocabulary:
    def test_every_tag_has_exactly_one_kind(self):
        groups = (EXPRESSION_TAGS, GESTURE_TAGS, STATE_TAGS)
        for i, group in enumerate(groups):
            for other in groups[i + 1 :]:
                assert set(group).isdisjoint(other)
        assert set(EMOTION_TAGS) == set().union(*(set(g) for g in groups))
        assert set(EMOTION_TAGS.values()) == {"expression", "gesture", "state"}

    def test_sleep_is_a_state_rather_than_an_expression(self):
        # The kinds are not decoration: the frontend routes on them. Filed as an
        # expression, `[sleep]` would be adopted as a POSE — held for the rest of
        # the reply and then dropped when the turn ended, so she would wake up on
        # her own a sentence later. As a gesture it would play for a moment and
        # hand the face straight back. Only 'state' outlives the message.
        assert EMOTION_TAGS["sleep"] == "state"

    def test_tag_names_are_wire_safe(self):
        # The frontend keys its render registry off these verbatim.
        for tag in EMOTION_TAGS:
            assert tag == tag.lower().strip()
            assert " " not in tag and "-" not in tag


class TestStripping:
    def test_removes_tags_and_reports_where_they_landed(self):
        text, found = cues("[playful] Hello there. [thinking] Let me see.")
        assert text == "Hello there. Let me see."
        assert found == [(0, "playful", "expression"), (13, "thinking", "expression")]
        # The offset must index the word the cue belongs to, in the STRIPPED text.
        assert text[13:16] == "Let"

    def test_offset_points_at_the_first_character_spoken_under_the_cue(self):
        text, found = cues("One. [excited] Two.")
        assert text == "One. Two."
        assert text[found[0][0]:] == "Two."

    def test_gestures_carry_their_kind(self):
        _, found = cues("[nod] Absolutely.")
        assert found == [(0, "nod", "gesture")]

    def test_accepts_spelling_variants_an_llm_will_produce(self):
        for written in ("[brow_flash]", "[brow-flash]", "[Brow Flash]", "[BROW_FLASH]"):
            _, found = cues(f"{written} Right.")
            assert found == [(0, "brow_flash", "gesture")], written

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("Hello [happy] world", "Hello world"),      # tag between spaces
            ("Hello[happy] world", "Hello world"),        # tag hugs the word
            ("Hello [happy]world", "Hello world"),        # space only before
            ("[happy] Hello", "Hello"),                   # tag opens the message
            ("[happy] [nod] Sure.", "Sure."),             # adjacent tags
        ],
    )
    def test_never_leaves_a_double_space_behind(self, raw, expected):
        # A doubled space is not cosmetic: TTS renders it as a hesitation, and
        # it shifts every following offset by one.
        text, _ = cues(raw)
        assert text == expected
        assert "  " not in text


class TestUnknownBrackets:
    def test_drops_tag_shaped_hallucinations_rather_than_speaking_them(self):
        # An LLM writes [smiles] eventually. Reading it aloud as the word
        # "smiles" is the exact failure this feature exists to prevent.
        text, found = cues("[smiles] Good to see you. [laughs] Really.")
        assert text == "Good to see you. Really."
        assert found == []

    @pytest.mark.parametrize(
        "raw",
        [
            "As shown in [1] and [2].",
            "See [Fig. 2] for detail.",
            "The flag is [TODO] for now.",
            "The array [ is empty.",
            "Range [0, 1] inclusive.",
        ],
    )
    def test_leaves_genuine_brackets_alone(self, raw):
        text, found = cues(raw)
        assert text == raw
        assert found == []


class TestStreaming:
    def test_withholds_a_half_written_tag_so_it_never_flashes_on_screen(self):
        text, found = cues("Let me think. [thin")
        assert text == "Let me think. "
        assert found == []
        assert strip_emotion_tags("Let me think. [thin").held is True

    def test_releases_the_withheld_tag_once_the_bracket_closes(self):
        text, found = cues("Let me think. [thinking] About that.")
        assert text == "Let me think. About that."
        assert found == [(14, "thinking", "expression")]

    def test_an_ordinary_unmatched_bracket_is_not_withheld(self):
        # Otherwise a stray "[" would swallow the rest of the reply — it would
        # never be spoken, because no closing bracket is ever coming.
        assert strip_emotion_tags("the array [ is empty").held is False
        assert strip_emotion_tags("a [" + "x" * 40).held is False

    def test_final_chunk_flushes_rather_than_holding(self):
        # There is no next chunk to release it into.
        result = strip_emotion_tags("Done. [thin", allow_partial_hold=False)
        assert result.text == "Done. [thin"
        assert result.held is False

    def test_is_idempotent_over_the_accumulating_reply(self):
        # The caller re-runs this on the whole reply-so-far each chunk, which is
        # what keeps a tag split across a chunk boundary from being missed.
        full = "[playful] Sure thing. [nod] Done."
        streamed = []
        for i in range(1, len(full) + 1):
            r = strip_emotion_tags(full[:i], allow_partial_hold=(i < len(full)))
            streamed.append(r)
        final = streamed[-1]
        assert final.text == strip_emotion_tags(full).text
        assert [c.tag for c in final.cues] == ["playful", "nod"]

    @pytest.mark.parametrize(
        "full",
        [
            "Okay. [thinking] Hmm. [happy] Got it.",
            "[playful] Sure. [nod] Done.",
            "No tags here at all.",
            "Ends on a tag [happy]",
        ],
    )
    def test_published_text_only_ever_grows_while_streaming(self, full):
        # STRICTLY grows: every intermediate result must be a prefix of the next.
        # Text that shrinks retracts words already on screen, and the sentence
        # splitter reads a non-extending update as a new turn and re-speaks the
        # whole reply. The withhold is what guarantees this, right down to the
        # bare "[" that opens a tag — a chunk boundary lands there routinely.
        previous = ""
        for i in range(1, len(full) + 1):
            text = strip_emotion_tags(full[:i], allow_partial_hold=(i < len(full))).text
            assert text.startswith(previous), (
                f"text shrank at {i}: {previous!r} -> {text!r}"
            )
            previous = text


class TestEdges:
    def test_empty_input(self):
        result = strip_emotion_tags("")
        assert result.text == "" and result.cues == [] and result.held is False

    def test_text_with_no_tags_is_returned_untouched(self):
        raw = "Nothing to see here."
        assert strip_emotion_tags(raw).text == raw

    def test_a_trailing_tag_yields_a_cue_past_the_end(self):
        # Nothing is left to speak, so the cursor never reaches it and the face
        # never switches. Harmless, and cheaper than special-casing it.
        text, found = cues("Nice work! [happy]")
        assert text == "Nice work! "
        assert found[0][0] >= len(text.rstrip())
