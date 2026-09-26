#!/usr/bin/env python3
"""Load test: how many simultaneous voice sessions does one GPU carry?

Simulates N conversations against the speech-to-text and text-to-speech services
(the two services that share the GPU): each simulated session keeps one
streaming STT connection open, speaks a recorded utterance into it in real time,
and asks the TTS service for a spoken reply on the same cadence a conversation
has. N goes up level by level; the first level where the voice slows or stutters
ends the run and the level before it is the measured capacity.

Not covered: the LLM, LiveKit and the agent process. Those cost CPU and network,
not this GPU, so a server with a bigger GPU can still be limited elsewhere.

    python load_test.py --stt localhost:50051 --tts localhost:50052 \
        --levels 1,2,4,6,8 --duration 60 --output result.json

Reach the services with `kubectl port-forward` or run this inside the cluster.
Read the README beside this file first.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from analysis import Criteria, LevelResult, find_capacity, playout_starvation  # noqa: E402

STT_RATE = 16000
CHUNK_MS = 20  # what a LiveKit frame carries
DEFAULT_SENTENCES = [
    "Hello, I would like to talk about how my week has been going so far.",
    "Well, I mostly worked from home, and in the evenings I went for a long walk by the lake.",
    "That sounds nice. I think the hardest part was keeping a regular routine.",
]


def build_stubs() -> Path:
    """Generate the gRPC stubs from proto/ into a temp dir and put it on sys.path."""
    out = Path(tempfile.mkdtemp(prefix="stella-loadtest-stubs-"))
    root = HERE.parent.parent
    # The services' own copies: they are what each service is built from, and the
    # TTS one carries RPCs (Warmup) the shared proto/ copy lacks.
    protos = [root / "stt-service" / "proto" / "stt.proto", root / "tts-service" / "proto" / "tts.proto"]
    subprocess.run(
        [sys.executable, "-m", "grpc_tools.protoc", *[f"-I{p.parent}" for p in protos],
         f"--python_out={out}", f"--grpc_python_out={out}", *map(str, protos)],
        check=True,
    )
    sys.path.insert(0, str(out))
    return out


def gpu_info() -> dict:
    """GPU name and memory from nvidia-smi on this machine, if it has one."""
    if not shutil.which("nvidia-smi"):
        return {}
    try:
        line = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            text=True, timeout=10,
        ).splitlines()[0]
        name, mem = [p.strip() for p in line.split(",")]
        return {"name": name, "memory_mb": int(float(mem))}
    except Exception:
        return {}


class GpuSampler:
    """Samples utilisation and memory once a second while a level runs."""

    def __init__(self, command_prefix: list[str]):
        self.prefix = command_prefix
        self.util: list[float] = []
        self.mem: list[float] = []
        self._task: Optional[asyncio.Task] = None

    async def _run(self):
        cmd = self.prefix + ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used",
                             "--format=csv,noheader,nounits"]
        while True:
            try:
                proc = await asyncio.create_subprocess_exec(
                    *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
                out, _ = await proc.communicate()
                u, m = out.decode().splitlines()[0].split(",")
                self.util.append(float(u))
                self.mem.append(float(m))
            except Exception:
                pass
            await asyncio.sleep(1.0)

    def start(self):
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass


def resample_to_16k(pcm16: bytes, rate: int) -> bytes:
    """Linear resample; good enough to drive a decoder, not for listening."""
    if rate == STT_RATE:
        return pcm16
    x = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32)
    n = int(len(x) * STT_RATE / rate)
    y = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)
    return y.astype(np.int16).tobytes()


class Session:
    """One simulated conversation, turn by turn like a real one.

    The participant speaks an utterance; speech recognition returns the final
    transcript; the agent answers with a spoken reply; the participant pauses and
    speaks again. Within a session the two never overlap, so any slowdown comes
    from other sessions sharing the GPU, which is the thing being measured.
    """

    FINAL_TIMEOUT_S = 30.0

    def __init__(self, idx, utterances, tts_text, stt_stub, tts_stub, tts_rate, args, result, stubs):
        self.idx = idx
        self.utterances = utterances
        self.tts_text = tts_text
        self.stt = stt_stub
        self.tts = tts_stub
        self.tts_rate = tts_rate
        self.args = args
        self.r = result
        self.stt_pb2, self.tts_pb2 = stubs
        self.sid = f"loadtest-{idx}-{int(time.time())}"
        self.frames: list[bytes] = []  # audio waiting to be sent (an utterance), else silence goes out
        self.finals: list[float] = []  # arrival times of finals since the current turn began
        self.final_arrived = asyncio.Event()
        self.stop = asyncio.Event()  # no new turns
        self.done = asyncio.Event()  # close the streams

    async def _audio_stream(self):
        """Real-time 20 ms frames: silence, except while an utterance is queued."""
        frame = STT_RATE * CHUNK_MS // 1000 * 2
        silence = bytes(frame)
        next_tick = time.monotonic()
        while not self.done.is_set():
            piece = self.frames.pop(0) if self.frames else silence
            yield self.stt_pb2.AudioChunk(
                audio_data=piece, session_id=self.sid, participant_id="loadtest",
                timestamp_ms=int(time.time() * 1000), sample_rate=STT_RATE)
            next_tick += CHUNK_MS / 1000.0
            delay = next_tick - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)

    async def run_stt(self):
        last_partial = None
        try:
            async for ev in self.stt.StreamTranscribe(self._audio_stream()):
                now = time.monotonic()
                if ev.is_final:
                    self.finals.append(now)
                    self.final_arrived.set()
                    last_partial = None
                elif ev.text.strip():
                    if last_partial is not None:
                        self.r.stt_partial_gap_s.append(now - last_partial)
                    last_partial = now
        except Exception as e:  # noqa: BLE001
            if not self.done.is_set():
                self.r.errors += 1
                print(f"  [session {self.idx}] STT error: {e}", file=sys.stderr)

    async def _speak(self, utterance: bytes) -> float:
        """Queue the utterance and return when its last frame has gone out."""
        frame = STT_RATE * CHUNK_MS // 1000 * 2
        pieces = [utterance[i:i + frame].ljust(frame, b"\0") for i in range(0, len(utterance), frame)]
        self.finals.clear()
        self.final_arrived.clear()
        self.frames.extend(pieces)
        while self.frames:
            await asyncio.sleep(CHUNK_MS / 1000.0)
        return time.monotonic()

    async def _final_after(self, eos: float):
        """Arrival time of the first final after the end of speech, or None on timeout."""
        deadline = eos + self.FINAL_TIMEOUT_S
        while True:
            late = [t for t in self.finals if t > eos]
            if late:
                return late[0]
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            self.final_arrived.clear()
            try:
                await asyncio.wait_for(self.final_arrived.wait(), remaining)
            except asyncio.TimeoutError:
                return None

    async def _reply(self):
        start = time.monotonic()
        chunks: list[tuple[float, float]] = []
        try:
            req = self.tts_pb2.SynthesizeRequest(text=self.tts_text, session_id=self.sid)
            first = None
            async for ch in self.tts.SynthesizeStream(req):
                now = time.monotonic()
                if ch.audio_data:
                    if first is None:
                        first = now
                        self.r.tts_ttfa_s.append(now - start)
                    chunks.append((now, len(ch.audio_data) / 2 / self.tts_rate))
        except Exception as e:  # noqa: BLE001
            self.r.errors += 1
            print(f"  [session {self.idx}] TTS error: {e}", file=sys.stderr)
        starved, audio = playout_starvation(chunks, self.args.preroll_ms / 1000.0)
        self.r.tts_starved_s += starved
        self.r.tts_audio_s += audio
        # The reply takes as long to play as it is long; the participant waits for it.
        await asyncio.sleep(max(0.0, audio - (time.monotonic() - start)))

    async def run_turns(self):
        await asyncio.sleep(random.uniform(0, self.args.turn_gap))  # stagger the sessions
        turn = 0
        while not self.stop.is_set():
            eos = await self._speak(self.utterances[turn % len(self.utterances)])
            turn += 1
            self.r.stt_utterances += 1
            final_at = await self._final_after(eos)
            # Finals before the end of speech (a pause inside the sentence, or the late final
            # of the previous turn) are not this turn's final: count them apart.
            self.r.stt_early_finals += sum(1 for t in self.finals if t <= eos)
            if final_at is None:
                self.r.stt_finals_missed += 1
            else:
                self.r.stt_final_s.append(final_at - eos)
            await self._reply()
            try:
                await asyncio.wait_for(self.stop.wait(), self.args.turn_gap)
            except asyncio.TimeoutError:
                pass


async def run_level(n, args, ctx) -> LevelResult:
    import grpc

    result = LevelResult(sessions=n)
    sampler = GpuSampler(args.gpu_command)
    if ctx["gpu"]:
        sampler.start()
    stt_chan = grpc.aio.insecure_channel(args.stt)
    tts_chan = grpc.aio.insecure_channel(args.tts)
    stt_stub = ctx["stt_grpc"].SpeechToTextStub(stt_chan)
    tts_stub = ctx["tts_grpc"].TextToSpeechStub(tts_chan)
    sessions = [
        Session(i, ctx["utterances"], ctx["reply"], stt_stub, tts_stub, ctx["tts_rate"], args, result,
                (ctx["stt_pb2"], ctx["tts_pb2"]))
        for i in range(n)
    ]
    tasks = [asyncio.create_task(s.run_stt()) for s in sessions] + \
            [asyncio.create_task(s.run_turns()) for s in sessions]
    await asyncio.sleep(args.duration)
    # No new turns; let the turn each session is in finish, then close the streams.
    for s in sessions:
        s.stop.set()
    turns = tasks[len(sessions):]
    await asyncio.wait(turns, timeout=args.drain)
    for s in sessions:
        s.done.set()
    await asyncio.sleep(0.3)
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await sampler.stop()
    await stt_chan.close()
    await tts_chan.close()
    if sampler.util:
        result.gpu_util_avg = round(sum(sampler.util) / len(sampler.util), 1)
        result.gpu_util_max = max(sampler.util)
        result.gpu_mem_max_mb = max(sampler.mem)
    return result


async def prepare(args, stubs):
    """Synthesize the test utterances once, so every session speaks the same audio."""
    import grpc

    stt_pb2, tts_pb2, stt_grpc, tts_grpc = stubs
    # Warm both models first: a cold Whisper or TTS stalls every stream for tens
    # of seconds, which would make the one-session baseline meaningless.
    async with grpc.aio.insecure_channel(args.stt) as ch:
        try:
            w = await stt_grpc.SpeechToTextStub(ch).Warmup(stt_pb2.WarmupRequest(session_id="loadtest"), timeout=180)
            print(f"STT warmup: {w.warmup_time_ms} ms")
        except Exception as e:  # noqa: BLE001
            print(f"STT warmup skipped: {e}")
    async with grpc.aio.insecure_channel(args.tts) as ch:
        try:
            w = await tts_grpc.TextToSpeechStub(ch).Warmup(tts_pb2.WarmupRequest(session_id="loadtest"), timeout=180)
            print(f"TTS warmup: {w.warmup_time_ms} ms")
        except Exception as e:  # noqa: BLE001
            print(f"TTS warmup skipped: {e}")
    async with grpc.aio.insecure_channel(args.tts) as ch:
        stub = tts_grpc.TextToSpeechStub(ch)
        health = await stub.HealthCheck(tts_pb2.Empty(), timeout=30)
        print(f"TTS provider: {health.provider}")
        utterances = []
        rate = 0
        for text in args.sentence or DEFAULT_SENTENCES:
            resp = await stub.Synthesize(tts_pb2.SynthesizeRequest(text=text, session_id="loadtest-prep"), timeout=180)
            rate = resp.sample_rate or 24000
            utterances.append(resample_to_16k(resp.audio_data, rate))
    async with grpc.aio.insecure_channel(args.stt) as ch:
        h = await stt_grpc.SpeechToTextStub(ch).HealthCheck(stt_pb2.Empty(), timeout=30)
        print(f"STT status: {h.model_status}")
    return {"utterances": utterances, "tts_rate": rate, "reply": (args.reply or DEFAULT_SENTENCES[1]),
            "stt_pb2": stt_pb2, "tts_pb2": tts_pb2, "stt_grpc": stt_grpc, "tts_grpc": tts_grpc}


def git_rev() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=HERE, text=True).strip()
    except Exception:
        return ""


async def main_async(args) -> dict:
    build_stubs()
    import stt_pb2, stt_pb2_grpc, tts_pb2, tts_pb2_grpc  # noqa: E401

    ctx = await prepare(args, (stt_pb2, tts_pb2, stt_pb2_grpc, tts_pb2_grpc))
    ctx["gpu"] = bool(args.gpu_command) or bool(shutil.which("nvidia-smi"))
    criteria = Criteria(stt_final_slack_ms=args.stt_slack_ms, tts_ttfa_slack_ms=args.ttfa_slack_ms,
                        max_tts_starved_pct=args.max_starved_pct, preroll_ms=args.preroll_ms)
    levels: list[dict] = []
    if args.settle > 0:
        print(f"Settling for {args.settle:.0f}s (not measured) ...", flush=True)
        settle = argparse.Namespace(**{**vars(args), "duration": int(args.settle)})
        await run_level(args.levels[0], settle, ctx)
    for n in args.levels:
        print(f"Level: {n} simultaneous session(s) for {args.duration}s ...", flush=True)
        r = (await run_level(n, args, ctx)).summary()
        levels.append(r)
        print("  " + json.dumps(r), flush=True)
        cap = find_capacity(levels, criteria)
        if cap["limited_by"]:
            print(f"  degraded: {'; '.join(cap['limited_by'])}", flush=True)
            if not args.keep_going:
                break
    cap = find_capacity(levels, criteria)
    gpu = args.gpu_name and {"name": args.gpu_name} or gpu_info()
    return {
        "measuredAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "gpuName": gpu.get("name") or args.gpu_name or "unknown",
        "gpuMemoryMb": gpu.get("memory_mb"),
        "sttProvider": args.stt_provider,
        "ttsProvider": args.tts_provider,
        "environment": args.environment,
        "gitRevision": git_rev(),
        "maxSessions": cap["sessions"],
        "limitedBy": cap["limited_by"],
        "reachedTopLevel": not cap["limited_by"],
        "criteria": criteria.__dict__,
        "durationSeconds": args.duration,
        "levels": levels,
    }


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--stt", default="localhost:50051", help="STT gRPC address")
    p.add_argument("--tts", default="localhost:50052", help="TTS gRPC address")
    p.add_argument("--levels", type=lambda s: [int(x) for x in s.split(",")], default=[1, 2, 4, 6, 8, 10],
                   help="simultaneous sessions per level, ascending; the first is the baseline")
    p.add_argument("--duration", type=int, default=60, help="seconds per level")
    p.add_argument("--turn-gap", type=float, default=2.0, help="seconds a participant pauses after the reply, before speaking again")
    p.add_argument("--drain", type=float, default=45.0, help="seconds to let each session finish the turn it is in after the run")
    p.add_argument("--keep-going", action="store_true", help="run every level even after one degrades")
    p.add_argument("--stt-slack-ms", type=float, default=1000.0, dest="stt_slack_ms")
    p.add_argument("--ttfa-slack-ms", type=float, default=1000.0, dest="ttfa_slack_ms")
    p.add_argument("--max-starved-pct", type=float, default=5.0)
    p.add_argument("--preroll-ms", type=float, default=200.0,
                   help="player pre-roll when judging starvation; use the deployment's STELLA_TTS_PREROLL_MS")
    p.add_argument("--settle", type=float, default=15.0, help="seconds of unmeasured load before the first level")
    p.add_argument("--sentence", action="append", help="utterance the simulated participant speaks (repeatable)")
    p.add_argument("--reply", help="text the agent's TTS reply speaks")
    p.add_argument("--gpu-name", help="GPU model when this machine has none (e.g. the GPU is on the server)")
    p.add_argument("--gpu-command", nargs="*", default=[],
                   help="prefix that runs nvidia-smi on the GPU host, e.g. --gpu-command ssh myserver")
    p.add_argument("--stt-provider", default="")
    p.add_argument("--tts-provider", default="")
    p.add_argument("--environment", default="development", help="label stored with the result")
    p.add_argument("--output", type=Path, help="write the result JSON here")
    p.add_argument("--publish-url", help="backend base URL, e.g. https://api.example/api; posts the result")
    args = p.parse_args(argv)
    if args.levels != sorted(args.levels) or len(args.levels) < 2:
        p.error("--levels must ascend and have at least two entries (the first is the baseline)")
    return args


def publish(result: dict, url: str):
    import urllib.error
    import urllib.request

    token = os.environ.get("STELLA_ADMIN_TOKEN")
    if not token:
        sys.exit("Set STELLA_ADMIN_TOKEN to a system admin's token to publish.")
    req = urllib.request.Request(
        url.rstrip("/") + "/admin/capacity", data=json.dumps(result).encode(), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print(f"Published: HTTP {resp.status}")
    except urllib.error.HTTPError as e:
        sys.exit(f"Publish failed: HTTP {e.code} {e.read().decode(errors='replace')[:500]}")


def main():
    args = parse_args()
    result = asyncio.run(main_async(args))
    text = json.dumps(result, indent=2)
    print(text)
    if args.output:
        args.output.write_text(text + "\n")
    if args.publish_url:
        publish(result, args.publish_url)


if __name__ == "__main__":
    main()
