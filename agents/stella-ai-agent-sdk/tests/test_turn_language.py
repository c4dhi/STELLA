"""Each user turn's language signal, kept with its message (#91).

The agent publishes one ``turn_language`` envelope per turn, after it has
resolved the language; the backend merges it into the stored transcript
message's metadata. These tests pin what goes in it:

- a free-decoded spoken turn carries STT's own signal, the turn's speech
  length and word count, and the language the conversation is in after it;
- a re-decoded turn says so, and still counts the words of the ORIGINAL free
  decode (the one the signal belongs to);
- typed text has no acoustic signal and no duration.

No transcript text is ever part of the record.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline
from stella_agent_sdk.language import turn_language_record
from stella_agent_sdk.services.stt_client import TranscriptEvent


def test_free_decoded_spoken_turn():
    record = turn_language_record(
        {"turn_id": "whisper_1", "detected_language": "de", "language_confidence": 0.9734},
        original_text="Ich gehe heute spazieren",
        resolved_language="de",
        redecoded=False,
        duration_s=1.8349,
    )
    assert record == {
        "transcript_id": "whisper_1",
        "detected_language": "de",
        "language_confidence": 0.973,
        "duration_s": 1.83,
        "word_count": 4,
        "resolved_language": "de",
        "redecoded": False,
    }


def test_redecoded_turn_counts_the_original_words():
    record = turn_language_record(
        {"turn_id": "whisper_2", "detected_language": "en", "language_confidence": 0.41},
        original_text="Yeah",
        resolved_language="de",
        redecoded=True,
        duration_s=0.52,
    )
    assert record["detected_language"] == "en"
    assert record["resolved_language"] == "de"
    assert record["redecoded"] is True
    assert record["word_count"] == 1


def test_typed_text_has_no_acoustic_signal_or_duration():
    record = turn_language_record(
        {"turn_id": "typed_3"},
        original_text="Guten Morgen zusammen",
        resolved_language="de",
        redecoded=False,
        duration_s=None,
    )
    assert record == {
        "transcript_id": "typed_3",
        "detected_language": None,
        "language_confidence": None,
        "duration_s": None,
        "word_count": 3,
        "resolved_language": "de",
        "redecoded": False,
    }


def test_no_record_without_a_turn_id():
    # Nothing to attach it to: an agent-opened turn, or a path with no id.
    assert turn_language_record({}, original_text="", resolved_language="en",
                                redecoded=False, duration_s=None) is None


# ── Speech length, from the pipeline's own VAD boundaries ────────────────────

def _bare_pipeline():
    p = AudioPipeline.__new__(AudioPipeline)
    p._speech_span_by_id = {}
    p._room = MagicMock()
    p._room.publish_data = AsyncMock()
    return p


def _event(tid, **flags):
    return TranscriptEvent(text="", is_final=False, transcript_id=tid, participant_id="human",
                           confidence=0.0, timestamp_ms=0, **flags)


def test_speech_length_spans_first_start_to_last_end():
    p = _bare_pipeline()
    p._note_speech_span(_event("t1", speech_started=True), now=10.0)
    p._note_speech_span(_event("t1", speech_ended=True), now=11.2)
    # A pause inside one utterance: the same id starts again.
    p._note_speech_span(_event("t1", speech_started=True), now=11.5)
    p._note_speech_span(_event("t1", speech_ended=True), now=12.4)
    assert p.utterance_speech_seconds("t1") == pytest.approx(2.4)


def test_speech_length_unknown_without_both_boundaries():
    p = _bare_pipeline()
    p._note_speech_span(_event("t2", speech_started=True), now=1.0)
    assert p.utterance_speech_seconds("t2") is None
    assert p.utterance_speech_seconds("never-seen") is None
    assert p.utterance_speech_seconds(None) is None


def test_speech_spans_are_bounded():
    p = _bare_pipeline()
    for i in range(20):
        p._note_speech_span(_event(f"t{i}", speech_started=True), now=float(i))
    assert len(p._speech_span_by_id) <= 8
    assert "t19" in p._speech_span_by_id


@pytest.mark.asyncio
async def test_publishes_one_turn_language_envelope():
    p = _bare_pipeline()
    record = {"transcript_id": "t1", "resolved_language": "de"}
    await p.publish_turn_language(record)
    p._room.publish_data.assert_awaited_once_with({"type": "turn_language", "data": record})


def test_typed_text_carries_the_frontend_correlation_id():
    # A typed message is stored by the frontend's own envelope, which has no
    # transcript id the agent knows, only its correlation_id: that is what
    # the backend matches a typed turn's record on.
    record = turn_language_record(
        {"turn_id": "uuid-from-sdk"},
        original_text="hallo",
        resolved_language="de",
        redecoded=False,
        duration_s=None,
        correlation_id="corr-1",
    )
    assert record["transcript_id"] == "uuid-from-sdk"
    assert record["correlation_id"] == "corr-1"


def test_pipeline_remembers_a_typed_turns_correlation_id():
    p = _bare_pipeline()
    p._typed_correlation_by_id = {}
    p._note_typed_correlation("uuid-1", "corr-1")
    p._note_typed_correlation("uuid-2", None)
    assert p.typed_correlation_id("uuid-1") == "corr-1"
    assert p.typed_correlation_id("uuid-2") is None
    for i in range(20):
        p._note_typed_correlation(f"u{i}", f"c{i}")
    assert len(p._typed_correlation_by_id) <= 8
