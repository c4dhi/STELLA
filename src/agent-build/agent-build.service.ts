import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaService } from '../prisma/prisma.service.js'
import { AgentPackageService } from '../agent-package/agent-package.service.js'
import { exec, ExecException } from 'child_process'
import { promisify } from 'util'
import * as fs from 'fs/promises'
import * as path from 'path'

const execAsync = promisify(exec)

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
    agentType: { id: string; slug: string; packagePath: string | null; version: string },
    buildLogId: string,
  ): Promise<BuildResult> {
    const imageName = `${agentType.slug}:${agentType.version}`
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

      // Find Dockerfile
      const dockerfilePath = await this.findDockerfile(extractedPath, agentType.packagePath!)
      if (!dockerfilePath) {
        throw new Error('Dockerfile not found in package')
      }

      // Build Docker image
      this.logger.log(`Building image ${imageName}...`)
      const buildOutput = await this.buildDockerImage(imageName, extractedPath, dockerfilePath)

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
        data: { imageUrl: imageName },
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
   * Find Dockerfile path in extracted package.
   */
  private async findDockerfile(extractedPath: string, storagePath: string): Promise<string | null> {
    // Check manifest for custom dockerfile path
    const manifest = await this.agentPackageService.parseManifest(storagePath)
    const dockerfileName = manifest?.image?.dockerfile || 'Dockerfile'

    const dockerfilePath = path.join(extractedPath, dockerfileName)

    try {
      await fs.access(dockerfilePath)
      return dockerfilePath
    } catch {
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
    const buildCmd = `docker build -t ${imageName} -f ${dockerfilePath} ${contextPath}`
    this.logger.debug(`Executing: ${buildCmd}`)

    try {
      const { stdout, stderr } = await execAsync(buildCmd, {
        timeout: 600000, // 10 minute timeout
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      })

      return stdout + '\n' + stderr
    } catch (error) {
      const execError = error as ExecException & { stdout?: string; stderr?: string }
      const output = (execError.stdout || '') + '\n' + (execError.stderr || '')
      throw new Error(`Docker build failed: ${execError.message}\n${output}`)
    }
  }

  /**
   * Import image to K3s containerd (Linux production only).
   */
  private async importToK3s(imageName: string): Promise<void> {
    this.logger.log(`Importing ${imageName} to K3s...`)

    const tarPath = `/tmp/${imageName.replace(':', '-').replace('/', '-')}.tar`

    try {
      // Export from Docker
      await execAsync(`docker save ${imageName} -o ${tarPath}`, { timeout: 120000 })

      // Import to K3s
      try {
        await execAsync(`k3s ctr images import ${tarPath}`, { timeout: 120000 })
      } catch (k3sErr) {
        this.logger.warn(`k3s ctr import failed (${(k3sErr as Error).message?.trim()}), falling back to ctr binary`)
        await execAsync(`ctr --address /run/k3s/containerd/containerd.sock -n k8s.io images import ${tarPath}`, { timeout: 120000 })
      }

      // Cleanup
      await execAsync(`rm -f ${tarPath}`)

      this.logger.log(`Successfully imported ${imageName} to K3s`)
    } catch (error) {
      this.logger.error(`Failed to import to K3s: ${error.message}`)
      throw error
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
