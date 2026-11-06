import { builtSdkProblem } from '../agent-package/sdk-support.js'
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
  ForbiddenException,
  UnauthorizedException,
  Sse,
  Logger,
  Req,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Observable, interval, map, takeWhile, concat, of } from 'rxjs'
import { Request } from 'express'
import { AgentPackageService } from '../agent-package/agent-package.service.js'
import { AgentBuildService, BuildStatus, resolveDockerfilePath } from '../agent-build/agent-build.service.js'
import { StorageService } from '../storage/storage.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { AgentValidationStatus } from '@prisma/client'
import { DEFAULT_DOCKERFILE } from '../agent-package/manifest-defaults.js'
import { manifestToAgentTypeData } from '../agent-package/manifest-mapper.js'

import type { AuthUser } from '../auth/auth-user.loader.js'
import { requirementsForListing } from '../agents/agent-requirements.js'
import { AgentsService } from '../agents/agents.service.js'

interface AuthenticatedRequest extends Request {
  user?: AuthUser
}

/** The signed-in user's id. The global JwtAuthGuard sets `req.user`; refuse if it is missing. */
export function requireUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.userId
  if (!userId) throw new UnauthorizedException('Sign in to manage your agents')
  return userId
}

/**
 * Only the uploader (or a system admin) may build or delete an upload. An upload
 * without an owner (stored before the owner was recorded) is admin-only.
 */
export function assertOwnsAgent(agentType: { userId: string | null }, req: AuthenticatedRequest): void {
  const userId = requireUserId(req)
  if (req.user?.isSystemAdmin) return
  if (agentType.userId !== userId) throw new ForbiddenException('You do not own this agent')
}

@Controller('agent-types')
export class AgentUploadController {
  private readonly logger = new Logger(AgentUploadController.name)

  constructor(
    private agentPackageService: AgentPackageService,
    private agentBuildService: AgentBuildService,
    private storageService: StorageService,
    private prisma: PrismaService,
    private agentsService: AgentsService,
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
    const userId = requireUserId(req)

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

    // An upload deploys the image STELLA builds from its Dockerfile, never one the
    // manifest points at: a prebuilt image would skip the build (and its base-image
    // check) and count as "built" straight away.
    if (manifest.image.imageUrl) {
      throw new BadRequestException(
        'image.imageUrl is not allowed in an uploaded agent; remove it and STELLA builds the image from your Dockerfile',
      )
    }

    // Refuse a Dockerfile path the build would refuse, so the uploader hears it now.
    try {
      resolveDockerfilePath('/package', manifest.image.dockerfile ?? DEFAULT_DOCKERFILE)
    } catch (err) {
      throw new BadRequestException((err as Error).message)
    }

    // The slug names an agent across STELLA. Uploading it again with a new
    // version replaces the uploader's own agent in place (same id, so its
    // templates, configurations and public projects keep pointing at it). An
    // agent of another user, or a built-in one, is never replaced.
    const existing = await this.prisma.agentType.findUnique({
      where: { slug: manifest.metadata.slug },
    })
    if (existing && (existing.isBuiltIn || existing.userId !== userId)) {
      throw new BadRequestException(
        `Another agent already uses the slug "${manifest.metadata.slug}"; pick another metadata.slug`,
      )
    }
    if (existing && existing.version === manifest.metadata.version) {
      throw new BadRequestException(
        `You already uploaded ${existing.name} ${existing.version}; raise metadata.version to replace it`,
      )
    }

    // Store the package
    const storageInfo = await this.agentPackageService.storePackage(
      file.buffer,
      file.originalname,
    )

    // Same mapping as built-in agents (the seed): manifest → AgentType columns,
    // including the default experts from config/experts/*.json.
    const expertDefaults = this.agentPackageService.readExpertDefaults(file.buffer, manifest.capabilities)
    const data = {
      ...manifestToAgentTypeData(manifest, expertDefaults),
      isBuiltIn: false,
      userId,
      packagePath: storageInfo.path,
      packageSize: storageInfo.size,
      packageHash: storageInfo.hash,
      // Set only by a successful build (AgentBuildService), with sdkVersion.
      imageUrl: null,
      sdkVersion: null,
      // New code: built and reviewed again before anyone else can deploy it.
      validationStatus: AgentValidationStatus.PENDING,
      validationNotes: null,
      validatedAt: null,
      validatedBy: null,
    }
    const agentType = existing
      ? await this.prisma.agentType.update({ where: { id: existing.id }, data })
      : await this.prisma.agentType.create({ data })

    // Agents already running keep their image (it is tagged with the old
    // version); only the old package goes.
    if (existing?.packagePath && existing.packagePath !== storageInfo.path) {
      await this.storageService.delete(existing.packagePath)
    }

    this.logger.log(
      existing
        ? `Replaced agent type ${agentType.slug} ${existing.version} with ${agentType.version} (${agentType.id})`
        : `Created agent type: ${agentType.slug} (${agentType.id})`,
    )

    return {
      id: agentType.id,
      slug: agentType.slug,
      name: agentType.name,
      version: agentType.version,
      validationStatus: agentType.validationStatus,
      replacedVersion: existing?.version ?? null,
      warnings: validation.warnings,
    }
  }

  /**
   * Get the current user's custom agents.
   * GET /agent-types/my-agents
   */
  @Get('my-agents')
  async getMyAgents(@Req() req: AuthenticatedRequest) {
    const userId = requireUserId(req)

    const agents = await this.prisma.agentType.findMany({
      where: { isBuiltIn: false, userId },
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
      configSchema: agent.configSchema,
      pipelineSchema: agent.pipelineSchema,
      // What deploying it needs, as GET /agent-types gives it, so a deploy
      // dialog can ask for its settings and connectors from this list too.
      requirements: requirementsForListing(agent).requirements,
      createdAt: agent.createdAt,
      built: !!agent.imageUrl,
      sdkVersion: agent.sdkVersion,
      // Set when the last build can't deploy on this STELLA: "Needs SDK update".
      sdkProblem: agent.imageUrl ? builtSdkProblem(agent.sdkVersion) : null,
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

    assertOwnsAgent(agentType, req)

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
   * Delete a custom agent, stopping its agents first.
   * POST /agent-types/:id/delete
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

    assertOwnsAgent(agentType, req)

    // A public project would lose its agent: refuse, and say where to change it.
    const publicProjects = await this.prisma.project.count({ where: { publicAgentTypeId: id } })
    if (publicProjects > 0) {
      throw new BadRequestException(
        `${publicProjects} public project${publicProjects === 1 ? ' uses' : 's use'} ${agentType.name}. Pick another agent there, then delete it`,
      )
    }

    // Deleting an agent stops its agents first: their pods go and they keep
    // their transcript. A row left RUNNING after its pod died is stopped the
    // same way, so it can no longer block the delete.
    const live = await this.prisma.agentInstance.findMany({
      where: { agentTypeId: id, status: { in: ['STARTING', 'RUNNING', 'STOPPING'] } },
      select: { id: true },
    })
    for (const agent of live) {
      await this.agentsService.stopAgent(agent.id)
    }

    // Env-var templates and configurations are scoped to this one type, so
    // they go with it. Stopped agents keep their record (and transcript) and
    // only lose the link; build logs cascade.
    await this.prisma.$transaction([
      this.prisma.envVarTemplate.deleteMany({ where: { agentTypeId: id } }),
      this.prisma.agentConfiguration.deleteMany({ where: { agentTypeId: id } }),
      this.prisma.agentInstance.updateMany({ where: { agentTypeId: id }, data: { agentTypeId: null } }),
      this.prisma.agentType.delete({ where: { id } }),
    ])

    // The package last: if the row could not be deleted, it is still there.
    if (agentType.packagePath) {
      await this.storageService.delete(agentType.packagePath)
    }

    this.logger.log(`Deleted agent type: ${agentType.slug}`)

    return { success: true, stoppedAgents: live.length }
  }
}

interface MessageEvent {
  type: string
  data: string
}
