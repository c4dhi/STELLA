import { Injectable, Logger } from '@nestjs/common'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { ManifestValidator } from '../agent-package/validators/manifest.validator.js'
import { AgentManifest } from '../agent-package/agent-manifest.types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export interface BuiltinAgentInfo {
  manifest: AgentManifest
  directoryPath: string
  dockerfilePath: string
}

// Directories to skip when scanning for agents
const SKIP_DIRS = ['stella-ai-agent-sdk']

@Injectable()
export class BuiltinAgentDiscoveryService {
  private readonly logger = new Logger(BuiltinAgentDiscoveryService.name)
  private readonly agentsDir: string

  constructor(private manifestValidator: ManifestValidator) {
    // Resolve agents directory relative to project root
    // In production, this would be set via environment variable
    this.agentsDir = process.env.AGENTS_DIR || path.resolve(__dirname, '../../agents')
  }

  /**
   * Discover all built-in agents by scanning the agents/ directory.
   * Each agent must have an agent.yaml manifest file.
   *
   * @throws Error if any manifest is missing or invalid
   */
  async discoverBuiltinAgents(): Promise<BuiltinAgentInfo[]> {
    this.logger.log(`Discovering built-in agents from: ${this.agentsDir}`)

    if (!fs.existsSync(this.agentsDir)) {
      throw new Error(`Agents directory not found: ${this.agentsDir}`)
    }

    const entries = fs.readdirSync(this.agentsDir, { withFileTypes: true })
    const agentDirs = entries.filter(
      (entry) => entry.isDirectory() && !SKIP_DIRS.includes(entry.name),
    )

    const agents: BuiltinAgentInfo[] = []

    for (const dir of agentDirs) {
      const agentPath = path.join(this.agentsDir, dir.name)
      const agentInfo = await this.validateBuiltinAgent(agentPath)

      if (agentInfo) {
        agents.push(agentInfo)
        this.logger.log(`  Found: ${agentInfo.manifest.metadata.name} (${agentInfo.manifest.metadata.slug})`)
      }
    }

    this.logger.log(`Discovered ${agents.length} built-in agents`)
    return agents
  }

  /**
   * Validate a single agent directory and return its manifest info.
   *
   * @param agentDir Full path to the agent directory
   * @throws Error if manifest is missing or invalid
   */
  async validateBuiltinAgent(agentDir: string): Promise<BuiltinAgentInfo> {
    const dirName = path.basename(agentDir)
    const manifestPath = path.join(agentDir, 'agent.yaml')

    // Check manifest exists
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `Missing agent.yaml in ${dirName}. Every built-in agent must have a manifest file.`,
      )
    }

    // Read and validate manifest
    const content = fs.readFileSync(manifestPath, 'utf-8')
    const validation = this.manifestValidator.validate(content)

    if (!validation.valid) {
      throw new Error(
        `Invalid agent.yaml in ${dirName}:\n  - ${validation.errors.join('\n  - ')}`,
      )
    }

    // Log any warnings
    if (validation.warnings.length > 0) {
      this.logger.warn(
        `Warnings for ${dirName}:\n  - ${validation.warnings.join('\n  - ')}`,
      )
    }

    const manifest = validation.manifest!

    // Determine Dockerfile path
    const dockerfilePath = manifest.image.dockerfile
      ? path.join(agentDir, manifest.image.dockerfile)
      : path.join(agentDir, 'Dockerfile')

    // Verify Dockerfile exists (unless using pre-built image)
    if (!manifest.image.imageUrl && !fs.existsSync(dockerfilePath)) {
      throw new Error(
        `Dockerfile not found for ${dirName}: ${dockerfilePath}`,
      )
    }

    return {
      manifest,
      directoryPath: agentDir,
      dockerfilePath,
    }
  }

  /**
   * Get the agents directory path.
   */
  getAgentsDir(): string {
    return this.agentsDir
  }
}
