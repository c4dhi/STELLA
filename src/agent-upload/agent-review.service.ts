import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { AgentValidationStatus } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service.js'
import { requirementsForListing } from '../agents/agent-requirements.js'

/**
 * Reviewing uploaded agents: what a system admin lists, opens, approves and
 * rejects. The REST controller (Settings → Agent Review) and the MCP tools both
 * call this, so they accept and refuse the same things. Callers check that the
 * caller is a system admin (SystemAdminGuard, systemAdminOnly).
 */

export const REVIEW_STATES = ['pending', 'approved', 'rejected'] as const
export type ReviewState = (typeof REVIEW_STATES)[number]

const STATUS_OF: Record<ReviewState, AgentValidationStatus> = {
  pending: AgentValidationStatus.PENDING,
  approved: AgentValidationStatus.APPROVED,
  rejected: AgentValidationStatus.REJECTED,
}

/** The validation status for a state name, or a 400 naming the valid ones. */
export function reviewStatusOf(state: string): AgentValidationStatus {
  const status = STATUS_OF[state.toLowerCase() as ReviewState]
  if (!status) {
    throw new BadRequestException(`Invalid status. Must be one of: ${REVIEW_STATES.join(', ')}`)
  }
  return status
}

/** Trimmed text, or null when there is none. */
function cleanText(text: string | null | undefined): string | null {
  const trimmed = text?.trim()
  return trimmed ? trimmed : null
}

type Owner = { id: string; email: string; name: string | null } | null

function ownerOf(user: Owner | undefined) {
  return user ? { id: user.id, email: user.email, name: user.name } : null
}

function buildOf(log: Record<string, any>) {
  return {
    id: log.id,
    status: log.status,
    imageName: log.imageName,
    errorMessage: log.errorMessage,
    startedAt: log.startedAt,
    completedAt: log.completedAt,
  }
}

/**
 * One upload in a review list. The latest build comes first, since whether it
 * built at all is what a reviewer looks at first (Felix, 7 Nov). What the
 * manifest declares is resolved by the one owner of that, so an unreadable
 * manifest shows its reason here instead of taking the list down.
 */
export function reviewSummary(agent: Record<string, any>) {
  const { requirements, error } = requirementsForListing(agent as any)
  return {
    lastBuild: agent.buildLogs?.[0] ? buildOf(agent.buildLogs[0]) : null,
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
    validationStatus: agent.validationStatus,
    validationNotes: agent.validationNotes,
    validatedAt: agent.validatedAt,
    createdAt: agent.createdAt,
    sdkVersion: agent.sdkVersion ?? null,
    capabilities: agent.capabilities ?? [],
    requirements,
    manifestError: error,
    owner: ownerOf(agent.user),
  }
}

@Injectable()
export class AgentReviewService {
  private readonly logger = new Logger(AgentReviewService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** Uploads in one state: pending oldest first (a queue), reviewed newest first. */
  async list(state: string) {
    const validationStatus = reviewStatusOf(state)
    const agents = await this.prisma.agentType.findMany({
      where: { validationStatus, isBuiltIn: false },
      orderBy:
        validationStatus === AgentValidationStatus.PENDING ? { createdAt: 'asc' } : { updatedAt: 'desc' },
      include: {
        user: { select: { id: true, email: true, name: true } },
        buildLogs: { orderBy: { startedAt: 'desc' }, take: 1 },
      },
    })
    return agents.map(reviewSummary)
  }

  /** Everything a reviewer looks at for one agent, with its five latest builds. */
  async get(id: string) {
    const agent = await this.prisma.agentType.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true, name: true } },
        buildLogs: { orderBy: { startedAt: 'desc' }, take: 5 },
      },
    })
    if (!agent) throw new NotFoundException('Agent type not found')

    return {
      ...reviewSummary(agent),
      isBuiltIn: agent.isBuiltIn,
      validatedBy: agent.validatedBy,
      packagePath: agent.packagePath,
      packageHash: agent.packageHash,
      dockerfilePath: agent.dockerfilePath,
      imageUrl: agent.imageUrl,
      configSchema: agent.configSchema,
      defaultConfig: agent.defaultConfig,
      resourceMemory: agent.resourceMemory,
      resourceCpu: agent.resourceCpu,
      tags: agent.tags,
      sdkMinVersion: agent.sdkMinVersion,
      updatedAt: agent.updatedAt,
      buildLogs: agent.buildLogs.map(buildOf),
    }
  }

  /** Let the agent deploy. A rejected upload can be approved after all. */
  async approve(id: string, adminId: string, notes?: string | null) {
    await this.reviewable(id, AgentValidationStatus.APPROVED, 'Agent is already approved')
    const updated = await this.decide(id, AgentValidationStatus.APPROVED, adminId, cleanText(notes))
    this.logger.log(`Agent ${updated.slug} approved by ${adminId}`)
    return updated
  }

  /**
   * Stop the agent from deploying, saying why: the uploader sees the reason.
   * Also withdraws an earlier approval.
   */
  async reject(id: string, adminId: string, reason: string) {
    const why = cleanText(reason)
    if (!why) throw new BadRequestException('Rejection reason is required')
    await this.reviewable(id, AgentValidationStatus.REJECTED, 'Agent is already rejected')
    const updated = await this.decide(id, AgentValidationStatus.REJECTED, adminId, why)
    this.logger.log(`Agent ${updated.slug} rejected by ${adminId}: ${why}`)
    return updated
  }

  private async reviewable(id: string, target: AgentValidationStatus, already: string) {
    const agent = await this.prisma.agentType.findUnique({ where: { id } })
    if (!agent) throw new NotFoundException('Agent type not found')
    if (agent.isBuiltIn) throw new BadRequestException('Cannot modify built-in agents')
    if (agent.validationStatus === target) throw new BadRequestException(already)
  }

  private async decide(id: string, status: AgentValidationStatus, adminId: string, notes: string | null) {
    const updated = await this.prisma.agentType.update({
      where: { id },
      data: { validationStatus: status, validationNotes: notes, validatedAt: new Date(), validatedBy: adminId },
    })
    return {
      id: updated.id,
      slug: updated.slug,
      name: updated.name,
      validationStatus: updated.validationStatus,
      validationNotes: updated.validationNotes,
      validatedAt: updated.validatedAt,
    }
  }
}
