"""Proves the Redecode RPC's wiring end-to-end — real grpc.aio server, real
client stub, real proto serialization — with a fake provider standing in for
Whisper (@zenith, #57 ref 331ff2f6: "make sure one test sends the new
re-decode RPC through the real stt_server gRPC path with a fake provider, so
the wiring is proven without Whisper").

Unit tests elsewhere already cover WhisperProvider.redecode() itself
(test_redecode.py) and the SDK client's request-building (test_stt_redecode.py
in the SDK). What neither proves is that `stt_server.py`'s servicer, the
compiled proto stubs, and an actual network round trip agree on the shape of
a RedecodeRequest/RedecodeResponse — that's what's at stake if, say, a field
number drifted between the two committed copies of stt.proto (the SDK's and
stt-service's own).

Plain `asyncio.run(...)` inside ordinary (sync) test functions, matching this
directory's existing convention (test_redecode.py) rather than pulling in
pytest-asyncio's fixture machinery, which nothing here is configured for.
"""

import asyncio
import contextlib
import sys
from pathlib import Path

import grpc

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import stt_pb2  # noqa: E402
import stt_pb2_grpc  # noqa: E402
from stt_server import SpeechToTextServicer  # noqa: E402


class _FakeProvider:
    """Stands in for WhisperProvider: records what it was asked to redecode,
    answers deterministically, never touches a real model."""

    def __init__(self):
        self.calls = []

    async def redecode(self, audio_data: bytes, language: str, sample_rate: int = 16000):
        self.calls.append({"audio_data": audio_data, "language": language, "sample_rate": sample_rate})
        if not audio_data:
            return None
        return f"[forced-{language}] decoded {len(audio_data)} bytes"


class _BoomProvider:
    async def redecode(self, *a, **k):
        raise RuntimeError("model exploded")


class _FakeEngine:
    provider_name = "fake"

    def __init__(self, provider):
        self.provider = provider


@contextlib.asynccontextmanager
async def _running_server(provider):
    """A real grpc.aio server + client stub, wired to the given provider."""
    server = grpc.aio.server()
    stt_pb2_grpc.add_SpeechToTextServicer_to_server(
        SpeechToTextServicer(_FakeEngine(provider)), server
    )
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    channel = grpc.aio.insecure_channel(f"127.0.0.1:{port}")
    try:
        yield stt_pb2_grpc.SpeechToTextStub(channel)
    finally:
        await channel.close()
        await server.stop(None)


def test_redecode_rpc_round_trips_through_the_real_server():
    provider = _FakeProvider()

    async def _run():
        async with _running_server(provider) as stub:
            request = stt_pb2.RedecodeRequest(
                audio_data=b"\x01\x02\x03\x04",
                session_id="s1",
                language="de",
                sample_rate=16000,
            )
            return await stub.Redecode(request)

    response = asyncio.run(_run())
    assert response.text == "[forced-de] decoded 4 bytes"
    # The servicer must pass the request through unchanged -- forced language
    # and raw bytes both arrive at the provider exactly as sent over the wire.
    assert provider.calls == [{"audio_data": b"\x01\x02\x03\x04", "language": "de", "sample_rate": 16000}]


def test_redecode_rpc_defaults_sample_rate_when_unset():
    provider = _FakeProvider()

    async def _run():
        async with _running_server(provider) as stub:
            request = stt_pb2.RedecodeRequest(audio_data=b"\xaa\xbb", session_id="s1", language="en")
            await stub.Redecode(request)

    asyncio.run(_run())
    assert provider.calls[0]["sample_rate"] == 16000


def test_redecode_rpc_returns_empty_text_when_provider_cannot_force_decode():
    provider = _FakeProvider()

    async def _run():
        async with _running_server(provider) as stub:
            request = stt_pb2.RedecodeRequest(audio_data=b"", session_id="s1", language="de")
            return await stub.Redecode(request)

    response = asyncio.run(_run())
    assert response.text == ""


def test_redecode_rpc_survives_a_provider_exception():
    """A provider error must come back as an empty response, not kill the
    stream the way an unhandled exception in a servicer method would."""

    async def _run():
        async with _running_server(_BoomProvider()) as stub:
            request = stt_pb2.RedecodeRequest(audio_data=b"\x01", session_id="s1", language="de")
            return await stub.Redecode(request)

    response = asyncio.run(_run())
    assert response.text == ""
