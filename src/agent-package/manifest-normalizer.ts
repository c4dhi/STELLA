import { CAPABILITIES, LEGACY_MANIFEST_VERSIONS, MANIFEST_VERSION } from './manifest-defaults.js'

/**
 * The only code that knows older manifest formats. It turns a raw agent.yaml
 * object of any supported format into the current format (2.0), which the
 * schema then validates. Nothing else in STELLA reads a 1.0 flag.
 *
 * Manifest 1.0 put its platform flags inside configSchema:
 *   configSchema.x-stella-env-vars               → env.required
 *   configSchema.x-stella-optional-env-vars      → env.optional
 *   configSchema.x-stella-supports-configurator  → features.configurator (only with a pipelineSchema)
 *   configSchema.x-stella-connectors             → connectors
 *   a property with x-stella-requires-plan       → features.plans.required (the property,
 *                                                  the plan STELLA injects, is dropped)
 *   capability "plans" / "companion"             → features.plans / its "companion" mode
 *   unknown capabilities                         → dropped (1.0 only warned about them)
 */

export interface NormalizeResult {
  manifest: Record<string, unknown>
  errors: string[]
  warnings: string[]
}

const V1_ROOT_FLAGS = {
  env: 'x-stella-env-vars',
  optionalEnv: 'x-stella-optional-env-vars',
  configurator: 'x-stella-supports-configurator',
  connectors: 'x-stella-connectors',
} as const
const V1_REQUIRES_PLAN = 'x-stella-requires-plan'

export function normalizeManifest(raw: Record<string, unknown>): NormalizeResult {
  const version = raw.version
  if (version === MANIFEST_VERSION) {
    return { manifest: raw, errors: [], warnings: [] }
  }
  if (typeof version === 'string' && (LEGACY_MANIFEST_VERSIONS as readonly string[]).includes(version)) {
    return upgradeFromV1(raw)
  }
  return {
    manifest: raw,
    errors: [
      `version: unsupported manifest version ${JSON.stringify(version)} (supported: ${[MANIFEST_VERSION, ...LEGACY_MANIFEST_VERSIONS].join(', ')})`,
    ],
    warnings: [],
  }
}

function upgradeFromV1(raw: Record<string, unknown>): NormalizeResult {
  const warnings = [
    `Manifest version ${String(raw.version)} is deprecated; move to version "${MANIFEST_VERSION}" (features, env and connectors blocks). See the agent manifest reference.`,
  ]
  const { configSchema: rawConfigSchema, capabilities: rawCapabilities, ...rest } = raw

  const capabilities: string[] = []
  for (const capability of Array.isArray(rawCapabilities) ? rawCapabilities : []) {
    if ((CAPABILITIES as readonly unknown[]).includes(capability)) {
      capabilities.push(capability as string)
    } else {
      warnings.push(`Unknown capability: ${String(capability)}`)
    }
  }

  const configSchema = isObject(rawConfigSchema) ? structuredClone(rawConfigSchema) : undefined
  const requiresPlan = configSchema ? removeRequiresPlanProperties(configSchema) : false

  const env = {
    required: takeArray(configSchema, V1_ROOT_FLAGS.env),
    optional: takeArray(configSchema, V1_ROOT_FLAGS.optionalEnv),
  }
  let configurator = take(configSchema, V1_ROOT_FLAGS.configurator) === true
  if (configurator && !rest.pipelineSchema) {
    // 1.0 accepted the flag without a pipeline; the wizard simply showed no Configuration step.
    warnings.push('x-stella-supports-configurator has no effect without a pipelineSchema; ignored')
    configurator = false
  }
  const connectors = takeArray(configSchema, V1_ROOT_FLAGS.connectors)

  const hasPlans = capabilities.includes('plans')
  const hasCompanion = capabilities.includes('companion')
  const features: Record<string, unknown> = { persona: true, configurator }
  if (hasPlans || requiresPlan) {
    // 1.0 refused requires-plan without the plans capability; keep that error by
    // leaving capabilities as declared, so the 2.0 rule reports it.
    features.plans = { required: requiresPlan, modes: hasCompanion ? ['plan', 'companion'] : ['plan'] }
  }

  const manifest: Record<string, unknown> = {
    ...rest,
    version: MANIFEST_VERSION,
    capabilities,
    features,
    env,
    connectors,
  }
  // A configSchema left with nothing but `type: object` carries no user settings.
  if (configSchema && hasUserSettings(configSchema)) manifest.configSchema = configSchema
  return { manifest, errors: [], warnings }
}

/**
 * Drop every property marked x-stella-requires-plan (the plan STELLA injects is not
 * a user setting) and report whether there was one. Searches nested properties too.
 */
function removeRequiresPlanProperties(schema: Record<string, unknown>): boolean {
  let found = false
  const properties = schema.properties
  if (isObject(properties)) {
    for (const [name, property] of Object.entries(properties)) {
      if (!isObject(property)) continue
      if (property[V1_REQUIRES_PLAN] === true) {
        delete properties[name]
        if (Array.isArray(schema.required)) {
          schema.required = schema.required.filter((r) => r !== name)
        }
        found = true
        continue
      }
      delete property[V1_REQUIRES_PLAN]
      found = removeRequiresPlanProperties(property) || found
    }
  }
  return found
}

function hasUserSettings(schema: Record<string, unknown>): boolean {
  const hasProperties = isObject(schema.properties) && Object.keys(schema.properties).length > 0
  const otherKeywords = Object.keys(schema).filter((key) => !['type', 'properties', 'required'].includes(key))
  return hasProperties || otherKeywords.length > 0
}

function take(schema: Record<string, unknown> | undefined, key: string): unknown {
  if (!schema || !(key in schema)) return undefined
  const value = schema[key]
  delete schema[key]
  return value
}

function takeArray(schema: Record<string, unknown> | undefined, key: string): unknown[] {
  const value = take(schema, key)
  return Array.isArray(value) ? value : []
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
