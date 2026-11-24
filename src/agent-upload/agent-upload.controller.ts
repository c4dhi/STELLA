import {
  Controller,
  Post,
  Put,
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
import { Observable, interval, concatMap, from, takeWhile, concat, of } from 'rxjs'
import { Request } from 'express'
import { StorageService } from '../storage/storage.service.js'
import { PrismaService } from '../prisma/prisma.service.js'

import type { AuthUser } from '../auth/auth-user.loader.js'
import { AgentsService } from '../agents/agents.service.js'
import { UpdateAgentSharesDto } from './dto/update-agent-shares.dto.js'
import { AgentUploadService } from './agent-upload.service.js'

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
 * Only the uploader (or a system admin) may delete an upload. An upload
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
    private agentUploadService: AgentUploadService,
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

    return this.agentUploadService.createFromPackage(file.buffer, userId)
  }

  /**
   * Get the current user's custom agents.
   * GET /agent-types/my-agents
   */
  @Get('my-agents')
  async getMyAgents(@Req() req: AuthenticatedRequest) {
    return this.agentUploadService.getMyAgents(requireUserId(req))
  }

  /**
   * Trigger a build for a custom agent.
   * POST /agent-types/:id/build
   */
  @Post(':id/build')
  async triggerBuild(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.agentUploadService.triggerBuild(id, requireUserId(req), req.user?.isSystemAdmin)
  }

  /**
   * Get build status for an agent, including its stored output (#961) so a
   * window reopened after the build finished still has something to show —
   * a build still running keeps streaming live over build-logs instead.
   * Only ever on this single latest-build lookup, never on build-history.
   * GET /agent-types/:id/build-status
   */
  @Get(':id/build-status')
  async getBuildStatus(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.agentUploadService.getBuildStatus(id, requireUserId(req), req.user?.isSystemAdmin)
  }

  /**
   * Get build history for an agent.
   * GET /agent-types/:id/build-history
   */
  @Get(':id/build-history')
  async getBuildHistory(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.agentUploadService.getBuildHistory(id, requireUserId(req), req.user?.isSystemAdmin)
  }

  /**
   * Stream build logs using Server-Sent Events.
   * GET /agent-types/:id/build-logs (SSE)
   */
  @Sse(':id/build-logs')
  async streamBuildLogs(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<Observable<MessageEvent>> {
    // Checked before the stream opens: a refusal is an ordinary 403/404.
    await this.agentUploadService.assertCanSeeBuilds(id, requireUserId(req), req.user?.isSystemAdmin)
    // Poll for build status every 2 seconds
    return concat(
      // Send initial status
      of({ type: 'status', data: 'connected' } as MessageEvent),

      // Poll until build completes. concatMap actually awaits each tick's
      // promise before emitting; the previous plain map() over an async
      // callback emitted the unresolved Promise itself as the "event", so
      // every polled update went out with no data and the browser's
      // EventSource silently dropped it (no live update ever reached a client).
      interval(2000).pipe(
        concatMap(() => from(this.buildLogEvent(id))),
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

  private async buildLogEvent(id: string): Promise<MessageEvent> {
    const status = await this.agentUploadService.latestBuildStatus(id)
    if (!status) {
      return { type: 'status', data: 'no_build' } as MessageEvent
    }

    const output = await this.agentUploadService.getBuildOutput(status.id)

    return {
      type: 'build',
      data: JSON.stringify({
        status: status.status,
        imageName: status.imageName,
        errorMessage: status.errorMessage,
        output: output?.slice(-5000), // Last 5000 chars
      }),
    } as MessageEvent
  }

  /**
   * The projects this custom agent is shared with, and the projects its owner
   * could share it with (the ones they are a member of).
   * GET /agent-types/:id/shares
   */
  @Get(':id/shares')
  async getShares(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.agentUploadService.getShares(id, requireUserId(req))
  }

  /**
   * Share this custom agent with exactly these projects. Their members see it
   * and may deploy it there; they cannot change it. Only the owner shares, and
   * only with projects they are a member of.
   * PUT /agent-types/:id/shares
   */
  @Put(':id/shares')
  async updateShares(@Param('id') id: string, @Body() dto: UpdateAgentSharesDto, @Req() req: AuthenticatedRequest) {
    return this.agentUploadService.updateShares(id, requireUserId(req), dto.projectIds)
  }

  /**
   * Delete a custom agent. Its owner's running agents are stopped first, and
   * rows left RUNNING after their pod died are cleaned up. Refused while a
   * public project uses it or another user's agent of it still runs.
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

    // Agents of this type that still run: a row whose pod is gone is only
    // cleaned up; the owner's own live agents are stopped; another user's live
    // agent blocks the delete (it is their session).
    const { live, stale } = await this.agentsService.runningAgentsOfType(id)
    const ownerId = agentType.userId
    const others = live.filter((a) => !ownerId || a.deployedByUserId !== ownerId)
    if (others.length > 0) {
      throw new BadRequestException(
        `${agentType.name} still runs in ${others.length} session${others.length === 1 ? '' : 's'} of other users. It can be deleted once ${others.length === 1 ? 'that agent stops' : 'those agents stop'}`,
      )
    }
    const toStop = [...stale, ...live.map((a) => a.id)]
    for (const agentId of toStop) {
      await this.agentsService.stopAgent(agentId)
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
