import { BadRequestException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import {
  DEFAULT_DOCKERFILE,
  RESOURCE_DEFAULTS,
  parseCpuMillicores,
  parseMemoryBytes,
  type PlanMode,
} from '../agent-package/manifest-defaults.js'
import {
  parseAgentManifest,
  type AgentManifest,
  type ManifestClientChannel,
  type ManifestConnectorSlot,
  type ManifestOptionalEnvVar,
} from '../agent-package/schemas/agent-manifest.schema.js'

/**
 * What deploying an agent type takes, resolved from its manifest. The deploy
 * pipeline enforces it and GET /agent-types returns it, so the server and the
 * wizard read the same answer and nothing parses configSchema flags.
 */
export interface AgentRequirements {
  /** The deployment carries a persona (config.persona). */
  persona: boolean
  /** Null: the agent runs no plans, and a deployment may not give it one. */
  plans: { required: boolean; modes: PlanMode[] } | null
  /** Null: the agent takes no Configurator configuration (config.pipeline_config). */
  configurator: { required: boolean } | null
  env: { required: string[]; optional: ManifestOptionalEnvVar[] }
  connectors: ManifestConnectorSlot[]
  /** What the user's screen and the agent may send each other (the client channel). */
  client: ManifestClientChannel
  /** The settings a user may give the agent (JSON Schema), or null for none. */
  configSchema: Record<string, unknown> | null
  defaultConfig: Record<string, unknown>
  resources: {
    memory: { request: string; limit: string }
    cpu: { request: string; limit: string }
    gpu: boolean
  }
  /** The oldest stella-ai-agent-sdk the agent works with. */
  sdkMinVersion: string | null
}

export function resolveAgentRequirements(manifest: AgentManifest): AgentRequirements {
  const { features } = manifest
  return {
    persona: features.persona,
    plans: features.plans ? { required: features.plans.required, modes: [...features.plans.modes] } : null,
    configurator: features.configurator ? { required: features.configurator.required } : null,
    env: { required: [...manifest.env.required], optional: manifest.env.optional.map((v) => ({ ...v })) },
    connectors: manifest.connectors.map((slot) => ({ ...slot })),
    client: structuredClone(manifest.client),
    configSchema: manifest.configSchema ? structuredClone(manifest.configSchema) : null,
    defaultConfig: structuredClone((manifest.defaultConfig as Record<string, unknown>) ?? {}),
    resources: {
      memory: quantity(manifest.resources?.memory, RESOURCE_DEFAULTS.memory, parseMemoryBytes),
      cpu: quantity(manifest.resources?.cpu, RESOURCE_DEFAULTS.cpu, parseCpuMillicores),
      gpu: manifest.resources?.gpu ?? false,
    },
    sdkMinVersion: manifest.sdk?.minVersion ?? null,
  }
}

/**
 * A request defaults to the platform default, lowered to the limit when the
 * limit is smaller: Kubernetes refuses a pod whose request exceeds its limit.
 */
function quantity(
  declared: { request?: string; limit?: string } | undefined,
  defaults: { request: string; limit: string },
  parse: (value: string) => number | null,
): { request: string; limit: string } {
  const limit = declared?.limit ?? defaults.limit
  if (declared?.request) return { request: declared.request, limit }
  const below = (parse(limit) ?? Infinity) < (parse(defaults.request) ?? 0)
  return { request: below ? limit : defaults.request, limit }
}

/** The AgentType columns a manifest is read from (see {@link manifestOfAgentType}). */
export const AGENT_TYPE_MANIFEST_SELECT = {
  slug: true,
  manifest: true,
  name: true,
  description: true,
  version: true,
  icon: true,
  capabilities: true,
  dockerfilePath: true,
  configSchema: true,
  defaultConfig: true,
  pipelineSchema: true,
  resourceMemory: true,
  resourceCpu: true,
  sdkMinVersion: true,
} as const satisfies Prisma.AgentTypeSelect

/**
 * The AgentType columns the manifest is read from. All but `manifest` are only
 * read for rows stored before the manifest column existed.
 */
export type AgentTypeManifestSource = Prisma.AgentTypeGetPayload<{ select: typeof AGENT_TYPE_MANIFEST_SELECT }>

/**
 * The manifest of a stored agent type. Rows written since the manifest column
 * exists carry it; older ones (uploads from before) are rebuilt from their 1.0
 * columns and go through the same normalizer as a 1.0 agent.yaml, so there is
 * still one reading of a manifest.
 */
export function manifestOfAgentType(row: AgentTypeManifestSource): AgentManifest {
  const result = parseAgentManifest(row.manifest ?? legacyManifest(row))
  if (!result.manifest) {
    throw new BadRequestException(
      `Agent type ${row.slug} has a manifest STELLA cannot read (${result.errors.join('; ')}). Upload it again`,
    )
  }
  return result.manifest
}

/**
 * Requirements for a listing: an unreadable row gives null and the reason, so
 * one bad upload cannot take a whole list down. Deploying it still fails with
 * that reason.
 */
export function requirementsForListing(
  row: AgentTypeManifestSource,
): { requirements: AgentRequirements | null; error: string | null } {
  try {
    return { requirements: resolveAgentRequirements(manifestOfAgentType(row)), error: null }
  } catch (error) {
    return { requirements: null, error: (error as Error).message }
  }
}

function legacyManifest(row: AgentTypeManifestSource): Record<string, unknown> {
  const resources: Record<string, unknown> = {}
  if (row.resourceMemory) resources.memory = { limit: row.resourceMemory }
  if (row.resourceCpu) resources.cpu = { limit: row.resourceCpu }
  return {
    version: '1.0',
    metadata: {
      name: row.name,
      slug: row.slug,
      version: row.version,
      description: row.description,
      ...(row.icon ? { icon: row.icon } : {}),
    },
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : [],
    image: { dockerfile: row.dockerfilePath ?? DEFAULT_DOCKERFILE },
    ...(row.configSchema ? { configSchema: row.configSchema } : {}),
    ...(row.defaultConfig ? { defaultConfig: row.defaultConfig } : {}),
    ...(row.pipelineSchema ? { pipelineSchema: row.pipelineSchema } : {}),
    ...(Object.keys(resources).length ? { resources } : {}),
    ...(row.sdkMinVersion ? { sdk: { minVersion: row.sdkMinVersion } } : {}),
  }
}
