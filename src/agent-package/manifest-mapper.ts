import { Prisma } from '@prisma/client'
import { hashPipelineSchema } from '../agent-configurations/configuration-compat.util.js'
import { DEFAULT_DOCKERFILE, RESOURCE_DEFAULTS } from './manifest-defaults.js'
import { withConfigSettings, type ConfigSetting } from './config-settings.js'
import type { AgentManifest } from './schemas/agent-manifest.schema.js'

/**
 * The AgentType columns that come from an agent's manifest: the only mapping from
 * agent.yaml to the database. The seed (built-in agents) and the upload endpoint
 * both use it, adding just what differs between them (isBuiltIn, owner, package
 * file, review status). The full normalized manifest is stored in `manifest`;
 * the other columns are projections of it kept for queries and existing readers.
 */
export function manifestToAgentTypeData(
  manifest: AgentManifest,
  expertDefaults: Record<string, unknown>[] | null,
) {
  const { metadata } = manifest
  // The pipelineSchema column carries every setting the agent declares (#996),
  // so validation and the Configurator read one list; its hash covers them too.
  const pipelineSchema = withConfigSettings(
    manifest.pipelineSchema as Record<string, unknown> | undefined,
    manifest.settings as ConfigSetting[],
  )
  return {
    slug: metadata.slug,
    name: metadata.name,
    description: metadata.description,
    icon: metadata.icon ?? null,
    version: metadata.version,
    authorName: metadata.author?.name ?? null,
    authorEmail: metadata.author?.email ?? null,
    tags: metadata.tags ? (metadata.tags as Prisma.InputJsonValue) : Prisma.JsonNull,
    deprecated: metadata.deprecated === true,
    deprecationNote: metadata.deprecationNote ?? null,
    manifest: manifest as unknown as Prisma.InputJsonValue,
    capabilities: manifest.capabilities as Prisma.InputJsonValue,
    dockerfilePath: manifest.image.dockerfile ?? DEFAULT_DOCKERFILE,
    // A prebuilt image for built-in agents; uploads override it (STELLA builds theirs).
    imageUrl: manifest.image.imageUrl ?? null,
    resourceMemory: manifest.resources?.memory?.limit ?? RESOURCE_DEFAULTS.memory.limit,
    resourceCpu: manifest.resources?.cpu?.limit ?? RESOURCE_DEFAULTS.cpu.limit,
    resourceGpu: manifest.resources?.gpu ?? false,
    // The agent's own config description only; requirements come from the manifest column.
    configSchema: manifest.configSchema ? (manifest.configSchema as Prisma.InputJsonValue) : Prisma.JsonNull,
    defaultConfig: manifest.defaultConfig ? (manifest.defaultConfig as Prisma.InputJsonValue) : Prisma.JsonNull,
    pipelineSchema: pipelineSchema ? (pipelineSchema as Prisma.InputJsonValue) : Prisma.DbNull,
    pipelineSchemaHash: hashPipelineSchema(pipelineSchema),
    runtimeVariables: manifest.runtimeVariables
      ? (manifest.runtimeVariables as Prisma.InputJsonValue)
      : Prisma.DbNull,
    // compilerVersion is what saved configs' minCompilerVersion is checked against.
    compilerVersion: manifest.promptCompiler?.version ?? null,
    sdkMinVersion: manifest.sdk?.minVersion ?? null,
    expertDefaults: expertDefaults ? (expertDefaults as Prisma.InputJsonValue) : Prisma.DbNull,
  } satisfies Omit<Prisma.AgentTypeCreateInput, 'isBuiltIn'>
}
