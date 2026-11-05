import * as yaml from 'js-yaml'
import { Ajv } from 'ajv'
import { z } from 'zod'
import {
  CAPABILITIES,
  CONNECTOR_KINDS,
  CONNECTOR_SLOT_REGEX,
  ENV_VAR_NAME_REGEX,
  KUBERNETES_CPU_REGEX,
  KUBERNETES_MEMORY_REGEX,
  MANIFEST_VERSION,
  PLAN_MODES,
  RESOURCE_DEFAULTS,
  SLUG_REGEX,
  VERSION_REGEX,
  parseCpuMillicores,
  parseMemoryBytes,
} from '../manifest-defaults.js'
import { normalizeManifest } from '../manifest-normalizer.js'

/**
 * The agent manifest (agent.yaml), format 2.0: the single description of an agent
 * that the platform reads. Everything STELLA does for an agent (what the deploy
 * wizard asks, which env vars a pod gets, its resources, which plans and connectors
 * it can use) follows from this schema. Types are inferred from it, and the
 * published JSON Schema (docs-site/static/schemas/agent-manifest.v2.json) is
 * generated from it, so there is nothing to keep in sync by hand.
 *
 * Older manifests (format 1.0) are upgraded by normalizeManifest before parsing.
 */

const EXPERTS_CAPABILITY = 'experts'
const EXPERT_CONFIG_PROPERTY_KEYS = ['experts', 'expert_overrides', 'experts_dir', 'custom_experts'] as const
const VALID_SLOT_TYPES = ['text', 'number', 'select', 'string_list', 'key_value', 'expert_list', 'verdict_directives'] as const

// Ajv checks that configSchema is a valid JSON Schema and defaultConfig fits it.
// Cast to `any` keeps this compatible with mixed Ajv major versions in local dependency trees.
const ajv = new Ajv({ allErrors: true, validateSchema: true, strict: false } as any)

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

/**
 * The settings a user may give an agent at deploy (a JSON Schema object). The
 * deploy wizard renders it as a form and the server validates the submitted
 * config against it. Platform concerns (env vars, plans, configurator,
 * connectors) are declared in their own blocks, never in here.
 */
const configSchemaSchema = z
  .object({
    type: z.literal('object').optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    properties: z.record(z.string(), jsonValueSchema).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.union([z.boolean(), jsonValueSchema]).optional(),
  })
  .catchall(jsonValueSchema)

const featuresSchema = z
  .object({
    /** The deploy wizard offers a persona and the agent receives it (config.persona). */
    persona: z.boolean().default(true),
    /** The agent runs plans. `required`: every deployment needs one. `modes`: how a session may run it. */
    plans: z
      .object({
        required: z.boolean().default(false),
        modes: z.array(z.enum(PLAN_MODES)).min(1).default(['plan']),
      })
      .strict()
      .optional(),
    /**
     * Deployments pick an AgentConfiguration built in the Configurator from
     * pipelineSchema, which the agent receives as config.pipeline_config.
     * `required`: every deployment needs one. `true` is short for `{ required: false }`.
     */
    configurator: z
      .union([z.boolean(), z.object({ required: z.boolean().default(false) }).strict()])
      .transform((value) => (value === true ? { required: false } : value || undefined))
      .optional(),
  })
  .strict()

const optionalEnvVarSchema = z
  .object({
    name: z.string().regex(ENV_VAR_NAME_REGEX, 'must be an uppercase environment variable name'),
    description: z.string().optional(),
    default: z.string().optional(),
  })
  .strict()

const envSchema = z
  .object({
    /** Must be set at deploy (from an env var template or typed in); deploy is refused without them. */
    required: z.array(z.string().regex(ENV_VAR_NAME_REGEX, 'must be an uppercase environment variable name')).default([]),
    /** Offered at deploy; `default` applies when the user leaves it empty. */
    optional: z.array(optionalEnvVarSchema).default([]),
  })
  .strict()

/**
 * An outside MCP server the agent needs (a Connector). The deploying user binds
 * one of their own connectors to each slot; the agent reaches it through the SDK
 * by slot name. Extra connectors the user offers are always allowed on top.
 */
const connectorSlotSchema = z
  .object({
    slot: z
      .string()
      .regex(CONNECTOR_SLOT_REGEX, 'must start with a letter and use only lowercase letters, digits and hyphens (max 40)'),
    kind: z.enum(CONNECTOR_KINDS),
    required: z.boolean().default(false),
    label: z.string().min(1),
    description: z.string().optional(),
    requiredTools: z.array(z.string().min(1)).default([]),
  })
  .strict()

const connectorsSchema = z.array(connectorSlotSchema).superRefine((slots, ctx) => {
  const seen = new Set<string>()
  slots.forEach((s, i) => {
    if (seen.has(s.slot)) {
      ctx.addIssue({ code: 'custom', path: [i, 'slot'], message: `duplicate connector slot "${s.slot}"` })
    }
    seen.add(s.slot)
  })
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
        code: 'custom',
        message: 'select slots must define a non-empty options array',
        path: ['options'],
      })
    }

    // Keep numeric constraints coherent for number slots.
    if (slot.min !== undefined && slot.max !== undefined && slot.min > slot.max) {
      ctx.addIssue({
        code: 'custom',
        message: 'number slots must satisfy min <= max',
        path: ['min'],
      })
    }

    if (slot.step !== undefined && slot.step <= 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'step must be > 0',
        path: ['step'],
      })
    }

    // Enforce type-aware numeric defaults so runtime can safely cast/compare values.
    if (slot.type === 'number' && slot.default !== undefined) {
      if (typeof slot.default !== 'number') {
        ctx.addIssue({
          code: 'custom',
          message: 'number slot default must be a number',
          path: ['default'],
        })
      } else {
        if (slot.min !== undefined && slot.default < slot.min) {
          ctx.addIssue({
            code: 'custom',
            message: 'number slot default must be >= min',
            path: ['default'],
          })
        }
        if (slot.max !== undefined && slot.default > slot.max) {
          ctx.addIssue({
            code: 'custom',
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
          code: 'custom',
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
          code: 'custom',
          path: ['edges', index, 'source'],
          message: `edge source references unknown node id: ${edge.source}`,
        })
      }
      if (!nodeIdSet.has(edge.target)) {
        ctx.addIssue({
          code: 'custom',
          path: ['edges', index, 'target'],
          message: `edge target references unknown node id: ${edge.target}`,
        })
      }
    }

    // Threshold IDs and numeric ranges must be coherent.
    for (const [index, threshold] of pipelineSchema.thresholds.entries()) {
      if (thresholdIdSet.has(threshold.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['thresholds', index, 'id'],
          message: `duplicate threshold id: ${threshold.id}`,
        })
      } else {
        thresholdIdSet.add(threshold.id)
      }

      if (threshold.min !== undefined && threshold.max !== undefined && threshold.min > threshold.max) {
        ctx.addIssue({
          code: 'custom',
          path: ['thresholds', index, 'min'],
          message: 'threshold must satisfy min <= max',
        })
      }

      if (threshold.step !== undefined && threshold.step <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['thresholds', index, 'step'],
          message: 'threshold step must be > 0',
        })
      }

      if (threshold.default !== undefined) {
        if (threshold.min !== undefined && threshold.default < threshold.min) {
          ctx.addIssue({
            code: 'custom',
            path: ['thresholds', index, 'default'],
            message: 'threshold default must be >= min',
          })
        }
        if (threshold.max !== undefined && threshold.default > threshold.max) {
          ctx.addIssue({
            code: 'custom',
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

const resourceQuantitySchema = (regex: RegExp, what: string) =>
  z
    .object({
      request: z.string().regex(regex, `must be a valid Kubernetes ${what} value`).optional(),
      limit: z.string().regex(regex, `must be a valid Kubernetes ${what} value`).optional(),
    })
    .strict()

const resourcesSchema = z
  .object({
    memory: resourceQuantitySchema(KUBERNETES_MEMORY_REGEX, 'memory (e.g. 256Mi, 1Gi)').optional(),
    cpu: resourceQuantitySchema(KUBERNETES_CPU_REGEX, 'CPU (e.g. 250m, 1)').optional(),
    gpu: z.boolean().optional(),
  })
  .strict()

const semver = (message = 'must be semantic version format (e.g. 1.0.0)') =>
  z.string().regex(VERSION_REGEX, message)

export const agentManifestSchema = z
  .object({
    version: z.literal(MANIFEST_VERSION),
    metadata: z
      .object({
        name: z.string().min(1),
        slug: z
          .string()
          .min(1)
          .regex(SLUG_REGEX, 'must start with a letter, and contain only lowercase letters, numbers, and hyphens'),
        version: semver(),
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
      })
      .strict(),
    capabilities: z.array(z.enum(CAPABILITIES)).default([]),
    features: featuresSchema.default({ persona: true }),
    env: envSchema.default({ required: [], optional: [] }),
    connectors: connectorsSchema.default([]),
    image: z
      .object({
        dockerfile: z.string().min(1).optional(),
        imageUrl: z.string().min(1).optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (!value.dockerfile && !value.imageUrl) {
          ctx.addIssue({ code: 'custom', message: 'Must specify either image.dockerfile or image.imageUrl' })
        }
      }),
    resources: resourcesSchema.optional(),
    configSchema: configSchemaSchema.optional(),
    defaultConfig: z.record(z.string(), jsonValueSchema).optional(),
    pipelineSchema: pipelineSchemaSchema.optional(),
    // Per-AgentType {{placeholder}} palette for the Configurator (manifest-driven).
    runtimeVariables: z.array(runtimeVariableSchema).optional(),
    // Version of the SDK prompt compiler this agent resolves prompts with. Saved
    // configurations are checked against it (a config can require a minimum version).
    promptCompiler: z.object({ version: semver() }).strict().optional(),
    sdk: z.object({ minVersion: semver().optional() }).strict().optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    checkResources(manifest.resources, ctx)

    // Features and capabilities describe the same agent and must agree.
    const caps = new Set(manifest.capabilities)
    const plans = manifest.features.plans
    if (plans && !caps.has('plans')) {
      ctx.addIssue({ code: 'custom', path: ['features', 'plans'], message: 'features.plans needs the "plans" capability' })
    }
    if (!plans && caps.has('plans')) {
      ctx.addIssue({ code: 'custom', path: ['capabilities'], message: 'the "plans" capability needs features.plans' })
    }
    const companion = plans?.modes.includes('companion') ?? false
    if (companion !== caps.has('companion')) {
      ctx.addIssue({
        code: 'custom',
        path: ['features', 'plans', 'modes'],
        message: 'features.plans.modes includes "companion" exactly when capabilities includes "companion"',
      })
    }

    if (manifest.features.configurator && !manifest.pipelineSchema) {
      ctx.addIssue({ code: 'custom', path: ['features', 'configurator'], message: 'features.configurator needs a pipelineSchema' })
    }

    // Expert-capable agents built in the Configurator must expose their expert configuration.
    if (
      caps.has(EXPERTS_CAPABILITY) &&
      manifest.features.configurator &&
      !EXPERT_CONFIG_PROPERTY_KEYS.some((key) => key in (manifest.configSchema?.properties ?? {}))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['configSchema'],
        message: 'capabilities includes "experts" with features.configurator but configSchema does not expose expert configuration',
      })
    }

    const optionalNames = new Set(manifest.env.optional.map((v) => v.name))
    for (const name of manifest.env.required) {
      if (optionalNames.has(name)) {
        ctx.addIssue({ code: 'custom', path: ['env'], message: `${name} is both required and optional` })
      }
    }

    // configSchema holds user settings only; v1's platform flags have their own blocks now.
    for (const key of findStellaExtensionKeys(manifest.configSchema)) {
      ctx.addIssue({
        code: 'custom',
        path: ['configSchema'],
        message: `${key} is a manifest 1.0 flag; declare it in features, env or connectors instead`,
      })
    }
  })

/** A parsed, validated agent manifest with every default applied. */
export type AgentManifest = z.output<typeof agentManifestSchema>
export type ManifestConnectorSlot = AgentManifest['connectors'][number]
export type ManifestOptionalEnvVar = AgentManifest['env']['optional'][number]

export interface ManifestSchemaParseResult {
  valid: boolean
  errors: string[]
  warnings: string[]
  manifest?: AgentManifest
}

/** Parse agent.yaml text. Upload, seed and CI validation all go through here. */
export function parseAgentManifestYaml(content: string): ManifestSchemaParseResult {
  let parsedYaml: unknown
  try {
    parsedYaml = yaml.load(content)
  } catch (error) {
    return { valid: false, errors: [`Invalid YAML: ${(error as Error).message}`], warnings: [] }
  }
  return parseAgentManifest(parsedYaml)
}

/** Parse an already-loaded manifest object (any supported format version). */
export function parseAgentManifest(raw: unknown): ManifestSchemaParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Manifest must be a valid YAML object'], warnings: [] }
  }

  const normalized = normalizeManifest(raw as Record<string, unknown>)
  if (normalized.errors.length > 0) {
    return { valid: false, errors: normalized.errors, warnings: normalized.warnings }
  }

  const parsed = agentManifestSchema.safeParse(normalized.manifest)
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.map(formatIssue), warnings: normalized.warnings }
  }

  const manifest = parsed.data
  const warnings = [...normalized.warnings]

  // configSchema must be a valid JSON Schema document, and defaultConfig must fit it.
  if (manifest.configSchema) {
    const schemaErrors = validateJsonSchemaObject(manifest.configSchema)
    if (schemaErrors.length > 0) {
      return { valid: false, errors: schemaErrors.map((e) => `configSchema: ${e}`), warnings }
    }
    if (manifest.defaultConfig) {
      // Defaults fill in settings; a setting the user must give (e.g. a project id)
      // has none, so `required` does not apply to them. Types and ranges do.
      const configErrors = validateAgainstSchema(withoutRequired(manifest.configSchema), manifest.defaultConfig)
      if (configErrors.length > 0) {
        return { valid: false, errors: configErrors.map((e) => `defaultConfig: ${e}`), warnings }
      }
    }
  }

  if (manifest.image.dockerfile && manifest.image.imageUrl) {
    warnings.push('Both dockerfile and imageUrl specified; dockerfile will be used')
  }
  if (manifest.resources?.gpu === true) {
    warnings.push('GPU resources require admin approval')
  }

  return { valid: true, errors: [], warnings, manifest }
}

function checkResources(resources: z.infer<typeof resourcesSchema> | undefined, ctx: z.RefinementCtx): void {
  const pairs = [
    ['memory', resources?.memory, parseMemoryBytes, RESOURCE_DEFAULTS.memory.max],
    ['cpu', resources?.cpu, parseCpuMillicores, RESOURCE_DEFAULTS.cpu.max],
  ] as const
  for (const [kind, quantity, parse, max] of pairs) {
    const limit = quantity?.limit ? parse(quantity.limit) : null
    const request = quantity?.request ? parse(quantity.request) : null
    if (limit !== null && limit > parse(max)!) {
      ctx.addIssue({ code: 'custom', path: ['resources', kind, 'limit'], message: `${kind} limit exceeds maximum allowed: ${max}` })
    }
    if (limit !== null && request !== null && request > limit) {
      ctx.addIssue({ code: 'custom', path: ['resources', kind, 'request'], message: `${kind} request must not exceed its limit` })
    }
  }
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const joinedPath = issue.path.length > 0 ? issue.path.join('.') : 'manifest'
  return `${joinedPath}: ${issue.message}`
}

function validateJsonSchemaObject(schema: unknown): string[] {
  const valid = (ajv as any).validateSchema(schema as object)
  const errors = ((ajv as any).errors ?? []) as unknown[]
  if (valid || errors.length === 0) return []
  return errors.map(formatAjvError)
}

/** Validate a value against a JSON Schema. Exported for the deploy path. */
export function validateAgainstSchema(schema: object, value: unknown): string[] {
  const validate = (ajv as any).compile(schema)
  if (validate(value)) return []
  return ((validate.errors ?? []) as unknown[]).map(formatAjvError)
}

function formatAjvError(error: unknown): string {
  const issue = error as { message?: string; instancePath?: string; dataPath?: string }
  // Ajv v8 uses instancePath while older versions use dataPath.
  const path = issue.instancePath || issue.dataPath || ''
  const at = path ? ` at ${path}` : ''
  return `${issue.message || 'invalid JSON Schema'}${at}`
}

/** A copy of a JSON Schema with every `required` list removed, at any depth. */
function withoutRequired(node: unknown): any {
  if (Array.isArray(node)) return node.map(withoutRequired)
  if (!node || typeof node !== 'object') return node
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required' && Array.isArray(value)) continue
    copy[key] = withoutRequired(value)
  }
  return copy
}

/** Every `x-stella-*` key anywhere inside a JSON Schema document. */
export function findStellaExtensionKeys(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) findStellaExtensionKeys(item, found)
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith('x-stella-')) found.add(key)
      findStellaExtensionKeys(value, found)
    }
  }
  return found
}

/** Where the published JSON Schema lives (served by the docs site). */
export const MANIFEST_JSON_SCHEMA_PATH = 'docs-site/static/schemas/agent-manifest.v2.json'

/**
 * The manifest as a JSON Schema document, for editors and other tools
 * (`# yaml-language-server: $schema=…` at the top of agent.yaml). Generated from
 * agentManifestSchema, so it can't drift; a spec checks the committed file is current.
 * Cross-field rules (features vs capabilities, resource maxima) are enforced only
 * by STELLA, since JSON Schema can't express them.
 */
export function manifestJsonSchema(): Record<string, unknown> {
  return {
    $id: 'https://stella.c4dhi.org/schemas/agent-manifest.v2.json',
    title: 'STELLA agent manifest (agent.yaml)',
    ...z.toJSONSchema(agentManifestSchema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' }),
  }
}
