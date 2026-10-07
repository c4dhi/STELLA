import { ManifestValidator } from './manifest.validator.js'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

describe('ManifestValidator', () => {
  let validator: ManifestValidator

  beforeEach(() => {
    validator = new ManifestValidator()
  })

  it('validates a manifest with config schema extensions and pipeline schema', () => {
    // Happy path: manifest includes required core fields plus x-stella extensions and pipeline schema.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Test Agent"
  slug: "test-agent"
  version: "1.2.3"
  description: "Test manifest"
  author:
    name: "Tester"
    email: "tester@example.com"
  tags: ["voice", "test"]
capabilities: ["voice", "text", "plans"]
image:
  dockerfile: "Dockerfile"
resources:
  memory:
    request: "512Mi"
    limit: "2Gi"
  cpu:
    request: "250m"
    limit: "1000m"
configSchema:
  type: object
  x-stella-supports-configurator: true
  x-stella-env-vars:
    - OPENAI_API_KEY
  x-stella-optional-env-vars:
    - name: INTERRUPT_MODE
      description: "Optional override"
      default: "none"
  properties:
    plan:
      type: object
      x-stella-requires-plan: true
defaultConfig:
  llm:
    model: "gpt-4o-mini"
pipelineSchema:
  nodes:
    - id: input_gate
      label: "Input Gate"
      position: { row: 0, col: 0 }
      slots:
        - id: model
          label: "Model"
          type: select
          options: ["gpt-4o-mini", "gpt-4o"]
          default: "gpt-4o-mini"
  edges: []
  thresholds: []
sdk:
  minVersion: "0.4.0"
`)

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.manifest?.configSchema?.['x-stella-supports-configurator']).toBe(true)
  })

  it('rejects invalid x-stella optional env var names', () => {
    // Env var names are intentionally strict (UPPER_SNAKE_CASE) to match deployment conventions.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Bad Env Agent"
  slug: "bad-env-agent"
  version: "1.0.0"
  description: "Bad env var"
image:
  dockerfile: "Dockerfile"
configSchema:
  type: object
  x-stella-optional-env-vars:
    - name: bad-name
`)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('x-stella-optional-env-vars.0.name')
  })

  it('rejects select slots without options in pipeline schema', () => {
    // Select slots must be self-contained; missing options would break frontend/runtime rendering.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Bad Pipeline Agent"
  slug: "bad-pipeline-agent"
  version: "1.0.0"
  description: "Bad pipeline"
image:
  dockerfile: "Dockerfile"
pipelineSchema:
  nodes:
    - id: response
      label: "Response"
      position: { row: 0, col: 0 }
      slots:
        - id: model
          label: "Model"
          type: select
  edges: []
  thresholds: []
`)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('select slots must define a non-empty options array')
  })

  it('accepts a verdict_directives slot type', () => {
    // The expert module exposes per-verdict deterministic responses via this slot type.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Verdict Agent"
  slug: "verdict-agent"
  version: "1.0.0"
  description: "Has a verdict_directives slot"
capabilities: ["voice", "text", "experts"]
image:
  dockerfile: "Dockerfile"
configSchema:
  type: object
  x-stella-supports-configurator: true
  properties:
    expert_overrides:
      type: object
pipelineSchema:
  nodes:
    - id: expert_pool
      label: "Expert Pool"
      position: { row: 0, col: 0 }
      slots:
        - id: verdict_directives
          label: "Verdict Responses"
          type: verdict_directives
  edges: []
  thresholds: []
`)

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('rejects an unknown slot type', () => {
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Bad Slot Agent"
  slug: "bad-slot-agent"
  version: "1.0.0"
  description: "Unknown slot type"
image:
  dockerfile: "Dockerfile"
pipelineSchema:
  nodes:
    - id: response
      label: "Response"
      position: { row: 0, col: 0 }
      slots:
        - id: thing
          label: "Thing"
          type: not_a_real_slot_type
  edges: []
  thresholds: []
`)

    expect(result.valid).toBe(false)
  })

  it('rejects edges that reference unknown node IDs', () => {
    // Topology integrity: every edge endpoint must refer to a declared node id.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Bad Edge Agent"
  slug: "bad-edge-agent"
  version: "1.0.0"
  description: "Bad edge"
image:
  dockerfile: "Dockerfile"
pipelineSchema:
  nodes:
    - id: input_gate
      label: "Input Gate"
      position: { row: 0, col: 0 }
      slots: []
  edges:
    - source: input_gate
      target: missing_node
  thresholds: []
`)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('edge target references unknown node id: missing_node')
  })

  it('rejects duplicate node IDs in pipeline schema', () => {
    // Node IDs are map keys at runtime, so duplicates must be rejected early.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Duplicate Node Agent"
  slug: "duplicate-node-agent"
  version: "1.0.0"
  description: "Duplicate node ids"
image:
  dockerfile: "Dockerfile"
pipelineSchema:
  nodes:
    - id: shared_node
      label: "Node A"
      position: { row: 0, col: 0 }
      slots: []
    - id: shared_node
      label: "Node B"
      position: { row: 0, col: 1 }
      slots: []
  edges: []
  thresholds: []
`)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('duplicate node id: shared_node')
  })

  it('rejects thresholds with invalid min/max', () => {
    // Numeric threshold ranges must be coherent before they are exposed in configurators.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Bad Threshold Agent"
  slug: "bad-threshold-agent"
  version: "1.0.0"
  description: "Bad threshold bounds"
image:
  dockerfile: "Dockerfile"
pipelineSchema:
  nodes: []
  edges: []
  thresholds:
    - id: confidence
      label: "Confidence"
      type: number
      min: 10
      max: 1
      step: 0.1
      default: 0.5
`)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('threshold must satisfy min <= max')
  })

  it('rejects threshold defaults outside range', () => {
    // Default values are validated against declared bounds to avoid invalid initial UI state.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Bad Threshold Default Agent"
  slug: "bad-threshold-default-agent"
  version: "1.0.0"
  description: "Bad threshold default"
image:
  dockerfile: "Dockerfile"
pipelineSchema:
  nodes: []
  edges: []
  thresholds:
    - id: confidence
      label: "Confidence"
      type: number
      min: 0
      max: 1
      default: 2
`)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('threshold default must be <= max')
  })

  it('rejects configSchema when it is not valid JSON Schema', () => {
    // Ajv-level check: keyword values must follow JSON Schema spec types.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Bad Config Schema Agent"
  slug: "bad-config-schema-agent"
  version: "1.0.0"
  description: "Invalid JSON Schema keyword value"
image:
  dockerfile: "Dockerfile"
configSchema:
  type: object
  properties:
    confidence:
      type: number
      exclusiveMinimum: "high"
`)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('configSchema:')
  })

  it('rejects x-stella-requires-plan when plans capability is missing', () => {
    // Capability consistency: requires-plan metadata must match advertised capabilities.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Missing Plans Capability Agent"
  slug: "missing-plans-capability-agent"
  version: "1.0.0"
  description: "Plan required but capability missing"
capabilities: ["voice", "text"]
image:
  dockerfile: "Dockerfile"
configSchema:
  type: object
  properties:
    plan:
      type: object
      x-stella-requires-plan: true
`)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('capabilities does not include "plans"')
  })

  it('accepts x-stella-requires-plan when plans capability is present', () => {
    // Positive case for plan requirement consistency.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Plans Capability Agent"
  slug: "plans-capability-agent"
  version: "1.0.0"
  description: "Plan requirement and capability aligned"
capabilities: ["voice", "plans"]
image:
  dockerfile: "Dockerfile"
configSchema:
  type: object
  properties:
    plan:
      type: object
      x-stella-requires-plan: true
`)

    expect(result.valid).toBe(true)
  })

  it('rejects experts capability when configSchema does not expose expert config', () => {
    // Cross-field rule applies when configurator support is enabled for expert-capable agents.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Experts Missing Config Agent"
  slug: "experts-missing-config-agent"
  version: "1.0.0"
  description: "Experts capability but no expert config"
capabilities: ["voice", "experts"]
image:
  dockerfile: "Dockerfile"
configSchema:
  type: object
  x-stella-supports-configurator: true
  properties:
    llm:
      type: object
`)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('x-stella-supports-configurator=true')
  })

  it('accepts experts capability when configSchema exposes expert config', () => {
    // Positive case: known expert-related config key is present.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Experts Config Agent"
  slug: "experts-config-agent"
  version: "1.0.0"
  description: "Experts capability with expert config"
capabilities: ["experts", "voice"]
image:
  dockerfile: "Dockerfile"
configSchema:
  type: object
  x-stella-supports-configurator: true
  properties:
    expert_overrides:
      type: object
`)

    expect(result.valid).toBe(true)
  })

  it('accepts experts capability when expert config is marked with x-stella-expert-config', () => {
    // Extension marker allows expert config discovery even when property key is custom.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Experts Marker Agent"
  slug: "experts-marker-agent"
  version: "1.0.0"
  description: "Experts capability with extension marker"
capabilities: ["experts", "voice"]
image:
  dockerfile: "Dockerfile"
configSchema:
  type: object
  x-stella-supports-configurator: true
  properties:
    specialist_settings:
      type: object
      x-stella-expert-config: true
`)

    expect(result.valid).toBe(true)
  })

  it('does not require expert config when experts capability is absent', () => {
    // Rule should only trigger for expert-capable manifests.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "No Experts Capability Agent"
  slug: "no-experts-capability-agent"
  version: "1.0.0"
  description: "No experts capability"
capabilities: ["voice"]
image:
  dockerfile: "Dockerfile"
configSchema:
  type: object
  properties:
    llm:
      type: object
`)

    expect(result.valid).toBe(true)
  })

  it('rejects number slots with non-numeric default', () => {
    // Number slots must keep numeric defaults to avoid runtime type mismatches.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Bad Number Slot Agent"
  slug: "bad-number-slot-agent"
  version: "1.0.0"
  description: "Bad number default"
image:
  dockerfile: "Dockerfile"
pipelineSchema:
  nodes:
    - id: input_gate
      label: "Input Gate"
      position: { row: 0, col: 0 }
      slots:
        - id: temperature
          label: "Temperature"
          type: number
          min: 0
          max: 1
          default: "high"
  edges: []
  thresholds: []
`)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('number slot default must be a number')
  })

  it('rejects number slots with non-positive step', () => {
    // Step must be strictly positive for numeric controls.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Bad Number Step Agent"
  slug: "bad-number-step-agent"
  version: "1.0.0"
  description: "Bad number step"
image:
  dockerfile: "Dockerfile"
pipelineSchema:
  nodes:
    - id: input_gate
      label: "Input Gate"
      position: { row: 0, col: 0 }
      slots:
        - id: temperature
          label: "Temperature"
          type: number
          step: 0
  edges: []
  thresholds: []
`)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('step must be > 0')
  })

  it('rejects duplicate threshold IDs in pipeline schema', () => {
    // Threshold IDs are used as keys in persisted overrides and must stay unique.
    const result = validator.validate(`
version: "1.0"
metadata:
  name: "Duplicate Threshold Agent"
  slug: "duplicate-threshold-agent"
  version: "1.0.0"
  description: "Duplicate threshold IDs"
image:
  dockerfile: "Dockerfile"
pipelineSchema:
  nodes: []
  edges: []
  thresholds:
    - id: confidence
      label: "Confidence A"
      type: number
    - id: confidence
      label: "Confidence B"
      type: number
`)

    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('duplicate threshold id: confidence')
  })

  it('validates all built-in agent manifests in agents directory', () => {
    // Fixture-level guardrail: all checked-in built-in manifests must satisfy the canonical validator.
    const projectRoot = path.resolve(__dirname, '../../..')
    const agentsDir = path.join(projectRoot, 'agents')
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true })
    const agentDirs = entries
      .filter((entry) => entry.isDirectory() && entry.name !== 'stella-ai-agent-sdk')
      .map((entry) => entry.name)

    expect(agentDirs.length).toBeGreaterThan(0)

    for (const dirName of agentDirs) {
      const manifestPath = path.join(agentsDir, dirName, 'agent.yaml')
      const content = fs.readFileSync(manifestPath, 'utf-8')
      const result = validator.validate(content)
      expect(result.valid).toBe(true)
    }
  })

  it('keeps compatibility warnings as warnings', () => {
    // Compatibility/deprecation scenarios should not block parsing when structure is valid.
    const result = validator.validate(`
version: "2.0"
metadata:
  name: "Warning Agent"
  slug: "warning-agent"
  version: "1.0.0"
  description: "warn"
image:
  dockerfile: "Dockerfile"
  imageUrl: "registry.example.com/agent:latest"
capabilities: ["voice", "unknown-capability"]
resources:
  gpu: true
`)

    expect(result.valid).toBe(true)
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'Manifest version 2.0 may not be fully supported',
        'Both dockerfile and imageUrl specified; dockerfile will be used',
        'Unknown capability: unknown-capability',
        'GPU resources require admin approval',
      ]),
    )
  })
})
