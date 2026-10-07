# Changelog

All notable changes to STELLA will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

---

## [1.3.0] - 2026-10-07

Personas and companion mode. An agent's identity is now separate from its plan,
and an agent can be deployed without a plan to keep someone company and run
activities on request. **If you upgrade an existing installation, read "Upgrade
notes" first. If your study runs plans on 1.2.0, read "For studies running
plans" under Changed.**

### Upgrade notes

- **Back up the database before you upgrade.** This release applies 8 database migrations on its own during the deploy (personas, the plan's default persona, measured voice capacity, the audit record) and nothing backs up for you first
- **Node on the host:** the deploy runs the database migration on the host with Prisma 7, which needs Node 20.19+, 22.12+ or 24+. The deploy workflows now install Node 26 themselves; if you deploy by hand with `./scripts/start-k8s.sh`, check `node --version` first
- **Personas, once after updating:** run `npx ts-node scripts/migrations/extract-plan-personas.ts` (a dry run that prints plan names, counts and persona names; add `--show-prompts` to also print prompt text), read the output, then run it again with `--apply`. It turns each plan's and public project's own prompt and voice into a persona and links the plan to it, so existing plans keep their personality. It is safe to re-run. Saved configurations that set a custom persona in the old configurator slot are not carried over
- No new required setting. `STELLA_MODEL_KEEP_WARM` (default on) is new and optional
- The backend now runs on NestJS 12 and Prisma 7 and is built with TypeScript 6. Nothing to do unless you build your own image from a changed `Dockerfile`

### Added

**Personas**
- An agent's identity (name, system prompt, voice, language) is now a persona, separate from its plan and from the pipeline configuration, and is chosen when deploying. A plan remembers the persona it was built with, and a deployment that names no persona uses the plan's, then the built-in default
- Persona variables: a plan or configuration can refer to the persona, for example `{{persona.name}}`, and the Plan Builder shows which variables exist and highlights them
- Public projects have a Persona step in their setup wizard. Before, every public link ran the built-in default
- Two built-in personas: one for plans and "STELLA Companion" for companion mode. The deploy dialog asks for the mode before the persona and preselects the matching one

**Companion mode**
- An agent can be deployed with no plan. It keeps company in free conversation, offers the plans the operator allowed as activities, starts one on request and leaves it when the participant wants to stop. Companion is a mode chosen when deploying; a deployment that does not choose it follows its plan as before
- She speaks first when woken: she asks how the participant is, then offers the activities, once each, and after that only responds. Free conversation keeps company instead of interviewing
- She asks before she acts on an unclear turn: "do you mean X?" before starting an activity that was not named outright, and "shall we stop?" before leaving one. Mood alone does not end an activity
- After an activity, stopped or finished, she asks once whether they would like another one
- Sleep: she goes to sleep when told goodbye or good night, or after 45 quiet seconds outside an activity, and never inside one. Tapping her wakes her. Captions are hidden while she sleeps
- What she says in each of these situations, which model judges a yes or a stop, how often she may ask, and the sleep time are settings in the new Companion node of the pipeline configurator
- The admin view of a session shows what the agent decided in each turn and which activities it can offer

**Face**
- The face is more expressive (eyes with lids, a wider set of expressions) and is driven by emotion tags the agent writes into its reply. The tags are never spoken and never shown to participants; the admin board shows them so an operator can see which replies were tagged
- The face can sleep and wake, and reports both to the agent

**Voice**
- Speech recognition and the voice model are kept warm in the background, so the first sentence after a quiet period no longer waits about 11 seconds (the 1.2.0 known limitation, #561). `STELLA_MODEL_KEEP_WARM=false` switches it off; the setup wizard asks
- `STELLA_TTS_PLAYBACK` per deployment: `stream` (default) or `sentence`, which waits for the whole sentence before playing it, for a voice model slower than real time
- When `STELLA_TTS_PREROLL_MS` is not set, the playback head start now adapts to how fast the voice is being synthesised (200 ms to 3 s). A set value still pins it
- Speech recognition reports a real confidence for each final transcript and passes it to the agent. It was a constant before
- Both speech-recognition providers now share one turn detection, backed by Silero VAD. The sherpa provider (the default without a GPU) gains proper barge-in: it can tell speech from noise and reports when speech ends

**Voice capacity**
- A repeatable load test (`scripts/load-test`) raises the number of simultaneous simulated sessions until speech recognition or the voice slows or stutters. The admin dashboard shows the measured number for each server behind an info icon on the GPU card, with the GPU it was measured on, the date, and the reason when the number is zero. Nothing is limited by it; it tells you what a server carries

**Backup**
- Every import of a backup is recorded in an audit record with who did it, the outcome and the bundle, and an import can no longer erase that record (#380)

**Agent SDK**
- Agent SDK 0.7.0 on PyPI (`pip install stella-ai-agent-sdk==0.7.0`). For agent authors: an agent can open a turn itself, send commands to the device and receive device events and an idle signal; `process()` receives the transcript confidence as `metadata["stt_confidence"]`; `set_deliverable` and `batch_update` accept `correction`; emotion tags and persona variables are handled by the SDK. Details in the [SDK changelog](https://github.com/c4dhi/STELLA/blob/main/agents/stella-ai-agent-sdk/CHANGELOG.md)

### Changed

**Personas replace the plan's own prompt and voice**
- A plan no longer carries a system prompt or a voice; saving a plan with either is rejected, and the AI plan generator no longer writes them. Run the upgrade step above so existing plans keep their personality
- The persona slot is gone from the Agent Configurator. A value stored there is no longer read; no saved configuration becomes invalid
- Sessions paused before the upgrade keep their plan's own personality when they wake up (temporary fallback, removed one release after 1.3.0)

**For studies running plans**
- The face no longer falls asleep on its own timer during a session. It sleeps only when the agent sends it to sleep, which a plan session does not do
- "Can we stop?" is no longer handled by the task-extraction expert: it is told to call no tool for it. In companion mode the stop is asked about and decided separately; in a plan session nothing else decides it. If your plan relied on the participant ending a step that way, test it before your study
- `batch_update` now reports `tasks_addressed` in its result
- A required answer that was already collected can no longer be silently replaced by a later, worse one. The agent has to mark the change as a deliberate correction, every change is kept in the answer's history, and rejected attempts are logged. The default prompts in the configurator teach this; if your study edited the task-extraction prompt, compare it with the new default
- Speech confidence limit: in companion mode a message heard with a confidence below 0.4 cannot start or leave an activity or send her to sleep; she asks instead (Minimum Transcript Confidence in the Companion node, 0 switches it off). The value is not yet tuned on real sessions. Plan sessions only log the confidence

**Agents**
- `stella-light` is deprecated in favour of `stella-v2`. Existing deployments keep running and it can still be deployed when chosen, but it is shown last and marked in the gallery, and a deployment that names no agent type now gets `stella-v2`

**Backup**
- Backup bundles are encrypted by default, because they contain the deployment's secrets. A plaintext bundle needs both `--no-encrypt` and `--allow-plaintext-config`. `BACKUP_PASSPHRASE` is honoured for unattended export and restore (#380)

### Fixed

- Conversations now end on their own after the farewell. The last step of a plan leads to the end by default (in stored plans and in AI-generated ones), a session stuck on its last step is released to the end, a last step with no tasks is not ended early at the turn limit, and the Plan Builder no longer claims a plan will end when it will not (#452)
- An AI-generated plan now starts at its first step: the generated start was not mapped to the new step id
- Muting the microphone no longer makes Stella stutter or answer half-sentences. Mute now keeps the audio connection and sends silence instead of tearing it down, so speech recognition is not restarted on every mute, and the agent is told the mute was deliberate. Unmuting reuses the same connection. Note for researchers: while muted, the browser still holds the microphone (the browser's mic indicator stays on) but no sound is sent
- The opening phrase of a reply is no longer spoken twice, and the reply no longer acknowledges the same thing a second time after it (#627)
- A reply that arrived right at the opening phrase's time limit could make the agent leave the room mid-reply; the limit can no longer cancel the turn
- Background noise no longer makes the agent lower its voice and stay quiet, and a short "mhm" that did not take the turn is now marked as such in the transcript instead of looking like a turn the agent ignored
- Two sessions speaking at the same time on the Qwen3 voice no longer garble each other's audio: the shared model takes one sentence at a time (#463)
- A cancelled sentence no longer lets the next one start on the voice model while the first is still being synthesised, and the keep-warm run never overlaps a live sentence
- On iPhone and Safari, agent audio that the browser blocked now starts on the next tap
- A tool-calling expert is offered only the tools on its own list again. Loading a configuration dropped that list, so every such expert was offered every tool
- The Plan Builder keeps highlighted text aligned with what is typed
- The deploy dialog keeps a built-in persona the user picked when the mode changes
- Companion mode: a clear yes to a still-open "do you mean X?" starts the activity, repeated declines no longer let the question be asked without end, and an activity is recognised when its title is said without the first word
- Security updates for npm dependencies (Dependabot alerts), and upload errors are reported as a client error again

### Known limitations

- On the development server's Tesla T4 with the Qwen3 voice in streaming playback, one session already starves the voice (9.7% of playback against a 5% limit, judged with an 800 ms player pre-roll) and two sessions collapse, so its measured capacity is 0 (see the Voice capacity card). This is the T4 only; production's GPU has not been measured, and the sentence-by-sentence playback mode was not tested
- Dependency updates for the voice service (`transformers`, `huggingface-hub`, `faster-qwen3-tts`) are held until they have been tested on a GPU host; `transformers` stays pinned below 5.17 ([#665](https://github.com/c4dhi/STELLA/issues/665))
- In companion free conversation, speech recognition detects the language anew for each utterance unless the persona or the deployment declares one, so a short or unclear utterance can be heard in the wrong language. Declare a language for companion deployments

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
