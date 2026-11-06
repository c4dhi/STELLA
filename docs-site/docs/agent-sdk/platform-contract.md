---
sidebar_position: 10
title: "📜 Platform Contract"
---

# 📜 Platform Contract

An agent is its `agent.yaml` plus code written against the SDK. STELLA needs no code of its own per agent, and the agent needs to know nothing about STELLA beyond the SDK. This page lists what the SDK gives an agent for that (stella-ai-agent-sdk 0.10 and later).

## Identity

The agent registers under the `AGENT_TYPE` and `AGENT_VERSION` that STELLA sets on the pod: the slug and version from `agent.yaml`. Don't set `_agent_type` yourself. If the type doesn't match the slug STELLA deployed, registration fails with "No pending session". Outside STELLA, the type falls back to the class name.

The SDK also reports its own version (`self.sdk_version`) when it registers, so STELLA can refuse agents built with an SDK older than it supports.

## Session config

`self.session` is `AGENT_CONFIG`, typed (`SessionConfig`). The first five fields are the platform keys STELLA sets (`PLATFORM_CONFIG_KEYS` in `src/agents/deploy-request.ts`). Every other key comes from the agent's own `defaultConfig`, unchanged: a deployment has no per-agent settings, and what a deployer chooses reaches the agent as an env var.

| Field | What it is |
|-------|------------|
| `persona` | The deployed Persona (`name`, `system_prompt`, `voice`, `language`, `variables`, …), also as `self.persona` |
| `mode` | `"companion"`, or `None`/`"plan"` to follow a plan |
| `plan` | The plan to follow, also as `self.plan` (inline plans only) |
| `available_plans` | Companion mode: the activities it may offer |
| `pipeline_config` | The Agent Configurator's saved configuration |
| `config` | The agent's own `defaultConfig` from `agent.yaml`. A deployment can't change it: whatever the deploying user chooses reaches the agent as an env var (see `env` in the manifest) |

Connectors aren't part of `AGENT_CONFIG`; list them with `await self.connectors.list()`.

```python
async def on_session_start(self, session_id, config):
    await super().on_session_start(session_id, config)   # parses self.session
    project = os.environ["ELIAS_PROJECT_ID"]          # declared under env.required
    greeting_name = self.persona.name if self.persona else "there"
```

`on_session_start` still receives the plain dict. A platform key that doesn't fit is logged as a warning and ignored, so one bad value never stops the agent from starting. The JSON Schema is in `agents/stella-ai-agent-sdk/contracts/agent-session-config.schema.json`.

## Plans: `self.plan_runtime`

To follow a plan, use the plan runtime instead of building a `StateMachineClient` yourself. It is opt-in: nothing connects until you call `start()`.

```python
if self.plan or self.session.is_companion:
    await self.plan_runtime.start(self.plan)       # connect, load the plan, build tools
    registry = self.plan_runtime.tools             # ToolRegistry with the state machine tools
    sm = self.plan_runtime.client                  # StateMachineClient for this session
```

The address comes from `STATE_MACHINE_ADDRESS`, which STELLA sets on every pod. Set `self.state_machine_address` to override it. `run_agent_from_env` closes the connection at teardown. Your own tools go on the same registry.

## Agents that drive their own loop

| Call | What it does |
|------|--------------|
| `await self.wait_for_participant(timeout=None)` | Waits until a person is in the room and returns their identity. Agents and services are skipped (`is_human_participant`) |
| `self.human_participants()` | The people in the room now |
| `await self.publish_progress(progress)` | Sends the task panel state outside a turn. The SDK re-sends it to anyone who joins later |
| `await self.complete_session(reason)` | Waits for speech to finish, shows the completion overlay, and stops the loop |
| `self.record_message_processed()` | Counts a handled message for health reporting |

## When the session ends

When the time cap runs out or the organiser ends the session, the SDK asks the agent what to do with `session_end_mode()`:

| Mode | What happens |
|------|--------------|
| `farewell` (default) | The SDK speaks the plan's farewell, or a built-in goodbye. `on_session_ending` is **not** called |
| `wrap_up` | The SDK calls `on_session_ending(session_id, reason, deadline_ms)` while the room is still live. What it yields is spoken; if it yields nothing, the farewell is spoken instead |
| `silent` | The session just closes |

By default `session_end_mode()` reads the `SESSION_END_MODE` env var. An agent with work to do at a real session end overrides it and returns `wrap_up`; otherwise its `on_session_ending` never runs. ELIAS-Interviewer does this to close the ELIAS interview. Stella Light overrides it to read its Configurator's `interrupt_handler` node instead.

`on_session_end` runs on every teardown, including an auto-pause, so it is the place to flush, not to finish.

## Environment variables the SDK owns

The voice pipeline's tuning variables (`INTERRUPT_MODE`, `TRANSCRIPT_DEBOUNCE_MS`, `BARGE_IN_*`, `STELLA_LANGUAGE`, `TTS_*`, `STELLA_TTS_*`, `STELLA_TELEPROMPTER_ENABLED`, `STELLA_EMOTION_TAGS_ENABLED`) and `SESSION_END_MODE` belong to the SDK. The SDK declares them once, with their defaults, in `stella_agent_sdk.platform_env`. They are exported as `contracts/sdk-platform-env.json`, which STELLA merges with what a manifest declares. An agent's `agent.yaml` only needs to declare its own variables.
