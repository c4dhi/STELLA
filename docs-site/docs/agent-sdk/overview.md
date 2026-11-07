---
sidebar_position: 1
title: "📚 Overview"
---

# 📚 Agent SDK Overview

The STELLA Agent SDK (`stella-ai-agent-sdk`, imported as `stella_agent_sdk`) is the communication layer between your agent and STELLA. You write a subclass of `BaseAgent` that turns user input into replies. The SDK does the rest: it joins the LiveKit room, sends the user's audio to the STT service, sends your replies to the TTS service, publishes text to the screen, and registers the agent with the session-management server.

The SDK has no LLM, RAG or expert logic of its own. Which model you call, and how, is up to your agent.

| The SDK handles | You write |
|-----------------|-----------|
| LiveKit room connection, audio in and out | `process()`: input in, replies out |
| Speech-to-text and text-to-speech (gRPC services) | Prompts and LLM calls |
| Sentence splitting, playback, barge-in | Your own tools |
| Session lifecycle, registration, health | What to do at session start and end |
| Typed session config, plans, connectors, chat history | Which of these your agent uses |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    LiveKit Room                             │
│  ┌──────────┐                        ┌──────────────────┐   │
│  │  User    │ ◄─── audio/data ─────► │  Agent (SDK)     │   │
│  └──────────┘                        └────────┬─────────┘   │
└────────────────────────────────────────────────┼────────────┘
                                                 │ gRPC
                      ┌──────────────────────────┼──────────┐
                      │   Kubernetes Cluster     │          │
                      │  ┌───────────┐    ┌──────▼──────┐   │
                      │  │ STT Svc   │    │  TTS Svc    │   │
                      │  └───────────┘    └─────────────┘   │
                      └─────────────────────────────────────┘
```

For every final transcript (or typed chat message) the SDK calls your `process()` with an `AgentInput`. What `process()` yields as `AgentOutput` is published to the screen and spoken.

## The smallest agent

```python
import asyncio
from typing import AsyncIterator

from stella_agent_sdk import AgentInput, AgentOutput, BaseAgent, run_agent_from_env


class EchoAgent(BaseAgent):
    async def process(self, input: AgentInput) -> AsyncIterator[AgentOutput]:
        yield AgentOutput.text_final(input.session_id, f"You said: {input.text}")

    async def on_interrupt(self, session_id: str) -> None:
        pass


if __name__ == "__main__":
    asyncio.run(run_agent_from_env(EchoAgent()))
```

`process()` and `on_interrupt()` are the only abstract methods. `run_agent_from_env()` is the only entry point: it reads its connection settings from environment variables that STELLA sets on the agent pod (see [Getting Started](./getting-started.md#run-it-locally) to set them by hand).

## What the SDK gives an agent

| Name | What it is | Read more |
|------|------------|-----------|
| `BaseAgent` | The class you subclass: `process()`, lifecycle hooks, helpers | [Base Agent](./base-agent.md) |
| `AgentInput`, `AgentOutput` | What `process()` receives and yields (`AgentOutput.text_chunk`, `text_final`, `status`, `progress_update`, …) | [Message Types](./message-types.md) |
| `run_agent_from_env` | Connects everything and runs the agent | [Getting Started](./getting-started.md) |
| `self.audio` | The audio pipeline (`audio_in()`, `publish_text()`, `speak()`, `stop_speaking()`), for agents that run their own loop | [Audio Pipeline](./audio-pipeline.md) |
| `self.session`, `self.persona`, `self.plan` | `AGENT_CONFIG`, typed (`SessionConfig`, `PersonaConfig`) | [Platform Contract](./platform-contract.md#session-config) |
| `self.plan_runtime` | The plan state machine and its tools (`PlanRuntime`) | [Platform Contract](./platform-contract.md#plans-selfplan_runtime) |
| `BaseTool`, `ToolRegistry`, `ToolExecutor`, `ToolCall`, `ToolResult` | Tools for your LLM | [Tools](./tools.md) |
| `self.connectors` | Outside MCP servers, called through STELLA's backend (`ConnectorsClient`) | [Connectors](./connectors.md) |
| `ProgressState`, `ProgressGroup`, `ProgressItem` | The task panel on the user's screen | [Progress Tracking](./progress-tracking.md) |
| `self.get_chat_history()` | The session's recorded messages, as `ChatMessage` objects | [Base Agent](./base-agent.md#chat-history) |
| `stella_agent_sdk.prompts` | The versioned `{{placeholder}}` prompt compiler | [Prompt Compiler](./prompt-compiler.md) |

The package's `__all__` in `stella_agent_sdk/__init__.py` is the full public API. An agent is described to STELLA by its [`agent.yaml`](./agent-manifest.md), not by code.

## Installation

The SDK needs Python 3.10 or newer.

```bash
pip install "stella-ai-agent-sdk>=0.10.0"
```

STELLA refuses to deploy an agent built with an SDK older than it supports, so pin at least the version in your manifest's `sdk.minVersion`.

## Next steps

- [Getting Started](./getting-started.md): write, run and package a first agent
- [Base Agent](./base-agent.md): every hook and helper on `BaseAgent`
- [Platform Contract](./platform-contract.md): what STELLA hands the agent, and what it expects back
- [The agent manifest](./agent-manifest.md): `agent.yaml`
- [Building Custom Agents](./building-custom-agent.md): a longer tutorial
