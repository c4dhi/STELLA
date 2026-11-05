/**
 * The one place that holds the defaults, limits and vocabularies of the agent
 * manifest (agent.yaml). The schema, the manifest → AgentType mapping, the pod
 * resource clamping and the docs all read from here, so a default can never be
 * one value on upload and another at deploy.
 */

/** The manifest format this platform writes and documents. */
export const MANIFEST_VERSION = '2.0'

/**
 * Manifest formats this platform still reads. v1 put its platform flags
 * (`x-stella-*`) inside configSchema; see manifest-normalizer.ts.
 */
export const LEGACY_MANIFEST_VERSIONS = ['1.0'] as const

export const SLUG_REGEX = /^[a-z][a-z0-9-]*[a-z0-9]$/
export const VERSION_REGEX = /^\d+\.\d+\.\d+$/
export const ENV_VAR_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/
export const CONNECTOR_SLOT_REGEX = /^[a-z][a-z0-9-]{0,39}$/
export const KUBERNETES_MEMORY_REGEX = /^\d+(Ki|Mi|Gi)?$/
export const KUBERNETES_CPU_REGEX = /^\d+m?$/

/** What an agent can do. Descriptive, and gates which experts it publishes. */
export const CAPABILITIES = ['voice', 'text', 'progress', 'plans', 'experts', 'companion'] as const
export type Capability = (typeof CAPABILITIES)[number]

/** How a session can run an agent that supports plans. */
export const PLAN_MODES = ['plan', 'companion'] as const
export type PlanMode = (typeof PLAN_MODES)[number]

export const CONNECTOR_KINDS = ['mcp'] as const

export const DEFAULT_DOCKERFILE = 'Dockerfile'

/**
 * Pod resources for an agent that declares none. A request is never above its
 * limit: Kubernetes refuses such a pod, so a declared limit below the default
 * request lowers the request to it.
 */
export const RESOURCE_DEFAULTS = {
  memory: { request: '512Mi', limit: '512Mi', max: '4Gi' },
  cpu: { request: '250m', limit: '250m', max: '2000m' },
} as const

/** Base images an uploaded Dockerfile may start FROM. */
export const SUPPORTED_BASE_IMAGES = [
  'python:3.10-slim',
  'python:3.11-slim',
  'python:3.12-slim',
  'python:3.10',
  'python:3.11',
  'python:3.12',
] as const

/**
 * The oldest stella-ai-agent-sdk STELLA still supports. An agent built with an
 * older SDK cannot be deployed until it is rebuilt with a newer one. Raising it
 * is how STELLA retires old SDKs: change it here and note it in the CHANGELOG.
 */
export const MIN_SUPPORTED_SDK_VERSION = '0.4.0'

/** Experts that implement a mode rather than assess a turn, and the capability each rides on. */
export const STRUCTURAL_EXPERT_CAPABILITY: Readonly<Record<string, Capability>> = {
  task_extraction: 'plans',
  companion_router: 'companion',
}

/** Verdict actions an expert may declare. Mirrors VERDICT_ACTIONS in the SDK's expert base. */
export const VERDICT_ACTIONS = ['inform', 'prepend', 'override', 'short_circuit'] as const

export function parseMemoryBytes(value: string): number | null {
  const match = value.match(/^(\d+)(Ki|Mi|Gi)?$/)
  if (!match) return null
  const units: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 }
  return parseInt(match[1], 10) * (match[2] ? units[match[2]] : 1)
}

export function parseCpuMillicores(value: string): number | null {
  const match = value.match(/^(\d+)(m?)$/)
  if (!match) return null
  const num = parseInt(match[1], 10)
  return match[2] === 'm' ? num : num * 1000
}
