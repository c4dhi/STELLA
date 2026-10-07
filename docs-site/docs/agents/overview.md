---
sidebar_position: 1
title: "Overview"
---

# Agents Overview

STELLA supports multiple agent types, each designed for different use cases. All agents connect to LiveKit rooms for real-time voice and data communication.

## Agent Types

| Agent | Description | Best For |
|-------|-------------|----------|
| **stella-v2** | Streamlined 5-stage pipeline with deterministic arbitration and configurable pipeline | Configurable deployments, lower latency, predictable behavior |
| **stella-agent** | Full-featured agent with LLM-based aggregation pipeline | Production conversations requiring high quality |
| **stella-light-agent** | ⚠️ **Deprecated** — superseded by stella-v2 | Nothing new. Use stella-v2 with a lean expert configuration |
| **echo-agent** | Simple test agent that echoes back messages | Testing and development |

## Architecture

All STELLA agents follow a similar pipeline architecture and can be configured with **Plans** — JSON-based conversation blueprints that define states, tasks, and data collection. See the [Plan Structure](../plan-structure/index.md) documentation for details.

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Pipeline                           │
│                                                                 │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │  Audio   │ -> │   STT    │ -> │   LLM    │ -> │   TTS    │  │
│  │  Input   │    │ (Speech  │    │(Response │    │  (Text   │  │
│  │(LiveKit) │    │  to Text)│    │Generation│    │ to Speech│  │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘  │
│                                                       │         │
│                                                       ▼         │
│                                              ┌──────────────┐   │
│                                              │ Audio Output │   │
│                                              │  (LiveKit)   │   │
│                                              └──────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Choosing an Agent

### stella-v2

Use `stella-v2` when you need:
- Configurable pipeline with visual Pipeline Configurator
- Lower response latency (deterministic arbitration instead of LLM synthesis)
- Predictable, debuggable expert conflict resolution
- Reusable pipeline configurations across deployments
- Bridge generation for reduced perceived latency in voice conversations

### stella-agent

Use the full-featured `stella-agent` when you need:
- High-quality speech recognition
- Advanced conversation capabilities
- Custom tool integration
- Complex dialogue flows
- Production deployments

### stella-light-agent (deprecated)

**Do not choose this for new work.** It is superseded by `stella-v2` and no longer developed; existing deployments keep running.

If you wanted it for lower cost, use `stella-v2` with only the experts you need enabled — the Expert Pool node has a per-expert on/off switch. You get comparable per-turn cost and keep the bridge (so the agent starts speaking immediately instead of waiting in silence), analytics, and companion mode. See [stella-light-agent](./stella-light-agent.md) for the full rationale and a migration table.

### echo-agent

Use `echo-agent` for:
- Testing LiveKit connectivity
- Verifying audio pipeline
- Development debugging

## Common Configuration

All agents support these common environment variables:

| Variable | Description | Required |
|----------|-------------|----------|
| `LIVEKIT_URL` | LiveKit server URL | Yes |
| `LIVEKIT_API_KEY` | LiveKit API key | Yes |
| `LIVEKIT_API_SECRET` | LiveKit API secret | Yes |
| `OPENAI_API_KEY` | OpenAI API key for LLM | Yes |
| `ROOM_NAME` | LiveKit room to join | Yes |
| `PARTICIPANT_IDENTITY` | Agent's identity in the room | Yes |

## Resource Requirements

| Agent | CPU Request | CPU Limit | Memory Request | Memory Limit |
|-------|-------------|-----------|----------------|--------------|
| stella-v2 | 500m | 2000m | 512Mi | 2Gi |
| stella-agent | 250m | 1000m | 512Mi | 2Gi |
| stella-light-agent | 100m | 500m | 256Mi | 1Gi |
| echo-agent | 50m | 200m | 128Mi | 512Mi |

## Lifecycle

1. **Created**: Backend creates a Kubernetes pod with agent configuration
2. **Starting**: Agent initializes and connects to LiveKit room
3. **Running**: Agent processes audio and responds to participants
4. **Stopping**: Graceful shutdown when session ends or agent is stopped
5. **Terminated**: Pod is deleted, resources freed

## Next Steps

- [stella-v2](./stella-v2/index.md) - Streamlined pipeline with configurator
- [stella-agent](./stella-agent/index.md) - Full-featured agent details
- [stella-light-agent](./stella-light-agent.md) - ⚠️ Deprecated; migration guidance
- [echo-agent](./echo-agent.md) - Test agent details
- [Agent SDK](../agent-sdk/overview.md) - Build custom agents
