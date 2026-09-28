import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { AgentsService } from '../agents/agents.service';
import { InvitationsService } from '../invitations/invitations.service';
import { AgentStatus } from '@prisma/client';
import {
  PublicProjectInfoDto,
  JoinPublicProjectResponseDto,
  StartJoinPublicProjectResponseDto,
  JoinProgressDto,
} from './dto/public-project-info.dto';

// In-memory progress state
interface ProgressState {
  step: number;
  status: 'in_progress' | 'complete' | 'failed';
  message: string;
  agentId?: string;
  invitationToken?: string;
  error?: string;
  updatedAt: Date;
}

interface PublicAgentConfig {
  name?: string;
  icon?: string;
  plan?: Record<string, unknown>;
  config?: Record<string, unknown>;
  pipelineConfig?: Record<string, unknown>;
  // Preferred: resolved by ID at spawn (type/version-checked). pipelineConfig is a
  // backward-compatible inline snapshot for public projects saved before this field.
  agentConfigurationId?: string;
  // Resolved by ID at spawn, like the pipeline configuration. Absent = the
  // system default persona, which is what every public project got before the
  // setup wizard could pick one.
  personaId?: string;
  envVarTemplateId?: string;
  envVars?: Record<string, string>;
}

@Injectable()
export class PublicProjectsService {
  private readonly logger = new Logger(PublicProjectsService.name);

  // Simple in-memory progress tracking
  private progressMap = new Map<string, ProgressState>();

  constructor(
    private prisma: PrismaService,
    private sessionsService: SessionsService,
    private agentsService: AgentsService,
    private invitationsService: InvitationsService,
  ) {
    // Cleanup old entries every minute
    setInterval(() => this.cleanup(), 60000);
  }

  private cleanup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000; // 5 minutes
    for (const [id, state] of this.progressMap) {
      if (state.updatedAt.getTime() < cutoff) {
        this.progressMap.delete(id);
      }
    }
  }

  private updateProgress(
    sessionId: string,
    step: number,
    status: ProgressState['status'],
    message: string,
    extra: Partial<ProgressState> = {},
  ): void {
    this.logger.log(
      `[${sessionId}] Progress: step=${step}, status=${status}, message=${message}`,
    );
    this.progressMap.set(sessionId, {
      step,
      status,
      message,
      updatedAt: new Date(),
      ...extra,
    });
  }

  private buildRuntimeAgentConfig(
    agentConfig: PublicAgentConfig | null,
  ): Record<string, unknown> {
    return {
      ...(agentConfig?.config || {}),
      ...(agentConfig?.plan ? { plan: agentConfig.plan } : {}),
      ...(agentConfig?.pipelineConfig
        ? { pipeline_config: agentConfig.pipelineConfig }
        : {}),
    };
  }

  /**
   * Get public project info by token
   * Returns display info for the waiting screen
   */
  async getPublicProjectInfo(
    publicToken: string,
  ): Promise<PublicProjectInfoDto> {
    const project = await this.prisma.project.findUnique({
      where: { publicToken },
      include: {
        publicAgentType: {
          select: {
            name: true,
            icon: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Public project not found');
    }

    if (!project.isPublic) {
      throw new NotFoundException('This project is not public');
    }

    // Check expiration
    const isExpired = project.publicExpiresAt
      ? new Date() > project.publicExpiresAt
      : false;

    // Get agent config from JSON
    const agentConfig = project.publicAgentConfig as {
      name?: string;
      icon?: string;
    } | null;

    return {
      projectName: project.name,
      agentName: agentConfig?.name || project.publicAgentType?.name || 'Agent',
      agentIcon:
        agentConfig?.icon || project.publicAgentType?.icon || undefined,
      visualizerType: project.publicVisualizerType || undefined,
      visualizerLocked: project.publicVisualizerLocked,
      maxSessionDurationSeconds: project.publicMaxSessionDurationSeconds ?? undefined,
      isExpired,
      isEnabled: project.publicEnabled,
    };
  }

  /**
   * Join a public project
   * Creates a new session, deploys the pre-configured agent,
   * waits for the agent to be ready, creates an invitation,
   * and returns the invitation token for redirect
   */
  async joinPublicProject(
    publicToken: string,
  ): Promise<JoinPublicProjectResponseDto> {
    // 1. Validate public project configuration
    const project = await this.prisma.project.findUnique({
      where: { publicToken },
      include: {
        publicAgentType: true,
        memberships: {
          where: { role: 'OWNER' },
          take: 1,
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Public project not found');
    }

    if (!project.isPublic) {
      throw new BadRequestException('This project is not public');
    }

    if (!project.publicEnabled) {
      throw new BadRequestException(
        'This public project is currently disabled',
      );
    }

    // Check expiration
    if (project.publicExpiresAt && new Date() > project.publicExpiresAt) {
      throw new BadRequestException('This public project link has expired');
    }

    // Ensure we have an agent type configured
    if (!project.publicAgentTypeId && !project.publicAgentType) {
      throw new BadRequestException('Public project has no agent configured');
    }

    // Get the owner's user ID for env var template access
    const ownerId = project.memberships[0]?.userId;
    if (!ownerId) {
      throw new BadRequestException('Project has no owner');
    }

    // Get agent config from JSON
    const agentConfig = project.publicAgentConfig as PublicAgentConfig | null;

    // 2. Create a new session
    const sessionName = `Public Session - ${new Date().toISOString().slice(0, 16)}`;
    const session = await this.sessionsService.create(project.id, {
      name: sessionName,
    });

    this.logger.log(
      `Created session ${session.id} for public project ${project.id}`,
    );

    // 3. Deploy the agent with pre-configured settings.
    // Config normalization (plan/pipelineConfig → runtime shape) and type validation
    // are now handled inside AgentsService.create(), so we pass the raw fields directly.
    const agent = await this.agentsService.create(
      session.id,
      {
        name: agentConfig?.name || project.publicAgentType?.name || 'Agent',
        icon: agentConfig?.icon || project.publicAgentType?.icon || '🤖',
        agentType: project.publicAgentType?.slug || 'stella-v2-agent',
        config: this.buildRuntimeAgentConfig(agentConfig),
        agentConfigurationId: agentConfig?.agentConfigurationId,
        personaId: agentConfig?.personaId,
        envVarTemplateId: agentConfig?.envVarTemplateId,
        envVars: agentConfig?.envVars,
      },
      ownerId,
    );

    this.logger.log(`Deployed agent ${agent.id} for session ${session.id}`);

    // 4. Wait for agent to be RUNNING
    const agentReady = await this.waitForAgentReady(agent.id, session.id);
    if (!agentReady) {
      throw new BadRequestException(
        'Failed to start agent. Please try again or contact support.',
      );
    }

    this.logger.log(`Agent ${agent.id} is ready for session ${session.id}`);

    // 5. Create invitation using existing service
    const { invitation } = await this.invitationsService.create(session.id, {
      visualizerType: project.publicVisualizerType || undefined,
      visualizerLocked: project.publicVisualizerLocked,
      maxSessionDurationSeconds: project.publicMaxSessionDurationSeconds ?? undefined,
      // Auto-generated name
    });

    this.logger.log(
      `Created invitation ${invitation.id} for session ${session.id}`,
    );

    return {
      invitationToken: invitation.token,
      sessionId: session.id,
      agentId: agent.id,
    };
  }

  /**
   * Start joining a public project (non-blocking)
   * Returns sessionId immediately. Frontend polls getJoinProgress for updates.
   *
   * Uses on_demand mode: agent is spawned via webhook when human joins LiveKit room.
   */
  async startJoinPublicProject(
    publicToken: string,
  ): Promise<StartJoinPublicProjectResponseDto> {
    const project = await this.validatePublicProject(publicToken);

    const ownerId = project.memberships[0]?.userId;
    if (!ownerId) {
      throw new BadRequestException('Project has no owner');
    }

    // Get agent config for storing
    const agentConfig = project.publicAgentConfig as PublicAgentConfig | null;

    // Prepare lastAgentConfig for on_demand webhook-driven spawning.
    // Config is normalized inline (plan/pipelineConfig → runtime shape).
    // Type validation runs in AgentsService.create() when the agent is eventually spawned.
    const lastAgentConfig = {
      name: agentConfig?.name || project.publicAgentType?.name || 'Agent',
      icon: agentConfig?.icon || project.publicAgentType?.icon || '🤖',
      agentType: project.publicAgentType?.slug || 'stella-v2-agent',
      agentConfig: this.buildRuntimeAgentConfig(agentConfig),
      agentConfigurationId: agentConfig?.agentConfigurationId || null,
      personaId: agentConfig?.personaId || null,
      envVarTemplateId: agentConfig?.envVarTemplateId || null,
      envVars: agentConfig?.envVars || {},
    };

    // Create session with on_demand mode - agent will be spawned when human joins
    const sessionName = `Public Session - ${new Date().toISOString().slice(0, 16)}`;
    const session = await this.sessionsService.create(project.id, {
      name: sessionName,
      agentSpawnMode: 'on_demand', // Agent spawned via webhook when human joins
    });

    // Store agent config for later spawning (cast to satisfy Prisma's JsonValue type)
    await this.prisma.session.update({
      where: { id: session.id },
      data: { lastAgentConfig: lastAgentConfig as any },
    });

    this.logger.log(
      `Created on_demand session ${session.id} for public project ${project.id}`,
    );

    // Initialize progress
    this.updateProgress(session.id, 1, 'in_progress', 'Session created');

    // Run join process async (fire and forget)
    this.runJoinProcess(project, session.id, ownerId).catch((err) => {
      this.logger.error(`Join failed: ${err.message}`);
    });

    return { sessionId: session.id };
  }

  /**
   * Get current join progress (polling endpoint)
   */
  getJoinProgress(sessionId: string): JoinProgressDto {
    const state = this.progressMap.get(sessionId);
    if (!state) {
      return {
        step: 0,
        totalSteps: 5,
        status: 'in_progress',
        message: 'Initializing...',
      };
    }
    return {
      step: state.step,
      totalSteps: 5,
      status: state.status,
      message: state.message,
      agentId: state.agentId,
      invitationToken: state.invitationToken,
      error: state.error,
    };
  }

  /**
   * Run the join process (async)
   *
   * For on_demand sessions: Skip agent deployment, just create invitation.
   * Agent will be spawned via webhook when human joins the LiveKit room.
   */
  private async runJoinProcess(
    project: any,
    sessionId: string,
    ownerId: string,
  ): Promise<void> {
    try {
      // Check session spawn mode
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { agentSpawnMode: true },
      });

      const isOnDemand = session?.agentSpawnMode === 'on_demand';

      if (isOnDemand) {
        // On-demand mode: Skip agent deployment, just create invitation
        // Agent will be spawned via webhook when human joins LiveKit room
        this.updateProgress(
          sessionId,
          2,
          'in_progress',
          'Preparing session...',
        );

        // Brief delay to simulate progress
        await new Promise((r) => setTimeout(r, 500));

        this.updateProgress(sessionId, 3, 'in_progress', 'Setting up room...');

        // Brief delay
        await new Promise((r) => setTimeout(r, 500));

        // Step 4: Create invitation
        this.updateProgress(sessionId, 4, 'in_progress', 'Creating session...');
        const { invitation } = await this.invitationsService.create(sessionId, {
          visualizerType: project.publicVisualizerType || undefined,
          visualizerLocked: project.publicVisualizerLocked,
        });

        // Step 5: Done - agent will spawn when user joins
        this.updateProgress(sessionId, 5, 'complete', 'Ready!', {
          invitationToken: invitation.token,
        });

        this.logger.log(
          `On-demand session ${sessionId} ready - agent will spawn when user joins`,
        );
      } else {
        // Immediate mode: Deploy agent now (legacy behavior).
        // AgentsService.create() handles config validation and env var resolution.
        const agentConfig =
          project.publicAgentConfig as PublicAgentConfig | null;

        // Step 2: Deploy agent
        this.updateProgress(sessionId, 2, 'in_progress', 'Deploying agent...');
        const agent = await this.agentsService.create(
          sessionId,
          {
            name: agentConfig?.name || project.publicAgentType?.name || 'Agent',
            icon: agentConfig?.icon || project.publicAgentType?.icon || '🤖',
            agentType: project.publicAgentType?.slug || 'stella-v2-agent',
            config: this.buildRuntimeAgentConfig(agentConfig),
            agentConfigurationId: agentConfig?.agentConfigurationId,
            personaId: agentConfig?.personaId,
            envVarTemplateId: agentConfig?.envVarTemplateId,
            envVars: agentConfig?.envVars,
          },
          ownerId,
        );

        // Step 3: Wait for agent
        this.updateProgress(sessionId, 3, 'in_progress', 'Starting agent...', {
          agentId: agent.id,
        });
        const ready = await this.pollAgentReady(agent.id);
        if (!ready.success) {
          this.updateProgress(sessionId, 3, 'failed', 'Agent failed to start', {
            error: ready.error,
          });
          return;
        }

        // Step 4: Create invitation
        this.updateProgress(
          sessionId,
          4,
          'in_progress',
          'Creating session...',
          { agentId: agent.id },
        );
        const { invitation } = await this.invitationsService.create(sessionId, {
          visualizerType: project.publicVisualizerType || undefined,
          visualizerLocked: project.publicVisualizerLocked,
        });

        // Step 5: Done
        this.updateProgress(sessionId, 5, 'complete', 'Ready!', {
          agentId: agent.id,
          invitationToken: invitation.token,
        });
      }
    } catch (error) {
      this.updateProgress(sessionId, 0, 'failed', 'Failed', {
        error: error.message,
      });
    }
  }

  /**
   * Wait for agent to be ready (blocking) - used by deprecated join endpoint
   */
  private async waitForAgentReady(
    agentId: string,
    sessionId: string,
  ): Promise<boolean> {
    const result = await this.pollAgentReady(agentId);
    if (!result.success) {
      this.logger.error(
        `Agent ${agentId} failed to start for session ${sessionId}: ${result.error}`,
      );
    }
    return result.success;
  }

  /**
   * Poll for agent to become RUNNING
   */
  private async pollAgentReady(
    agentId: string,
    maxWaitMs = 120000,
  ): Promise<{ success: boolean; error?: string }> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const agent = await this.prisma.agentInstance.findUnique({
        where: { id: agentId },
        select: { status: true, lastError: true },
      });

      if (!agent) return { success: false, error: 'Agent not found' };
      if (agent.status === AgentStatus.RUNNING) return { success: true };
      if (agent.status === AgentStatus.FAILED)
        return { success: false, error: agent.lastError || 'Failed' };
      if (agent.status === AgentStatus.STOPPED)
        return { success: false, error: 'Stopped' };

      await new Promise((r) => setTimeout(r, 500));
    }
    return { success: false, error: 'Timeout' };
  }

  /**
   * Validate public project and return project data
   */
  private async validatePublicProject(publicToken: string) {
    const project = await this.prisma.project.findUnique({
      where: { publicToken },
      include: {
        publicAgentType: true,
        memberships: {
          where: { role: 'OWNER' },
          take: 1,
        },
      },
    });

    if (!project) {
      throw new NotFoundException('Public project not found');
    }

    if (!project.isPublic) {
      throw new BadRequestException('This project is not public');
    }

    if (!project.publicEnabled) {
      throw new BadRequestException(
        'This public project is currently disabled',
      );
    }

    // Check expiration
    if (project.publicExpiresAt && new Date() > project.publicExpiresAt) {
      throw new BadRequestException('This public project link has expired');
    }

    // Ensure we have an agent type configured
    if (!project.publicAgentTypeId && !project.publicAgentType) {
      throw new BadRequestException('Public project has no agent configured');
    }

    return project;
  }
}
