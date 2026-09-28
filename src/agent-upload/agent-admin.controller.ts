import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  BadRequestException,
  NotFoundException,
  Logger,
  Req,
} from '@nestjs/common'
import { Request } from 'express'
import { PrismaService } from '../prisma/prisma.service.js'
import { AgentValidationStatus } from '@prisma/client'

interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string }
}

interface ApproveDto {
  notes?: string
}

interface RejectDto {
  reason: string
}

@Controller('admin/agent-types')
export class AgentAdminController {
  private readonly logger = new Logger(AgentAdminController.name)

  constructor(private prisma: PrismaService) {}

  /**
   * Get all pending agent types for review.
   * GET /admin/agent-types/pending
   */
  @Get('pending')
  async getPendingAgents() {
    const agents = await this.prisma.agentType.findMany({
      where: {
        validationStatus: AgentValidationStatus.PENDING,
        isBuiltIn: false,
      },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: { id: true, email: true, name: true },
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
      authorName: agent.authorName,
      authorEmail: agent.authorEmail,
      resourceGpu: agent.resourceGpu,
      packageSize: agent.packageSize,
      createdAt: agent.createdAt,
      owner: agent.user
        ? {
            id: agent.user.id,
            email: agent.user.email,
            name: agent.user.name,
          }
        : null,
    }))
  }

  /**
   * Get all agent types by validation status.
   * GET /admin/agent-types/status/:status
   */
  @Get('status/:status')
  async getAgentsByStatus(@Param('status') status: string) {
    // Validate status
    const statusMap: Record<string, AgentValidationStatus> = {
      pending: AgentValidationStatus.PENDING,
      approved: AgentValidationStatus.APPROVED,
      rejected: AgentValidationStatus.REJECTED,
    }

    const validationStatus = statusMap[status.toLowerCase()]
    if (!validationStatus) {
      throw new BadRequestException(
        `Invalid status. Must be one of: ${Object.keys(statusMap).join(', ')}`,
      )
    }

    const agents = await this.prisma.agentType.findMany({
      where: {
        validationStatus,
        isBuiltIn: false,
      },
      orderBy: { updatedAt: 'desc' },
      include: {
        user: {
          select: { id: true, email: true, name: true },
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
      validationNotes: agent.validationNotes,
      validatedAt: agent.validatedAt,
      createdAt: agent.createdAt,
      owner: agent.user
        ? {
            id: agent.user.id,
            email: agent.user.email,
            name: agent.user.name,
          }
        : null,
    }))
  }

  /**
   * Approve a pending agent type.
   * POST /admin/agent-types/:id/approve
   */
  @Post(':id/approve')
  async approveAgent(
    @Param('id') id: string,
    @Body() dto: ApproveDto,
    @Req() req: AuthenticatedRequest,
  ) {
    const agentType = await this.prisma.agentType.findUnique({
      where: { id },
    })

    if (!agentType) {
      throw new NotFoundException('Agent type not found')
    }

    if (agentType.isBuiltIn) {
      throw new BadRequestException('Cannot modify built-in agents')
    }

    if (agentType.validationStatus === AgentValidationStatus.APPROVED) {
      throw new BadRequestException('Agent is already approved')
    }

    const adminId = req.user?.id

    // Update status to approved
    const updated = await this.prisma.agentType.update({
      where: { id },
      data: {
        validationStatus: AgentValidationStatus.APPROVED,
        validationNotes: dto.notes,
        validatedAt: new Date(),
        validatedBy: adminId,
      },
    })

    this.logger.log(
      `Agent ${updated.slug} approved by ${adminId || 'anonymous'}`,
    )

    return {
      id: updated.id,
      slug: updated.slug,
      name: updated.name,
      validationStatus: updated.validationStatus,
      validatedAt: updated.validatedAt,
    }
  }

  /**
   * Reject a pending agent type.
   * POST /admin/agent-types/:id/reject
   */
  @Post(':id/reject')
  async rejectAgent(
    @Param('id') id: string,
    @Body() dto: RejectDto,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!dto.reason || dto.reason.trim().length === 0) {
      throw new BadRequestException('Rejection reason is required')
    }

    const agentType = await this.prisma.agentType.findUnique({
      where: { id },
    })

    if (!agentType) {
      throw new NotFoundException('Agent type not found')
    }

    if (agentType.isBuiltIn) {
      throw new BadRequestException('Cannot modify built-in agents')
    }

    if (agentType.validationStatus === AgentValidationStatus.REJECTED) {
      throw new BadRequestException('Agent is already rejected')
    }

    const adminId = req.user?.id

    // Update status to rejected
    const updated = await this.prisma.agentType.update({
      where: { id },
      data: {
        validationStatus: AgentValidationStatus.REJECTED,
        validationNotes: dto.reason,
        validatedAt: new Date(),
        validatedBy: adminId,
      },
    })

    this.logger.log(
      `Agent ${updated.slug} rejected by ${adminId || 'anonymous'}: ${dto.reason}`,
    )

    return {
      id: updated.id,
      slug: updated.slug,
      name: updated.name,
      validationStatus: updated.validationStatus,
      validationNotes: updated.validationNotes,
      validatedAt: updated.validatedAt,
    }
  }

  /**
   * Get detailed info about an agent for review.
   * GET /admin/agent-types/:id
   */
  @Get(':id')
  async getAgentDetails(@Param('id') id: string) {
    const agent = await this.prisma.agentType.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, email: true, name: true },
        },
        buildLogs: {
          orderBy: { startedAt: 'desc' },
          take: 5,
        },
      },
    })

    if (!agent) {
      throw new NotFoundException('Agent type not found')
    }

    return {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      description: agent.description,
      icon: agent.icon,
      version: agent.version,
      isBuiltIn: agent.isBuiltIn,
      validationStatus: agent.validationStatus,
      validationNotes: agent.validationNotes,
      validatedAt: agent.validatedAt,
      validatedBy: agent.validatedBy,
      packagePath: agent.packagePath,
      packageSize: agent.packageSize,
      packageHash: agent.packageHash,
      dockerfilePath: agent.dockerfilePath,
      imageUrl: agent.imageUrl,
      configSchema: agent.configSchema,
      capabilities: agent.capabilities,
      defaultConfig: agent.defaultConfig,
      resourceMemory: agent.resourceMemory,
      resourceCpu: agent.resourceCpu,
      resourceGpu: agent.resourceGpu,
      authorName: agent.authorName,
      authorEmail: agent.authorEmail,
      tags: agent.tags,
      sdkMinVersion: agent.sdkMinVersion,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      owner: agent.user
        ? {
            id: agent.user.id,
            email: agent.user.email,
            name: agent.user.name,
          }
        : null,
      buildLogs: agent.buildLogs.map((log) => ({
        id: log.id,
        status: log.status,
        imageName: log.imageName,
        errorMessage: log.errorMessage,
        startedAt: log.startedAt,
        completedAt: log.completedAt,
      })),
    }
  }
}
