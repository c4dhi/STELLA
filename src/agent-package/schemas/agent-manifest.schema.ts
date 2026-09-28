import * as yaml from 'js-yaml'
import Ajv from 'ajv'
import { z } from 'zod'
import {
  MANIFEST_SCHEMA_VERSION,
  RESOURCE_LIMITS,
  SLUG_REGEX,
  VERSION_REGEX,
} from '../agent-manifest.types'

const VALID_CAPABILITIES = ['voice', 'text', 'progress', 'plans', 'experts'] as const
const VALID_SLOT_TYPES = ['text', 'number', 'select', 'string_list', 'key_value', 'expert_list', 'verdict_directives'] as const
const ENV_VAR_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/
const PLAN_CAPABILITY = 'plans'
const EXPERTS_CAPABILITY = 'experts'
const EXPERT_CONFIG_PROPERTY_KEYS = ['experts', 'expert_overrides', 'experts_dir', 'custom_experts'] as const

// Ajv validates that configSchema itself is a syntactically valid JSON Schema document.
// Cast to `any` keeps this compatible with mixed Ajv major versions in local dependency trees.
const ajv = new Ajv({ allErrors: true, validateSchema: true } as any)

const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
type JsonPrimitive = z.infer<typeof jsonPrimitiveSchema>

type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue }

// Recursive JSON value schema used by configSchema/defaultConfig/pipeline defaults.
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonPrimitiveSchema, z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
)

// Subset of JSON Schema we currently accept inside configSchema properties.
const jsonSchemaNodeSchema: z.ZodType<Record<string, JsonValue>> = z.lazy(() =>
  z
    .object({
      type: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      properties: z.record(z.string(), jsonSchemaNodeSchema).optional(),
      items: z.union([jsonSchemaNodeSchema, z.array(jsonSchemaNodeSchema)]).optional(),
      required: z.array(z.string()).optional(),
      additionalProperties: z.union([z.boolean(), jsonSchemaNodeSchema]).optional(),
      enum: z.array(jsonValueSchema).optional(),
      default: jsonValueSchema.optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      pattern: z.string().optional(),
      format: z.string().optional(),
      'x-stella-requires-plan': z.boolean().optional(),
    })
    .catchall(jsonValueSchema),
)

const optionalEnvVarSchema = z.object({
  name: z.string().regex(ENV_VAR_NAME_REGEX, 'must be an uppercase environment variable name'),
  description: z.string().optional(),
  default: z.string().optional(),
})

const configSchemaSchema = z
  .object({
    type: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    properties: z.record(z.string(), jsonSchemaNodeSchema).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.union([z.boolean(), jsonSchemaNodeSchema]).optional(),
    default: jsonValueSchema.optional(),
    'x-stella-env-vars': z.array(z.string().regex(ENV_VAR_NAME_REGEX)).optional(),
    'x-stella-optional-env-vars': z.array(optionalEnvVarSchema).optional(),
    'x-stella-supports-configurator': z.boolean().optional(),
  })
  .catchall(jsonValueSchema)
  .superRefine((schema, ctx) => {
    // We only support object-shaped top-level config schemas.
    if (schema.type !== undefined && schema.type !== 'object') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'configSchema.type must be "object" when provided',
      })
    }
  })

const pipelineSlotSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(VALID_SLOT_TYPES),
    description: z.string().optional(),
    default: jsonValueSchema.optional(),
    options: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    maxLength: z.number().int().positive().optional(),
    isCustom: z.boolean().optional(),
  })
  .superRefine((slot, ctx) => {
    // Select controls are not meaningful without explicit options.
    if (slot.type === 'select' && (!slot.options || slot.options.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'select slots must define a non-empty options array',
        path: ['options'],
      })
    }

    // Keep numeric constraints coherent for number slots.
    if (slot.min !== undefined && slot.max !== undefined && slot.min > slot.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'number slots must satisfy min <= max',
        path: ['min'],
      })
    }

    if (slot.step !== undefined && slot.step <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'step must be > 0',
        path: ['step'],
      })
    }

    // Enforce type-aware numeric defaults so runtime can safely cast/compare values.
    if (slot.type === 'number' && slot.default !== undefined) {
      if (typeof slot.default !== 'number') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'number slot default must be a number',
          path: ['default'],
        })
      } else {
        if (slot.min !== undefined && slot.default < slot.min) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'number slot default must be >= min',
            path: ['default'],
          })
        }
        if (slot.max !== undefined && slot.default > slot.max) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'number slot default must be <= max',
            path: ['default'],
          })
        }
      }
    }
  })
  .passthrough()

const pipelineNodeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    icon: z.string().optional(),
    position: z.object({ row: z.number(), col: z.number() }),
    slots: z.array(pipelineSlotSchema),
  })
  .passthrough()

const pipelineEdgeSchema = z
  .object({
    source: z.string().min(1),
    target: z.string().min(1),
    label: z.string().optional(),
    style: z.enum(['solid', 'dashed']).optional(),
  })
  .passthrough()

const pipelineThresholdSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    type: z.literal('number'),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
    default: z.number().optional(),
  })
  .passthrough()

const pipelineSchemaSchema = z
  .object({
    nodes: z.array(pipelineNodeSchema),
    edges: z.array(pipelineEdgeSchema),
    thresholds: z.array(pipelineThresholdSchema),
  })
  .superRefine((pipelineSchema, ctx) => {
    const nodeIdSet = new Set<string>()
    const thresholdIdSet = new Set<string>()

    // Node IDs must be unique for deterministic edge/config resolution.
    for (const [index, node] of pipelineSchema.nodes.entries()) {
      if (nodeIdSet.has(node.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nodes', index, 'id'],
          message: `duplicate node id: ${node.id}`,
        })
      } else {
        nodeIdSet.add(node.id)
      }
    }

    // Every edge must point to known nodes so topology is always valid.
    for (const [index, edge] of pipelineSchema.edges.entries()) {
      if (!nodeIdSet.has(edge.source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index, 'source'],
          message: `edge source references unknown node id: ${edge.source}`,
        })
      }
      if (!nodeIdSet.has(edge.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['edges', index, 'target'],
          message: `edge target references unknown node id: ${edge.target}`,
        })
      }
    }

    // Threshold IDs and numeric ranges must be coherent.
    for (const [index, threshold] of pipelineSchema.thresholds.entries()) {
      if (thresholdIdSet.has(threshold.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['thresholds', index, 'id'],
          message: `duplicate threshold id: ${threshold.id}`,
        })
      } else {
        thresholdIdSet.add(threshold.id)
      }

      if (threshold.min !== undefined && threshold.max !== undefined && threshold.min > threshold.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['thresholds', index, 'min'],
          message: 'threshold must satisfy min <= max',
        })
      }

      if (threshold.step !== undefined && threshold.step <= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['thresholds', index, 'step'],
          message: 'threshold step must be > 0',
        })
      }

      if (threshold.default !== undefined) {
        if (threshold.min !== undefined && threshold.default < threshold.min) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['thresholds', index, 'default'],
            message: 'threshold default must be >= min',
          })
        }
        if (threshold.max !== undefined && threshold.default > threshold.max) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['thresholds', index, 'default'],
            message: 'threshold default must be <= max',
          })
        }
      }
    }
  })

// Runtime variable the agent's prompt compiler can resolve ({{name}} or, when
// parametric, {{name_N}}). Declared per-AgentType so the Configurator renders the
// palette generically instead of hardcoding it. Color/theming is assigned in the
// frontend, not declared here.
const runtimeVariableSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1).optional(),
    description: z.string().optional(),
    preview: z.string().optional(),
    parametric: z.boolean().optional(),
  })
  .passthrough()

const resourcesSchema = z.object({
  memory: z
    .object({
      request: z.string().regex(/^\d+[KMGkmg]i?$/, 'must be a valid Kubernetes memory value').optional(),
      limit: z.string().regex(/^\d+[KMGkmg]i?$/, 'must be a valid Kubernetes memory value').optional(),
    })
    .optional(),
  cpu: z
    .object({
      request: z.string().regex(/^\d+m?$/, 'must be a valid Kubernetes CPU value').optional(),
      limit: z.string().regex(/^\d+m?$/, 'must be a valid Kubernetes CPU value').optional(),
    })
    .optional(),
  gpu: z.boolean().optional(),
})

export const agentManifestSchema = z
  .object({
    version: z.string().min(1),
    metadata: z.object({
      name: z.string().min(1),
      slug: z
        .string()
        .min(1)
        .regex(
          SLUG_REGEX,
          'must start with a letter, and contain only lowercase letters, numbers, and hyphens',
        ),
      version: z
        .string()
        .min(1)
        .regex(VERSION_REGEX, 'must be semantic version format (e.g. 1.0.0)'),
      description: z.string().min(1),
      author: z
        .object({
          name: z.string().min(1),
          email: z.string().email().optional(),
        })
        .optional(),
      icon: z.string().optional(),
      tags: z.array(z.string()).optional(),
      // Superseded, but still deployable. Unlike removing an agent from the
      // registry (which retires it outright), this keeps existing deployments
      // and their saved configurations working — it only demotes the type in
      // the gallery so nobody picks it for something new.
      deprecated: z.boolean().optional(),
      deprecationNote: z.string().min(1).optional(),
    }),
    capabilities: z.array(z.string()).optional(),
    image: z
      .object({
        dockerfile: z.string().min(1).optional(),
        imageUrl: z.string().min(1).optional(),
      })
      .superRefine((value, ctx) => {
        if (!value.dockerfile && !value.imageUrl) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Must specify either image.dockerfile or image.imageUrl',
          })
        }
      }),
    resources: resourcesSchema.optional(),
    configSchema: configSchemaSchema.optional(),
    pipelineSchema: pipelineSchemaSchema.optional(),
    defaultConfig: z.record(z.string(), jsonValueSchema).optional(),
    // Per-AgentType {{placeholder}} palette for the Configurator (manifest-driven).
    runtimeVariables: z.array(runtimeVariableSchema).optional(),
    // Version of the SDK prompt compiler this agent resolves prompts with. Saved
    // configurations are checked against it (a config can require a minimum version).
    promptCompiler: z
      .object({
        version: z
          .string()
          .regex(VERSION_REGEX, 'must be semantic version format (e.g. 1.0.0)'),
      })
      .optional(),
    sdk: z
      .object({
        minVersion: z
          .string()
          .regex(VERSION_REGEX, 'must be semantic version format (e.g. 1.0.0)')
          .optional(),
      })
      .optional(),
  })
  .superRefine((manifest, ctx) => {
    // Keep resource guardrails aligned with runtime pod limits.
    if (manifest.resources?.memory?.limit) {
      const memoryLimitBytes = parseMemoryToBytes(manifest.resources.memory.limit)
      const maxMemoryBytes = parseMemoryToBytes(RESOURCE_LIMITS.memory.max)
      if (memoryLimitBytes > maxMemoryBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resources', 'memory', 'limit'],
          message: `Memory limit exceeds maximum allowed: ${RESOURCE_LIMITS.memory.max}`,
        })
      }
    }

    if (manifest.resources?.cpu?.limit) {
      const cpuLimitMillicores = parseCpuToMillicores(manifest.resources.cpu.limit)
      const maxCpuMillicores = parseCpuToMillicores(RESOURCE_LIMITS.cpu.max)
      if (cpuLimitMillicores > maxCpuMillicores) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['resources', 'cpu', 'limit'],
          message: `CPU limit exceeds maximum allowed: ${RESOURCE_LIMITS.cpu.max}`,
        })
      }
    }
  })

export type CanonicalAgentManifest = z.infer<typeof agentManifestSchema>

export interface ManifestSchemaParseResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  manifest?: CanonicalAgentManifest
}

export function parseAgentManifestYaml(content: string): ManifestSchemaParseResult {
  let parsedYaml: unknown
  try {
    parsedYaml = yaml.load(content)
  } catch (error) {
    return {
      valid: false,
      errors: [`Invalid YAML: ${(error as Error).message}`],
      warnings: [],
    }
  }

  if (!parsedYaml || typeof parsedYaml !== 'object') {
    return {
      valid: false,
      errors: ['Manifest must be a valid YAML object'],
      warnings: [],
    }
  }

  const parsed = agentManifestSchema.safeParse(parsedYaml)
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map(formatIssue),
      warnings: [],
    }
  }

  const warnings: string[] = []
  const manifest = parsed.data

  // Validate that configSchema is itself a valid JSON Schema document.
  // This catches keyword-level mistakes that are outside our Zod manifest shape checks.
  if (manifest.configSchema) {
    const schemaErrors = validateJsonSchemaObject(manifest.configSchema)
    if (schemaErrors.length > 0) {
      return {
        valid: false,
        errors: schemaErrors.map((error) => `configSchema: ${error}`),
        warnings: [],
      }
    }
  }

  // Enforce feature consistency: if config schema marks any field as requiring a plan,
  // the agent must advertise the `plans` capability.
  if (
    manifest.configSchema &&
    configSchemaRequiresPlan(manifest.configSchema) &&
    !(manifest.capabilities ?? []).includes(PLAN_CAPABILITY)
  ) {
    return {
      valid: false,
      errors: [
        'configSchema sets x-stella-requires-plan=true but capabilities does not include "plans"',
      ],
      warnings: [],
    }
  }

  // Cross-field constraint: expert-capable agents must expose at least one expert config input.
  if (
    hasCapability(manifest.capabilities, EXPERTS_CAPABILITY) &&
    configSchemaSupportsConfigurator(manifest.configSchema) &&
    !configSchemaSupportsExperts(manifest.configSchema)
  ) {
    return {
      valid: false,
      errors: [
        'capabilities includes "experts" with x-stella-supports-configurator=true but configSchema does not expose expert configuration',
      ],
      warnings: [],
    }
  }

  // Non-fatal compatibility warnings are intentionally separate from structural validation.
  if (manifest.version !== MANIFEST_SCHEMA_VERSION) {
    warnings.push(`Manifest version ${manifest.version} may not be fully supported`)
  }

  if (manifest.image.dockerfile && manifest.image.imageUrl) {
    warnings.push('Both dockerfile and imageUrl specified; dockerfile will be used')
  }

  for (const capability of manifest.capabilities ?? []) {
    if (!VALID_CAPABILITIES.includes(capability as (typeof VALID_CAPABILITIES)[number])) {
      warnings.push(`Unknown capability: ${capability}`)
    }
  }

  if (manifest.resources?.gpu === true) {
    warnings.push('GPU resources require admin approval')
  }

  return {
    valid: true,
    errors: [],
    warnings,
    manifest,
  }
}

function formatIssue(issue: z.ZodIssue): string {
  const joinedPath = issue.path.length > 0 ? issue.path.join('.') : 'manifest'
  return `${joinedPath}: ${issue.message}`
}

function parseMemoryToBytes(size: string): number {
  const match = size.match(/^(\d+)([KMGkmg])i?$/)
  if (!match) return 0

  const value = parseInt(match[1], 10)
  const unit = match[2].toUpperCase()

  const multipliers: Record<string, number> = {
    K: 1024,
    M: 1024 * 1024,
    G: 1024 * 1024 * 1024,
  }

  return value * (multipliers[unit] || 1)
}

function parseCpuToMillicores(size: string): number {
  if (size.endsWith('m')) {
    return parseInt(size.slice(0, -1), 10)
  }
  return parseInt(size, 10) * 1000
}

function validateJsonSchemaObject(schema: unknown): string[] {
  const valid = (ajv as any).validateSchema(schema as object)
  const errors = ((ajv as any).errors ?? []) as unknown[]
  if (valid || errors.length === 0) return []
  return errors.map(formatAjvSchemaError)
}

function formatAjvSchemaError(error: unknown): string {
  const issue = error as { message?: string; instancePath?: string; dataPath?: string }
  // Ajv v8 uses instancePath while older versions use dataPath.
  const path = issue.instancePath || issue.dataPath || ''
  const at = path ? ` at ${path}` : ''
  return `${issue.message || 'invalid JSON Schema'}${at}`
}

function configSchemaRequiresPlan(configSchema: Record<string, unknown>): boolean {
  const queue: unknown[] = [configSchema]

  // Breadth-first walk through schema objects to find any x-stella-requires-plan markers.
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') {
      continue
    }

    const node = current as Record<string, unknown>
    if (node['x-stella-requires-plan'] === true) {
      return true
    }

    if (node.properties && typeof node.properties === 'object') {
      queue.push(...Object.values(node.properties as Record<string, unknown>))
    }

    if (node.items) {
      queue.push(node.items)
    }

    if (Array.isArray(node.allOf)) {
      queue.push(...node.allOf)
    }
    if (Array.isArray(node.anyOf)) {
      queue.push(...node.anyOf)
    }
    if (Array.isArray(node.oneOf)) {
      queue.push(...node.oneOf)
    }
    if (node.not) {
      queue.push(node.not)
    }
    if (node.then) {
      queue.push(node.then)
    }
    if (node.else) {
      queue.push(node.else)
    }
  }

  return false
}

function hasCapability(capabilities: string[] | undefined, capability: string): boolean {
  return (capabilities ?? []).includes(capability)
}

function configSchemaSupportsExperts(configSchema: Record<string, unknown> | undefined): boolean {
  if (!configSchema) {
    return false
  }

  const properties = configSchema.properties
  if (!properties || typeof properties !== 'object') {
    return false
  }

  const propertyMap = properties as Record<string, unknown>

  // Explicit well-known expert config keys.
  if (EXPERT_CONFIG_PROPERTY_KEYS.some((key) => key in propertyMap)) {
    return true
  }

  // Extension-based marker for future schemas.
  return Object.values(propertyMap).some((value) => {
    if (!value || typeof value !== 'object') return false
    return (value as Record<string, unknown>)['x-stella-expert-config'] === true
  })
}

function configSchemaSupportsConfigurator(configSchema: Record<string, unknown> | undefined): boolean {
  return configSchema?.['x-stella-supports-configurator'] === true
}
