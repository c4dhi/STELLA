"""The client-side half of the one-shot forced re-decode (#57):

- `redecode_utterance_audio` forwards the retained audio for ONE transcript
  id to `STTClient.redecode`, and only that id's audio (@sable, PR 750
  review: a stale or mismatched id must never reach for a different
  utterance's audio).
- The capture state machine (`_begin_utterance_capture` /
  `_end_utterance_capture` / `_accumulate_utterance_audio`) must not reset a
  resumed utterance's buffer (same transcript id, `speech_started` fires
  again out of MAYBE_ENDING), and must seed a genuinely new utterance with
  the rolling pre-roll so the onset isn't lost before the event's round trip.

A bare instance (``__new__`` + just the attributes each method touches) is
used rather than the full constructor, matching how this pipeline's other
collaborators test it elsewhere in this codebase: ``AudioPipeline`` pulls in
LiveKit/room wiring that a unit test for these methods should not need.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline


def _pipeline(redecode_return=None):
    p = AudioPipeline.__new__(AudioPipeline)
    p._capturing_utterance_audio = False
    p._utterance_audio_by_id = {}
    p._active_transcript_id = None
    p._utterance_audio_max_bytes = 1_000_000
    p._utterance_preroll_audio = bytearray()
    p._utterance_preroll_max_bytes = 16  # small, so tests can exercise the cap directly
    p._session_id = "s1"
    p._stt = MagicMock()
    p._stt.redecode = AsyncMock(return_value=redecode_return)
    p._room = MagicMock()
    p._room.audio_sample_rate = 48000
    return p


# ─────────────────────── redecode_utterance_audio ───────────────────────

@pytest.mark.asyncio
async def test_returns_none_when_nothing_was_retained_for_this_id():
    p = _pipeline()
    assert await p.redecode_utterance_audio("t1", "de") is None
    p._stt.redecode.assert_not_called()


@pytest.mark.asyncio
async def test_forwards_the_retained_audio_and_forced_language():
    p = _pipeline(redecode_return="hallo")
    p._utterance_audio_by_id["t1"] = bytearray(b"\x01\x02\x03\x04")
    text = await p.redecode_utterance_audio("t1", "de")
    assert text == "hallo"
    args, kwargs = p._stt.redecode.call_args
    assert args[0] == b"\x01\x02\x03\x04"
    assert args[1] == "de"
    assert kwargs["session_id"] == "s1"
    assert kwargs["sample_rate"] == 48000
    assert kwargs["timeout"] == 1.5  # short: #33/#59 care about shaving the stall


@pytest.mark.asyncio
async def test_returns_none_when_stt_cannot_force_decode():
    p = _pipeline(redecode_return=None)
    p._utterance_audio_by_id["t1"] = bytearray(b"\x01\x02")
    assert await p.redecode_utterance_audio("t1", "de") is None


@pytest.mark.asyncio
async def test_ignores_a_different_utterances_audio():
    # The exact bug being fixed: a turn asking for id "t1" must never be
    # answered with "t2"'s audio just because something is in a buffer.
    p = _pipeline(redecode_return="should not be returned")
    p._utterance_audio_by_id["t2"] = bytearray(b"\x09\x09")
    assert await p.redecode_utterance_audio("t1", "de") is None
    p._stt.redecode.assert_not_called()


@pytest.mark.asyncio
async def test_consumes_the_buffer_so_a_second_call_returns_none():
    p = _pipeline(redecode_return="hallo")
    p._utterance_audio_by_id["t1"] = bytearray(b"\x01\x02")
    assert await p.redecode_utterance_audio("t1", "de") == "hallo"
    assert await p.redecode_utterance_audio("t1", "de") is None


# ─────────────────────── capture state machine ───────────────────────

def test_a_new_utterance_starts_a_fresh_buffer_seeded_with_preroll():
    p = _pipeline()
    p._utterance_preroll_audio = bytearray(b"\xaa\xbb")
    p._begin_utterance_capture("t1")
    assert bytes(p._utterance_audio_by_id["t1"]) == b"\xaa\xbb"
    assert p._capturing_utterance_audio is True
    assert p._active_transcript_id == "t1"


def test_resuming_the_same_id_does_not_reset_the_buffer():
    # The actual bug: speech_started fires again on MAYBE_ENDING -> SPEAKING
    # (same transcript id). Resetting here would replace "Ich weiss nicht ...
    # vielleicht morgen" with "vielleicht morgen" alone on re-decode.
    p = _pipeline()
    p._begin_utterance_capture("t1")
    p._accumulate_utterance_audio(b"Ich weiss nicht ")
    p._end_utterance_capture()  # MAYBE_ENDING, not yet final
    p._begin_utterance_capture("t1")  # resumed: same id
    p._accumulate_utterance_audio(b"vielleicht morgen")
    p._end_utterance_capture()
    assert bytes(p._utterance_audio_by_id["t1"]) == b"Ich weiss nicht vielleicht morgen"


def test_a_genuinely_new_id_after_a_final_does_start_fresh():
    p = _pipeline()
    p._utterance_preroll_max_bytes = 0  # isolate from pre-roll seeding, tested separately
    p._begin_utterance_capture("t1")
    p._accumulate_utterance_audio(b"ja")
    p._end_utterance_capture()
    p._begin_utterance_capture("t2")
    p._accumulate_utterance_audio(b"nein")
    p._end_utterance_capture()
    assert bytes(p._utterance_audio_by_id["t1"]) == b"ja"
    assert bytes(p._utterance_audio_by_id["t2"]) == b"nein"


def test_audio_is_not_accumulated_once_capture_has_ended():
    p = _pipeline()
    p._begin_utterance_capture("t1")
    p._accumulate_utterance_audio(b"ja")
    p._end_utterance_capture()
    p._accumulate_utterance_audio(b"MORE AFTER FINAL")  # should be dropped for t1
    assert bytes(p._utterance_audio_by_id["t1"]) == b"ja"


def test_preroll_rolls_continuously_regardless_of_capture_state():
    p = _pipeline()
    p._utterance_preroll_max_bytes = 4
    for chunk in (b"ab", b"cd", b"ef"):
        p._accumulate_utterance_audio(chunk)
    assert bytes(p._utterance_preroll_audio) == b"cdef"  # oldest dropped, capped at 4


def test_old_unread_buffers_are_aged_out():
    p = _pipeline()
    for i in range(6):
        p._begin_utterance_capture(f"t{i}")
        p._end_utterance_capture()
    assert len(p._utterance_audio_by_id) <= 4
    assert "t5" in p._utterance_audio_by_id  # the most recent is never evicted
