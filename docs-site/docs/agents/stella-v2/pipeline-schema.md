---
sidebar_position: 3
title: "Pipeline Schema Reference"
---

# Pipeline Schema Reference

The `pipelineSchema` in `agent.yaml` defines the configurable surface of a pipeline agent. It declares which nodes exist, how they connect, what parameters each node exposes, and what global thresholds are available.

## Overview

```yaml
pipelineSchema:
  nodes:        # Pipeline stages with configurable slots
    - id: expert_pool
      slots: [...]
    - id: arbitration
      slots: [...]
  edges:        # Data flow connections between nodes
    - source: expert_pool
      target: arbitration
  thresholds:   # Global pipeline parameters
    - id: history_limit
```

The schema serves two purposes:
1. **Frontend**: Drives the Pipeline Configurator — each node becomes a configurable card, each slot becomes a form field, each edge becomes a visual connection.
2. **Agent**: Provides default values that are used when no override is specified in the configuration.

## Enabling the Configurator

Add `x-stella-supports-configurator: true` to `configSchema` to enable the Pipeline Configurator for an agent type:

```yaml
configSchema:
  type: object
  x-stella-supports-configurator: true
  properties:
    # ... other config properties
```

Without this flag, the agent uses the legacy configuration view.

## Nodes

Each node represents a pipeline stage.

```yaml
nodes:
  - id: expert_pool             # Unique identifier (used in config overrides)
    label: "Expert Pool"         # Display name
    description: "Parallel expert execution with structured verdicts (~200ms)"
    icon: "🧪"                   # Emoji icon
    position:                    # Layout position (row/col grid)
      row: 0
      col: 1
    slots:                       # Configurable parameters
      - id: experts
        label: "Built-in Experts"
        type: expert_list
        description: "Configure built-in experts"
```

### Node Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique node identifier. Used as key in `config.nodes[id]`. |
| `label` | string | Yes | Human-readable name |
| `description` | string | No | Brief description of what this stage does |
| `icon` | string | No | Emoji icon for the node |
| `position` | object | Yes | `{ row: number, col: number }` — layout position in the pipeline visualization |
| `slots` | array | Yes | List of configurable parameters (see [Slots](#slots)) |

## Slots

Slots define the individual parameters that can be configured for each node.

### Slot Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique within the node. Used as key in `config.nodes[nodeId][slotId]`. |
| `label` | string | Yes | Human-readable name |
| `type` | string | Yes | One of: `text`, `number`, `select`, `string_list`, `key_value`, `expert_list`, `verdict_directives` |
| `description` | string | No | Help text explaining what this parameter controls |
| `default` | any | No | Default value used when no override is specified |

### Slot Types

#### `text`

Free-form text input. Used for prompts, personas, and messages.

```yaml
- id: system_prompt
  label: "System Prompt"
  type: text
  description: "System prompt for the bridge generator"
  maxLength: 5000     # Optional character limit
  default: |
    You produce a short conversational filler phrase...
```

| Extra Field | Type | Description |
|-------------|------|-------------|
| `maxLength` | number | Maximum character count |

#### `number`

Numeric input with optional range constraints.

```yaml
- id: temperature
  label: "Temperature"
  type: number
  min: 0
  max: 1
  step: 0.1
  default: 0.7
```

| Extra Field | Type | Description |
|-------------|------|-------------|
| `min` | number | Minimum allowed value |
| `max` | number | Maximum allowed value |
| `step` | number | Increment step size |

#### `select`

Single choice from predefined options.

```yaml
- id: model
  label: "Model"
  type: select
  options: ["gpt-5.4-mini", "gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1-nano"]
  default: "gpt-5.4-mini"
```

| Extra Field | Type | Description |
|-------------|------|-------------|
| `options` | string[] | Available choices |

#### `string_list`

Ordered list of strings. Used for tags and other simple list-valued parameters.

```yaml
- id: stop_sequences
  label: "Stop Sequences"
  type: string_list
  description: "Strings that halt generation"
  default: ["\n\n"]
```

#### `key_value`

Key-value map. Used for mappings like expert → tone.

```yaml
- id: tone_map
  label: "Tone Map"
  type: key_value
  description: "Expert name → tone when that expert flags something"
  default:
    medical: "cautious"
    legal: "cautious"
    probing: "curious"
```

#### `expert_list`

Specialized type for managing expert configurations. Supports enable/disable, priority ordering, model selection, and prompt editing per expert.

```yaml
- id: experts
  label: "Built-in Experts"
  type: expert_list
  description: "Configure built-in experts"

- id: custom_experts
  label: "Custom Experts"
  type: expert_list
  description: "Define new custom experts"
  isCustom: true      # Allows creating new experts (not just editing existing ones)
```

| Extra Field | Type | Description |
|-------------|------|-------------|
| `isCustom` | boolean | If `true`, allows defining entirely new experts rather than just configuring existing ones |

Each expert's verdict labels, their LLM-facing explanations, and the deterministic action wired to each verdict are configured inline in the Expert Module — see [`verdict_directives`](#verdict_directives) and [Verdict Responses](./pipeline-configurator.md#expert-module--verdict-responses).

#### `verdict_directives`

Editor for an expert's **verdict → response** mapping. Each verdict an expert can emit is a row with: the **label** and a plain-language **explanation** (both handed to the classifying LLM), and the deterministic **action** + **template** applied in the arbitration layer.

```yaml
- id: verdict_directives
  label: "Verdict Responses"
  type: verdict_directives
```

The action is one of:

| Action | Effect |
|--------|--------|
| `inform` | Default. The verdict influences tone/guidance; the response LLM still writes the reply. |
| `prepend` | Speak the template first, then the generated reply. |
| `override` | Speak only the template; the response LLM is bypassed (post-processing still runs). |
| `short_circuit` | Speak only the template and end the turn — nothing downstream runs. |

Verdict directives are stored per expert (under `nodes.expert_pool.experts[name].verdict_directives`), so no top-level slot is required for built-in experts — the Expert Module renders this editor for every expert. The output **interface** (`{verdict, confidence, recommendation}`) is fixed; only the verdict **labels/explanations/actions** are configurable.

## Edges

Edges define data flow connections between nodes.

```yaml
edges:
  - source: expert_pool
    target: arbitration
    label: "ExpertVerdict[]"

  - source: bridge_generator
    target: response_generator
    label: "bridge phrase"
    style: dashed            # Visual style: dashed = non-blocking/async
```

### Edge Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | string | Yes | Source node `id` |
| `target` | string | Yes | Target node `id` |
| `label` | string | No | Description of the data passed along this edge |
| `style` | string | No | `"dashed"` for non-blocking connections, solid by default |

## Thresholds

Global pipeline parameters that affect cross-stage behavior.

```yaml
thresholds:
  - id: history_limit
    label: "History Limit"
    description: "Maximum conversation history messages to include"
    type: number
    min: 5
    max: 50
    step: 5
    default: 20
```

### Threshold Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier. Used as key in `config.thresholds[id]`. |
| `label` | string | Yes | Human-readable name |
| `description` | string | No | Help text |
| `type` | string | Yes | Currently only `"number"` is supported |
| `min` | number | No | Minimum allowed value |
| `max` | number | No | Maximum allowed value |
| `step` | number | No | Increment step |
| `default` | number | No | Default value |

## Configuration Format

When a user saves a configuration, only the overridden values are stored:

```json
{
  "nodes": {
    "arbitration": {
      "gate_failure_message": "Sorry, I didn't catch that — could you repeat it?"
    },
    "response_generator": {
      "persona": "You are a medical intake assistant...",
      "temperature": 0.5,
      "max_tokens": 200
    }
  },
  "thresholds": {
    "history_limit": 30
  }
}
```

Nodes and slots not present in the configuration use their schema defaults. This is the **sparse override pattern** — configurations are minimal diffs against the schema.

## How the Agent Receives Configuration

1. The configuration is wrapped in a `pipeline_config` key and serialized as the `AGENT_CONFIG` environment variable:

```json
{
  "pipeline_config": {
    "nodes": { ... },
    "thresholds": { ... }
  },
  "plan": { ... }
}
```

2. The agent reads it in `on_session_start()`:

```python
async def on_session_start(self, session_id: str, config: Dict[str, Any]):
    pipeline_config = config.get("pipeline_config")
    if not pipeline_config:
        raise ValueError("pipeline_config is required")
    self._apply_pipeline_config(pipeline_config)
```

3. `_apply_pipeline_config()` merges overrides with built-in defaults for each stage.

## Backend Validation

The backend validates configurations before saving:

- **Node IDs**: Only node IDs present in `pipelineSchema.nodes` are accepted. Unknown node IDs result in a `400 Bad Request`.
- **Threshold ranges**: Threshold values are validated against `min`/`max` from the schema. Out-of-range values are rejected.
- **Sanitization**: All configuration values pass through `sanitizeAgentConfig()` to prevent injection attacks.

## Complete Example

See `agents/stella-v2-agent/agent.yaml` for the full stella-v2 pipeline schema with 5 nodes (expert_pool, arbitration, response_generator, bridge_generator, barge_in), 3 edges, and 1 threshold.

## See Also

- [Pipeline Configurator](./pipeline-configurator.md) — How to create and manage configurations
- [stella-v2 Overview](./index.md) — Architecture and design rationale
