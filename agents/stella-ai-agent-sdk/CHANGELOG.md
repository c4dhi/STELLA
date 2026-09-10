# Changelog — STELLA Agent SDK

All notable changes to the `stella-ai-agent-sdk` package are documented here.

This package versions **independently of the STELLA platform** and is released to
[PyPI](https://pypi.org/project/stella-ai-agent-sdk/) on its own `sdk-v*` tags. The
platform's changelog lives [at the repository root](https://github.com/c4dhi/STELLA/blob/main/CHANGELOG.md).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
package uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
