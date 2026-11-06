import { Injectable, NotFoundException, ForbiddenException, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateProjectDto } from './dto/create-project.dto.js';
import { UpdateProjectDto } from './dto/update-project.dto.js';
import { ProjectStatsDto } from './dto/project-stats.dto.js';
import { UpdatePublicConfigDto } from './dto/update-public-config.dto.js';
import { SessionStatus, AgentStatus } from '@prisma/client';
import { AgentsService } from '../agents/agents.service.js';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);
  // Typed `any` on the constructor parameter (assigned to the field above) so
  // TS's emitDecoratorMetadata doesn't reference the still-circularly-importing
  // class eagerly in design:paramtypes, which throws a TDZ ReferenceError under
  // ESM depending on module evaluation order. forwardRef already handles the
  // actual lazy DI resolution.
  private agentsService: AgentsService;

  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => AgentsService))
    agentsService: any,
  ) {
    this.agentsService = agentsService;
  }

  async create(createProjectDto: CreateProjectDto, userId: string) {
    // Create project with owner membership in a transaction
    return this.prisma.project.create({
      data: {
        ...createProjectDto,
        memberships: {
          create: {
            userId,
            role: 'OWNER',
          },
        },
      },
      include: {
        memberships: true,
      },
    });
  }

  async findAll(userId: string) {
    // Get user's project IDs from memberships
    const memberships = await this.prisma.projectMembership.findMany({
      where: { userId },
      select: { projectId: true },
    });
    const projectIds = memberships.map((m) => m.projectId);

    const projects = await this.prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: {
        id: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        isPublic: true,
        publicToken: true,
        publicEnabled: true,
        agentInactivityTimeoutMinutes: true,
        memberships: {
          where: { role: 'OWNER' },
          select: { userId: true },
          take: 1,
        },
        _count: {
          select: {
            sessions: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Get additional counts for each project
    const projectsWithCounts = await Promise.all(
      projects.map(async (project) => {
        const activeSessions = await this.prisma.session.count({
          where: {
            projectId: project.id,
            status: SessionStatus.ACTIVE,
          },
        });

        const activeAgents = await this.prisma.agentInstance.count({
          where: {
            session: {
              projectId: project.id,
            },
            status: AgentStatus.RUNNING,
          },
        });

        const ownerId = project.memberships[0]?.userId || null;
        return {
          id: project.id,
          name: project.name,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          isPublic: project.isPublic,
          publicToken: project.publicToken,
          publicEnabled: project.publicEnabled,
          agentInactivityTimeoutMinutes: project.agentInactivityTimeoutMinutes,
          ownerId,
          isOwner: ownerId === userId,
          activeSessions,
          activeAgents,
          totalSessions: project._count.sessions,
        };
      }),
    );

    return projectsWithCounts;
  }

  async findOne(id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        sessions: {
          include: {
            _count: {
              select: {
                agents: true,
                participants: true,
              },
            },
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 10,
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    return project;
  }

  async getStats(id: string): Promise<ProjectStatsDto> {
    const project = await this.prisma.project.findUnique({
      where: { id },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    const [
      totalSessions,
      activeSessions,
      totalMessages,
      totalParticipants,
      agents,
    ] = await Promise.all([
      this.prisma.session.count({
        where: { projectId: id },
      }),
      this.prisma.session.count({
        where: {
          projectId: id,
          status: SessionStatus.ACTIVE,
        },
      }),
      this.prisma.message.count({
        where: {
          session: {
            projectId: id,
          },
        },
      }),
      this.prisma.participant.count({
        where: {
          session: {
            projectId: id,
          },
        },
      }),
      this.prisma.agentInstance.findMany({
        where: {
          session: {
            projectId: id,
          },
        },
        select: {
          status: true,
        },
      }),
    ]);

    const totalAgents = agents.length;
    const activeAgents = agents.filter((a) => a.status === AgentStatus.RUNNING)
      .length;

    return {
      totalSessions,
      activeSessions,
      totalAgents,
      activeAgents,
      totalMessages,
      totalParticipants,
    };
  }

  async update(id: string, updateProjectDto: UpdateProjectDto) {
    const project = await this.prisma.project.findUnique({
      where: { id },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    return this.prisma.project.update({
      where: { id },
      data: updateProjectDto,
    });
  }

  async remove(id: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      include: {
        sessions: {
          select: { id: true },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    this.logger.log(
      `Deleting project ${id} (${project.name}) - stopping all agents and cleaning up ${project.sessions.length} sessions`,
    );

    // Stop all agents for each session before deleting
    // This ensures K8s pods, secrets, and configmaps are properly cleaned up
    for (const session of project.sessions) {
      this.logger.log(`Stopping agents for session ${session.id}`);
      try {
        await this.agentsService.stopAllSessionAgents(session.id);
      } catch (error) {
        this.logger.warn(
          `Failed to stop agents for session ${session.id}: ${error.message}`,
        );
        // Continue with deletion even if agent stop fails
      }
    }

    // Now delete the project - Prisma cascade will delete sessions, invitations, etc.
    await this.prisma.project.delete({
      where: { id },
    });

    this.logger.log(
      `Project ${id} deleted - all agents stopped, all data removed`,
    );

    return { message: 'Project deleted successfully' };
  }

  /**
   * Update public project configuration
   * Allows configuring a project as public with agent, visualizer, and expiration settings.
   * `callerId` is the member saving it: only they decide which connectors the
   * public agent may use (see assertMayBindForPublic).
   */
  async updatePublicConfig(id: string, dto: UpdatePublicConfigDto, callerId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    // Validate agent type if provided
    if (dto.agentTypeId) {
      const agentType = await this.prisma.agentType.findUnique({
        where: { id: dto.agentTypeId },
      });
      if (!agentType) {
        throw new NotFoundException(`Agent type with ID ${dto.agentTypeId} not found`);
      }
    }

    // Build the update data
    const updateData: any = {
      isPublic: dto.isPublic,
    };

    // Only set public-specific fields if making the project public
    if (dto.isPublic) {
      if (dto.agentTypeId !== undefined) {
        updateData.publicAgentTypeId = dto.agentTypeId;
      }
      if (dto.agentConfig !== undefined) {
        updateData.publicAgentConfig = dto.agentConfig;
      }
      if (dto.visualizerType !== undefined) {
        updateData.publicVisualizerType = dto.visualizerType;
      }
      if (dto.visualizerLocked !== undefined) {
        updateData.publicVisualizerLocked = dto.visualizerLocked;
      }
      if (dto.expiresAt !== undefined) {
        updateData.publicExpiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
      }
      if (dto.enabled !== undefined) {
        updateData.publicEnabled = dto.enabled;
      }
      if (dto.maxSessionDurationSeconds !== undefined) {
        updateData.publicMaxSessionDurationSeconds = dto.maxSessionDurationSeconds;
      }
      // Public agents are deployed as the owner: check now that the owner may
      // deploy this type with these connectors, so a setup that cannot run fails here, not when a visitor joins.
      const agentTypeId = dto.agentTypeId ?? project.publicAgentTypeId;
      if (dto.agentConfig !== undefined && agentTypeId) {
        const owner = await this.prisma.projectMembership.findFirst({
          where: { projectId: id, role: 'OWNER' },
          select: { userId: true },
        });
        await this.assertMayBindForPublic(
          id,
          callerId,
          owner?.userId ?? null,
          dto.agentConfig.connectorBindings,
        );
        if (owner) {
          await this.agentsService.checkDeployable(
            agentTypeId,
            owner.userId,
            id,
            dto.agentConfig.connectorBindings,
          );
        }
      }
    } else {
      // When making private, optionally clear public config
      // Keep the publicToken so it can be re-enabled without losing the link
      updateData.publicEnabled = false;
    }

    const updatedProject = await this.prisma.project.update({
      where: { id },
      data: updateData,
      include: {
        publicAgentType: {
          select: {
            id: true,
            name: true,
            slug: true,
            icon: true,
          },
        },
      },
    });

    this.logger.log(
      `Updated public config for project ${id}: isPublic=${dto.isPublic}`,
    );

    return updatedProject;
  }

  /**
   * The public agent runs as the owner, so the deploy check alone would let any
   * member bind the owner's private connectors. A binding is allowed only for a
   * connector shared with the project, or one of the caller's own connectors
   * when the caller is the owner.
   */
  private async assertMayBindForPublic(
    projectId: string,
    callerId: string,
    ownerId: string | null,
    bindings: { connectorId: string }[] | undefined,
  ): Promise<void> {
    const ids = [...new Set((bindings ?? []).map((b) => b.connectorId))];
    if (ids.length === 0) return;
    const ownAllowed = ownerId !== null && callerId === ownerId;
    const allowed = await this.prisma.connector.findMany({
      where: {
        id: { in: ids },
        OR: [
          { shares: { some: { projectId } } },
          ...(ownAllowed ? [{ userId: callerId }] : []),
        ],
      },
      select: { id: true },
    });
    const ok = new Set(allowed.map((c) => c.id));
    if (ids.some((connectorId) => !ok.has(connectorId))) {
      throw new ForbiddenException(
        'A public setup can only use connectors shared with this project, or the owner\'s own connectors when the owner saves it',
      );
    }
  }

  /**
   * Get the public link for a project
   * Returns the full URL for sharing
   */
  async getPublicLink(id: string, baseUrl: string) {
    const project = await this.prisma.project.findUnique({
      where: { id },
      select: {
        isPublic: true,
        publicToken: true,
        publicEnabled: true,
      },
    });

    if (!project) {
      throw new NotFoundException(`Project with ID ${id} not found`);
    }

    if (!project.isPublic || !project.publicToken) {
      return { publicLink: null };
    }

    return {
      publicLink: `${baseUrl}/p/${project.publicToken}`,
      isEnabled: project.publicEnabled,
    };
  }
}
