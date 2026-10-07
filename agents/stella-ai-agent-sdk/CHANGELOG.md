# Changelog — STELLA Agent SDK

All notable changes to the `stella-ai-agent-sdk` package are documented here.

This package versions **independently of the STELLA platform** and is released to
[PyPI](https://pypi.org/project/stella-ai-agent-sdk/) on its own `sdk-v*` tags. The
platform's changelog lives [at the repository root](https://github.com/c4dhi/STELLA/blob/main/CHANGELOG.md).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
