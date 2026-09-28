# Voice load test

How many conversations at once does one server's GPU carry before the voice
slows down or stutters? `load_test.py` finds out by raising the number of
simulated simultaneous sessions level by level (default 1, 2, 4, 6, 8, 10)
until one degrades. The level before it is the measured capacity.

## What a simulated session does

Each session holds one streaming speech-recognition (STT) connection open and
plays a conversation turn by turn: the participant speaks a recorded utterance
in real time (20 ms frames, like a LiveKit participant), speech recognition
returns the final transcript, the agent answers with a spoken reply from the
text-to-speech (TTS) service, the participant pauses and speaks again. Within a
session the two never overlap, so a slowdown comes from other sessions sharing
the GPU. Sessions start at random offsets, so they overlap the way real ones do.
Both models are warmed up first and the first level is preceded by an unmeasured
settling period. The test audio is synthesized once by the TTS service under
test and resampled to 16 kHz, so it needs no audio files and any provider works.

Not covered: the LLM, LiveKit and the agent process. They cost CPU and network,
not the GPU. A bigger GPU can still be limited elsewhere.

## What "degraded" means

A level fails when any of these is true (all tunable):

| Measure | Fails when |
| --- | --- |
| Speech recognition: end of speech to final transcript, p95 | more than 1000 ms above the same figure with one session (`--stt-slack-ms`) |
| Voice: time to first audio, p95 | more than 1000 ms above one session (`--ttfa-slack-ms`) |
| Voice: starvation, the share of playback the player would have sat silent waiting for audio after its pre-roll (`--preroll-ms`, set it to the deployment's `STELLA_TTS_PREROLL_MS`) | above 5% (`--max-starved-pct`) |
| Utterances that got no final transcript, or any request error | at least one |

Latency limits are relative to the one-session baseline because the absolute
numbers differ per GPU and model. The run stops at the first failing level; a
later level that would pass does not count. A server whose single session
already fails (for example a GPU too slow to synthesize in real time) measures
0 sessions, and says why.

## Running it

```bash
python3.12 -m venv .venv && .venv/bin/pip install grpcio grpcio-tools numpy
```

Reach the services, from inside the cluster or with port-forwards:

```bash
kubectl -n ai-agents port-forward svc/stt-service 50051:50051 &
kubectl -n ai-agents port-forward svc/tts-service 50052:50052 &

.venv/bin/python scripts/load-test/load_test.py \
    --levels 1,2,4,6,8,10 --duration 60 \
    --environment development --gpu-name "Tesla T4" \
    --stt-provider whisper --tts-provider qwen3 \
    --output result.json
```

- **GPU name and utilisation.** On the GPU host the script reads `nvidia-smi`.
  When it runs elsewhere, pass `--gpu-name`, and `--gpu-command ssh <host>` to
  sample utilisation and memory over SSH.
- **Nothing else should be running** on the server: a deploy or a real session
  loads the GPU and spoils the measurement. Say which GPU the numbers are from;
  the T4 on development is slower than the L4 in production.
- **Production is Felix's.** Do not point this at it without him.

## Showing the number in the admin dashboard

Add `--publish-url https://<backend>` with `STELLA_ADMIN_TOKEN` set to a
system admin's token. The result appears under **Settings → Admin → Voice
capacity** with the GPU, the environment and the date. Each run is stored; the
dashboard shows the newest per environment and GPU.

## Tests

```bash
pip install pytest pytest-asyncio
python -m pytest scripts/load-test
```

`test_driver.py` runs the driver against fake STT and TTS servers that share one
lock as their "GPU", so a fast fake reaches the top level and a slow one is
found to degrade.
