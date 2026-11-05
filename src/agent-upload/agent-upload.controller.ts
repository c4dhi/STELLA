import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  NotFoundException,
  Sse,
  Logger,
  Req,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Observable, interval, map, takeWhile, concat, of } from 'rxjs'
import { Request } from 'express'
import { AgentPackageService } from '../agent-package/agent-package.service.js'
import { AgentBuildService, BuildStatus } from '../agent-build/agent-build.service.js'
import { StorageService } from '../storage/storage.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { AgentValidationStatus, Prisma } from '@prisma/client'
import { hashPipelineSchema } from '../agent-configurations/configuration-compat.util.js'

interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string }
}

@Controller('agent-types')
export class AgentUploadController {
  private readonly logger = new Logger(AgentUploadController.name)

  constructor(
    private agentPackageService: AgentPackageService,
    private agentBuildService: AgentBuildService,
    private storageService: StorageService,
    private prisma: PrismaService,
  ) {}

  /**
   * Upload a custom agent package (zip file).
   * POST /agent-types/upload
   */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
    }),
  )
  async uploadPackage(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!file) {
      throw new BadRequestException('No file uploaded')
    }

    // Validate file type
    if (!file.originalname.endsWith('.zip')) {
      throw new BadRequestException('File must be a .zip archive')
    }

    this.logger.log(`Received upload: ${file.originalname} (${file.size} bytes)`)

    // Validate package contents
    const validation = await this.agentPackageService.validatePackage(file.buffer)

    if (!validation.valid) {
      throw new BadRequestException({
        message: 'Package validation failed',
        errors: validation.errors,
        warnings: validation.warnings,
      })
    }

    const manifest = validation.manifest!

    // Check for existing agent with same slug
    const existing = await this.prisma.agentType.findUnique({
      where: { slug: manifest.metadata.slug },
    })

    if (existing) {
      throw new BadRequestException(
        `Agent with slug "${manifest.metadata.slug}" already exists`,
      )
    }

    // Store the package
    const storageInfo = await this.agentPackageService.storePackage(
      file.buffer,
      file.originalname,
    )

    // Get user ID from request (if authenticated)
    const userId = req.user?.id

    // Publish the agent's declared default experts (config/experts/*.json) so the
    // Configurator's Expert Module renders them. Null for non-expert agents.
    const expertDefaults = this.agentPackageService.readExpertDefaults(
      file.buffer,
      manifest.capabilities,
    )

    // Create agent type record
    const agentType = await this.prisma.agentType.create({
      data: {
        slug: manifest.metadata.slug,
        name: manifest.metadata.name,
        description: manifest.metadata.description,
        icon: manifest.metadata.icon,
        version: manifest.metadata.version,
        isBuiltIn: false,
        userId,
        packagePath: storageInfo.path,
        packageSize: storageInfo.size,
        packageHash: storageInfo.hash,
        dockerfilePath: manifest.image.dockerfile || 'Dockerfile',
        imageUrl: manifest.image.imageUrl,
        validationStatus: AgentValidationStatus.PENDING,
        configSchema: manifest.configSchema as Prisma.InputJsonValue,
        capabilities: manifest.capabilities as Prisma.InputJsonValue,
        defaultConfig: manifest.defaultConfig as Prisma.InputJsonValue,
        // Persist the Configurator/compatibility inputs so uploaded agents behave
        // like seeded ones: pipelineSchema drives the Configurator, its hash detects
        // schema drift, runtimeVariables drive the {{placeholder}} palette, and
        // compilerVersion is what saved configs' minCompilerVersion is checked against
        // (omitting it left every config with a minCompilerVersion stuck OUTDATED).
        pipelineSchema: manifest.pipelineSchema
          ? (manifest.pipelineSchema as Prisma.InputJsonValue)
          : Prisma.DbNull,
        pipelineSchemaHash: hashPipelineSchema(manifest.pipelineSchema ?? null),
        runtimeVariables: manifest.runtimeVariables
          ? (manifest.runtimeVariables as Prisma.InputJsonValue)
          : Prisma.DbNull,
        compilerVersion: manifest.promptCompiler?.version ?? null,
        resourceMemory: manifest.resources?.memory?.limit || '512Mi',
        resourceCpu: manifest.resources?.cpu?.limit || '250m',
        resourceGpu: manifest.resources?.gpu || false,
        authorName: manifest.metadata.author?.name,
        authorEmail: manifest.metadata.author?.email,
        tags: manifest.metadata.tags as Prisma.InputJsonValue,
        sdkMinVersion: manifest.sdk?.minVersion,
        expertDefaults: expertDefaults
          ? (expertDefaults as Prisma.InputJsonValue)
          : Prisma.DbNull,
      },
    })

    this.logger.log(`Created agent type: ${agentType.slug} (${agentType.id})`)

    return {
      id: agentType.id,
      slug: agentType.slug,
      name: agentType.name,
      version: agentType.version,
      validationStatus: agentType.validationStatus,
      warnings: validation.warnings,
    }
  }

  /**
   * Get the current user's custom agents.
   * GET /agent-types/my-agents
   */
  @Get('my-agents')
  async getMyAgents(@Req() req: AuthenticatedRequest) {
    const userId = req.user?.id

    const agents = await this.prisma.agentType.findMany({
      where: {
        isBuiltIn: false,
        ...(userId ? { userId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        buildLogs: {
          orderBy: { startedAt: 'desc' },
          take: 1,
        },
      },
    })

    return agents.map((agent) => ({
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      icon: agent.icon,
      version: agent.version,
      validationStatus: agent.validationStatus,
      capabilities: agent.capabilities,
      defaultConfig: agent.defaultConfig,
      createdAt: agent.createdAt,
      lastBuild: agent.buildLogs[0]
        ? {
            status: agent.buildLogs[0].status,
            startedAt: agent.buildLogs[0].startedAt,
            completedAt: agent.buildLogs[0].completedAt,
          }
        : null,
    }))
  }

  /**
   * Trigger a build for a custom agent.
   * POST /agent-types/:id/build
   */
  @Post(':id/build')
  async triggerBuild(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const agentType = await this.prisma.agentType.findUnique({
      where: { id },
    })

    if (!agentType) {
      throw new NotFoundException('Agent type not found')
    }

    if (agentType.isBuiltIn) {
      throw new BadRequestException('Cannot rebuild built-in agents')
    }

    if (!agentType.packagePath) {
      throw new BadRequestException('Agent has no uploaded package')
    }

    // Check ownership (if user is authenticated)
    const userId = req.user?.id
    if (userId && agentType.userId && agentType.userId !== userId) {
      throw new BadRequestException('You do not own this agent')
    }

    // Start build
    const result = await this.agentBuildService.startBuild(id)

    return {
      buildLogId: result.buildLogId,
      message: 'Build started',
    }
  }

  /**
   * Get build status for an agent.
   * GET /agent-types/:id/build-status
   */
  @Get(':id/build-status')
  async getBuildStatus(@Param('id') id: string): Promise<BuildStatus | null> {
    // Get latest build log for this agent
    const latestBuild = await this.prisma.agentBuildLog.findFirst({
      where: { agentTypeId: id },
      orderBy: { startedAt: 'desc' },
    })

    if (!latestBuild) {
      return null
    }

    return this.agentBuildService.getBuildStatus(latestBuild.id)
  }

  /**
   * Get build history for an agent.
   * GET /agent-types/:id/build-history
   */
  @Get(':id/build-history')
  async getBuildHistory(@Param('id') id: string) {
    return this.agentBuildService.getBuildHistory(id)
  }

  /**
   * Stream build logs using Server-Sent Events.
   * GET /agent-types/:id/build-logs (SSE)
   */
  @Sse(':id/build-logs')
  streamBuildLogs(@Param('id') id: string): Observable<MessageEvent> {
    // Poll for build status every 2 seconds
    return concat(
      // Send initial status
      of({ type: 'status', data: 'connected' } as MessageEvent),

      // Poll until build completes
      interval(2000).pipe(
        map(async () => {
          const status = await this.getBuildStatus(id)
          if (!status) {
            return { type: 'status', data: 'no_build' } as MessageEvent
          }

          const output = await this.agentBuildService.getBuildOutput(status.id)

          return {
            type: 'build',
            data: JSON.stringify({
              status: status.status,
              imageName: status.imageName,
              errorMessage: status.errorMessage,
              output: output?.slice(-5000), // Last 5000 chars
            }),
          } as MessageEvent
        }),
        map((promise) => promise as unknown as MessageEvent),
        takeWhile((event) => {
          try {
            const data = JSON.parse((event as any).data || '{}')
            return data.status !== 'success' && data.status !== 'failed'
          } catch {
            return true
          }
        }, true),
      ),
    )
  }

  /**
   * Delete a custom agent.
   * DELETE /agent-types/:id
   */
  @Post(':id/delete')
  async deleteAgent(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const agentType = await this.prisma.agentType.findUnique({
      where: { id },
    })

    if (!agentType) {
      throw new NotFoundException('Agent type not found')
    }

    if (agentType.isBuiltIn) {
      throw new BadRequestException('Cannot delete built-in agents')
    }

    // Check ownership
    const userId = req.user?.id
    if (userId && agentType.userId && agentType.userId !== userId) {
      throw new BadRequestException('You do not own this agent')
    }

    // Delete stored package
    if (agentType.packagePath) {
      await this.storageService.delete(agentType.packagePath)
    }

    // Delete from database (cascades to build logs)
    await this.prisma.agentType.delete({ where: { id } })

    this.logger.log(`Deleted agent type: ${agentType.slug}`)

    return { success: true }
  }
}

interface MessageEvent {
  type: string
  data: string
}
