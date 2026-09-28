import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { parseAgentManifestYaml } from '../src/agent-package/schemas/agent-manifest.schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SKIP_DIRS = new Set(['stella-ai-agent-sdk'])

function resolveWorkspaceRoot(): string {
  const cwdAgents = path.join(process.cwd(), 'agents')
  if (fs.existsSync(cwdAgents)) {
    return process.cwd()
  }

  const scriptRoot = path.resolve(__dirname, '..')
  const scriptAgents = path.join(scriptRoot, 'agents')
  if (fs.existsSync(scriptAgents)) {
    return scriptRoot
  }

  throw new Error('Could not resolve workspace root (missing agents/ directory)')
}

function discoverAgentManifests(agentsDir: string): string[] {
  const manifests: string[] = []

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        if (currentDir === agentsDir && SKIP_DIRS.has(entry.name)) {
          continue
        }
        walk(fullPath)
        continue
      }

      if (entry.isFile() && entry.name === 'agent.yaml') {
        manifests.push(fullPath)
      }
    }
  }

  walk(agentsDir)
  return manifests.sort((a, b) => a.localeCompare(b))
}

function listBuiltinAgentDirectories(agentsDir: string): string[] {
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
    .map((entry) => path.join(agentsDir, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

function formatBulletList(items: string[]): string {
  return items.map((item) => `  - ${item}`).join('\n')
}

function parseProjectVersionFromPyproject(pyprojectPath: string): string {
  if (!fs.existsSync(pyprojectPath)) {
    throw new Error(`SDK pyproject.toml not found: ${pyprojectPath}`)
  }

  const raw = fs.readFileSync(pyprojectPath, 'utf-8')
  const projectSectionMatch = raw.match(/\[project\][\s\S]*?(?=\n\[|$)/)
  const projectSection = projectSectionMatch ? projectSectionMatch[0] : raw
  const versionMatch = projectSection.match(/^\s*version\s*=\s*"([^"]+)"\s*$/m)

  if (!versionMatch) {
    throw new Error(`Could not parse SDK version from ${pyprojectPath}`)
  }

  return versionMatch[1]
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10), Number.parseInt(match[3], 10)]
}

function isSemverGte(actual: string, required: string): boolean {
  const a = parseSemver(actual)
  const b = parseSemver(required)
  if (!a || !b) return false

  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true
    if (a[i] < b[i]) return false
  }
  return true
}

function main(): void {
  const workspaceRoot = resolveWorkspaceRoot()
  const agentsDir = path.join(workspaceRoot, 'agents')
  const sdkPyprojectPath = path.join(workspaceRoot, 'agents', 'stella-ai-agent-sdk', 'pyproject.toml')
  const sdkVersion = parseProjectVersionFromPyproject(sdkPyprojectPath)

  console.log(`Validating built-in agents from: ${agentsDir}`)
  console.log(`Current SDK version: ${sdkVersion}`)

  if (!fs.existsSync(agentsDir)) {
    throw new Error(`Agents directory not found: ${agentsDir}`)
  }

  const manifestPaths = discoverAgentManifests(agentsDir)
  const failures: string[] = []
  const warnings: string[] = []
  const builtinAgentDirs = listBuiltinAgentDirectories(agentsDir)
  const seenSlugs = new Map<string, string>()

  for (const agentDir of builtinAgentDirs) {
    const expectedManifestPath = path.join(agentDir, 'agent.yaml')
    if (!fs.existsSync(expectedManifestPath)) {
      failures.push(
        `[${path.relative(workspaceRoot, agentDir)}] manifest check failed:\n` +
          '  - Missing agent.yaml',
      )
    }
  }

  if (manifestPaths.length === 0) {
    failures.push('No agent.yaml files found under agents/')
  }

  for (const manifestPath of manifestPaths) {
    const relativeManifestPath = path.relative(workspaceRoot, manifestPath)
    const agentDir = path.dirname(manifestPath)
    const manifestRaw = fs.readFileSync(manifestPath, 'utf-8')
    const parsed = parseAgentManifestYaml(manifestRaw)

    if (!parsed.valid || !parsed.manifest) {
      failures.push(
        `[${relativeManifestPath}] schema validation failed:\n${formatBulletList(parsed.errors)}`,
      )
      continue
    }

    if (parsed.warnings.length > 0) {
      warnings.push(
        `[${relativeManifestPath}] warnings:\n${formatBulletList(parsed.warnings)}`,
      )
    }

    const manifest = parsed.manifest
    const manifestDirName = path.basename(agentDir)

    if (manifest.metadata.slug !== manifestDirName) {
      failures.push(
        `[${relativeManifestPath}] metadata consistency check failed:\n` +
          `  - metadata.slug "${manifest.metadata.slug}" must match directory name "${manifestDirName}"`,
      )
    }

    const firstPathForSlug = seenSlugs.get(manifest.metadata.slug)
    if (firstPathForSlug) {
      failures.push(
        `[${relativeManifestPath}] duplicate slug check failed:\n` +
          `  - metadata.slug "${manifest.metadata.slug}" is already used by ${firstPathForSlug}`,
      )
    } else {
      seenSlugs.set(manifest.metadata.slug, relativeManifestPath)
    }

    const requiredSdkVersion = manifest.sdk?.minVersion
    if (!requiredSdkVersion) {
      failures.push(
        `[${relativeManifestPath}] sdk compatibility check failed:\n` +
          '  - sdk.minVersion is required for built-in agents',
      )
    } else if (!isSemverGte(sdkVersion, requiredSdkVersion)) {
      failures.push(
        `[${relativeManifestPath}] sdk compatibility check failed:\n` +
          `  - sdk.minVersion ${requiredSdkVersion} is not compatible with current SDK ${sdkVersion}`,
      )
    }

    if (!manifest.image.imageUrl) {
      const dockerfileRelativePath = manifest.image.dockerfile || 'Dockerfile'
      const dockerfileAbsolutePath = path.join(agentDir, dockerfileRelativePath)
      if (!fs.existsSync(dockerfileAbsolutePath)) {
        failures.push(
          `[${relativeManifestPath}] dockerfile check failed:\n` +
            `  - Dockerfile not found at ${path.relative(workspaceRoot, dockerfileAbsolutePath)}`,
        )
      }
    }

    console.log(`  OK: ${relativeManifestPath}`)
  }

  if (warnings.length > 0) {
    console.warn('\nAgent manifest warnings:')
    for (const warning of warnings) {
      console.warn(warning)
    }
  }

  if (failures.length > 0) {
    console.error('\nAgent validation failed:')
    for (const failure of failures) {
      console.error(failure)
    }
    process.exit(1)
  }

  console.log(`\nValidation succeeded: ${manifestPaths.length} agent manifest(s) checked.`)
}

main()
