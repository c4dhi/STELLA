import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { AgentValidationStatus } from '@prisma/client'
import { AgentPackageService } from '../agent-package/agent-package.service.js'
import { AgentBuildService, BuildStatus, resolveDockerfilePath } from '../agent-build/agent-build.service.js'
import { StorageService } from '../storage/storage.service.js'
import { PrismaService } from '../prisma/prisma.service.js'
import { DEFAULT_DOCKERFILE } from '../agent-package/manifest-defaults.js'
import { manifestToAgentTypeData } from '../agent-package/manifest-mapper.js'
import { requirementsForListing } from '../agents/agent-requirements.js'
import { builtSdkProblem } from '../agent-package/sdk-support.js'

/**
 * Who may see an agent's builds (log, status, history): whoever sees the agent
 * in their library. That is its owner, a member of a project it is shared
 * with, or a system admin. A built-in has no owner, so only admins.
 */
export function canSeeAgentBuilds(
  agentType: { isBuiltIn: boolean; userId: string | null },
  who: { userId: string; isSystemAdmin?: boolean; memberOf: string[]; sharedWith: string[] },
): boolean {
  if (who.isSystemAdmin) return true
  if (agentType.isBuiltIn || !agentType.userId) return false
  if (agentType.userId === who.userId) return true
  const shared = new Set(who.sharedWith)
  return who.memberOf.some((projectId) => shared.has(projectId))
}

/**
 * Uploaded (custom, non-built-in) agent types: upload, list, build and
 * sharing. Both the REST controller (agent-upload.controller.ts) and the MCP
 * tools (mcp/tools/agent-uploads.tools.ts) call this - neither duplicates the
 * logic itself. Deleting an upload stays on the controller: it reaches into
 * agents/sessions to stop running agents, which belongs to that surface, not
 * here.
 */
@Injectable()
export class AgentUploadService {
  private readonly logger = new Logger(AgentUploadService.name)

  constructor(
    private agentPackageService: AgentPackageService,
    private agentBuildService: AgentBuildService,
    private storageService: StorageService,
    private prisma: PrismaService,
  ) {}

  /** Validate and store a package buffer, same for a .zip upload or one packed in-memory (MCP). */
  async createFromPackage(buffer: Buffer, userId: string) {
    const validation = await this.agentPackageService.validatePackage(buffer)
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

    const storageInfo = await this.agentPackageService.storePackage(
      buffer,
      `${manifest.metadata.slug}-${manifest.metadata.version}.zip`,
    )

    // Same mapping as built-in agents (the seed): manifest → AgentType columns,
    // including the default experts from config/experts/*.json.
    const expertDefaults = this.agentPackageService.readExpertDefaults(buffer, manifest.capabilities)
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
      // Built and reviewed again before anyone else can deploy it.
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

    // The upload itself succeeded regardless of this; a kickoff failure is
    // logged, not surfaced as an upload error, and the uploader can still
    // press Rebuild.
    try {
      await this.agentBuildService.startBuild(agentType.id, userId)
    } catch (err) {
      this.logger.error(`Failed to start build for ${agentType.slug} (${agentType.id}): ${(err as Error).message}`)
    }

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

  /** The user's own custom (non-built-in) agents, with their build and sharing state. */
  async getMyAgents(userId: string) {
    const agents = await this.prisma.agentType.findMany({
      where: { isBuiltIn: false, userId },
      orderBy: { createdAt: 'desc' },
      include: {
        buildLogs: { orderBy: { startedAt: 'desc' }, take: 1 },
        projectShares: { select: { projectId: true } },
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
      // What the reviewing admin wrote: the approval notes or the rejection reason.
      validationNotes: agent.validationNotes,
      validatedAt: agent.validatedAt,
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
      // The projects whose members may deploy it.
      sharedProjectIds: agent.projectShares.map((share) => share.projectId),
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

  /** Only the uploader (or a system admin) may build this upload. */
  async triggerBuild(id: string, userId: string, isSystemAdmin?: boolean) {
    const agentType = await this.prisma.agentType.findUnique({ where: { id } })
    if (!agentType) throw new NotFoundException('Agent type not found')
    if (agentType.isBuiltIn) throw new BadRequestException('Cannot rebuild built-in agents')
    if (!agentType.packagePath) throw new BadRequestException('Agent has no uploaded package')
    if (!isSystemAdmin && agentType.userId !== userId) {
      throw new ForbiddenException('You do not own this agent')
    }

    const result = await this.agentBuildService.startBuild(id, userId)
    return { buildLogId: result.buildLogId, message: 'Build started' }
  }

  /**
   * Looks up the latest build log for an agent type and its stored output
   * (#961), with no access check of its own - callers reachable without one
   * (the controller's build-logs SSE stream) must not be newly gated by
   * adding output here.
   */
  async latestBuildStatus(id: string): Promise<BuildStatus | null> {
    const latestBuild = await this.prisma.agentBuildLog.findFirst({
      where: { agentTypeId: id },
      orderBy: { startedAt: 'desc' },
    })
    if (!latestBuild) return null

    const status = await this.agentBuildService.getBuildStatus(latestBuild.id)
    if (!status) return null

    const buildOutput = await this.agentBuildService.getBuildOutput(latestBuild.id)
    return { ...status, buildOutput: buildOutput ?? undefined }
  }

  /** Build status (#961), including stored output, for whoever may see this agent's builds. */
  async getBuildStatus(id: string, userId: string, isSystemAdmin?: boolean): Promise<BuildStatus | null> {
    await this.assertCanSeeBuilds(id, userId, isSystemAdmin)
    return this.latestBuildStatus(id)
  }

  /** Past builds, newest first, for whoever may see this agent's builds. */
  async getBuildHistory(id: string, userId: string, isSystemAdmin?: boolean) {
    await this.assertCanSeeBuilds(id, userId, isSystemAdmin)
    return this.agentBuildService.getBuildHistory(id)
  }

  /** A build's stored output, trimmed for the controller's SSE stream. No access check: callers check once at stream open. */
  async getBuildOutput(buildLogId: string): Promise<string | null> {
    return this.agentBuildService.getBuildOutput(buildLogId)
  }

  /** 404 for an unknown agent, 403 unless the caller may see its builds (`canSeeAgentBuilds`). */
  async assertCanSeeBuilds(id: string, userId: string, isSystemAdmin?: boolean): Promise<void> {
    const agentType = await this.prisma.agentType.findUnique({ where: { id } })
    if (!agentType) throw new NotFoundException('Agent type not found')
    const [memberships, shares] =
      isSystemAdmin || agentType.userId === userId
        ? [[], []]
        : await Promise.all([
            this.prisma.projectMembership.findMany({ where: { userId }, select: { projectId: true } }),
            this.prisma.agentTypeProjectShare.findMany({ where: { agentTypeId: id }, select: { projectId: true } }),
          ])
    const allowed = canSeeAgentBuilds(agentType, {
      userId,
      isSystemAdmin,
      memberOf: memberships.map((m) => m.projectId),
      sharedWith: shares.map((s) => s.projectId),
    })
    if (!allowed) throw new ForbiddenException("You cannot see this agent's builds")
  }

  /** The projects this custom agent is shared with, and the projects its owner could share it with. */
  async getShares(id: string, userId: string) {
    const agentType = await this.ownUpload(id, userId)
    const [shares, memberships] = await Promise.all([
      this.prisma.agentTypeProjectShare.findMany({ where: { agentTypeId: id }, select: { projectId: true } }),
      this.prisma.projectMembership.findMany({
        where: { userId: agentType.userId! },
        select: { project: { select: { id: true, name: true } } },
        orderBy: { project: { name: 'asc' } },
      }),
    ])
    return {
      projectIds: shares.map((s) => s.projectId),
      projects: memberships.map((m) => m.project),
    }
  }

  /** Share this custom agent with exactly these projects, replacing the current set. Only the owner shares, and only with projects they are a member of. */
  async updateShares(id: string, userId: string, projectIds: string[]) {
    const agentType = await this.ownUpload(id, userId)
    const ids = [...new Set(projectIds)]
    const memberOf = await this.prisma.projectMembership.findMany({
      where: { userId: agentType.userId!, projectId: { in: ids } },
      select: { projectId: true },
    })
    if (memberOf.length !== ids.length) {
      throw new ForbiddenException('You can only share an agent with projects you are a member of')
    }
    await this.prisma.$transaction([
      this.prisma.agentTypeProjectShare.deleteMany({ where: { agentTypeId: id, projectId: { notIn: ids } } }),
      ...ids.map((projectId) =>
        this.prisma.agentTypeProjectShare.upsert({
          where: { agentTypeId_projectId: { agentTypeId: id, projectId } },
          create: { agentTypeId: id, projectId },
          update: {},
        }),
      ),
    ])
    this.logger.log(`Agent type ${agentType.slug} shared with ${ids.length} project(s)`)
    return { projectIds: ids }
  }

  /** The caller's own upload: sharing is the owner's alone, not an admin's. */
  private async ownUpload(id: string, userId: string) {
    const agentType = await this.prisma.agentType.findUnique({ where: { id } })
    if (!agentType) throw new NotFoundException(`Agent type ${id} not found`)
    if (agentType.isBuiltIn || agentType.userId !== userId) {
      throw new ForbiddenException('Only its owner can share this agent')
    }
    return agentType
  }
}
