---
sidebar_position: 2
title: "Pipeline Configurator"
---

# Pipeline Configurator

The Pipeline Configurator lets you tune every stage of the stella-v2 pipeline without touching code. Configurations are saved as reusable presets that can be selected when deploying an agent.

## Why Pipeline Configurations?

Agent behavior depends on many parameters: which experts are enabled, what prompts they use, which models and temperatures are set, how conversation history is managed. Rather than baking these into the agent code or passing them as environment variables, stella-v2 uses **pipeline configurations** — named presets that override specific pipeline slots.

**Key design principles:**

- **Sparse overrides**: Only changed values are stored. Defaults always come from the `pipelineSchema` in `agent.yaml`. This keeps configurations small and forward-compatible — when schema defaults are updated, only explicit overrides persist.
- **Reusable across deployments**: The same configuration can be used for multiple agent instances. Each deployment gets a snapshot of the configuration at deployment time.
- **Version-tracked**: Configurations record which agent version they were created for, enabling compatibility checks as the pipeline evolves.
- **Mandatory for stella-v2**: You must select a saved configuration before deploying. This ensures every deployment has an explicit, auditable configuration rather than relying on implicit defaults.

## Configuration Lifecycle

1. **Create**: Define a new configuration, optionally customizing slots from their defaults
2. **Edit**: Modify an existing configuration. Does not affect already-deployed agents (they have their own snapshot).
3. **Duplicate**: Clone a configuration as a starting point for variations
4. **Deploy**: Select a configuration during agent deployment. The configuration's overrides are merged with schema defaults and passed to the agent pod.

## Pipeline Stages

:::note No Input Gate
Earlier versions began with an **Input Gate** — a JSON routing classifier that picked which experts to run. It was removed in #363. Every enabled expert now runs on every turn and *self-gates* (abstains via a non-flagging verdict), and Arbitration drops the abstentions. There is no routing slot to configure.
:::

### Expert Pool

**Purpose**: Runs all enabled experts in parallel to analyze the user's message from different angles. Each expert self-gates — on most turns it "taps out" by returning a non-flagging verdict.

| Slot | Type | Default | Rationale |
|------|------|---------|-----------|
| `experts` | expert_list | Built-in set | Enable/disable experts, set per-expert model, temperature, prompt, and priority. |
| `custom_experts` | expert_list | Empty | Define entirely new experts with custom prompts for domain-specific analysis. |

**When to customize**: Add custom experts for domain-specific analysis (e.g., a "compliance" expert for regulated industries). Reorder expert priority to change which expert "wins" in arbitration conflicts. Wire each expert's verdicts to deterministic responses in the [Expert Module](#expert-module--verdict-responses).

### Arbitration

**Purpose**: Deterministic priority-based conflict resolution. When multiple experts return verdicts, Arbitration walks them in priority order and applies the winning expert's configured **verdict directive** — which can deterministically **replace, prepend to, or short-circuit** the generated response with a literature-informed template, rather than relying on the response LLM's interpretation. Verdicts without a deterministic directive feed tone/guidance into the Response Generator as before.

This is the clinical-determinism knob: each expert maps each verdict to an action (`inform` / `prepend` / `override` / `short_circuit`) and a response template, edited in the [Expert Module](#expert-module--verdict-responses). The highest-priority non-`inform` directive wins.

| Slot | Type | Default | Rationale |
|------|------|---------|-----------|
| `tone_map` | key_value | Expert → tone mapping | Maps each expert to a tone (e.g., `medical → cautious`, `probing → curious`) used for `inform` verdicts. The winning expert's tone is injected into the Response Generator's context. |
| `gate_failure_message` | text | "I'm sorry, I didn't quite catch that..." | Locale-aware fallback spoken when `noise_detection` returns `unclear` and its `short_circuit` directive carries no template. |

**Why not LLM-based?** V1's Aggregator uses an LLM to synthesize multiple expert findings (~500ms, non-deterministic). Arbitration is pure Python (~1ms) — the expert list order defines priority, and the winning verdict directive is applied deterministically: given the same verdicts, the same response is produced. For `override`/`short_circuit` the response LLM is bypassed entirely; for `prepend` the template is spoken and the LLM continues from it.

**When to customize**: Author per-verdict templates for safety-critical experts (medical/legal) in the Expert Module. Adjust `tone_map` for `inform` verdicts. `gate_failure_message` is the noise fallback for localization.

### Response Generator

**Purpose**: Produces the final spoken response, streaming tokens to TTS for low-latency audio output.

| Slot | Type | Default | Rationale |
|------|------|---------|-----------|
| `conversation_guidelines` | text | Professional interviewer style | Detailed rules for tone, register, response length, and formatting. How the agent speaks — not who it is. |
| `model` | select | `gpt-4o-mini` | Balances quality and speed. Upgrade to `gpt-4o` for complex domains requiring stronger reasoning. |
| `temperature` | number | `0.7` | Moderate temperature for natural conversational variation. Lower for more consistent responses, higher for more creative ones. |
| `max_tokens` | number | `150` | Targets 30-50 spoken words. Voice conversations need short responses — long monologues feel unnatural in speech. |

:::info Identity is not configured here
There is no `persona` slot. **Who** the agent is comes from the persona selected at deploy time (Settings → Personas), and from nowhere else — not from this configuration, and not from the plan.

That is the point of the separation: the same configuration can front any number of personas, and the same persona can run under any configuration. A slot here would have been a second place to define identity, competing with the one an operator actually picked at deploy.

`conversation_guidelines` stays, because delivery is a genuinely different question from identity — you can put a new character behind the same speaking style, or give one character a different register.
:::

**When to customize**: Adjust temperature and max_tokens based on whether you need consistent short answers (lower both) or detailed explanations (raise both). For personality, edit the persona rather than anything on this screen.

### Bridge Generator

**Purpose**: Produces an ultra-short conversational filler phrase immediately when the user stops speaking, synthesized via TTS while the full pipeline runs in parallel.

| Slot | Type | Default | Rationale |
|------|------|---------|-----------|
| `system_prompt` | text | Bridge phrase rules | Strict rules: complete sentence, max 6 words, never answer the question, match user's language. |
| `model` | select | `gpt-4o-mini` | Must be fast — the bridge needs to be spoken before the main response starts generating. |
| `temperature` | number | `0.4` | Low-moderate for slight variation without unpredictability. Bridges should feel natural but not surprising. |
| `max_tokens` | number | `30` | Very low cap because output is a single short sentence (e.g., "Good question.", "Absolutely.", "I appreciate that."). |

**Why the Bridge Generator exists**: In voice conversations, silence after the user stops speaking feels like the agent is unresponsive. The bridge fills this gap with a natural acknowledgment while the full pipeline (Expert Pool → Arbitration → Response Generator) runs in parallel. This reduces **perceived** latency from ~800ms to ~100ms without affecting actual processing time. The bridge phrase is spoken as a standalone TTS segment, and the full response follows immediately after.

**When to customize**: Adjust the system prompt to match your agent's personality (e.g., more formal bridges for professional domains, warmer bridges for casual ones).

## Expert Module & Verdict Responses

The **Expert Module** (the right-hand panel of the Configurator) is where you manage experts and wire each verdict to a response. Expand any expert to edit its prompt, model settings, and a **Verdict Responses** list.

### The verdict model

Each expert classifies a turn into exactly one **verdict**. A verdict is fully editable:

- **Label** — the value the expert emits (e.g. `none`, `low`, `high`, `critical`). Add, rename, or remove labels freely.
- **Explanation** — a plain-language description of what the verdict means. **The label and explanation are handed to the classifying LLM** so it knows when to pick each verdict.
- **Action** — what the [Arbitration](#arbitration) layer does deterministically when this verdict wins: `inform`, `prepend`, `override`, or `short_circuit` (see [`verdict_directives`](./pipeline-schema.md#verdict_directives)).
- **Template** — the literature-informed response spoken for `prepend`/`override`/`short_circuit` (supports `{{variables}}`).

The output **interface** stays fixed (`{verdict, confidence, recommendation}`); only the labels, explanations, and actions are configurable — so you never hardcode an output structure in the prompt.

Every verdict ships with a sensible default action and explanation. The editor shows defaults dimmed and offers **per-verdict reset** and **reset all to default**, mirroring the prompt editor.

### Custom experts

The **New Custom Expert** form uses the same prompt editor as the edit view (variable insertion, `{{variable}}` highlighting, fullscreen expand) and includes an **Always Triggered** toggle — when enabled, the expert runs on every turn and the Trigger Criteria field is hidden.

### Unsaved-changes guard

Closing the Configurator (backdrop click or the close button) while there are unsaved changes prompts a **Discard changes?** confirmation. Clean configurations close immediately.

## Agent-Declared Defaults & Capability Gating

Experts and their default verdicts/actions are **declared by the agent**, not hardcoded in the UI. On seed/upload the platform reads each agent's `config/experts/*.json` and publishes them on `AgentType.expertDefaults`; the Configurator renders the agent's declared experts/verdicts/actions (with a transitional fallback to built-ins until re-seeded).

Which sections appear is gated by the agent's declared `capabilities`:

| Capability | Unlocks |
|------------|---------|
| `plans` | **Task Extraction** configuration (deliverable extraction fills the plan's state machine) |
| `experts` | the **assessment expert pool** + arbitration + custom experts + verdict directives |

This is the same split the manifest validator enforces (`x-stella-requires-plan` ⟹ `plans`; expert config ⟹ `experts`). An agent receives only the configuration its capabilities expose.

## Thresholds

Thresholds are global pipeline parameters that affect cross-stage behavior.

### history_limit

| Property | Value |
|----------|-------|
| Default | `20` |
| Range | `5` – `50` |
| Step | `5` |

Controls how many conversation history messages are included in LLM context. This is a tradeoff:

- **Higher values**: Better context understanding, the agent remembers more of the conversation. But increases token cost and may hit context window limits.
- **Lower values**: Faster, cheaper, but the agent may "forget" earlier parts of the conversation.

The default of 20 messages (~10 exchanges) works well for most conversations. Increase for long-form interviews or complex multi-step workflows. Decrease for simple, transactional interactions.

## How Configurations Reach the Agent

When an agent is deployed with a selected configuration:

1. The frontend sends the configuration's `nodes` and `thresholds` overrides as `pipeline_config` in the agent creation request
2. The backend validates overrides against the `pipelineSchema` (unknown node IDs and out-of-range thresholds are rejected)
3. The validated config is serialized as JSON into the `AGENT_CONFIG` environment variable on the Kubernetes pod
4. The agent reads `AGENT_CONFIG` on startup and calls `_apply_pipeline_config()` to merge overrides with schema defaults
5. Each pipeline stage reads its overrides from `config.nodes[stage_id]`

If no `pipeline_config` is present, the agent raises an error — configuration is mandatory for stella-v2.

## See Also

- [Pipeline Schema Reference](./pipeline-schema.md) — Full `pipelineSchema` format for defining configurable pipelines
- [stella-v2 Overview](./index.md) — Architecture and design rationale
