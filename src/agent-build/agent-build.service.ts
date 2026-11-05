import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service.js'
import { AgentPackageService } from '../agent-package/agent-package.service.js'
import { execFile, ExecFileException } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { DEFAULT_DOCKERFILE, SLUG_REGEX, VERSION_REGEX } from '../agent-package/manifest-defaults.js'
import { SDK_PACKAGE, builtSdkProblem, sdkSupport } from '../agent-package/sdk-support.js'
import { manifestOfAgentType, type AgentTypeManifestSource } from '../agents/agent-requirements.js'

// execFile, never exec: every argument goes to the program as-is, with no shell
// in between, so nothing from an uploaded package can run a command on the host.
const execFileAsync = promisify(execFile)

/** `<slug>:<version>`, after checking both against the manifest patterns. */
export function buildImageName(slug: string, version: string): string {
  if (!SLUG_REGEX.test(slug)) throw new Error(`Invalid agent slug for an image name: ${JSON.stringify(slug)}`)
  if (!VERSION_REGEX.test(version)) throw new Error(`Invalid agent version for an image tag: ${JSON.stringify(version)}`)
  return `${slug}:${version}`
}

/**
 * Resolves the manifest's `image.dockerfile` inside the extracted package. It must
 * be a plain relative path (letters, digits, `.`, `_`, `-`, `/`) that stays inside
 * the package; anything else is refused rather than cleaned up.
 */
export function resolveDockerfilePath(extractedPath: string, dockerfile: string): string {
  const bad = () => new Error(`image.dockerfile must be a plain relative path inside the package: ${JSON.stringify(dockerfile)}`)
  if (!/^[A-Za-z0-9._/-]+$/.test(dockerfile) || dockerfile.startsWith('/') || dockerfile.startsWith('-')) throw bad()
  if (dockerfile.split('/').some((part) => part === '..')) throw bad()
  const root = path.resolve(extractedPath)
  const resolved = path.resolve(root, dockerfile)
  if (!resolved.startsWith(root + path.sep)) throw bad()
  return resolved
}

/** The version printed by the SDK probe, or null when it printed none. */
export function parseSdkVersionOutput(stdout: string): string | null {
  const version = stdout.trim().split('\n').pop()?.trim() ?? ''
  return /^\d+(\.\d+)*([.-]?[A-Za-z0-9.]+)?$/.test(version) ? version : null
}

export interface BuildResult {
  success: boolean
  imageName?: string
  buildLogId: string
  errorMessage?: string
}

export interface BuildStatus {
  id: string
  status: 'pending' | 'building' | 'success' | 'failed'
  imageName?: string
  progress?: string
  errorMessage?: string
  startedAt: Date
  completedAt?: Date
}

@Injectable()
export class AgentBuildService {
  private readonly logger = new Logger(AgentBuildService.name)
  private readonly isProduction: boolean

  // Track active builds to prevent duplicates
  private readonly activeBuilds: Map<string, Promise<BuildResult>> = new Map()

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
    private agentPackageService: AgentPackageService,
  ) {
    const nodeEnv = this.configService.get<string>('NODE_ENV', 'local')
    this.isProduction = nodeEnv === 'production'
  }

  /**
   * Start building a Docker image for an agent type.
   * Returns immediately with build log ID; build runs asynchronously.
   */
  async startBuild(agentTypeId: string): Promise<BuildResult> {
    // Check if build is already in progress
    const existingBuild = this.activeBuilds.get(agentTypeId)
    if (existingBuild) {
      this.logger.log(`Build already in progress for ${agentTypeId}`)
      return existingBuild
    }

    // Get agent type
    const agentType = await this.prisma.agentType.findUnique({
      where: { id: agentTypeId },
    })

    if (!agentType) {
      throw new Error(`Agent type not found: ${agentTypeId}`)
    }

    if (!agentType.packagePath) {
      throw new Error('Agent type has no uploaded package')
    }

    // Create build log
    const buildLog = await this.prisma.agentBuildLog.create({
      data: {
        agentTypeId,
        status: 'pending',
      },
    })

    // Start build in background
    const buildPromise = this.executeBuild(agentType, buildLog.id)
    this.activeBuilds.set(agentTypeId, buildPromise)

    // Clean up when done
    buildPromise.finally(() => {
      this.activeBuilds.delete(agentTypeId)
    })

    return {
      success: true,
      buildLogId: buildLog.id,
    }
  }

  /**
   * Execute the Docker build process.
   */
  private async executeBuild(
    agentType: AgentTypeManifestSource & { id: string; packagePath: string | null },
    buildLogId: string,
  ): Promise<BuildResult> {
    const imageName = buildImageName(agentType.slug, agentType.version)
    let extractedPath: string | null = null

    try {
      // Update status to building
      await this.prisma.agentBuildLog.update({
        where: { id: buildLogId },
        data: { status: 'building', imageName },
      })

      // Extract package to temp directory
      this.logger.log(`Extracting package for ${agentType.slug}...`)
      extractedPath = await this.agentPackageService.extractPackage(agentType.packagePath!)

      // The Dockerfile the stored manifest names (checked on upload, read here once more).
      const manifest = manifestOfAgentType(agentType)
      const dockerfilePath = await this.findDockerfile(extractedPath, manifest.image.dockerfile ?? DEFAULT_DOCKERFILE)
      if (!dockerfilePath) {
        throw new Error('Dockerfile not found in package')
      }

      // Build Docker image
      this.logger.log(`Building image ${imageName}...`)
      const buildOutput = await this.buildDockerImage(imageName, extractedPath, dockerfilePath)

      // What the image really has installed decides deployability, not what the
      // package claims: a build outside the SDK support window fails here.
      const sdkVersion = await this.detectSdkVersion(imageName)
      const sdkProblem = builtSdkProblem(sdkVersion)
      if (sdkProblem) {
        throw new Error(`Built ${imageName}, but ${sdkProblem}. Install ${SDK_PACKAGE} ${sdkSupport().minSupported} or newer in the package, then build again`)
      }

      // Update build log with success
      await this.prisma.agentBuildLog.update({
        where: { id: buildLogId },
        data: {
          status: 'success',
          buildOutput,
          completedAt: new Date(),
        },
      })

      // Import to K3s if production
      if (this.isProduction) {
        await this.importToK3s(imageName)
      }

      // Update agent type with image info
      await this.prisma.agentType.update({
        where: { id: agentType.id },
        data: { imageUrl: imageName, sdkVersion },
      })

      this.logger.log(`Successfully built image ${imageName}`)

      return {
        success: true,
        imageName,
        buildLogId,
      }
    } catch (error) {
      this.logger.error(`Build failed for ${agentType.slug}: ${error.message}`)

      // Update build log with failure
      await this.prisma.agentBuildLog.update({
        where: { id: buildLogId },
        data: {
          status: 'failed',
          errorMessage: error.message,
          completedAt: new Date(),
        },
      })

      return {
        success: false,
        buildLogId,
        errorMessage: error.message,
      }
    } finally {
      // Clean up extracted directory
      if (extractedPath) {
        try {
          await fs.rm(extractedPath, { recursive: true, force: true })
        } catch {
          this.logger.warn(`Failed to clean up: ${extractedPath}`)
        }
      }
    }
  }

  /**
   * The manifest's Dockerfile inside the extracted package, or null when missing.
   */
  private async findDockerfile(extractedPath: string, dockerfileName: string): Promise<string | null> {
    const dockerfilePath = resolveDockerfilePath(extractedPath, dockerfileName)

    try {
      await fs.access(dockerfilePath)
      return dockerfilePath
    } catch {
      return null
    }
  }

  /**
   * The stella-ai-agent-sdk version installed in a built image, or null when it
   * has none. Runs the image's Python only, with no network, and removes the
   * container. The build already ran this package's Dockerfile on the host, so
   * this adds no new trust.
   */
  private async detectSdkVersion(imageName: string): Promise<string | null> {
    const args = [
      'run', '--rm', '--network', 'none', '--entrypoint', 'python', imageName,
      '-c', `import importlib.metadata as m; print(m.version(${JSON.stringify(SDK_PACKAGE)}))`,
    ]
    try {
      const { stdout } = await execFileAsync('docker', args, { timeout: 60000 })
      return parseSdkVersionOutput(stdout)
    } catch (error) {
      this.logger.warn(`No ${SDK_PACKAGE} found in ${imageName}: ${(error as Error).message.split('\n')[0]}`)
      return null
    }
  }

  /**
   * Build Docker image using Docker CLI.
   */
  private async buildDockerImage(
    imageName: string,
    contextPath: string,
    dockerfilePath: string,
  ): Promise<string> {
    const args = ['build', '-t', imageName, '-f', dockerfilePath, contextPath]
    this.logger.debug(`Executing: docker ${args.join(' ')}`)

    try {
      const { stdout, stderr } = await execFileAsync('docker', args, {
        timeout: 600000, // 10 minute timeout
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      })

      return stdout + '\n' + stderr
    } catch (error) {
      const execError = error as ExecFileException & { stdout?: string; stderr?: string }
      const output = (execError.stdout || '') + '\n' + (execError.stderr || '')
      throw new Error(`Docker build failed: ${execError.message}\n${output}`)
    }
  }

  /**
   * Import image to K3s containerd (Linux production only).
   */
  private async importToK3s(imageName: string): Promise<void> {
    this.logger.log(`Importing ${imageName} to K3s...`)

    const tarDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stella-agent-image-'))
    const tarPath = path.join(tarDir, 'image.tar')

    try {
      // Export from Docker
      await execFileAsync('docker', ['save', imageName, '-o', tarPath], { timeout: 120000 })

      // Import to K3s
      try {
        await execFileAsync('k3s', ['ctr', 'images', 'import', tarPath], { timeout: 120000 })
      } catch (k3sErr) {
        this.logger.warn(`k3s ctr import failed (${(k3sErr as Error).message?.trim()}), falling back to ctr binary`)
        await execFileAsync(
          'ctr',
          ['--address', '/run/k3s/containerd/containerd.sock', '-n', 'k8s.io', 'images', 'import', tarPath],
          { timeout: 120000 },
        )
      }

      this.logger.log(`Successfully imported ${imageName} to K3s`)
    } catch (error) {
      this.logger.error(`Failed to import to K3s: ${error.message}`)
      throw error
    } finally {
      await fs.rm(tarDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Get build status for a build log.
   */
  async getBuildStatus(buildLogId: string): Promise<BuildStatus | null> {
    const log = await this.prisma.agentBuildLog.findUnique({
      where: { id: buildLogId },
    })

    if (!log) {
      return null
    }

    return {
      id: log.id,
      status: log.status as BuildStatus['status'],
      imageName: log.imageName || undefined,
      errorMessage: log.errorMessage || undefined,
      startedAt: log.startedAt,
      completedAt: log.completedAt || undefined,
    }
  }

  /**
   * Get all build logs for an agent type.
   */
  async getBuildHistory(agentTypeId: string): Promise<BuildStatus[]> {
    const logs = await this.prisma.agentBuildLog.findMany({
      where: { agentTypeId },
      orderBy: { startedAt: 'desc' },
      take: 10,
    })

    return logs.map((log) => ({
      id: log.id,
      status: log.status as BuildStatus['status'],
      imageName: log.imageName || undefined,
      errorMessage: log.errorMessage || undefined,
      startedAt: log.startedAt,
      completedAt: log.completedAt || undefined,
    }))
  }

  /**
   * Get build log output (for streaming).
   */
  async getBuildOutput(buildLogId: string): Promise<string | null> {
    const log = await this.prisma.agentBuildLog.findUnique({
      where: { id: buildLogId },
      select: { buildOutput: true },
    })

    return log?.buildOutput || null
  }
}
