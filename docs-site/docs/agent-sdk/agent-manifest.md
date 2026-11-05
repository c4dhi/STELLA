---
sidebar_position: 7
---

# 📜 The agent manifest (agent.yaml)

Every agent, built-in or uploaded, is described by one file at the root of its folder: `agent.yaml`. It is the only place STELLA learns about an agent. It covers what the agent is and what it needs (env vars, plans, a configuration, connectors, resources). It also says what a user may set when deploying it. STELLA has no agent-specific code: anything not declared here doesn't exist for the platform.

STELLA reads built-in agents (`agents/*/agent.yaml`) and uploaded packages through the same parser and the same mapping to the database, so both behave the same way.

## Editor support

The manifest has a published JSON Schema. Put this on the first line of `agent.yaml` to get completion and validation in VS Code, JetBrains and other YAML-language-server editors:

```yaml
# yaml-language-server: $schema=https://stella.c4dhi.org/schemas/agent-manifest.v2.json
```

The schema is generated from STELLA's own validator (`npm run manifest:schema`), so it can't fall behind. STELLA also checks a few rules that JSON Schema can't express; they are listed under [Rules](#rules).

## A complete example

```yaml
version: "2.0"

metadata:
  name: "ELIAS Interviewer"
  slug: "elias-interviewer"          # lowercase, digits, hyphens; unique
  version: "0.1.0"                   # semantic version of the agent
  description: "Runs an ELIAS interview guide word for word"
  icon: "🎙️"
  tags: [interview, elias]

capabilities: [voice, text]          # voice, text, progress, plans, experts, companion

features:
  persona: true                      # the wizard offers a persona (default: true)
  # plans:                           # only for agents that run plans
  #   required: true                 # every deployment needs a plan
  #   modes: [plan, companion]       # how a session may run them
  # configurator:                    # deployments pick a Configurator configuration
  #   required: true                 # every deployment needs one (`true` = optional)

env:
  required:                          # deploy is refused without these
    - OPENAI_API_KEY
  optional:                          # offered at deploy
    - name: STELLA_LANGUAGE
      description: "Pin the conversation to one language (e.g. 'de')"

connectors:                          # outside MCP servers the agent needs
  - slot: elias
    kind: mcp
    required: true
    label: "ELIAS"
    requiredTools: [get_interview_guide, save_answer]

image:
  dockerfile: "Dockerfile"

resources:
  memory: { request: "128Mi", limit: "256Mi" }
  cpu: { request: "50m", limit: "250m" }

# What a user may set when deploying this agent (a JSON Schema object).
configSchema:
  type: object
  required: [elias]
  properties:
    elias:
      type: object
      required: [project_id]
      properties:
        project_id:
          type: string
          description: "ELIAS project id"

defaultConfig:
  elias: {}

sdk:
  minVersion: "0.10.0"
```

## Blocks

| Block | What it is for |
|---|---|
| `version` | The manifest format. Write `"2.0"`. |
| `metadata` | Name, slug, version, description, icon, tags, author. `deprecated` and `deprecationNote` keep an agent deployable but demote it in the gallery. |
| `capabilities` | What the agent can do. They decide which of its experts it publishes (see below). Unknown values are refused. |
| `features` | Which platform features STELLA wires up for the agent. `persona` (default `true`), `plans` (`required`, `modes`) and `configurator` (`required`; `true` is short for an optional configuration). Leave a block out to turn the feature off. |
| `env` | Environment variables the deploying user provides: `required` names, and `optional` entries with a `description` and a `default`. |
| `connectors` | Outside MCP servers (Connectors) the agent reaches through the SDK by slot name. Users can always offer extra ones on top. |
| `image` | `dockerfile` (default `Dockerfile`). Uploaded agents are always built by STELLA from it. `command` (optional, exec form, e.g. `[python, -m, my_agent]`) is the pod's start command. Leave it out and the image's own `CMD` runs. |
| `resources` | Kubernetes `request` and `limit` for `memory` and `cpu`. Defaults: 512Mi and 250m. Maximum limits: 4Gi and 2000m. |
| `configSchema` | The settings a user may give the agent at deploy, as a JSON Schema object. Only user settings belong here. |
| `defaultConfig` | Default values for those settings. They must fit `configSchema`. |
| `pipelineSchema` | The pipeline the Configurator edits (nodes, slots, thresholds). Needed for `features.configurator`. |
| `runtimeVariables` | The `{{placeholder}}` palette the agent's prompt compiler resolves. |
| `promptCompiler.version` | The SDK prompt compiler version the agent uses. Saved configurations are checked against it. |
| `sdk.minVersion` | The oldest `stella-ai-agent-sdk` the agent works with. It may not be newer than the SDK this STELLA ships. |

### Experts

An agent publishes default experts from `config/experts/*.json`, one expert per file. Each expert needs the matching capability. `task_extraction` needs `plans` and `companion_router` needs `companion`. Every other expert needs `experts`. A broken file stops the upload or the seed: invalid JSON, a missing or duplicate `name`, or an unknown verdict action (`inform`, `prepend`, `override`, `short_circuit`).

## Rules

STELLA refuses a manifest that breaks any of these:

- `features.plans` is set exactly when `capabilities` includes `plans`, and `features.plans.modes` includes `companion` exactly when `capabilities` includes `companion`.
- `features.configurator` needs a `pipelineSchema`. An `experts` agent with the configurator must expose its expert configuration in `configSchema` (`experts`, `expert_overrides`, `experts_dir` or `custom_experts`).
- A resource `request` is not above its `limit`, and no limit is above the maximum.
- `configSchema` is a valid JSON Schema that STELLA can compile, and `defaultConfig` fits it. Values for required settings may be left out of the defaults.
- `configSchema` uses no regular expressions (`pattern`, `patternProperties`). STELLA checks settings on its server, where a badly written expression can stall it. Use `enum`, `minLength` or `maxLength` instead.
- An env var is not both required and optional.
- Unknown keys are refused, not ignored. A typo like `conectors:` is an error, not a silently missing feature.

## What STELLA checks at deploy

STELLA reads the manifest again on every deploy, restart and wake after auto-pause. It refuses the deployment with a 400 that lists every problem when:

- an `env.required` variable is missing or empty;
- `features.plans.required` is set and the deployment has neither a plan nor, for agents with the `companion` mode, a companion session;
- the deployment brings a plan, a companion session or a Configurator configuration that the manifest doesn't declare;
- `features.configurator.required` is set and no configuration was picked;
- the user's settings, merged over `defaultConfig`, don't fit `configSchema`;
- `sdk.minVersion` is newer than the SDK this STELLA ships (`GET /agent-types/sdk-support`).

The agent receives its settings at the top level of `AGENT_CONFIG`. A setting the user leaves out takes its value from `defaultConfig`. Objects merge key by key, and an array replaces the default. Next to the settings, STELLA puts the keys it sets itself: `persona`, `mode`, `plan`, `available_plans` and `pipeline_config`. Don't use these names for settings.

`GET /agent-types` returns these resolved `requirements` for every agent type, so a client never needs to read the manifest itself.

`env.optional` defaults are shown to the user when deploying. They are not injected into the pod, so the agent's own fallback still applies when a variable is unset. Keep the two in agreement.

## SDK versions

STELLA supports a window of `stella-ai-agent-sdk` versions. `GET /agent-types/sdk-support` returns it as `{ minSupported, current }`.

- After every build, STELLA reads the SDK version that is actually installed in the image. A build with no SDK, or one older than `minSupported`, fails and says so.
- When STELLA raises `minSupported`, agent types built with an older SDK stay listed, but can't be deployed, restarted or woken. My Agents marks them as needing an SDK update. Update the SDK in the package and build again.
- `sdk.minVersion` must not be newer than `current`. Such an agent needs a newer STELLA.

## Format 1.0

Manifests with `version: "1.0"` still work. STELLA upgrades them on read, and upload and the seed show a deprecation warning. In 1.0 the platform flags lived inside `configSchema`. They map to 2.0 like this:

| 1.0 | 2.0 |
|---|---|
| `configSchema.x-stella-env-vars` | `env.required` |
| `configSchema.x-stella-optional-env-vars` | `env.optional` |
| `configSchema.x-stella-supports-configurator` | `features.configurator: true` (optional). This is ignored, with a warning, when there is no `pipelineSchema`. |
| `configSchema.x-stella-connectors` | `connectors` |
| a `configSchema` property with `x-stella-requires-plan` | `features.plans.required: true`. The property itself is dropped, since STELLA injects the plan. |
| capability `plans` / `companion` | `features.plans` / its `companion` mode |
| unknown capabilities | dropped, with a warning |

`x-stella-*` keys inside a 2.0 `configSchema` are refused.
