import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import * as fs from 'fs'
import * as path from 'path'
import * as dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { loadAgentDirectory, type LoadedAgentDirectory } from '../src/agent-package/agent-directory.js'
import { manifestToAgentTypeData } from '../src/agent-package/manifest-mapper.js'
import { CURRENT_SDK_VERSION } from '../src/agent-package/manifest-defaults.js'
import { reconcileAgentTypeConfigurations } from '../src/agent-configurations/configuration-reconciliation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveWorkspaceRoot(): string {
  if (process.env.AGENT_WORKSPACE_ROOT) {
    return process.env.AGENT_WORKSPACE_ROOT
  }

  // Support both compile layouts:
  // - prisma/seed.js            -> __dirname ends with /prisma
  // - prisma/prisma/seed.js     -> __dirname ends with /prisma/prisma
  const candidates = [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'agents'))) {
      return candidate
    }
  }

  // Fall back to previous behavior for consistent error messaging downstream.
  return path.resolve(__dirname, '..')
}

function loadSeedEnv(): void {
  const workspaceRoot = resolveWorkspaceRoot()
  const envPath = path.join(workspaceRoot, '.env')
  const envLocalPath = path.join(workspaceRoot, '.env.local')

  // Load .env first, then .env.local to allow local overrides.
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath })
  }
  if (fs.existsSync(envLocalPath)) {
    dotenv.config({ path: envLocalPath, override: true })
  }
}

loadSeedEnv()

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })

// Directories to skip when scanning for agents
const SKIP_DIRS = ['stella-ai-agent-sdk']


type BuiltinAgentInfo = LoadedAgentDirectory

/**
 * Discover built-in agents from the agents/ directory.
 *
 * Path resolution:
 * - In K8s: Uses AGENT_WORKSPACE_ROOT env var (mounted project directory)
 * - Local dev: Uses relative path from prisma/ to agents/
 */
function discoverBuiltinAgents(): BuiltinAgentInfo[] {
  const workspaceRoot = resolveWorkspaceRoot()
  const agentsDir = path.join(workspaceRoot, 'agents')

  if (!fs.existsSync(agentsDir)) {
    throw new Error(
      `Agents directory not found: ${agentsDir}\n` +
      `If running in K8s, ensure AGENT_WORKSPACE_ROOT is set and the project is mounted.`
    )
  }

  console.log(`Discovering built-in agents from: ${agentsDir}`)

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true })
  const agentDirs = entries.filter(
    (entry) => entry.isDirectory() && !SKIP_DIRS.includes(entry.name),
  )

  const agents: BuiltinAgentInfo[] = []

  for (const dir of agentDirs) {
    // Same parser, Dockerfile check and expert reader as uploads, so the two can't drift.
    const loaded = loadAgentDirectory(path.join(agentsDir, dir.name))
    if (loaded.warnings.length > 0) {
      console.warn(`  Warnings for ${dir.name}:`)
      for (const warning of loaded.warnings) {
        console.warn(`    - ${warning}`)
      }
    }
    agents.push(loaded)
    console.log(`  Found: ${loaded.manifest.metadata.name} (${loaded.manifest.metadata.slug})`)
  }

  console.log(`Discovered ${agents.length} built-in agents`)
  return agents
}

function normalizeJsonForCompare(value: unknown): unknown {
  // Prisma null sentinels (DbNull/JsonNull/AnyNull) should compare as null
  // against values read back from the database.
  if (value === Prisma.DbNull || value === Prisma.JsonNull || value === Prisma.AnyNull) {
    return null
  }

  if (
    typeof value === 'object' &&
    value !== null &&
    ['DbNull', 'JsonNull', 'AnyNull'].includes(
      (value as { constructor?: { name?: string } }).constructor?.name ?? '',
    )
  ) {
    return null
  }

  if (value === null || value === undefined) return null
  if (Array.isArray(value)) {
    return value.map(normalizeJsonForCompare)
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, normalizeJsonForCompare(v)])
    return Object.fromEntries(entries)
  }
  return value
}

function normalizedString(value: unknown): string {
  return JSON.stringify(normalizeJsonForCompare(value))
}

function preview(value: unknown, max = 240): string {
  const serialized = normalizedString(value)
  if (serialized.length <= max) return serialized
  return `${serialized.slice(0, max)}...<truncated ${serialized.length - max} chars>`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Post-seed round-trip verification:
 * Re-read persisted AgentType rows and assert key mapped fields still match source manifests.
 * This protects against silent drift in mapping logic or Prisma null/JSON serialization behavior.
 */
async function verifySeedRoundTrip(agents: BuiltinAgentInfo[]): Promise<void> {
  const mismatches: string[] = []

  for (const { manifest } of agents) {
    const expected = manifestToAgentTypeData(manifest, null)
    const actual = await prisma.agentType.findUnique({
      where: { slug: manifest.metadata.slug },
      select: {
        slug: true,
        name: true,
        description: true,
        icon: true,
        version: true,
        authorName: true,
        authorEmail: true,
        tags: true,
        capabilities: true,
        dockerfilePath: true,
        imageUrl: true,
        resourceMemory: true,
        resourceCpu: true,
        resourceGpu: true,
        configSchema: true,
        defaultConfig: true,
        pipelineSchema: true,
        sdkMinVersion: true,
      },
    })

    if (!actual) {
      mismatches.push(`[${manifest.metadata.slug}] missing persisted AgentType record`)
      continue
    }

    // Compare deterministic scalar and array fields (including resource limits and capabilities).
    const scalarChecks: Array<[field: string, expectedValue: unknown, actualValue: unknown]> = [
      ['slug', expected.slug, actual.slug],
      ['name', expected.name, actual.name],
      ['description', expected.description, actual.description],
      ['icon', expected.icon, actual.icon],
      ['version', expected.version, actual.version],
      ['authorName', expected.authorName, actual.authorName],
      ['authorEmail', expected.authorEmail, actual.authorEmail],
      ['dockerfilePath', expected.dockerfilePath, actual.dockerfilePath],
      ['imageUrl', expected.imageUrl, actual.imageUrl],
      ['resourceMemory', expected.resourceMemory, actual.resourceMemory],
      ['resourceCpu', expected.resourceCpu, actual.resourceCpu],
      ['resourceGpu', expected.resourceGpu, actual.resourceGpu],
      ['sdkMinVersion', expected.sdkMinVersion, actual.sdkMinVersion],
      ['capabilities', expected.capabilities, actual.capabilities],
    ]

    for (const [field, expectedValue, actualValue] of scalarChecks) {
      if (normalizedString(expectedValue) !== normalizedString(actualValue)) {
        mismatches.push(
          `[${manifest.metadata.slug}] ${field} mismatch (expected=${preview(expectedValue)}, actual=${preview(actualValue)})`,
        )
      }
    }

    // Explicit shape checks catch malformed JSON writes before deep comparison.
    if (manifest.configSchema && !isPlainObject(actual.configSchema)) {
      mismatches.push(
        `[${manifest.metadata.slug}] configSchema malformed in DB (expected object, got ${typeof actual.configSchema})`,
      )
    }

    if (manifest.defaultConfig && !isPlainObject(actual.defaultConfig)) {
      mismatches.push(
        `[${manifest.metadata.slug}] defaultConfig malformed in DB (expected object, got ${typeof actual.defaultConfig})`,
      )
    }

    if (manifest.pipelineSchema) {
      if (!isPlainObject(actual.pipelineSchema)) {
        mismatches.push(
          `[${manifest.metadata.slug}] pipelineSchema malformed in DB (expected object, got ${typeof actual.pipelineSchema})`,
        )
      } else {
        const nodes = (actual.pipelineSchema as Record<string, unknown>).nodes
        const edges = (actual.pipelineSchema as Record<string, unknown>).edges
        const thresholds = (actual.pipelineSchema as Record<string, unknown>).thresholds
        if (!Array.isArray(nodes) || !Array.isArray(edges) || !Array.isArray(thresholds)) {
          mismatches.push(
            `[${manifest.metadata.slug}] pipelineSchema malformed in DB (nodes/edges/thresholds must be arrays)`,
          )
        }
      }
    }

    // Compare JSON fields with null-safe canonicalization to avoid ordering/shape noise.
    const jsonChecks: Array<[field: string, expectedValue: unknown, actualValue: unknown]> = [
      ['tags', expected.tags, actual.tags],
      ['configSchema', expected.configSchema, actual.configSchema],
      ['defaultConfig', expected.defaultConfig, actual.defaultConfig],
      ['pipelineSchema', expected.pipelineSchema, actual.pipelineSchema],
    ]

    for (const [field, expectedValue, actualValue] of jsonChecks) {
      const expectedNormalized = normalizedString(expectedValue)
      const actualNormalized = normalizedString(actualValue)

      // Length comparison is a simple guardrail for silent truncation.
      if (expectedNormalized.length !== actualNormalized.length) {
        mismatches.push(
          `[${manifest.metadata.slug}] ${field} possible truncation (expected length=${expectedNormalized.length}, actual length=${actualNormalized.length})`,
        )
      }

      if (expectedNormalized !== actualNormalized) {
        mismatches.push(
          `[${manifest.metadata.slug}] ${field} JSON mismatch (expected=${preview(expectedValue)}, actual=${preview(actualValue)})`,
        )
      }
    }
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Post-seed round-trip verification failed:\n  - ${mismatches.join('\n  - ')}`,
    )
  }

  console.log(`Round-trip verification passed for ${agents.length} agent types`)
}

/**
 * Deactivate built-in agent types that are no longer present in agents/.
 *
 * Retiring an agent = removing (archiving) its directory. This flips any leftover
 * built-in row whose slug is no longer discovered to REJECTED, so it disappears
 * from the gallery (AgentTypeService.findAll filters to APPROVED) without deleting
 * data — sessions and saved configurations that reference it keep their FK intact.
 * Custom (non-built-in) agents are never touched.
 */
async function deactivateRetiredBuiltins(discoveredSlugs: string[]): Promise<void> {
  const retired = await prisma.agentType.updateMany({
    where: {
      isBuiltIn: true,
      slug: { notIn: discoveredSlugs },
      // Skip already-deactivated rows so reruns stay idempotent and quiet.
      validationStatus: { not: 'REJECTED' },
    },
    data: {
      // Literal to avoid a hard dependency on generated enum export names.
      validationStatus: 'REJECTED',
      validationNotes: 'Retired: no longer present in the built-in agents/ registry',
    },
  })

  if (retired.count > 0) {
    console.log(`Deactivated ${retired.count} retired built-in agent type(s)`)
  }
}

/**
 * The system default persona (#467) — the terminus of the persona resolution
 * chain, so it must always exist.
 *
 * The row is created by the add_persona migration; this keeps its TEXT current
 * across deploys without ever clobbering ownership or resurrecting a row an
 * operator repointed. Deliberately id-stable: agentConfig snapshots reference
 * personas by id, so a fresh id each seed would orphan them.
 */
const SYSTEM_DEFAULT_PERSONA_ID = '00000000-0000-4000-8000-000000000001'

const SYSTEM_DEFAULT_PERSONA_PROMPT = `You are STELLA — a warm, genuinely curious conversation partner with a personality of your own, working toward collecting specific information through real conversation, not a form.

- Respond in the SAME LANGUAGE the user speaks (German if they speak German, English if English).
- Keep responses to 30-50 words (this is a voice conversation).
- NEVER mention internal systems, experts, deliverables, or technical metadata.
- React to the specific thing the user said; never re-ask something they already answered.
- Ask for missing information naturally, one thing at a time.`

/**
 * The built-in persona for companion deployments. The default above is written
 * for plans; a companion keeps company and collects nothing, and saying so in
 * the persona means no hidden instruction has to argue the persona down.
 * Id-stable for the same reason, and looked up BY id: with two defaults,
 * "the row flagged isSystemDefault" no longer names one.
 */
const COMPANION_DEFAULT_PERSONA_ID = '00000000-0000-4000-8000-000000000002'

const COMPANION_DEFAULT_PERSONA_PROMPT = `You are STELLA — a warm, easygoing companion with a personality of your own. You keep someone company. You are not interviewing them, and there is nothing you need to find out.

- Respond in the SAME LANGUAGE the user speaks (German if they speak German, English if English).
- Keep responses to one or two short sentences (this is a voice conversation).
- NEVER mention internal systems, experts, deliverables, or technical metadata.
- React to the specific thing the user said. Do not ask questions to keep the conversation going: let them lead, and be comfortable with silence.
- While an activity is running, follow it: ask what it asks, one thing at a time.`

async function seedSystemDefaultPersona(): Promise<void> {
  // The plan default may have been repointed to another id by an operator, so
  // it is "the default that is not the companion one".
  const existing = await prisma.persona.findFirst({
    where: { isSystemDefault: true, id: { not: COMPANION_DEFAULT_PERSONA_ID } },
  })

  if (existing) {
    // Only the prompt text is refreshed. Name/icon are left alone so an operator
    // can rename the default without the next seed undoing it.
    if (existing.systemPrompt !== SYSTEM_DEFAULT_PERSONA_PROMPT) {
      await prisma.persona.update({
        where: { id: existing.id },
        data: { systemPrompt: SYSTEM_DEFAULT_PERSONA_PROMPT },
      })
      console.log(`  - refreshed system default persona (${existing.id})`)
    }
  } else {
    const created = await prisma.persona.create({
      data: {
        id: SYSTEM_DEFAULT_PERSONA_ID,
        userId: null,
        name: 'STELLA (default)',
        description:
          'Built-in fallback identity, used when a deployment names no persona. Copy it to make your own.',
        icon: '🌟',
        systemPrompt: SYSTEM_DEFAULT_PERSONA_PROMPT,
        isSystemDefault: true,
      },
    })
    console.log(`  - created system default persona (${created.id})`)
  }

  const companion = await prisma.persona.findUnique({ where: { id: COMPANION_DEFAULT_PERSONA_ID } })
  if (companion) {
    if (companion.systemPrompt !== COMPANION_DEFAULT_PERSONA_PROMPT) {
      await prisma.persona.update({
        where: { id: companion.id },
        data: { systemPrompt: COMPANION_DEFAULT_PERSONA_PROMPT },
      })
      console.log(`  - refreshed companion default persona (${companion.id})`)
    }
    return
  }
  await prisma.persona.create({
    data: {
      id: COMPANION_DEFAULT_PERSONA_ID,
      userId: null,
      name: 'STELLA Companion (default)',
      description:
        'Built-in identity for companion deployments, used when one names no persona. Keeps company instead of interviewing. Copy it to make your own.',
      icon: '🛋️',
      systemPrompt: COMPANION_DEFAULT_PERSONA_PROMPT,
      isSystemDefault: true,
    },
  })
  console.log(`  - created companion default persona (${COMPANION_DEFAULT_PERSONA_ID})`)
}

async function main() {
  console.log('Seeding agent types from manifests...')

  // Discover and validate all built-in agents
  const agents = discoverBuiltinAgents()

  if (agents.length === 0) {
    throw new Error('No built-in agents found. Check that agents/ directory contains agent subdirectories with agent.yaml files.')
  }

  // Upsert each agent to database
  for (const { manifest, expertDefaults } of agents) {
    // Built-ins are built from this repo, so they install the repo's SDK.
    const dbFields = { ...manifestToAgentTypeData(manifest, expertDefaults), sdkVersion: CURRENT_SDK_VERSION }

    // Capture the pre-upsert state so we can detect a version/schema change and
    // reconcile saved configurations ONLY when the agent type actually changed.
    const before = await prisma.agentType.findUnique({
      where: { slug: manifest.metadata.slug },
      select: { version: true, pipelineSchemaHash: true, compilerVersion: true },
    })

    const result = await prisma.agentType.upsert({
      where: { slug: manifest.metadata.slug },
      // The manifest is the source of truth for every manifest-derived column, so
      // an UPDATE carries all of them (deprecation included). isBuiltIn and
      // validationStatus are kept as they are.
      update: dbFields,
      create: {
        ...dbFields,
        isBuiltIn: true,
        // Use literal to avoid hard dependency on generated enum export names.
        validationStatus: 'APPROVED',
      },
    })

    console.log(`  - ${result.name} (${result.slug}) [${result.id}]`)

    // Reconcile saved configurations only when the version or pipeline schema
    // changed (or this type is brand new). Keeps the seed O(changed types).
    const versionChanged = before?.version !== result.version
    const schemaChanged = before?.pipelineSchemaHash !== result.pipelineSchemaHash
    // Compatibility also depends on compilerVersion (a config can require a minimum
    // prompt-compiler version), so a manifest that bumps ONLY promptCompiler.version
    // must still re-flag saved configs — otherwise the deploy path trusts a stale flag.
    const compilerChanged = before?.compilerVersion !== result.compilerVersion
    if (!before || versionChanged || schemaChanged || compilerChanged) {
      const report = await reconcileAgentTypeConfigurations(prisma, result.id)
      if (report.total > 0) {
        console.log(
          `    reconciled ${report.total} configuration(s): ` +
            `${report.current} current, ${report.compatible} compatible, ` +
            `${report.outdated} outdated, ${report.pruned} pruned`,
        )
      }
    }
  }

  // Hide any built-in agent types that were retired (directory archived/removed).
  await deactivateRetiredBuiltins(agents.map(({ manifest }) => manifest.metadata.slug))

  await verifySeedRoundTrip(agents)

  console.log('Seeding personas...')
  await seedSystemDefaultPersona()

  console.log('Seeding complete!')
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
