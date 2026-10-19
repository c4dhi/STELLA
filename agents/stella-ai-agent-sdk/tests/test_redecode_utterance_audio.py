"""AudioPipeline.redecode_utterance_audio: the client-side half of the one-shot
forced re-decode (#57) — forwarding the retained utterance audio to STTClient,
and declining safely when there is nothing retained.

A bare instance (``__new__`` + just the attributes this method touches) is
used rather than the full constructor, matching how this pipeline's other
collaborators test it elsewhere in this codebase: ``AudioPipeline`` pulls in
LiveKit/room wiring that a unit test for one method should not need.
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from stella_agent_sdk.audio.pipeline import AudioPipeline


def _pipeline(utterance_audio: bytes = b"", redecode_return=None):
    p = AudioPipeline.__new__(AudioPipeline)
    p._utterance_audio = bytearray(utterance_audio)
    p._session_id = "s1"
    p._stt = MagicMock()
    p._stt.redecode = AsyncMock(return_value=redecode_return)
    p._room = MagicMock()
    p._room.audio_sample_rate = 48000
    return p


@pytest.mark.asyncio
async def test_returns_none_when_nothing_was_retained():
    p = _pipeline(utterance_audio=b"")
    assert await p.redecode_utterance_audio("de") is None
    p._stt.redecode.assert_not_called()


@pytest.mark.asyncio
async def test_forwards_the_retained_audio_and_forced_language():
    p = _pipeline(utterance_audio=b"\x01\x02\x03\x04", redecode_return="hallo")
    text = await p.redecode_utterance_audio("de")
    assert text == "hallo"
    p._stt.redecode.assert_awaited_once()
    _, kwargs = p._stt.redecode.call_args
    args = p._stt.redecode.call_args[0]
    assert args[0] == b"\x01\x02\x03\x04"
    assert args[1] == "de"
    assert kwargs["session_id"] == "s1"
    assert kwargs["sample_rate"] == 48000


@pytest.mark.asyncio
async def test_returns_none_when_stt_cannot_force_decode():
    # The lightweight dev provider has no language steering (see
    # providers.base.STTProvider.redecode) and STTClient.redecode already
    # turns that into None — this just confirms the pipeline passes it through
    # rather than inventing a fallback text of its own.
    p = _pipeline(utterance_audio=b"\x01\x02", redecode_return=None)
    assert await p.redecode_utterance_audio("de") is None
