import * as fs from 'fs'
import * as path from 'path'
import { DEFAULT_DOCKERFILE } from './manifest-defaults.js'
import { selectExpertDefaults, type ExpertFile } from './expert-defaults.js'
import { parseAgentManifestYaml, type AgentManifest } from './schemas/agent-manifest.schema.js'

/** Where built-in agents live, relative to the backend root. Each folder is named after its slug. */
export const BUILT_IN_AGENTS_DIR = 'agents'

/**
 * The Dockerfile of a built-in agent, relative to the backend root, which is
 * its build context (its Dockerfile copies the SDK from agents/ too).
 */
export function builtInDockerfilePath(manifest: AgentManifest): string {
  return path.posix.join(BUILT_IN_AGENTS_DIR, manifest.metadata.slug, manifest.image.dockerfile ?? DEFAULT_DOCKERFILE)
}

export interface LoadedAgentDirectory {
  directoryPath: string
  manifest: AgentManifest
  warnings: string[]
  expertDefaults: Record<string, unknown>[] | null
}

/**
 * Read an agent from a folder on disk (a built-in agent under agents/): its
 * agent.yaml, its Dockerfile and its config/experts/*.json. Throws with every
 * problem listed, so a broken built-in agent stops the seed.
 */
export function loadAgentDirectory(directoryPath: string): LoadedAgentDirectory {
  const name = path.basename(directoryPath)
  const manifestPath = path.join(directoryPath, 'agent.yaml')
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing agent.yaml in ${name}. Every built-in agent must have a manifest file.`)
  }

  const parsed = parseAgentManifestYaml(fs.readFileSync(manifestPath, 'utf-8'))
  if (!parsed.valid || !parsed.manifest) {
    throw new Error(`Invalid agent.yaml in ${name}:\n  - ${parsed.errors.join('\n  - ')}`)
  }
  const manifest = parsed.manifest
  if (manifest.metadata.slug !== name) {
    // The image build and the scripts find a built-in by its folder.
    throw new Error(`The folder of agent ${manifest.metadata.slug} must be named ${manifest.metadata.slug}, not ${name}`)
  }

  if (!manifest.image.imageUrl) {
    const dockerfilePath = path.join(directoryPath, manifest.image.dockerfile ?? DEFAULT_DOCKERFILE)
    if (!fs.existsSync(dockerfilePath)) {
      throw new Error(`Dockerfile not found for ${name}: ${dockerfilePath}`)
    }
  }

  return {
    directoryPath,
    manifest,
    warnings: parsed.warnings,
    expertDefaults: selectExpertDefaults(readExpertFiles(directoryPath), manifest.capabilities),
  }
}

function readExpertFiles(directoryPath: string): ExpertFile[] {
  const expertsDir = path.join(directoryPath, 'config', 'experts')
  if (!fs.existsSync(expertsDir)) return []
  return fs
    .readdirSync(expertsDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({
      path: `config/experts/${file}`,
      content: fs.readFileSync(path.join(expertsDir, file), 'utf-8'),
    }))
}
