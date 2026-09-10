# Coherent language handling (STT → LLM → TTS)

- **Ticket:** [#214 — Coherent language handling for STT, TTS, and user selection](https://github.com/c4dhi/STELLA/issues/214)
- **Branch / PR:** `feature/language-handling-214` · PR #244
- **Status:** Implemented. One item is a deployment toggle, not code — see [§9](#9-whats-left).

The system automatically detects the spoken language and responds in it — bridge, main response text, and voice all coherent within a turn — and switches language only on a sustained, confident change. Typed input is handled by the same logic via a text classifier.

---

## 1. Problem

Language was decided **three times independently** in a single turn, with nothing keeping them in sync:

| Stage | How it decided | 
|---|---|
| STT (Whisper) | auto-detected, then **cached once** and forced for the rest of the session |
| Bridge | a German word-list heuristic on the transcript |
| LLM response | a "respond in the same language" prompt — the model guessed |
| TTS voice | a static `TTS_LANGUAGE` env var, fixed per process |

Because each stage guessed on its own, they could disagree **within one turn** — most visibly a **bridge in one language and the answer in another**, spoken by whatever voice the env var named. There was also no way for a plan to declare an expected language, and the STT proto couldn't carry a language signal at all.

---

## 2. Design: detect once, propagate everywhere

One language is resolved **per turn**, before the bridge fires, and every downstream stage reads that one value.

```
   STT auto-detects each utterance (language=None) and reports
   (detected_language, confidence) FREE from the transcription pass
                          │
                          ▼
   Agent LanguageResolver  ── confidence-gated switch, lock, fallback ──►  session language
                          │
        ┌─────────────────┼───────────────────┬───────────────┐
        ▼                 ▼                   ▼               ▼
      bridge        LLM response      {{language}} var     TTS (language + voice)
```

- **STT reports, the agent decides.** STT emits a genuine per-utterance `detected_language` + `confidence`. The gating policy (thresholds, debounce, clamp to the supported set) lives in the **agent**, as product logic — not in the STT VAD loop.
- The resolved value is frozen for the turn and fed to the bridge, the response prompt, the `{{language}}` template variable, and the TTS request (language + voice).

### Decisions

| Decision | Choice | Why |
|---|---|---|
| Switching | **Confidence-gated** — session-locked; switches only on a sustained, high-confidence change | Reliable, but never traps a real switch |
| Plan control | **Optional declared language** — a soft *seed*, default `auto` | Sharpens turn-1 detection when known; pure auto otherwise |
| Participant picker | **None — pure auto-detect** | Zero friction; matches "the system just picks it up" |

---

## 3. Why bridge ↔ response are coherent by construction

The bridge does **not** race ahead of detection. It is generated from the **final** transcript, in parallel with the input gate (`agent.py` `process()`), and the final transcript is exactly where Whisper computes the language. So at bridge time the language for that utterance is already known.

> **The rule:** language is resolved once per turn, before the bridge, and is immutable for that turn. A gated switch takes effect at a **turn boundary**, never mid-turn.

This is why no language-neutral / filler bridge is needed: the bridge is produced directly in the detected language, with no one-turn lag.

---

## 4. STT detection — free, no added latency

Whisper transcribes in **auto-detect mode** (`language=None`) and the detection is read straight off the transcription result (`info.language` / `info.language_probability`) — values faster-whisper computes anyway. There is **no second model call**: detection is a byproduct of the pass we already run.

- A genuine `(detected_language, confidence)` rides on every final `TranscriptEvent` above the ~2s reliability floor. Below it, no signal is emitted and the agent falls back to its text classifier ([§6](#6-typed-input--unified-fallback)).
- Because transcription is never forced to a stale language, the switch utterance itself transcribes correctly — there is no garbled turn.
- **Pinning is opt-in** (`WHISPER_LANGUAGE` env service-wide, or a per-session `AudioChunk.language`) for deployments that must stay in one language; it trades away the free detection. Off by default. This is the mechanism the per-agent deployment pin uses ([§6.1](#61-the-deployment-pin)).

> An earlier cut forced transcription to the resolved language and ran a separate `detect_language()` probe (~one extra encoder pass per utterance). Auto-detect makes both unnecessary — same signal, zero cost.

---

## 5. Resolution order & gating (per turn)

`LanguageResolver.resolve(text, signal=…)` takes the acoustic `(language, confidence)` when present (voice) and falls back to the bundled text classifier otherwise (typed input / no signal). Both shapes flow through one gating path:

1. **Confident, supported signal** (`confidence ≥ threshold`) → adopt it.
2. **Hold the lock** — unchanged turn-to-turn by default.
3. **Confidence-gated switch** — change only on a *different supported* language at `confidence ≥ switch_threshold`, debounced. A stray "ja"/"ok"/number cannot flip it.
4. **Clamp** — anything outside the supported set keeps the current lock.

**Fallback chain** when a turn has no confident signal:

1. the current session lock (**the last detected language**), else
2. the plan seed (`Plan.language`, if set), else
3. the global default.

A lock established *provisionally* from the seed/default (turn-1 ambiguity) is not treated as a real detection: the first genuine detection adopts it at the lower `detect_threshold` rather than having to clear `switch_threshold`, so the last *detected* language always wins over a placeholder. Thresholds and debounce are tunable constants in the resolver.

---

## 6. Plan language vs. spoken language — *hint, never deafen*

> **Exception: the deployment pin.** Everything in this section describes the
> default `auto` mode. When an operator picks a language in the deploy UI
> (`STELLA_LANGUAGE`), that deployment is *fixed* to it — see [§6.1](#61-the-deployment-pin).

The plan language is a seed, not a cage: **the spoken language wins.**

| Plan | User speaks | Resolution |
|---|---|---|
| `auto` | anything | pure detect |
| `de` (seed) | German | no conflict; seed also sharpens turn-1 accuracy |
| `de` (seed) | **English** (supported) | **English wins** — seed only biases turn 1 / sub-2s, a confident detection overrides |
| `de` (seed) | French (unsupported) | clamp: stay in `de` |

This is safe because **plans are instructions, not scripts** — states carry LLM-interpreted `description`/`instruction`/`goal`/`acceptance_criteria`, never verbatim spoken lines, and transitions match collected *data values*, not text. A German-authored plan conducted in English still behaves correctly; it just sounds English.

> The seed may *bias* STT's first guess but must never suppress STT's independent detection ([§4](#4-stt-detection--free-no-added-latency)). Once STT confidently hears another supported language, that wins — for transcription, response, and voice.

### 6.1 The deployment pin

The seed-never-deafens rule solves the *multilingual* case, but it leaves the
**fixed-language deployment** unserved. Auto-detect needs a long enough,
clear enough utterance to clear `detect_threshold`; a short or garbled opener
produces no confident signal, so the fallback chain lands on the plan seed or
the global default — English. A study running entirely in German would open in
English on exactly the turn that makes the first impression.

So the deploy UI's language choice is a **pin**, not a seed:

| Mode | STT | Resolver | Reply + voice |
|---|---|---|---|
| `auto` (default) | auto-detect | detect → lock → seed → default | follows detection; English when undetectable |
| pinned `de` | **forced to `de`** | **forced to `de`** — detection not consulted | always German |

- One env var, `STELLA_LANGUAGE`, read in the SDK (`language.forced_language()`),
  so both agents inherit it with no per-agent wiring.
- `LanguageResolver.resolve()` short-circuits on the pin before any gating, so no
  signal — however confident, however sustained — can flip it, and the plan seed
  is outranked.
- STT is pinned per session via the existing `AudioChunk.language` hint
  (`language_provider` in `audio/pipeline.py`), **not** `WHISPER_LANGUAGE`: the
  env var is service-wide and would drag every other agent along with it.
- A garbled opener is therefore *transcribed as* the pinned language rather than
  auto-detected badly, which is the whole point.
- An unsupported pin is ignored with a warning and falls back to auto-detect,
  so a bad value degrades to today's behavior instead of breaking the session.

This deliberately trades away the free per-utterance detection (§4) — that is
what "pinned" means.

### Typed input & unified fallback

Typed turns carry no acoustic signal, so `resolve()` classifies the text instead (same `(language, confidence)` shape, same gating). The session lock is one value regardless of modality, so a voice-established language carries into a typed turn and vice-versa.

---

## 7. Provider contract — best-effort, provider-agnostic

The resolved **language** and **voice** are passed to TTS as per-request hints. A provider that can switch honors them; one that can't **discards them without erroring** (verified across all four). Crucially, the **response text, bridge, and `{{language}}` always follow the language regardless of provider** — only the spoken audio is provider-limited.

| Provider | Languages | Per-request `language` | Per-request `voice` |
|---|---|---|---|
| **Piper** (current default) | one per built voice | ignored | ignored (single ONNX) |
| **Kokoro** | English only | ignored | **honored** (`_resolve_working_voice`) |
| **Qwen3** | 60+, autodetect | **honored** | ignored (reference-clip cloning) |
| **ChatterBox** | en / de | **honored** | ignored (reference-clip cloning) |

So on the default Piper the voice stays fixed but the agent still *responds* in the user's language — degraded gracefully, not broken. Deploying Qwen3/ChatterBox makes the voice follow too, with no code change (env/build-arg + weights).

**Voice** rides the exact same contract: `Plan.voice` → `metadata["voice"]` → `AudioPipeline.set_tts_voice()` → `SynthesizeRequest.voice`, stamped on the bridge and every response chunk so they share one voice. Unlike language there is no detection — voice is a configured choice, just propagated.

**Agent-side clamp (separate concern):** the resolver clamps its own decision to the committed supported set (v1: `en`, `de`) so the LLM is never asked to answer in a language we don't intend to support. Adding a language later means widening the supported set **and** (for voice) deploying a provider that can speak it.

---

## 8. Where it lives

The resolved value (`session.language`) is the single source of truth; `{{language}}` and the per-stage injections are projections of it, not second sources.

| Surface | How language reaches it | File |
|---|---|---|
| **STT detection** | `detected_language` + `language_confidence` on the final `TranscriptEvent`; opt-in `language` pin on `AudioChunk` | `proto/stt.proto`, `whisper_provider.py`, `stt_server.py` |
| **SDK → agent** | `from_proto` → `AgentInput.metadata` → `process()` | `stt_client.py`, `agent/base.py` |
| **Resolver** | confidence-gated `resolve(text, signal)` + fallback chain | `language_resolver.py` |
| **Bridge** | `generate(…, language=…)`: explicit directive + language-correct fallback (`_detect_german` no longer on the live path) | `bridge_generator.py` |
| **Response** | unconditional highest-priority `Respond entirely in {language}` directive | `response_prompt.py` |
| **Runtime variable** | `{{language}}` placeholder backed by `sm_context["language"]`, recomputed per turn — usable in any expert/configured prompt | `template_compiler.py` |
| **TTS language** | `set_tts_language()` from `metadata["language"]`; `TTS_LANGUAGE` demoted to a seed | `audio/pipeline.py`, `agent/base.py` |
| **TTS voice** | `Plan.voice` → `set_tts_voice()` → `SynthesizeRequest.voice` | `plan/types.py`, `agent.py`, `pipeline.py` |

---

## 9. Testing

- **`test_language_resolver.py` — 35 unit tests** (green): detect / lock / hold / confidence-gated switch / debounce / clamp / seed / provisional-vs-confirmed fallback / reset, and the acoustic-signal path (signal-over-text, acoustic switch, out-of-set clamp, low-confidence hold, text fallback).
- **STT proto round-trip** verified (provider event → `from_proto` → `AgentInput`), including backward-compat for events without the new fields.
- **Not runnable locally** (no GPU / models): the live STT→TTS audio path. Manual checklist on a real deployment — speak German → German answer + voice; mid-session switch → coherent at the next turn; one-word "ja" → no flip. `stt-service`/`tts-service` have no pytest harness yet; adding one is the path to provider-level regression coverage.

---

## 10. What's left

**TTS provider for spoken multilingualism** — a *deployment toggle, no code*: to make the spoken **voice** switch language, deploy Qwen3 (60+ langs) or ChatterBox (native en/de) instead of Piper (env/build-arg + model weights). Response text already follows the language on any provider. Recommendation: **ChatterBox** for the committed en/de v1.

**Done since:** the explicit force flag, shipped as the deployment pin `STELLA_LANGUAGE` ([§6.1](#61-the-deployment-pin)) and surfaced in the deploy UI's "Voice & Language" step. It pins the ears too (STT), which the original sketch left open — a fixed-language deployment gains nothing from detecting a language it will not use, and pinning is what rescues the short/garbled first turn.

Possible later refinements: empirical tuning of `detect_threshold` / `switch_threshold` / debounce; deliverable normalization across languages (extraction must map e.g. a German answer to the plan's canonical value).
