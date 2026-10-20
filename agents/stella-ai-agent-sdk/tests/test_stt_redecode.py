"""STTClient.redecode: the SDK side of the one-shot forced re-decode (#57).

Thin wrapper tests only — the actual decode behaviour is stt-service's own
(tests there). What matters here is that the client builds the right request,
never raises out of a failure, and treats "no result" and "not connected" the
same way (None — caller keeps its original text).
"""

from unittest.mock import AsyncMock, MagicMock

import pytest

from stella_agent_sdk.services.stt_client import STTClient


def _connected_client(stub_response=None, stub_side_effect=None):
    client = STTClient("stt-service:50051")
    client._connected = True
    client._pb2 = MagicMock()
    client._pb2.RedecodeRequest = lambda **kw: kw  # identity: just inspect kwargs
    client._stub = MagicMock()
    if stub_side_effect is not None:
        client._stub.Redecode = AsyncMock(side_effect=stub_side_effect)
    else:
        client._stub.Redecode = AsyncMock(return_value=stub_response)
    return client


@pytest.mark.asyncio
async def test_redecode_returns_text_from_the_response():
    response = MagicMock(text="hallo wie geht es dir")
    client = _connected_client(stub_response=response)
    text = await client.redecode(b"\x00\x00", "de", session_id="s1")
    assert text == "hallo wie geht es dir"


@pytest.mark.asyncio
async def test_redecode_sends_the_forced_language_and_audio():
    response = MagicMock(text="ok")
    client = _connected_client(stub_response=response)
    await client.redecode(b"\x01\x02", "de", session_id="s1", sample_rate=16000)
    sent_request = client._stub.Redecode.call_args[0][0]
    assert sent_request["language"] == "de"
    assert sent_request["audio_data"] == b"\x01\x02"
    assert sent_request["session_id"] == "s1"


@pytest.mark.asyncio
async def test_redecode_returns_none_on_empty_text():
    response = MagicMock(text="")
    client = _connected_client(stub_response=response)
    assert await client.redecode(b"\x00", "de") is None


@pytest.mark.asyncio
async def test_redecode_returns_none_when_not_connected():
    client = STTClient("stt-service:50051")
    assert await client.redecode(b"\x00", "de") is None


@pytest.mark.asyncio
async def test_redecode_swallows_rpc_errors():
    client = _connected_client(stub_side_effect=RuntimeError("boom"))
    assert await client.redecode(b"\x00", "de") is None


@pytest.mark.asyncio
async def test_redecode_times_out_cleanly():
    import asyncio

    async def _hang(*args, **kwargs):
        await asyncio.sleep(10)

    client = _connected_client(stub_side_effect=_hang)
    assert await client.redecode(b"\x00", "de", timeout=0.05) is None
