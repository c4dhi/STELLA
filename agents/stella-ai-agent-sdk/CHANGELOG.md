# Changelog — STELLA Agent SDK

All notable changes to the `stella-ai-agent-sdk` package are documented here.

This package versions **independently of the STELLA platform** and is released to
[PyPI](https://pypi.org/project/stella-ai-agent-sdk/) on its own `sdk-v*` tags. The
platform's changelog lives [at the repository root](https://github.com/c4dhi/STELLA/blob/main/CHANGELOG.md).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Releases as 0.10.0 (`pyproject.toml` is already bumped). The platform contract: an agent declares itself in `agent.yaml`, uses the SDK, and needs no STELLA-side code or knowledge of STELLA internals.

### Added

- **The client channel as a protocol.** Screen events and agent commands are declared in `agent.yaml` (`client.events`, `client.commands`, each with an optional JSON Schema for its data); STELLA passes the declaration as `STELLA_CLIENT_CHANNEL`. The SDK refuses undeclared events and commands and data that does not fit (`send_client_command` raises `ValueError`). An event with a `request_id` gets a `client_event_reply`: what `on_client_event` returns, or its error. The channel is connected in `run.py`, so agents with their own `run_audio_loop` get events too. New dependency: `jsonschema` (reinstall the SDK, `pip install -e .`, in an existing venv). A command yielded from `process()` that is not declared is logged and dropped; the turn still ends.
- **Voice or text interface (`stella.interaction_mode`).** The SDK's own event, needing no declaration. In `"text"` mode nothing is spoken or waited for, playing speech stops, and spoken transcripts are not turns (typed messages are). `"voice"` switches back on the next line; TTS and STT stay connected. `AudioPipeline.set_interaction_mode()` / `.interaction_mode`.
- **Identity from the platform.** `BaseAgent` registers under `AGENT_TYPE` (the slug STELLA deployed and waits for) and `AGENT_VERSION`, falling back to the class name and `1.0.0` outside STELLA. Agents should stop setting `_agent_type`/`_agent_version`: a type that does not match the slug fails registration with "No pending session"
- **`SessionConfig`**: `AGENT_CONFIG`, typed, as `self.session` (with `self.persona` and `self.plan`). The platform keys are typed: `persona`, `mode`, `plan`, `available_plans` and `pipeline_config`, mirroring `PLATFORM_CONFIG_KEYS` in the backend's `src/agents/deploy-request.ts`, which owns the list (a test checks the two agree). Every other key is a user setting from `configSchema`, with `defaultConfig` already merged in: `self.session.config`. A malformed platform key is logged as a warning and ignored. `on_session_start` still gets the plain dict. JSON Schema for the backend: `contracts/agent-session-config.schema.json`
- **`self.plan_runtime`** (opt-in): one session's `StateMachineClient` from `STATE_MACHINE_ADDRESS` (default `session-management-server:50051`, override with `self.state_machine_address`), the plan loaded into it, and a `ToolRegistry` with the state machine tools. Nothing connects until `await self.plan_runtime.start(plan)`; `run_agent_from_env` closes it at teardown. stella-v2 and stella-light use it
- **Public room APIs** for agents that drive their own loop: `await self.wait_for_participant(timeout=None)` (first person in the room; `human_participants()`, `is_human_participant()`, `NON_HUMAN_PREFIXES`), `await self.publish_progress(progress)` (also re-sent to late joiners), `await self.complete_session(reason)` (completion overlay, stops the loop) and `record_message_processed()`. On `AudioPipeline`: `publish_data()` and `participant_identities()`
- **SDK-owned env vars** declared once in `stella_agent_sdk.platform_env` (name, description, default, group): `INTERRUPT_MODE`, `TRANSCRIPT_DEBOUNCE_MS`, `BARGE_IN_*`, `STELLA_LANGUAGE`, `TTS_*`, `STELLA_TTS_*`, `STELLA_TELEPROMPTER_ENABLED`, `STELLA_EMOTION_TAGS_ENABLED`. Exported as `contracts/sdk-platform-env.json` for the backend and UI to merge with what a manifest declares. Agents can drop them from `agent.yaml` once the backend merges this list
- **SDK version reporting.** `RegisterAgentRequest.sdk_version` (proto field 4) carries the installed `stella-ai-agent-sdk` version (`self.sdk_version`, also in `get_health_status()`), so STELLA can refuse SDKs older than it supports
- `python -m stella_agent_sdk.contracts` regenerates both contract files; a test fails when they are stale or when the SDK reads a tuning env var that is not declared
- `self.connectors` on `BaseAgent`: call outside MCP servers the user bound to the deployment ("connectors") through STELLA's backend, which keeps the credentials. `await self.connectors.list()`, `list_tools(handle)` and `call_tool(handle, tool, args)`. `call_tool` returns the tool's structured content (or its parsed text). Failures raise `ConnectorError`, whose `code` says what went wrong and whose `retryable` says whether trying again can help. `run_agent` wires it from `STELLA_CONNECTOR_TOKEN`; without connectors, `list()` is `[]`. New gRPC contract `proto/connectors.proto` (`ConnectorService`). See docs: Agent SDK → Connectors

### Fixed

- **`wait_for_participant()` waits for the session's participant, not an organiser watching.** It counted anyone who is not an agent or service, so an agent that speaks first (ELIAS) started as soon as the admin opened the session page. It now waits for a `participant-*` identity (invitation link, public project or manual registration), the same rule the plan's join and leave messages already used. New: `self.session_participants()`, `is_session_participant()` and `SESSION_PARTICIPANT_PREFIX`; `human_participants()` is unchanged
- `enqueue_sentence` with `TTS_ENABLED=false` no longer starts a speech worker that tries to synthesise.
- **A typed message sent while the agent speaks is no longer lost.** With barge-in off, a `user_text` message queued behind the closed transcript gate was dropped as "stale" when the gate reopened, although the chat had already shown it as sent. Typed events (`TranscriptEvent.typed`) now survive the gate; speech heard while the agent talked is still dropped.

## [0.9.0] - 2026-10-28

Ships with STELLA 1.5.0. What changes for agent authors:

### Added

- `BaseAgent.get_chat_history()` takes `before`, an ISO timestamp cursor, so an agent can page back past the 500-message cap. The v2 agent uses it to find a long activity's start (#727)
- Each sentence long enough to measure (`_MIN_MEASURABLE_AUDIO_MS`) publishes a `tts_sentence_speed` analytics event: `audio_ms`, `synth_ms`, `rtf` and the `playback` mode it played in. The `auto` switch to `sentence` publishes `tts_playback_switch` once, with `rtf` and `slow_sentences`. Neither carries `elapsed_ms`, so the latency stats and stage timeline skip them. Platform Defaults scores the hardware from these (#765)

## [0.8.0] - 2026-10-21

Ships with STELLA 1.4.0. What changes for agent authors:

### Added

- `TranscriptEvent` carries `trailing_silence_ms`, `decode_ms`, `speech_ms` (None when STT does not send them) and `rescued_pauses` from the STT final. The pipeline puts the first three on `stt_end`, emits one `pause_rescued` per rescued pause, and emits `user_resumed_after_final` when a new utterance starts within `RESUMED_AFTER_FINAL_WINDOW_MS` (3000) of a turn's final, on that turn's id. `_emit_analytics_event` takes an explicit `turn_id` for events that land after their turn. Logging only (#763)
- `BaseAgent.publish_turn_language()` publishes a `turn_language` envelope per user turn (built by `language.turn_language_record`): detected language and confidence, VAD speech length (`AudioPipeline.utterance_speech_seconds`), word count of the free decode, resolved language, and whether it was re-decoded, plus the frontend `correlation_id` for typed turns. No transcript text. `send_turn_language()` does the same in the background, which is what the v2 and light agents call from `_resolve_language`, so the publish never delays the reply; the recorder forwards it and the backend merges it into the turn's message (#759)
- `stream_completion()` takes `first_token_timeout` and `retry_first_token_timeout`. A call with no first token within the budget is abandoned and started once more with the retry budget. If that one stalls too, it raises `FirstTokenTimeout`. Once a stream has started there is no limit. Both are logged as `[REPLY-TIMEOUT]` and `[REPLY-RETRY]`, with `log_context`. The v2 agent uses 4 s and 2 s (#684)
- The `[TTS] Playback mode` log line says where the mode came from (`from the deployment`, `from the platform default`, `from the built-in default`) when the backend sets `STELLA_TTS_PLAYBACK_SOURCE`. Unset, the line is unchanged (#756)

### Changed

- The default model is `gpt-5.4-mini` (was `gpt-4o-mini`): `LLMConfig.model` and the barge-in evaluator. An agent that sets a model keeps it.
- The state machine tool guidance tells the model how a goal-oriented phase ends: complete or skip its one task, `__goal__`, and never store an answer under a "goal reached" key.
- `STELLA_TTS_PLAYBACK` defaults to `auto` (unset means `auto` too). A session starts in `stream` and switches once to `sentence` — never back — after 3 consecutive sentences synthesize slower than real time. `stream`/`sentence` still pin the mode outright with no switching (#669)
- A short utterance dropped because the agent held the floor is now logged (`[GATE] Not taken as a turn`). In turn-based mode it is now also published to the transcript, marked as discarded, as it already was with barge-in.
- `bridge_tts_done` is emitted once per turn, when the bridge's last sentence has played, instead of after every bridge sentence. It carries `bridge_playback_ms`, the time from the bridge's first audible byte to its end. `bridge_tts_done` and `response_tts_done` now mark when the last sentence is heard (push time plus the audio still queued for playout), not when its last frame was handed to LiveKit.
- `LanguageResolver` switches the session language on a decaying confidence score (`text_bar` / `decay` / `switch_score`) instead of a fixed confidence threshold plus a count of consecutive turns (`switch_threshold` / `debounce`, removed). Evidence against the current lock now accumulates across a mixed run of turns rather than needing a streak, and a genuine switch spoken at merely moderate, sustained confidence can no longer be structurally unable to switch at all. A doubtful turn's own transcript can also be re-decoded forced into the current lock for display, via a new STT `Redecode` RPC — this never feeds back into the switching decision, which only ever sees the original free decode.

  **For researchers running multilingual studies:** a session's transcription no longer re-guesses the language on every turn in free conversation (no declared plan language); it holds the detected language through short or ambiguous turns and follows a real language switch within a few turns, the same way spoken replies already did. `switch_threshold`/`debounce` in a pipeline configuration are now silently ignored — set `text_bar` (default 0.85), `decay` (0.5) and `switch_score` (1.5) instead (#685)
- `LanguageResolver` locks the first language only on a detection of at least `detect_threshold`, now 0.9 by default (was 0.4), and a confirmed lock switches outright on one off-lock turn of 4+ words at `instant_switch_threshold` (new, default 0.9). Less confident turns still go through the decay build-up (#758)
- `LanguageResolver.deployment_pin` (#699): the deployment's own language pin (`STELLA_LANGUAGE`, or a configured `force`), captured once and never overwritten by a later `set_plan_language` call — unlike `forced`, which still reflects whichever source called most recently. Lets a companion-mode caller tell "the operator pinned this deployment" apart from "a plan or persona happened to set `forced`", since only the former outranks the persona.

  **For researchers running companion-mode studies with mixed-language activities:** a companion conversation no longer gets stuck in an activity's language after that activity ends. The session keeps the language it was pinned to (by the deployment, or the persona) or had detected, through an activity whose own content was written in a different language, inside it and after it — the activity's language is only ever mentioned to the model as a translation note, never applied to speech recognition or the voice.

## [0.7.0] - 2026-10-07

Ships with STELLA 1.3.0. What changes for agent authors:

### Added

- An agent can open a turn itself: `start_turn(**metadata)` queues a turn nobody spoke. `process()` is called with empty text and `input.metadata["agent_initiated"]`, and what it yields is published and spoken like any reply. It waits behind a running turn and is replaced by a message the user sends meanwhile.
- Device channel: `AgentOutput.client_command(session_id, command, **data)` is yielded from `process()` and delivered once the turn's speech has been heard (a turn the user interrupted drops its commands); `send_client_command()` sends one outside a turn. `on_client_event(session_id, event, data)` receives whatever the client sent as `{"type": "client_event"}`. Which commands and events exist is agreed between an agent and its client.
- Idle signal: set `idle_timeout_seconds` and `on_idle(session_id, idle_seconds)` fires once per quiet stretch. Off by default.
- `process()` receives the transcript confidence as `input.metadata["stt_confidence"]` (typed text is 1.0; 0.0 means the provider gave no signal). It was a constant before.
- Emotion tags: inline `[tags]` in a reply are stripped before anything is spoken or published and sent to the client as cues with character offsets into the spoken text. `stella_agent_sdk.emotion` exports `strip_emotion_tags`, `EmotionCue` and the tag sets; an agent that does not want this sets `supports_emotion_tags = False`.
- Persona variables: prompt templates resolve `{{persona.<key>}}` (author-defined variables first, then the built-in name, voice and language).
- `StateMachineClient.load_plan(plan)` and `clear_plan()`, for an agent that switches plans within a session.
- `AgentOutput.tool_call(...)` and `AgentOutput.decision(...)` report an executed function call or a routing decision on the debug channel, so an operator can see what the agent decided.
- `set_deliverable` and `batch_update` accept `correction` (default false): a participant's deliberate change to an already-collected answer. A settled required deliverable is now rejected by the state machine without it, so a later, worse answer can no longer replace it silently. `StateMachineClient.set_deliverable(..., correction=False)` and the `SetDeliverableRequest.correction` field carry it.
- `STELLA_TTS_PLAYBACK` (`stream` default, or `sentence`): `sentence` waits for the whole sentence to be synthesized before playing it, as 1.1.0 did, for TTS providers slower than real time. Barge-in and the teleprompter work in both modes; an unknown value logs a warning and uses `stream`.

### Changed

- When `STELLA_TTS_PREROLL_MS` is not set, the playback head start adapts to the measured synthesis speed (200 ms to 3 s): it rises at once when playback ran dry and falls slowly. A set value still pins it.
- A participant's deliberate mute (`audio_stream_mute` / `audio_stream_unmute` data messages) no longer restarts the STT stream. The track stays published; on mute the room feeds `STELLA_MUTE_SILENCE_MS` (default 3000) of real-time silence so the in-flight utterance finalizes like any pause. The end-of-audio sentinel from a real track unsubscribe (#165) is unchanged.
- A backchannel that ducked the agent but did not take the floor is marked `discarded` in the transcript instead of appearing as a delivered turn.

### Fixed

- A duck that is never confirmed as an interruption lifts by itself after `BARGE_IN_DUCK_TIMEOUT_MS` (default 1200), so background noise can no longer keep the agent quiet for the rest of a sentence.
- An audio loop that dies or is cancelled from inside a turn is now logged; its exception was never retrieved before.

## [0.6.0] - 2026-09-25

Ships with STELLA 1.2.0. What changes for agent authors:

### Added
- `set_deliverable` and `batch_update` (and `StateMachineClient.set_deliverable`) accept `unconfirmed=True` for something the user mentioned in passing but hasn't confirmed. It is stored with status `partial`, and setting the key again without the flag confirms it.
- Language pinning: `STELLA_LANGUAGE` fixes a deployment to one language, and `LanguageResolver.set_plan_language()` lets a plan's declared language pin speech recognition from the first utterance.
- `TranscriptEvent.decode_diagnostics`: optional speech-recognition decode metrics, filled when the STT service runs with `STT_DECODE_DIAGNOSTICS=1`.
- `TTS_PROGRESS_TICK_MS`: how often teleprompter progress is emitted during playback (default 200 ms).

### Changed
- Speech plays sentence by sentence as it is synthesized, behind a jitter buffer (`STELLA_TTS_PREROLL_MS`, default 200 ms) with an underrun guard. Synthesis is serialized per session.
- Barge-in: the agent ducks its voice on the first sound (`BARGE_IN_DUCK_GAIN`, default 0.25), yields once the STT service reports enough voiced audio, and can resume from where it paused. `on_barge_in` judges the final transcript of the whole utterance, after the agent has already ducked and yielded.
- `TRANSCRIPT_DEBOUNCE_MS` defaults to 0 (was 300).
- LangChain clients are pooled and reused across calls.

### Fixed
- Teleprompter progress tiles each sentence and no longer trails the voice.
- Analytics anchor every turn, typed turns included.

## [0.5.0] - 2026-09-08

First public release. The SDK has been used in production inside STELLA for some
time; this is the first version published to PyPI, so the entries below describe
what the package provides rather than what changed since a previous release.

### Added

**Agent interface**
- `BaseAgent` — the class agents implement. Two required methods, `process()` and
  `on_interrupt()`, plus optional lifecycle hooks: `on_session_start`,
  `on_session_end`, `on_session_ending`, `on_ready`, `on_barge_in`,
  `on_config_update`, and `run_audio_loop`
- `run_agent_from_env()` — the single entry point. Reads all connection settings
  from the environment, connects LiveKit, STT, TTS and the session server, and
  runs the agent

**Message types**
- `AgentInput` / `AgentOutput` with factories for streaming and final text,
  status, metadata, and errors. Streamed chunks share a `transcript_id` so a
  client can assemble them into one message
- Progress tracking types (`ProgressState`, `ProgressGroup`, `ProgressItem`) and
  `progress_from_full_state()`, the canonical state-machine-to-progress transform
- Plan types (`Plan`, `PlanState`, `PlanTask`, `PlanDeliverable`,
  `SessionContext`) and `normalize_plan()`

**Prompt compiler**
- Versioned `{{placeholder}}` compiler resolving authored prompts against live
  runtime state. `prompts.compile(template, version=...)` requires an explicit
  version, so upgrading the SDK can never silently change how an agent's prompts
  resolve

**Tools**
- `BaseTool`, `ToolRegistry` and `ToolExecutor`, with a built-in state-machine
  toolbox (get state, get/complete/skip tasks, get/set deliverables, batch
  updates, guidance)

**Audio and transport**
- LiveKit room management, streaming TTS playout with barge-in support, and
  language resolution
- Pre-generated gRPC stubs for the agent, state-machine, STT and TTS services —
  no protoc run is needed at install time
- `py.typed`, so consumers get full type information

### Notes

- Requires Python 3.10 or newer. Verified on 3.10 through 3.14, Linux and macOS.
- The SDK is a **client for STELLA infrastructure**. An agent built with it needs
  a reachable LiveKit server, STT and TTS services, and a session-management
  server; it does not run standalone.
- Marked `Development Status :: 3 - Alpha`. The API is in use and stable in
  practice, but is not yet covered by a semver compatibility promise.
