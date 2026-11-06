import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service.js'
import { AgentType, AgentValidationStatus } from '@prisma/client'
import { requirementsForListing, type AgentRequirements } from '../agents/agent-requirements.js'
import { agentTypeAccessProblem } from '../agents/deployable-agent-type.util.js'
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js'

/** Who is looking at the agent list, and in which project (optional). */
export interface AgentTypeViewer {
  userId: string
  /** List only what can be deployed in this project. Ignored unless the user is a member. */
  projectId?: string | null
}

export interface AgentTypeInfo {
  id: string
  slug: string
  name: string
  description: string
  icon: string | null
  version: string
  isBuiltIn: boolean
  /** Superseded but still deployable; the gallery demotes it. */
  deprecated: boolean
  deprecationNote: string | null
  capabilities: string[]
  defaultConfig: Record<string, unknown>  // Default config for this agent type
  configSchema: Record<string, unknown> | null  // JSON Schema of the agent's own settings, as its manifest declares it
  pipelineSchema: Record<string, unknown> | null  // Pipeline topology + configurable slots
  // Agent-declared default experts (config/experts/*.json). Null for non-expert agents.
  expertDefaults: Record<string, unknown>[] | null
  /**
   * What deploying this type takes, resolved from its manifest. The deploy
   * wizard renders from this. Null only for a row whose manifest cannot be read.
   */
  requirements: AgentRequirements | null
  /** Who uploaded it. Null for a built-in. */
  ownerName: string | null
  /**
   * Another user's upload, shared with a project the viewer is in: they can
   * deploy it, but not build, re-upload, share or delete it.
   */
  sharedWithYou: boolean
}

@Injectable()
export class AgentTypeService {
  private readonly logger = new Logger(AgentTypeService.name)

  constructor(
    private prisma: PrismaService,
    private platformSettings: PlatformSettingsService,
  ) {}

  /**
   * Get all approved agent types for display in the gallery
   */
  async findAll(): Promise<AgentType[]> {
    return this.prisma.agentType.findMany({
      where: { validationStatus: AgentValidationStatus.APPROVED },
      // Deprecated last: the gallery should lead with what to pick, not with
      // what is being retired. Still returned — existing deployments reference
      // these rows and must stay reproducible.
      orderBy: [{ deprecated: 'asc' }, { isBuiltIn: 'desc' }, { name: 'asc' }],
    })
  }

  /**
   * Find an agent type by its unique slug
   */
  async findBySlug(slug: string): Promise<AgentType | null> {
    return this.prisma.agentType.findUnique({ where: { slug } })
  }

  /**
   * Find an agent type by its UUID
   */
  async findById(id: string): Promise<AgentType | null> {
    return this.prisma.agentType.findUnique({ where: { id } })
  }

  /**
   * The agent types formatted for the gallery. With a viewer: built-ins, the
   * viewer's own uploads, and uploads shared with a project they are in (or
   * with `viewer.projectId` only). Without one: the approved types, for lookups
   * that do not deploy (a deploy checks access itself).
   */
  async getAgentTypesForGallery(viewer?: AgentTypeViewer): Promise<AgentTypeInfo[]> {
    const rows = viewer ? await this.visibleTo(viewer) : (await this.findAll()).map((t) => ({ ...t, user: null }))

    return rows.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description,
      icon: t.icon,
      version: t.version,
      isBuiltIn: t.isBuiltIn,
      deprecated: t.deprecated,
      deprecationNote: t.deprecationNote,
      capabilities: (t.capabilities as string[]) || [],
      defaultConfig: (t.defaultConfig as Record<string, unknown>) || {},
      configSchema: (t.configSchema as Record<string, unknown>) || null,
      pipelineSchema: (t.pipelineSchema as Record<string, unknown>) || null,
      expertDefaults: (t.expertDefaults as Record<string, unknown>[]) || null,
      requirements: this.requirementsOf(t),
      ownerName: t.isBuiltIn ? null : (t.user?.name || t.user?.email || null),
      sharedWithYou: !!viewer && !t.isBuiltIn && t.userId !== viewer.userId,
    }))
  }

  private async visibleTo(viewer: AgentTypeViewer) {
    const memberships = await this.prisma.projectMembership.findMany({
      where: { userId: viewer.userId },
      select: { projectId: true },
    })
    const memberOf = memberships.map((m) => m.projectId)
    const projectId = viewer.projectId && memberOf.includes(viewer.projectId) ? viewer.projectId : null
    const shareProjects = viewer.projectId ? (projectId ? [projectId] : []) : memberOf
    const rows = await this.prisma.agentType.findMany({
      where: {
        OR: [
          { isBuiltIn: true, validationStatus: AgentValidationStatus.APPROVED },
          { isBuiltIn: false, userId: viewer.userId },
          { isBuiltIn: false, projectShares: { some: { projectId: { in: shareProjects } } } },
        ],
      },
      include: {
        projectShares: { select: { projectId: true } },
        user: { select: { name: true, email: true } },
      },
      orderBy: [{ deprecated: 'asc' }, { isBuiltIn: 'desc' }, { name: 'asc' }],
    })
    const reviewRequired = await this.platformSettings.isAgentReviewRequired()
    // The deploy rule decides what is listed; the owner also sees their own
    // uploads that cannot deploy yet (pending, unbuilt), with their state.
    return rows.filter(
      (t) =>
        (!t.isBuiltIn && t.userId === viewer.userId && t.validationStatus !== AgentValidationStatus.REJECTED) ||
        !agentTypeAccessProblem(t, { userId: viewer.userId, projectId, memberOf: viewer.projectId ? [] : memberOf, reviewRequired }),
    )
  }

  /** One unreadable row must not take the whole gallery down; deploying it still fails with the reason. */
  private requirementsOf(type: AgentType): AgentRequirements | null {
    const { requirements, error } = requirementsForListing(type)
    if (error) this.logger.warn(`Agent type ${type.slug}: ${error}`)
    return requirements
  }
}
