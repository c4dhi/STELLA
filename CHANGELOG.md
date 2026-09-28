# Changelog

All notable changes to STELLA will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Voice capacity: a repeatable load test (`scripts/load-test`) raises the number of simultaneous simulated sessions until speech recognition or the voice slows or stutters, and the admin dashboard shows the measured number for each server with the GPU it was measured on and the date. Nothing is limited by it; it tells you what a server carries
- Personas: an agent's identity (name, system prompt, voice, language) is now separate from its plan and can be chosen when deploying. A plan remembers the persona it was built with, and a deployment that names no persona uses the plan's, then the system default
- **Upgrade step for existing installations:** run `npx ts-node scripts/migrations/extract-plan-personas.ts` once after updating (a dry run that prints plan names, counts and persona names; add `--show-prompts` to also print prompt text), read the output, then run it again with `--apply`. It turns each plan's and public project's own prompt and voice into a persona and links the plan to it, so existing plans keep their personality. It is safe to re-run. Saved configurations that set a custom persona in the old configurator slot are not carried over

### Changed

- Sessions paused before the upgrade keep their plan's own personality when they wake up (temporary fallback, removed one release after 1.3.0)

### Fixed

- Conversations now end on their own after the farewell. The last step of a plan leads to the end by default (in stored plans and in AI-generated ones), a session stuck on its last step is released to the end, and the Plan Builder no longer claims a plan will end when it will not
- Muting the microphone no longer makes Stella stutter or answer half-sentences. Mute now keeps the audio connection and sends silence instead of tearing it down, so speech recognition is not restarted on every mute, and the agent is told the mute was deliberate. Unmuting reuses the same connection. Note for researchers: while muted, the browser still holds the microphone (the browser's mic indicator stays on) but no sound is sent.

### Known limitations

- On the development server's Tesla T4 with the Qwen3 voice in streaming playback, one session already starves the voice (9.7% of playback against a 5% limit, judged with an 800 ms player pre-roll) and two sessions collapse, so its measured capacity is 0 (see the Voice capacity card). This is the T4 only; production's GPU has not been measured, and the sentence-by-sentence playback mode was not tested

---

## [1.2.0] - 2026-09-25

Restores the voice-latency and naturalness work that production ran in August
from a deployment branch. It was listed under 1.1.0 by mistake; that code was not
part of v1.1.0. **If your study tuned barge-in on 1.1.0, read "Interruptions work
differently" under Changed first.**

### Added

**Voice latency & audio quality**
- Streaming TTS playback: audio starts on the first synthesised chunk instead of waiting for the whole sentence
- Bridge generation overlaps the Expert Pool instead of running before it (#455)
- Jitter buffer ahead of playback with a tunable pre-roll (`STELLA_TTS_PREROLL_MS`, default 200 ms)
- Underrun guard that emits real silence when synthesis falls behind, with de-click ramps and starvation logging
- `STT_DECODE_DIAGNOSTICS`: per-turn speech-recognition metrics in the session metrics modal (costs extra GPU work; off by default)

**Language**
- Choosing a language when deploying now fixes the conversation to that language (`STELLA_LANGUAGE`): speech recognition, replies and voice all follow it, instead of Stella answering in English on a short or unclear first sentence (#214)
- A plan can declare its own language, and speech recognition is told what it is
- Public projects get the same Voice & Language step as a normal deployment (#214)

**Conversation**
- The agent keeps track of things the participant mentioned in passing but hasn't confirmed, so it checks back on them instead of treating them as answered or asking them cold later

**Deployment safety**
- Deployments fail when the ConfigMap template has a placeholder with no substitution rule
- Deployments fail when the text-to-speech service comes up without a working voice model, instead of going green with every session silent

**Agent SDK**
- Agent SDK 0.6.0 on PyPI (`pip install stella-ai-agent-sdk==0.6.0`). For agent authors: speech streams sentence by sentence behind a tunable pre-roll, barge-in ducks first and calls `on_barge_in` once with the whole utterance, a deployment or plan language pins speech recognition, and `set_deliverable` accepts `unconfirmed=True`. Details in the [SDK changelog](https://github.com/c4dhi/STELLA/blob/main/agents/stella-ai-agent-sdk/CHANGELOG.md)

### Changed

**Interruptions work differently (barge-in, #15)**
- In 1.1.0, the agent stopped on the first few words of a partial transcript and then asked an LLM evaluator whether to carry on. In 1.2.0, the decision to stop comes from how long the participant has been speaking (`BARGE_IN_MIN_SPEECH_MS`, default 600 ms), with no transcript and no LLM call in the way
- The agent now lowers its voice the moment the participant makes a sound (`BARGE_IN_DUCK_GAIN`, default 25%). It stops only once they keep going, and it can pick up again from where it paused
- The evaluator now judges only the participant's complete utterance, never a partial. It decides whether the agent's interrupted reply is dropped or resumes. Short acknowledgements like "mhm" no longer take the turn, and an answer that opens with agreement ("yes, absolutely, …") is no longer mistaken for one. If your study edited the evaluator prompt in 1.1.0, compare it with the new default, because the old default treated agreement as a reason to carry on
- Speech that whisper hallucinates over silence ("Thank you.", "You") no longer interrupts the agent
- The agent no longer hands the turn back while the participant is still speaking, and a sentence the participant continued straight after a pause is no longer dropped

**Replies & bridge**
- One question per turn, and always at the end of the reply
- Turns vary in shape, not just in wording: the bridge phrase is no longer played on every turn, and replies no longer follow a fixed "acknowledge, then ask" pattern
- The bridge is a single prompted model instead of phrase inventories. It no longer repeats the participant's own words back, or falls into the same sympathetic phrase ("that sounds like a strain…") turn after turn
- Bridge phrases arrive sooner: model connections are reused across calls

**Speed**
- First audio per sentence reduced from 2.2-3.9 s to approximately 1.0 s, and no longer scales with sentence length
- TTS time-to-first-audio reduced by roughly 30% (233-244 ms to 148-167 ms)
- Inter-sentence gap reduced to ~167 ms, below the 200-500 ms pause of natural speech
- About 300 ms less wait after every participant turn: a transcript debounce that could never merge anything now defaults to 0
- Reference voice clips trimmed from 17-20 s to 6.5 s (German) and 7.5 s (English), cutting the per-request model prefill by about two thirds
- The task-extraction expert is offered only the tools it can use, making it about 300 ms faster per turn

**Deploy UI**
- The deploy wizards ask for the plan before the voice and language. If the plan declares a language, that becomes the session language and the language picker is skipped

### Fixed

- Speech recognition no longer drops the beginning of utterances longer than 16 seconds
- Concurrent TTS synthesis corrupting audio within a session (per-session lock)
- Jitter buffer re-arming its full cushion mid-sentence, starving the output source and producing audible warble
- Speech-progress envelopes racing each other; now published in order
- Teleprompter highlight trailing the voice
- Chat bubbles size to their content instead of every message filling 75% of the width
- Session analytics: typed turns and other non-speech turns are timed too, and a session with no data no longer shows "NaN"
- The live transcript no longer blanks out for up to a second before each final transcript arrives
- Silent sessions after rebuilding the text-to-speech image: a newer `transformers` release broke the Qwen3 voice model, so it is now pinned below 5.17
- Test workflows now also run on pull requests into `development`

### Known limitations

- If no session has started for more than 5 minutes, the first sentence of the next session waits about 11 seconds while speech recognition warms up, down from about 30 seconds before this release. Sessions already running can pause briefly while this happens. A keep-warm setting is planned for 1.2.1 (#561).

---

## [1.1.0] - 2026-09-06

### Added

**stella-v2 Agent**
- stella-v2 agent with a streamlined pipeline: Expert Pool, Deterministic Arbitration, Response Generator, and a parallel Bridge Generator (no Input Gate — see Removed)
- Visual Pipeline Configurator for creating and managing pipeline configurations
- Pipeline configuration management (create, edit, duplicate, delete) with sparse override pattern
- Mandatory pipeline configuration selection for stella-v2 deployment
- Bridge Generator for reduced perceived latency in voice conversations
- gRPC State Machine integration for decoupled conversation flow management
- Documentation for stella-v2 architecture, pipeline configurator, and schema reference

**Delivery pipeline**
- Continuous deployment: `development` to the test server, `main` to production, on self-hosted runners
- Deploys verify themselves — the running service must report the version just built, reachable through the public URL, or the run fails
- Every production deployment is tagged `prod/<version>` and published as a GitHub Release
- `GET /version` reports the deployed build

**Open source & project governance**
- STELLA is now released under the **[MIT License](https://github.com/c4dhi/STELLA/blob/main/LICENSE)** (© Universität St. Gallen (HSG) & University of Zurich (UZH)) — free to use, modify, and self-host
- Public documentation and a **researcher-focused landing page** are now hosted on **GitHub Pages** at [c4dhi.github.io/STELLA](https://c4dhi.github.io/STELLA/), auto-deployed from `main`
- Community & release files added to the repository: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` (private vulnerability reporting), `NOTICE.md` (third-party attributions), `CITATION.cff` (GitHub "Cite this repository"), and `RELEASING.md`

**Backup, restore & relocation (#378)**
- **Full-system export/import** for backups and machine-to-machine migration, driven by a guided wizard (`./scripts/start-k8s.sh --backup`) with a readable restore report
- `STELLA_DATA_ROOT` relocates all heavy storage (PVCs, models, temp) onto a chosen disk

**Voice — TTS providers & voices**
- Multiple text-to-speech providers: **Piper** (default local), **in-process Qwen3-TTS**, **ChatterBox** multilingual (EN/DE), and **Voxtral** (opt-in, GPU) with low-VRAM 4-bit/8-bit knobs
- Default **Stella voice registry** shipped with de + en reference clips, plus language-aware, per-agent and per-stream reference-voice selection

**Language handling**
- End-to-end language support: **STT acoustic language detection**, coherent **per-turn language resolution** moved into the SDK and adopted by both agents, and a configurable resolver with sensible defaults

**Barge-in**
- Users can **interrupt the agent mid-speech** (voice and text), reusing the voice plumbing, via a configurable COMMIT/RESUME evaluator — at parity across stella-v2 and stella-light

**Setup wizard & deployment**
- Chapter-based onboarding wizard: **auto-generates required secrets**, guides the LiveKit internal URL with same-machine IP detection, prompts for `STELLA_DATA_ROOT` and a Hugging Face token, and adds a skippable initial-admin bootstrap chapter
- **Independently configurable** public frontend and backend URLs; manifest-driven runtime-variable palette with a minimum config-compiler version; env-var templates and pipeline configs **scoped to agent type + version**

**Sessions & transcripts**
- Sessions **auto-end** on inactivity or max-duration
- Transcript download with a **mode selector** (transcript / + verdicts / full debug export) and per-message-type checkboxes
- **Word-by-word** speech highlighting (teleprompter) on both chat surfaces

**Agent Configurator — Expert Module**
- Deterministic, literature-informed **verdict responses**: each expert verdict maps to an action (`inform`/`prepend`/`override`/`short_circuit`) + template, applied by priority in the arbitration layer so safety-critical output doesn't depend on the LLM's interpretation
- **Generic, editable verdict labels** with LLM-facing explanations (label + explanation handed to the classifier; action stays in arbitration); fixed output interface
- Agent-declared expert defaults published from `config/experts/*.json` to `AgentType.expertDefaults`, **capability-gated** (`task_extraction` ← `plans`, assessment pool ← `experts`)
- Unified prompt editor in the New Custom Expert form (#178), Always-Triggered toggle on creation (#175), and an unsaved-changes discard guard on close (#177)

**Stella Light**
- **Barge-in support** at parity with stella-v2: a configurable Barge-in Evaluator (COMMIT/RESUME classifier) with an editable prompt/model in the Configurator, plus `BARGE_IN_ENABLED` / `BARGE_IN_EVAL_TIMEOUT_MS` env controls
- **"Branch chosen" indicator** now renders for the light agent too — it tracks state changes and emits `last_transition`, reaching parity with stella-v2

**Agent SDK — shared progress builder (#310)**
- New `stella_agent_sdk.progress.progress_from_full_state()` — the single canonical `get_full_state() → ProgressState` transform every agent uses, replacing two hand-maintained per-agent copies that had drifted (the source of the disappearing-skipped-state and `8000%` bugs). Group status derives only from the authoritative `state.status`; the percentage is used raw (0–100); real `task.status`, goal metadata, and discovered insights are handled consistently
- New `build_last_transition()` — shared "branch chosen" derivation; agent identity is parameterized via `extra_metadata` and the clock is injectable for deterministic tests
- Additive and backward compatible: existing custom agents need no changes. See [Progress Tracking → State machine–backed progress](https://c4dhi.github.io/STELLA/docs/agent-sdk/progress-tracking)

### Changed

**Editable agent prompts**
- **stella-v2:** response and bridge behavioral prose moved into editable prompt slots behind one unified template interface; the bridge now streams to TTS and carries the full reaction to cover the response gap; sharper per-expert engage/tap-out contracts
- **stella-light:** persona + conversation guidelines merged into a single editable System Prompt; safety guardrails and phase-transition notes moved into editable slots; deliverable-driven steering with precise skip semantics

**State machine — task completion (#291)**
- Task completion is now derived from collected data: a task with deliverables is addressed automatically once its **required** deliverables are collected (or, for an all-optional task, once **every** declared deliverable is in), with no separate "mark complete" step. Deliverable-less tasks still require an explicit complete/skip. A state advances only once **every** task (required *and* optional) is addressed, and is never vacuously complete on entry.

### Fixed

- GPU images unbuildable since a dependency bump raised the numpy floor above what the Python 3.11 base supports
- CUDA base image pinned to a version the GPU drivers actually support

**Audio & deployment reliability**
- Prevent the STT stall when an audio track ends or the participant mutes; audio-output readiness is now a real-time round-trip test
- LiveKit audio and webhook-processing fixes; barge-in now silences client audio on interrupt with a hardened evaluator
- Agent image caching now rebuilds when Docker/config changes so config edits actually take effect

**Progress / to-do rendering (#291)**
- A skipped task no longer renders as pending — it shows as skipped and counts toward "tasks done". Skipping a task now also marks its uncollected deliverables `skipped`.
- **stella-v2:** skipping a task no longer makes the whole state disappear from the route view (group status now follows the state machine's authoritative status), and the progress percentage is no longer mis-scaled.
- Live and historical-replay views now share one progress→to-do conversion, so they can't disagree about task status.
- **(#310)** The `full_state → progress` transform is now consolidated into one shared SDK builder, so the agents can no longer drift; the two historical bugs above are now covered by a single golden-fixture suite.

**Goal states (#310)**
- Goal-level deliverables now honour the **skip cascade**, same as regular task deliverables: once a goal state completes, any uncollected goal deliverable renders `skipped` instead of a stale `pending`, and the synthetic goal task reads `completed`.

### Removed

**stella-v2 — Input Gate (#363)**
- Removed the Input Gate stage from the stella-v2 pipeline — experts now self-gate and arbitration filters, simplifying the pipeline to five stages

---

## [0.3.0] - 2026-01-29

### Added

**Participant Experience**
- Text-only interface for participant screen (#24)
- Marketing landing page (#12)
- Mobile-ready participant screen with responsive design (#25)
- Session transcript export functionality (#50)
- Public web interface for interviewees (#3)

**Agent & System Capabilities**
- Agent Toolkit/Toolbox implementation for extensible agent capabilities (#20)
- Enhanced Conversational Agent with improved dialogue handling (#88)
- Whisper integration for Text-to-Speech (#7)
- Public Projects feature for shared access (#4)
- Environment variable override support in DeployAgentModal

**Project & User Management**
- Per-user project basis with sharing capabilities (#34)
- Environment Variable Templates for Agent Types (#28)
- System-wide state persistence (#31)

**Documentation & Onboarding**
- Adaptive documentation system (#29)
- Dynamic onboarding through start-script (#56)
- Custom Tools guide for extending agent capabilities
- Database Schema documentation with complete Prisma model reference
- Custom Agent Visualizers guide for creating face visualizers
- Environment Variables reference documentation
- Message Recording deployment guide
- Authentication guide with JWT implementation details

### Changed
- Refactored Conversational AI Agent to SDK architecture (#10)
- Migrated system from Minikube to K3S with enforced microservice architecture for STT and TTS (#14)
- Improved start script and repository structure (#16)
- Improved code block styling with automatic word wrapping
- Updated architecture overview with database references
- Enhanced cross-linking between documentation pages

### Fixed
- Fixed Whisper warmup functions not existing (#70)
- Fixed Whisper not reliably transcribing speech (#49) [P0]
- Fixed double texting issue (#9)
- Fixed new user error when no projects exist (#36)
- Fixed initial message bug (#6)
- Fixed unselecting Debug in Session Overview not working (#11)
- Fixed environment variables not reaching agent pods when modified in deploy modal
- Fixed LiveKit Production page title formatting

---

## [0.2.0] - 2026-01-17

### Added
- Complete documentation site with Docusaurus
- Getting Started guides (Quick Start, Installation, First Agent)
- Architecture documentation (Overview, Data Flow, Session Lifecycle, Kubernetes)
- SDK Reference (Overview, Base Agent, Plans, Tools, Streaming, TypeScript Types)
- Deployment guides (Kubernetes, Nginx, Production Checklist)
- LiveKit integration documentation
- Contributing guidelines (Development Setup, Coding Standards, PR Process)
- Plan Structure documentation with state machine details

### Changed
- Migrated documentation from standalone markdown files to Docusaurus
- Reorganized documentation structure for better navigation

---

## [0.1.0] - 2026-01-10

### Added
- Initial STELLA backend release
- NestJS-based session management server
- LiveKit integration for real-time audio/video
- PostgreSQL database with Prisma ORM
- Kubernetes orchestration for agent pods
- STELLA Agent SDK for Python agents
- State machine for conversation flow management
- React frontend with visualizer gallery
- JWT-based authentication system
- Project and session management APIs

---

[Unreleased]: https://github.com/c4dhi/STELLA/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/c4dhi/STELLA/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/c4dhi/STELLA/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/c4dhi/STELLA/releases/tag/v0.1.0
