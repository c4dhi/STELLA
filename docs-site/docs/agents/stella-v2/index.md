---
sidebar_position: 1
title: "Overview"
---

# stella-v2

A streamlined voice AI pipeline with deterministic arbitration, parallel expert execution that self-gates, and a configurable pipeline architecture.

## Why V2?

stella-agent (V1) routes messages through an **LLM-based Aggregator** that synthesizes expert findings into a final response. This works but introduces two problems:

1. **Latency**: The Aggregator adds ~500ms of LLM inference on top of expert execution, making the full UNSAFE path slow.
2. **Non-determinism**: Two identical expert outputs can produce different aggregated responses, making behavior hard to predict and debug.

stella-v2 replaces the Aggregator with **deterministic Arbitration** (~1ms) — a priority-based conflict resolver that selects the winning expert verdict and injects it as context into the Response Generator. This makes the pipeline faster and predictable.

V2 also adds a **Bridge Generator** that produces an ultra-short spoken phrase (e.g., "Good question.") immediately when the user stops speaking. This phrase is synthesized and played via TTS while the full pipeline runs in parallel, reducing perceived latency significantly.

## Pipeline Architecture

```
                                  ┌────────────────────┐
                                  │  Bridge Generator  │
                                  │  (~100ms, 6 words) │
                                  └─────────┬──────────┘
                                            │ bridge phrase (non-blocking)
                                            ▼
                 ┌──────────────┐    ┌───────────────┐    ┌───────────────────┐
                 │  Expert Pool │───►│  Arbitration  │───►│Response Generator │
                 │  (~200ms)    │    │  (~1ms)       │    │  (~500ms)         │
                 │              │    │               │    │                   │
                 │ Parallel     │    │ Priority-based│    │ Streaming final   │
                 │ experts,     │    │ resolution,   │    │ answer            │
                 │ self-gating  │    │ drops abstain │    │                   │
                 └──────────────┘    └───────────────┘    └───────────────────┘
                    ExpertVerdict[]     ResponseDirective
```

There is **no Input Gate / routing classifier**. Every enabled expert runs on every turn and *self-gates* — most turns it "taps out" by returning a non-flagging verdict — and Arbitration is the sole gate, dropping those abstentions (the centralized router was removed in #363). Garbled input is handled by the `noise_detection` expert's `unclear` → short-circuit verdict rather than a gate-failure path.

**Data flow:**
- **Expert Pool → Arbitration**: Structured `ExpertVerdict[]` with findings, confidence, and recommendations
- **Arbitration → Response Generator**: A single `ResponseDirective` containing the winning verdict, tone, and context
- **Bridge Generator → Response Generator**: A short bridge phrase spoken via TTS while the main pipeline runs; non-blocking

## Key Design Decisions

### Deterministic Arbitration over LLM Synthesis

V1's Aggregator uses an LLM to combine multiple expert findings into one response. This is flexible but slow and unpredictable. V2's Arbitration uses a fixed priority order (derived from expert configuration) to select the most important verdict. The Response Generator then crafts the final answer with the selected verdict as context injection. This is:
- **Fast**: ~1ms vs ~500ms
- **Predictable**: Same inputs always produce the same arbitration result
- **Debuggable**: You can trace exactly which expert "won" and why

### Parallel Expert Execution with Background Experts

All enabled experts run via `asyncio.gather()` in parallel — there is no routing step selecting a subset; each expert self-gates. Some experts (like `task_extraction`) are marked as **background experts** — their results are collected after the response is already being generated, so they don't add to response latency. This is useful for side-effect experts that extract structured data without influencing the spoken response.

### Sparse Configuration Overrides

Pipeline configurations store only the values that differ from defaults. The `pipelineSchema` in `agent.yaml` defines every configurable slot with its default value. A saved configuration might override just 2-3 slots out of 20+. This keeps configurations small, readable, and forward-compatible — when schema defaults change, only explicit overrides persist.

### gRPC State Machine

V1 runs the state machine locally inside the agent process. V2 delegates state management to a separate **gRPC StateMachineClient** service. This decouples conversation flow logic from agent processing, enabling shared state across services and independent scaling.

## Configuration

stella-v2 uses two configuration schemas in `agent.yaml`:

- **`features`**: what a deployment needs. `features.configurator.required: true` turns on the Pipeline Configurator and makes a configuration mandatory; `features.plans` declares the plan and companion modes.
- **`pipelineSchema`**: Defines the 5 pipeline nodes, their configurable slots, edges between them, and global thresholds.

Users create **Pipeline Configurations** — named, reusable presets that override specific slots. A configuration is **mandatory** when deploying stella-v2. See [Pipeline Configurator](./pipeline-configurator.md) for details.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for all LLM calls |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `INTERRUPT_MODE` | `"none"` | `"none"` for turn-based gating, `"smart"` for barge-in with re-prompting |
| `TTS_ENABLED` | `"true"` | Set to `"false"` for text-only mode |
| `TRANSCRIPT_DEBOUNCE_MS` | `"300"` | Debounce window (ms) for aggregating rapid successive final transcripts. `0` to disable |
| `STELLA_EXPERTS_DIR` | — | External directory for expert JSON configs (overrides built-in) |
| `EXPERT_TIMEOUT_MS` | `"3000"` | Timeout per expert in milliseconds |

## Resource Requirements

| Resource | Request | Limit |
|----------|---------|-------|
| CPU | 500m | 2000m |
| Memory | 512Mi | 2Gi |

## See Also

- [Pipeline Configurator](./pipeline-configurator.md) — How to create and manage pipeline configurations
- [Pipeline Schema Reference](./pipeline-schema.md) — `pipelineSchema` format for `agent.yaml`
- [Plan Structure](../../plan-structure/index.md) — Conversation flow definitions used with stella-v2
