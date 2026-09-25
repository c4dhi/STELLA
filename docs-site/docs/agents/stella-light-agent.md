---
sidebar_position: 4
title: "💫 stella-light-agent (deprecated)"
---

# 💫 stella-light-agent

:::danger Deprecated — use stella-v2
This agent is superseded by [stella-v2](./stella-v2/index.md) and is no longer developed. Existing deployments keep running and their saved configurations stay valid, but **do not choose it for new work**.

**If you came here for lower cost**, save a stella-v2 configuration with only the experts you need enabled (the Expert Pool node has a per-expert on/off). You get comparable per-turn cost and keep everything stella-light never grew.
:::

## Why it was deprecated

Its pitch was "faster and cheaper". Only half of that survived.

**Cheaper still holds** — roughly two LLM calls per turn against stella-v2's seven-plus — but that is now a stella-v2 *configuration*, not a reason for a second codebase.

**Faster no longer holds.** stella-v2 gained a bridge generator: it starts speaking a short opening beat immediately, while the rest of the pipeline runs behind it. stella-light has no bridge, so it waits in silence for its single call to finish. On *perceived* latency — the only latency that matters in a spoken conversation — stella-light is now the slower of the two. It also emits no analytics, so that gap is invisible on the dashboard.

Meanwhile the divergence cost was real. The two agents run the **same plans**, and features kept landing in stella-v2 only: the bridge, analytics, companion mode, persona token resolution. A plan authored with `{{persona.name}}` read correctly under stella-v2 and printed the raw token under stella-light — and plan prose is spoken aloud.

## Migrating

| You used stella-light for… | Do this instead |
|---|---|
| Lower per-turn cost | A stella-v2 configuration with only `task_extraction` and `noise_detection` enabled |
| A simple agent to develop against | stella-v2 with its default configuration |
| Faster replies | stella-v2 — the bridge makes it start speaking sooner |

Nothing about your plans, personas or sessions changes: those are shared, and both agents drive the same state machine through the same SDK.

## Overview

`stella-light-agent` provides a streamlined voice AI pipeline that sacrifices some advanced features for improved performance:

- Lower memory footprint
- Simpler configuration
- Fewer LLM calls per turn

## Comparison with stella-agent

| Feature | stella-agent | stella-light-agent |
|---------|-------------|-------------------|
| STT Quality | High | Good |
| Response Latency | ~2-3s | ~1-2s |
| Memory Usage | 512Mi-2Gi | 256Mi-1Gi |
| Tool Calling | Yes | Limited |
| Progress Tracking | Yes | Basic |
| Conversation History | Full | Limited |

## When to Use

Choose `stella-light-agent` when:

- **Development/Testing**: Faster iteration cycles
- **Simple Conversations**: Q&A, basic support
- **Resource Constraints**: Limited cluster resources
- **Cost Optimization**: Lower compute costs
- **Low Latency Required**: Interactive demos

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key | Required |
| `OPENAI_MODEL` | Model to use | `gpt-4o-mini` |
| `STT_PROVIDER` | Speech-to-text provider | `sherpa` |
| `TTS_PROVIDER` | Text-to-speech provider | `kokoro` |
| `MAX_HISTORY` | Max conversation turns to keep | `5` |

## Pipeline

The light agent uses a simplified pipeline:

```
Audio In → STT → LLM → TTS → Audio Out
```

Key differences from stella-agent:
- Minimal preprocessing
- Shorter context window
- Direct response streaming
- Limited tool support

## Resource Requirements

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 100m | 500m |
| Memory | 256Mi | 1Gi |

## Data Channel Messages

Similar to stella-agent but with a reduced message set:

```typescript
// Transcript updates
{
  type: 'transcript_chunk',
  data: {
    text: string,
    is_final: boolean
  }
}

// Agent status
{
  type: 'agent_status',
  data: {
    status: 'listening' | 'speaking'
  }
}
```

## Deployment

Deploy via the API:

```bash
curl -X POST http://localhost:3000/sessions/{sessionId}/agents \
  -H "Content-Type: application/json" \
  -d '{
    "role": "conversational-ai",
    "agentType": "stella-light-agent"
  }'
```

Or via the Frontend UI by selecting "stella-light-agent" from the agent type dropdown.

## Performance Tuning

### Reduce Latency

1. Use a smaller LLM model (`gpt-4o-mini` vs `gpt-4o`)
2. Reduce `MAX_HISTORY` to minimize context
3. Use local STT/TTS services

### Reduce Memory

1. Lower `MAX_HISTORY` value
2. Disable unused features
3. Use streaming for all responses

## Limitations

- **Limited Tool Support**: Only basic tools available
- **Shorter Context**: May lose context in long conversations
- **Basic Progress Tracking**: No detailed todo management
- **Simpler Prompts**: Less nuanced conversation handling

## Upgrading to stella-agent

If you outgrow stella-light-agent:

1. Update the agent type in your deployment
2. Increase resource limits in your pod configuration
3. Add any additional environment variables for new features
4. Update your plans to use advanced features

## See Also

- [stella-agent](./stella-agent/index.md) - Full-featured agent
- [Agents Overview](./overview.md) - Agent comparison
- [First Agent](../getting-started/first-agent.md) - Deployment guide
