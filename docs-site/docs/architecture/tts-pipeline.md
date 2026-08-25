---
sidebar_position: 6
title: TTS & Audio Pipeline
description: How a streamed LLM reply becomes audio the user hears, and which knobs change the timing
---

# TTS & Audio Pipeline

This page traces one agent reply from the moment the LLM starts streaming tokens to the moment sound leaves the user's speakers, and documents the timing constants involved.

The short version: text is cut into **sentences**, each sentence is synthesized into **raw audio**, and that audio is pushed into the LiveKit call in **20 ms slices**. The browser is an ordinary WebRTC participant — it plays the agent's track exactly like another caller's voice.

```
LLM tokens → sentence splitter → TTS queue → Qwen3 model → PCM buffer
                    │                                          │
                    ▼                                          ▼
            published as text                          800 ms pre-roll
                    │                                          │
                    ▼                                          ▼
             chat bubble                    20 ms frames → LiveKit → browser
```

Text reaches the screen **before** audio reaches the ear. That is by design, and it is why the teleprompter exists (see below).

---

## Step by step

### 1. The LLM streams, the agent accumulates

`agent/base.py` — each output event carries the **whole** text so far, so the agent diffs it against what it already had to find the newly added part.

### 2. New text is cut at sentence boundaries

`AgentBase._dispatch_sentences`. A boundary is punctuation followed by whitespace. Abbreviations are guarded: `Dr.` or `z. B.` do **not** end a sentence — on a false boundary the fragment keeps accumulating instead of being spoken as a clipped stub.

:::note Why sentences, not words
A TTS model needs a full phrase to place prosody. Feeding it word-by-word produces flat, stress-less speech. The sentence is the smallest unit that still sounds human.
:::

There is one extra dispatch rule: if the buffer already ends in `.`/`!`/`?` and this is not the final chunk, it is spoken immediately. That is what lets a short bridge ("Good question.") start playing while the real answer is still generating.

### 3. The sentence is queued — generation continues

`AudioPipeline.enqueue_sentence` never blocks. In parallel the text is published to the frontend, which is why the chat bubble appears first.

### 4. A worker speaks sentences in order, one ahead

`AudioPipeline._speech_worker` plays sentence N while **already synthesizing N+1**. This prefetch is what removes the silence between sentences.

### 5. Synthesis starts and returns immediately

`AudioPipeline._begin_synthesis` opens a gRPC `SynthesizeStream` against `tts-service` and returns an **empty buffer that fills in the background**.

This is load-bearing. The earlier implementation collected every chunk before returning, so the first sound of a sentence waited for the *entire* sentence — 1040–4138 ms instead of the ~235 ms the provider needs for its first chunk, i.e. 4–17× the provider's actual latency.

### 6. The model generates progressively

`tts-service/src/providers/qwen3_provider.py` — Qwen3 decodes PCM as it goes; a worker thread pumps chunks into a queue and re-slices them into fixed frames.

Output format is **24 kHz, 16-bit mono PCM** — raw uncompressed samples.

### 7. Playback holds a cushion (default 800 ms), then starts

See [Why the pre-roll exists](#why-the-pre-roll-exists) for the reasoning, and [Tuning the pre-roll for your hardware](#tuning-the-pre-roll-for-your-hardware) if you are running on a faster GPU. This is the least intuitive step and the one most worth understanding.

### 8. Audio is pushed in 20 ms frames

`AudioPipeline._play_utterance` pushes 480-sample frames into LiveKit's `AudioSource`. The buffer is still growing underneath this loop as the model produces more, and a sample-accurate playhead is tracked so barge-in can cut mid-sentence.

Only **whole** frames go out while synthesis is still running; a short final frame is allowed once the buffer is complete. Publishing a partial frame early would glitch the output.

### 9. LiveKit delivers it

`AudioSource.capture_frame` self-paces at exactly 1× real time. LiveKit Opus-encodes and ships over WebRTC.

### 10. The browser plays it

`frontend-ui/src/services/PeerTransport.ts` — on a remote audio track, `track.attach()` creates an `<audio>` element.

---

## Why the pre-roll exists

The deployed model (Qwen3-TTS-12Hz-1.7B on an **L4**) runs at a **real-time factor of 0.92–1.33**. Generating one second of speech takes roughly one second — and for short sentences it is *slower than real time*.

Playback drains at exactly 1× and cannot slow down. So if playback starts the instant the first chunk arrives, it **catches up with generation** and the buffer runs dry mid-word.

Measured on production, three German sentences of 1.7–4.2 s of audio:

| Metric | Measured |
|---|---|
| Real-time factor | 0.92 – 1.33 |
| First chunk from provider | ~235 ms |
| Whole sentence | 2235 – 3907 ms |
| **Max playout deficit** | **614 – 756 ms** |

That deficit is what sets the constant. Playback must start late enough that it never overtakes synthesis:

- **300 ms** — first frame at ~434 ms, **below the 756 ms deficit**. Still underran mid-sentence.
- **800 ms** — clears the deficit with margin. First frame at a **constant ~1037 ms**, regardless of sentence length (versus 2235–3907 ms when playback waited for full synthesis).

:::info The 800 ms default is calibrated to one specific deployment
It is **not** a universal constant. It is sized from the measured deficit of a 1.7B model on an L4 — hardware with no headroom to stream into. On a faster GPU (or a smaller model) this value is too conservative and adds latency you do not need to pay.

If you are running STELLA on better hardware, see [Tuning the pre-roll for your hardware](#tuning-the-pre-roll-for-your-hardware) below. Lower it deliberately, using the measurement below — do not just try 300 because it appears in the comment, and do not leave 800 in place assuming it is a safe default.
:::

---

## Tuning the pre-roll for your hardware

### The rule

The pre-roll is measured in **buffered audio**, not wall-clock waiting: playback begins once `STELLA_TTS_PREROLL_MS` worth of *audio* exists. So the wall-clock delay before first sound is roughly:

```
first_sound ≈ time_to_first_chunk + (preroll × RTF)
```

Underrun happens when playback (which drains at exactly 1×) overtakes synthesis. For a sentence of audio duration `D`, the cushion must satisfy:

```
preroll  ≥  D × (RTF − 1) / RTF
```

Which gives two regimes:

| Your RTF | What it means | Pre-roll needed |
|---|---|---|
| **< 1.0** | Synthesis outruns playback. The buffer *grows* while speaking — it cannot starve. | Only enough to absorb network/scheduler jitter. **150–300 ms.** |
| **≈ 1.0** | Synthesis barely keeps up. Any hiccup starves the source. | Scales with your longest sentence. **500–1000 ms.** |
| **> 1.0** | Synthesis is slower than playback. Deficit grows with sentence length. | `D_max × (RTF−1)/RTF`, and consider a faster provider. |

The formula is a conservative upper bound — it assumes RTF stays constant across the whole sentence. In practice the measured deficit on the reference deployment was 614–756 ms where the formula predicts ~1040 ms, which is why 800 ms suffices there.

:::caution Two different "RTF" conventions appear in this codebase
`audio/pipeline.py` uses **RTF = synthesis time ÷ audio duration** — *lower is better*, and `> 1` means slower than real time. That is the convention used on this page.

The Qwen3 provider docstring instead quotes "4.78 RTF" for the 0.6B model on a 4090, which is the **reciprocal** — a speed multiplier where *higher is better*. That 4.78 corresponds to RTF ≈ 0.21 in this page's terms.

Check which one you are reading before plugging a number into the formula.
:::

### How to measure your deployment

Both numbers you need are already logged — no instrumentation required.

**1. Time to first chunk** — from the `tts-service` pod:

```
[Qwen3] First audio in 156ms (stream, icl)
```

**2. Whether you are starving** — from the **agent** pod (this is the one that matters):

```
[TTS] Playout starved 3x on a 201600B response utterance; bridged 60ms of silence to keep the source fed
```

This line is emitted once per utterance, and **only** when playback actually ran dry. Its absence across a real conversation is your pass condition.

You can convert the byte count to audio duration to recover `D`:

```
duration_ms = bytes ÷ (24000 × 2) × 1000     # 201600 B ≈ 4200 ms
```

### Procedure

1. Run a normal session at the current setting and confirm the logs are clean.
2. Lower `STELLA_TTS_PREROLL_MS` (declared in `agent.yaml`, settable per deployment in the deploy modal).
3. Start a **new** session — the value is read when the agent pod builds its pipeline, so a running agent keeps the value it started with.
4. Hold a conversation with long replies, then grep the agent pod for `Playout starved`.
5. Any starve lines → go back up. Clean → you may go lower.

Tune against your **longest** expected replies. Short sentences starve first in relative terms, but long ones accumulate the largest absolute deficit.

:::warning Setting it to `0` also disables the underrun guard
The silence-bridging floor is `min(120 ms, preroll ÷ 2)`, so a zero pre-roll leaves nothing to bridge with — a stall reverts to the Opus concealment warble rather than an honest pause. Use a small positive value (150 ms+) rather than `0` unless you have measured that your provider streams comfortably faster than real time.
:::

---

## Tunables

All are read by the SDK inside the agent pod. Declare them in `agent.yaml` under `x-stella-optional-env-vars` to expose them in the deploy modal.

| Variable | Default | Description |
|---|---|---|
| `STELLA_TTS_PREROLL_MS` | `800` | Jitter buffer held before the first frame of an utterance. Read once at pipeline construction. **The default is calibrated to one specific deployment — [tune it for your hardware](#tuning-the-pre-roll-for-your-hardware).** Faster GPUs should lower it; `0` also disables the underrun guard. |
| `TTS_PROGRESS_TICK_MS` | `200` | How often a teleprompter progress envelope is emitted during playback. |
| `TTS_ENABLED` | `true` | `false` = text-only mode; the TTS connection is skipped entirely. |
| `TTS_VOICE` | provider default | Seed voice, overridable per stream. Honored by voice-selecting providers. |
| `TTS_LANGUAGE` | detected | Seed language (ISO 639-1). Empty = follow the per-turn detected language. |
| `STELLA_TELEPROMPTER_ENABLED` | on | Word-by-word highlight synchronized to playback. |

Changing any of these takes effect on the **next session** — the value is read when the agent pod builds its pipeline, so a running agent keeps the value it started with.

### Internal constants

These are not environment variables; changing them means editing `audio/pipeline.py`.

| Constant | Value | Meaning |
|---|---|---|
| `_TTS_SAMPLE_RATE` | `24000` | Output sample rate (Hz) |
| `_PLAYOUT_FRAME_SAMPLES` | `480` | 20 ms per frame at 24 kHz |
| `_UNDERRUN_FLOOR_MS` | `120` | Top the source up once it drops below this |
| `_UNDERRUN_POLL_MS` | `10` | Re-check interval while starved |
| `_DECLICK_MS` | `5` | Ramp applied either side of inserted silence |

---

## Guards, and the bugs that motivated them

### Real silence on underrun

A starved LiveKit `AudioSource` does **not** go quiet. The client simply stops receiving packets, and Opus **packet-loss concealment** fills the hole by extrapolating the last frame it had — a synthetic, warbling continuation of whatever phoneme was in flight.

That artifact is the "interference between chunks" people report. It is the client *inventing* audio, not the model producing it.

So when the buffer is about to empty, the pipeline pushes **real silence**. A synthesis stall then sounds like a short pause, which is honest, rather than a warble, which is not. A 5 ms de-click ramp is applied on either side, because cutting a speech waveform to zero is a step discontinuity and a step is audible as a click.

### One generation at a time

`tts-service` shares a **single model instance** across a 10-thread gRPC pool with no lock of its own. Two overlapping `synthesize_stream` calls contend on the same weights and CUDA graphs.

Observed on production: two streams starting in the same millisecond, finishing in lockstep, time-to-first-audio doubling from ~235 ms to ~495 ms, and audibly garbled output.

Before playback streamed, this could not happen — sentence N was fully synthesized before it began playing, so only N+1 was ever in flight. Streaming removed that **accidental** serialization, so `_synthesis_lock` makes it explicit: at most one stream in flight per pipeline.

:::info
This is a client-side workaround for a service-side gap. The durable fix is a lock (or a queue) inside `tts-service` itself, so concurrency is safe for *any* caller rather than only for well-behaved ones.
:::

---

## The teleprompter rides alongside, not inside

The word highlight is **not** derived from the audio signal. Every `TTS_PROGRESS_TICK_MS` the agent sends a small LiveKit data message meaning:

> "I am about to speak characters 100–128, starting in *N* ms, lasting *M* ms."

The browser animates a cursor on its own clock from those envelopes (`frontend-ui/src/hooks/useTeleprompter.ts`).

Each tick describes only audio **already synthesized**, plus at most one tick of extrapolation at a session-calibrated pace, so it can never promise text that does not yet exist as sound. Segments **tile**: contiguous, non-overlapping, summing to the audio duration.

:::warning Coupled deploy
The SDK (`audio/pipeline.py`) and the frontend (`useTeleprompter.ts`) must ship **together**. A new agent against an old frontend makes the highlight step forward and then back once per tick.
:::

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Warbling / garbled between chunks | Source underran — playback overtook synthesis. Check RTF and the pre-roll. |
| Audio garbled *and* TTFA roughly doubled | Concurrent synthesis on the shared model. Check `_synthesis_lock` is held. |
| Long delay before first sound | Expected ~1037 ms. Much longer suggests synthesis is not streaming, or the whole sentence is being awaited. |
| Highlight jumps or freezes | Progress envelopes stalled, or a **skewed deploy** — new agent against old frontend. |
| Clipped fragments spoken as sentences | A false sentence boundary — an abbreviation the guard does not know. |
| Speech is fine but silent gaps between sentences | Prefetch not arming — the next sentence was not enqueued in time. |
