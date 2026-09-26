"""End-to-end check of the driver against fake STT/TTS servers that share one 'GPU'.

The fake GPU is a lock: every decode and every synthesis step holds it for a
fixed time, so more sessions means longer queues, like a real shared model.
"""
import asyncio
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(__file__))
import load_test  # noqa: E402

TTS_RATE = 24000


def make_servers(stt_pb2, stt_grpc, tts_pb2, tts_grpc, decode_s, synth_s):
    gpu = asyncio.Lock()

    async def work(seconds):
        async with gpu:
            await asyncio.sleep(seconds)

    class Stt(stt_grpc.SpeechToTextServicer):
        async def HealthCheck(self, request, context):
            return stt_pb2.HealthResponse(healthy=True, model_status="fake")

        async def StreamTranscribe(self, request_iterator, context):
            speaking = False
            quiet = 0
            async for chunk in request_iterator:
                loud = np.abs(np.frombuffer(chunk.audio_data, dtype=np.int16)).mean() > 200
                if loud:
                    quiet = 0
                    if not speaking:
                        speaking = True
                        yield stt_pb2.TranscriptEvent(speech_started=True)
                elif speaking:
                    quiet += 1
                    if quiet == 20:  # 400 ms of silence ends the utterance
                        await work(decode_s)
                        speaking = False
                        yield stt_pb2.TranscriptEvent(text="hello", is_final=True)

    class Tts(tts_grpc.TextToSpeechServicer):
        def _audio(self, seconds):
            t = np.arange(int(TTS_RATE * seconds)) / TTS_RATE
            return (np.sin(2 * np.pi * 220 * t) * 8000).astype(np.int16).tobytes()

        async def HealthCheck(self, request, context):
            return tts_pb2.HealthResponse(healthy=True, provider="fake")

        async def Synthesize(self, request, context):
            return tts_pb2.SynthesizeResponse(audio_data=self._audio(2.0), sample_rate=TTS_RATE, duration_ms=2000)

        async def SynthesizeStream(self, request, context):
            for i in range(4):
                await work(synth_s)
                yield tts_pb2.AudioChunk(audio_data=self._audio(0.5), chunk_index=i, is_final=i == 3)

    return Stt(), Tts()


async def serve(decode_s, synth_s):
    import grpc

    load_test.build_stubs()
    import stt_pb2, stt_pb2_grpc, tts_pb2, tts_pb2_grpc  # noqa: E401

    stt, tts = make_servers(stt_pb2, stt_pb2_grpc, tts_pb2, tts_pb2_grpc, decode_s, synth_s)
    server = grpc.aio.server()
    stt_pb2_grpc.add_SpeechToTextServicer_to_server(stt, server)
    tts_pb2_grpc.add_TextToSpeechServicer_to_server(tts, server)
    port = server.add_insecure_port("127.0.0.1:0")
    await server.start()
    return server, f"127.0.0.1:{port}"


def args_for(addr, levels):
    return load_test.parse_args([
        "--stt", addr, "--tts", addr, "--levels", ",".join(map(str, levels)), "--duration", "9",
        "--turn-gap", "3", "--settle", "0", "--gpu-name", "Fake GPU", "--stt-slack-ms", "300", "--ttfa-slack-ms", "300",
        "--sentence", "one", "--sentence", "two",
    ])


@pytest.mark.asyncio
async def test_a_fast_shared_gpu_reaches_the_top_level():
    server, addr = await serve(decode_s=0.01, synth_s=0.01)
    try:
        result = await load_test.main_async(args_for(addr, [1, 3]))
    finally:
        await server.stop(0)
    assert result["gpuName"] == "Fake GPU"
    assert result["maxSessions"] == 3 and result["reachedTopLevel"]
    assert result["levels"][0]["stt_utterances"] >= 1
    assert result["levels"][0]["stt_finals_missed"] == 0


@pytest.mark.asyncio
async def test_a_slow_shared_gpu_is_found_to_degrade_and_the_run_stops():
    # Each decode holds the GPU 0.5 s: three sessions queue behind each other.
    server, addr = await serve(decode_s=0.5, synth_s=0.3)
    try:
        result = await load_test.main_async(args_for(addr, [1, 2, 8, 16]))
    finally:
        await server.stop(0)
    assert not result["reachedTopLevel"]
    assert result["maxSessions"] < 16
    assert result["limitedBy"]
    assert len(result["levels"]) < 4  # stopped at the first degraded level
