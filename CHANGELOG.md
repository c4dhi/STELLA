# Changelog

All notable changes to STELLA will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

These landed on production in August from a deployment branch, but were not part
of the v1.1.0 code; they were listed under 1.1.0 by mistake.

### Added

**Voice latency & audio quality**
- Streaming TTS playback: audio starts on the first synthesised chunk instead of waiting for the whole sentence
- Bridge generation overlaps the Expert Pool instead of running before it (#455)
- Jitter buffer ahead of playback with a tunable pre-roll (`STELLA_TTS_PREROLL_MS`)
- Underrun guard that emits real silence when synthesis falls behind, with de-click ramps and starvation logging
- `BARGE_IN_MIN_SPEECH_MS` (voiced audio required before a barge-in) and `STT_DECODE_DIAGNOSTICS`
- Deployments fail when the ConfigMap template has a placeholder with no substitution rule

### Changed

- First audio per sentence reduced from 2.2-3.9 s to approximately 1.0 s, and no longer scales with sentence length
- TTS time-to-first-audio reduced by roughly 30% (233-244 ms to 148-167 ms)
- Inter-sentence gap reduced to ~167 ms, below the 200-500 ms pause of natural speech
- Reference voice clips trimmed from 17-20 s to 6.5 s (German) and 7.5 s (English), cutting the per-request model prefill by about two thirds

### Fixed

- Concurrent TTS synthesis corrupting audio within a session (per-session lock)
- Jitter buffer re-arming its full cushion mid-sentence, starving the output source and producing audible warble
- Speech-progress envelopes racing each other; now published in order
- Teleprompter highlight trailing the voice

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
