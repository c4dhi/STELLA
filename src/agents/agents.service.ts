import { Injectable, NotFoundException, BadRequestException, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { KubernetesService } from '../kubernetes/kubernetes.service';
import { AgentServerService } from '../agent-server/agent-server.service';
import { SessionsService } from '../sessions/sessions.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import {
  AgentMetricsResponseDto,
  StageLatencyDto,
  StageDataPointDto,
  SessionStagePointDto,
  OutlierSessionDto,
  OutlierStageDto,
  SessionAnalyticsResponseDto,
  MetricsSummaryDto,
  PlanCompletionSessionDto,
} from './dto/agent-metrics.dto';
import { AgentStatus, Prisma } from '@prisma/client';
import { sanitizeAgentConfig } from '../common/utils/sanitize-config';
import { EncryptionService } from '../env-var-templates/encryption.service';
import { EnvVarTemplatesService } from '../env-var-templates/env-var-templates.service';
import { AgentConfigurationsService } from '../agent-configurations/agent-configurations.service';

/**
 * AgentsService - Manages agent lifecycle.
 *
 * In the new architecture:
 * - Agents connect directly to LiveKit rooms via SDK
 * - Session-management-server only deploys K8s pods
 * - No RoomAgentService needed (agents handle audio directly)
 */
@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    private prisma: PrismaService,
    private k8s: KubernetesService,
    private configService: ConfigService,
    // Used for encrypting manual env vars at persist time and decrypting them on restart.
    private readonly encryptionService: EncryptionService,
    // Used for resolving env vars (template decrypt + manual merge) before K8s pod creation.
    private readonly envVarTemplatesService: EnvVarTemplatesService,
    // Used to resolve + validate a stored pipeline configuration at deploy time.
    private readonly agentConfigurationsService: AgentConfigurationsService,
    private readonly eventEmitter: EventEmitter2,
    @Optional() private agentServerService?: AgentServerService,
    @Optional() @Inject(forwardRef(() => SessionsService)) private sessionsService?: SessionsService,
  ) {
    // Validate OpenAI API key on startup
    this.validateOpenAIKey();
  }

  /**
   * Validate OpenAI API key format
   */
  private validateOpenAIKey(): void {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');

    if (!apiKey) {
      this.logger.error('❌ OPENAI_API_KEY is not set in environment variables');
      this.logger.error('   Agents will fail to start. Please set OPENAI_API_KEY in .env file');
      return;
    }

    // Check basic format
    if (!apiKey.startsWith('sk-')) {
      this.logger.error(`❌ OPENAI_API_KEY has invalid format: ${apiKey.substring(0, 7)}...`);
      this.logger.error('   Valid OpenAI keys start with "sk-"');
      return;
    }

    // Check reasonable length (OpenAI keys are typically 48-51 characters)
    if (apiKey.length < 40) {
      this.logger.error(`❌ OPENAI_API_KEY appears truncated (${apiKey.length} chars)`);
      this.logger.error('   Expected length: 48-51 characters');
      return;
    }

    this.logger.log(`✅ OPENAI_API_KEY is set (${apiKey.substring(0, 7)}...${apiKey.substring(apiKey.length - 4)})`);
    this.logger.log(`   Key length: ${apiKey.length} characters`);
  }

  /**
   * Security: Sanitize agent config to prevent injection attacks.
   * Delegates to shared utility in common/utils/sanitize-config.ts
   */
  private sanitizeAgentConfig(config: Record<string, unknown>): Record<string, unknown> {
    return sanitizeAgentConfig(config);
  }

  /**
   * Validate that the agent config satisfies requirements for the given agent type.
   * Called on every create() path so no entry point can skip type-specific validation.
   *
   * Currently enforced: stella-v2-agent requires a pipeline_config object.
   */
  private validateRuntimeConfigForAgentType(
    agentTypeSlug: string,
    runtimeConfig: Record<string, unknown>,
  ): void {
    if (agentTypeSlug !== 'stella-v2-agent') return;

    const pipelineConfig = runtimeConfig.pipeline_config;
    if (!pipelineConfig || typeof pipelineConfig !== 'object' || Array.isArray(pipelineConfig)) {
      throw new BadRequestException(
        'stella-v2-agent requires a pipeline configuration (config.pipeline_config).',
      );
    }
  }

  private encryptManualEnvVarsForStorage(
    manualVars?: Record<string, string>,
  ): string | null {
    if (!manualVars || Object.keys(manualVars).length === 0) {
      return null;
    }

    return this.encryptionService.encrypt(manualVars);
  }

  /**
   * Map Kubernetes pod phase to AgentStatus
   */
  private mapPodPhaseToAgentStatus(podStatus: any): AgentStatus | null {
    if (!podStatus) {
      return AgentStatus.STOPPED;
    }

    const phase = podStatus.phase;
    const containerStatuses = podStatus.containerStatuses;

    // Check if container is running
    if (phase === 'Running') {
      return AgentStatus.RUNNING;
    }

    // Check if pod is pending (starting)
    if (phase === 'Pending') {
      return AgentStatus.STARTING;
    }

    // Check if pod succeeded (graceful stop)
    if (phase === 'Succeeded') {
      return AgentStatus.STOPPED;
    }

    // Check if pod failed
    if (phase === 'Failed') {
      return AgentStatus.FAILED;
    }

    // Check container states for more detail
    if (containerStatuses && containerStatuses.length > 0) {
      const containerState = containerStatuses[0].state;
      if (containerState?.waiting) {
        return AgentStatus.STARTING;
      }
      if (containerState?.terminated) {
        const exitCode = containerState.terminated.exitCode;
        return exitCode === 0 ? AgentStatus.STOPPED : AgentStatus.FAILED;
      }
    }

    return null; // Unknown state, don't update
  }

  /**
   * Sync agent status from Kubernetes pod status.
   * All agents run as K8s pods - no in-process agents.
   */
  async syncAgentStatus(agentId: string): Promise<AgentStatus | null> {
    const agent = await this.prisma.agentInstance.findUnique({
      where: { id: agentId },
    });

    if (!agent) {
      return null;
    }

    // Don't override STARTING state - this is set by create()/restartAgent()
    // and will transition to RUNNING when agent connects via gRPC,
    // or to FAILED if pod creation fails in the catch block
    if (agent.status === AgentStatus.STARTING) {
      return agent.status;
    }

    // Agent without podName that's not starting = orphaned, mark as STOPPED
    if (!agent.podName) {
      if (agent.status === AgentStatus.RUNNING) {
        this.logger.warn(`Agent ${agentId} has no podName but status is RUNNING, marking as STOPPED`);
        await this.prisma.agentInstance.update({
          where: { id: agentId },
          data: {
            status: AgentStatus.STOPPED,
            stoppedAt: new Date(),
          },
        });
        return AgentStatus.STOPPED;
      }
      return agent.status;
    }

    // Don't override STOPPING state - this is controlled by manual stop action
    if (agent.status === AgentStatus.STOPPING) {
      return agent.status;
    }

    try {
      const podStatus = await this.k8s.getPodStatus(agent.podName);
      const actualStatus = this.mapPodPhaseToAgentStatus(podStatus);

      // Log when pod doesn't exist
      if (!podStatus) {
        this.logger.debug(`Agent ${agentId} pod ${agent.podName} not found in K8s, status will be ${actualStatus}`);
      }

      // Only update if status changed
      if (actualStatus && actualStatus !== agent.status) {
        this.logger.log(
          `Agent ${agentId} status changed from ${agent.status} to ${actualStatus} (pod: ${agent.podName})`
        );

        await this.prisma.agentInstance.update({
          where: { id: agentId },
          data: {
            status: actualStatus,
            stoppedAt: actualStatus === AgentStatus.STOPPED || actualStatus === AgentStatus.FAILED
              ? new Date()
              : null,
          },
        });

        return actualStatus;
      }

      return agent.status;
    } catch (error) {
      this.logger.error(`Failed to sync agent status for ${agentId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Create an agent instance for a session.
   * Creates a K8s pod that connects back to session-management-server via gRPC.
   * Session management server handles ALL LiveKit communication.
   *
   * @param sessionId - The session ID
   * @param createAgentDto - Agent creation parameters
   * @param userId - The user creating the agent (for env var template access)
   */
  async create(sessionId: string, createAgentDto: CreateAgentDto, userId: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { room: true, project: true },
    });

    if (!session) {
      throw new NotFoundException(`Session with ID ${sessionId} not found`);
    }

    if (!session.room) {
      throw new NotFoundException('Session does not have an associated room');
    }

    // Determine agent type (default to stella-light-agent)
    const agentType = createAgentDto.agentType || 'stella-light-agent';

    // Security: Validate agent type against allowed list
    const allowedAgentTypes = ['stella-v2-agent', 'stella-light-agent'];
    if (!allowedAgentTypes.includes(agentType)) {
      throw new BadRequestException(`Invalid agent type: ${agentType}. Allowed: ${allowedAgentTypes.join(', ')}`);
    }

    // Look up AgentType from DB for per-agent resource limits, type scoping and
    // pipeline-config resolution.
    const agentTypeRecord = await this.prisma.agentType.findUnique({
      where: { slug: agentType },
      select: {
        id: true,
        version: true,
        compilerVersion: true,
        resourceCpu: true,
        resourceMemory: true,
        defaultConfig: true,
        pipelineSchema: true,
        configSchema: true,
      },
    });

    // Security: Sanitize agent name (max 255 chars, no control characters)
    const sanitizedName = createAgentDto.name
      .substring(0, 255)
      .replace(/[\x00-\x1F\x7F]/g, ''); // Remove control characters

    // Security: Validate and sanitize agent config
    const agentConfig = this.sanitizeAgentConfig(createAgentDto.config || {});

    // Enforce type/version scoping of configuration artifacts BEFORE persisting the
    // agent or creating any pod, so a mismatch returns 400 and leaves no trace.
    // This runs FIRST so that a selected `agentConfigurationId` resolves and injects
    // `pipeline_config` before the type-specific validator checks for its presence
    // (the deploy modal passes only the id and intentionally does not inline it).
    await this.applyScopedConfiguration(createAgentDto, userId, agentTypeRecord, agentConfig);

    // Validate type-specific config requirements for ALL creation paths.
    // (Previously this only ran for public-project flows in PublicProjectsService.)
    this.validateRuntimeConfigForAgentType(agentType, agentConfig);

    // Encrypt manual env vars now so they are persisted before the async pod creation.
    // This guarantees restart() can recover them even if the pod creation fails.
    const manualEnvVarsEncrypted = this.encryptManualEnvVarsForStorage(createAgentDto.envVars);

    // 1. Create agent record (status=STARTING, no podName yet)
    const agent = await this.prisma.agentInstance.create({
      data: {
        sessionId,
        name: sanitizedName,
        icon: createAgentDto.icon || '🤖',
        agentConfig: agentConfig as Prisma.InputJsonValue,
        agentType,
        agentTypeId: agentTypeRecord?.id ?? null,  // Persist FK (was previously left null)
        envVarTemplateId: createAgentDto.envVarTemplateId || null,  // Store for restarts
        // Keep encrypted manual env vars for restart path parity with template-based deployments.
        manualEnvVarsEncrypted,
        status: AgentStatus.STARTING,
        healthState: 'initializing',
      },
    });

    this.logger.log(`Created agent ${agent.id} (type: ${agentType}) for session ${sessionId}`);

    // 2. Emit SSE event: agent.starting
    if (this.sessionsService) {
      this.sessionsService.emitAgentStarting(sessionId, agent.id, sanitizedName, agentType);
    }

    // 3. Register pending session for gRPC agent connection (non-blocking)
    if (this.agentServerService) {
      const config: Record<string, string> = {
        sessionId: session.id,
        roomName: session.room.livekitRoomName,
        projectId: session.projectId,
        agentName: sanitizedName,
        agentId: agent.id,
      };

      this.agentServerService.registerPendingSession(sessionId, agentType, config);
      this.logger.log(`Registered pending session ${sessionId} for agent type: ${agentType}`);
    }

    // 4. Create K8s pod asynchronously (don't block response)
    // NOTE: In the new architecture, agents connect directly to LiveKit rooms via SDK
    // No need for session-management-server to join rooms
    this.createAgentPodAsync(agent.id, session, sanitizedName, createAgentDto, agentType, userId, agentConfig, agentTypeRecord);

    return agent;
  }

  /**
   * Async K8s pod creation - runs in background, updates DB on completion/failure.
   */
  private async createAgentPodAsync(
    agentId: string,
    session: { id: string; projectId: string; room: { livekitRoomName: string; serverUrl: string } | null },
    sanitizedName: string,
    createAgentDto: CreateAgentDto,
    agentType: string,
    userId: string,
    sanitizedConfig: Record<string, unknown>,
    agentTypeRecord?: { resourceCpu: string | null; resourceMemory: string | null } | null,
  ): Promise<void> {
    try {
      // Get environment variables for LiveKit (agent pod needs these for gRPC config)
      const livekitApiKey = this.configService.get<string>('LIVEKIT_API_KEY');
      const livekitApiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');
      const livekitUrl = this.configService.get<string>('LIVEKIT_URL', session.room?.serverUrl || '');

      if (!livekitApiKey || !livekitApiSecret) {
        throw new Error('Missing LIVEKIT_API_KEY or LIVEKIT_API_SECRET');
      }

      // Resolve env vars once here, before touching K8s.
      // Decrypts the template (if any), merges manual overrides on top, and returns the final map.
      // KubernetesService receives only the merged plaintext — no business logic leaks into infrastructure.
      const { merged: resolvedEnvVars } = await this.envVarTemplatesService.resolveEnvVars(
        createAgentDto.envVarTemplateId,
        userId,
        createAgentDto.envVars,
      );

      // Create K8s pod - agent connects directly to LiveKit via SDK
      const { podName, secretName } = await this.k8s.createAgentPod({
        agentId,
        sessionId: session.id,
        projectId: session.projectId,
        agentName: sanitizedName,
        agentIcon: createAgentDto.icon || '🤖',
        agentType,
        roomName: session.room?.livekitRoomName || '',
        livekitUrl,
        livekitApiKey,
        livekitApiSecret,
        ttsProvider: this.configService.get<string>('TTS_PROVIDER', 'opensource'),
        agentConfig: sanitizedConfig,
        forceRebuild: createAgentDto.forceRebuild,
        resolvedEnvVars,
        resourceCpuLimit: agentTypeRecord?.resourceCpu || undefined,
        resourceMemoryLimit: agentTypeRecord?.resourceMemory || undefined,
      });

      // Update agent with pod info
      await this.prisma.agentInstance.update({
        where: { id: agentId },
        data: { podName, secretName },
      });

      this.logger.log(`Created K8s pod ${podName} for agent ${agentId}`);

      // Status will change to RUNNING when agent connects via gRPC
      // (detected via AgentServerService.handleRegisterAgent)

    } catch (error) {
      this.logger.error(`Failed to create pod for agent ${agentId}: ${error.message}`);

      await this.prisma.agentInstance.update({
        where: { id: agentId },
        data: {
          status: AgentStatus.FAILED,
          stoppedAt: new Date(),
          lastError: error.message,
        },
      });

      // Emit SSE event: agent.failed
      if (this.sessionsService) {
        this.sessionsService.emitAgentFailed(session.id, agentId, sanitizedName, error.message);
      }

      // Emit internal EventEmitter event for PublicProjectsService to catch
      // This allows event-based waiting instead of DB polling
      this.eventEmitter.emit(`agent.failed.${session.id}`, { error: error.message });
    }
  }

  /**
   * Enforce that env-var templates and pipeline configurations are scoped to the
   * target agent's type (and, for configurations, not outdated) BEFORE anything is
   * persisted. A mismatch throws BadRequestException (HTTP 400) and no pod is created.
   *
   * When an `agentConfigurationId` is supplied, the resolved (defaults-merged,
   * current-schema-valid) config replaces any client-supplied `pipeline_config`,
   * so the agent always receives a config it can reliably process.
   *
   * Mutates `agentConfig` in place (sets `pipeline_config`).
   */
  private async applyScopedConfiguration(
    createAgentDto: CreateAgentDto,
    userId: string,
    agentTypeRecord:
      | {
          id: string;
          version: string | null;
          compilerVersion: string | null;
          defaultConfig: Prisma.JsonValue | null;
          pipelineSchema: Prisma.JsonValue | null;
          configSchema: Prisma.JsonValue | null;
        }
      | null,
    agentConfig: Record<string, unknown>,
  ): Promise<void> {
    const { envVarTemplateId, agentConfigurationId } = createAgentDto;

    if (!envVarTemplateId && !agentConfigurationId) return;

    // Scoping requires a known AgentType row to compare against.
    if (!agentTypeRecord) {
      throw new BadRequestException(
        'Cannot apply a scoped env-var template or configuration: the target agent type is not registered',
      );
    }

    if (envVarTemplateId) {
      await this.envVarTemplatesService.assertCompatibleWithAgentType(
        envVarTemplateId,
        userId,
        agentTypeRecord.id,
      );
    }

    if (agentConfigurationId) {
      agentConfig.pipeline_config =
        await this.agentConfigurationsService.resolveForDeploy(
          agentConfigurationId,
          userId,
          agentTypeRecord.id,
          agentTypeRecord,
        );
    }
  }

  /**
   * Create an agent that runs as a standalone gRPC service.
   * The agent pod connects back to session-management via gRPC.
   * @param sessionId - The session ID
   * @param createAgentDto - Agent creation parameters
   * @param grpcAddress - The gRPC address where the agent will listen (e.g., "agent-pod:50051")
   */
  async createStandaloneAgent(sessionId: string, createAgentDto: CreateAgentDto, grpcAddress?: string) {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { room: true, project: true },
    });

    if (!session) {
      throw new NotFoundException(`Session with ID ${sessionId} not found`);
    }

    if (!session.room) {
      throw new Error('Session does not have an associated room');
    }

    // Determine agent type (default to stella-light-agent)
    const agentType = createAgentDto.agentType || 'stella-light-agent';
    // Encrypt manual env vars so standalone agents have the same restart behavior as regular agents.
    const manualEnvVarsEncrypted = this.encryptManualEnvVarsForStorage(createAgentDto.envVars);

    // Create agent record with gRPC address
    const agent = await this.prisma.agentInstance.create({
      data: {
        sessionId,
        name: createAgentDto.name,
        icon: createAgentDto.icon || '🤖',
        agentConfig: (createAgentDto.config || {}) as Prisma.InputJsonValue,
        agentType,  // Store agent type for restarts
        envVarTemplateId: createAgentDto.envVarTemplateId || null,  // Store for restarts
        // Keep encrypted manual env vars for restart path parity with template-based deployments.
        manualEnvVarsEncrypted,
        status: AgentStatus.STARTING,
        healthState: 'initializing',
        grpcAddress: grpcAddress || null,
      },
    });

    this.logger.log(`Created standalone agent ${agent.id} (type: ${agentType}) for session ${sessionId}`);

    // Register pending session with AgentServerService
    if (this.agentServerService) {
      const config: Record<string, string> = {
        sessionId: session.id,
        roomName: session.room.livekitRoomName,
        projectId: session.projectId,
        agentName: createAgentDto.name,
      };

      this.agentServerService.registerPendingSession(sessionId, agentType, config);
      this.logger.log(`Registered pending session ${sessionId} for standalone agent`);
    }

    // NOTE: In the new architecture, agents connect directly to LiveKit rooms via SDK
    // No need for session-management-server to join rooms

    return agent;
  }

  /**
   * Update the gRPC address for an agent (called when agent pod starts and reports its address).
   */
  async updateGrpcAddress(agentId: string, grpcAddress: string): Promise<void> {
    await this.prisma.agentInstance.update({
      where: { id: agentId },
      data: { grpcAddress },
    });
    this.logger.log(`Updated gRPC address for agent ${agentId}: ${grpcAddress}`);
  }

  async findOne(id: string) {
    const agent = await this.prisma.agentInstance.findUnique({
      where: { id },
      include: {
        session: {
          include: {
            room: true,
          },
        },
      },
    });

    if (!agent) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }

    // Get pod status if pod exists
    let podStatus = null;
    if (agent.podName) {
      podStatus = await this.k8s.getPodStatus(agent.podName);
    }

    return {
      ...agent,
      podStatus,
    };
  }

  async getLogs(id: string): Promise<string> {
    const agent = await this.prisma.agentInstance.findUnique({
      where: { id },
    });

    if (!agent) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }

    if (!agent.podName) {
      throw new BadRequestException('Agent pod not found');
    }

    return this.k8s.getPodLogs(agent.podName);
  }

  async streamLogs(id: string, callback: (chunk: string) => void, onError?: (error: Error) => void): Promise<() => void> {
    // Poll for agent to have a podName (pod creation is async)
    const maxWaitMs = 60000; // 60 seconds max wait
    const pollIntervalMs = 2000;
    const startTime = Date.now();

    let agent = await this.prisma.agentInstance.findUnique({
      where: { id },
    });

    if (!agent) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }

    // If no podName yet, wait for pod creation
    while (!agent.podName && (Date.now() - startTime) < maxWaitMs) {
      callback(`[Waiting for pod creation...]\n`);
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

      agent = await this.prisma.agentInstance.findUnique({
        where: { id },
      });

      if (!agent) {
        throw new NotFoundException(`Agent with ID ${id} not found`);
      }

      // Check if agent failed during pod creation
      if (agent.status === 'FAILED') {
        callback(`[Pod creation failed: ${agent.lastError || 'Unknown error'}]\n`);
        throw new BadRequestException(`Pod creation failed: ${agent.lastError || 'Unknown error'}`);
      }
    }

    if (!agent.podName) {
      callback(`[Timeout waiting for pod creation after ${maxWaitMs / 1000}s]\n`);
      throw new BadRequestException('Timeout waiting for pod creation');
    }

    callback(`[Connected to pod: ${agent.podName}]\n`);
    return await this.k8s.streamPodLogs(agent.podName, callback, onError);
  }

  // ============================================================================
  // Centralized Agent Lifecycle Management
  // All agent stop/delete operations should use these core functions
  // ============================================================================

  /**
   * Stop an agent - core logic used by remove(), session close, etc.
   * Handles room disconnection, K8s resource cleanup, and DB status update.
   * @returns The updated agent instance
   */
  async stopAgent(id: string): Promise<any> {
    const agent = await this.prisma.agentInstance.findUnique({
      where: { id },
    });

    if (!agent) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }

    // Update status to STOPPING
    await this.prisma.agentInstance.update({
      where: { id },
      data: {
        status: AgentStatus.STOPPING,
      },
    });

    // NOTE: In the new architecture, agents connect directly to LiveKit rooms via SDK
    // Agent pod deletion will automatically disconnect from LiveKit

    // Clean up K8s resources (pod, secret, configmap)
    // This is critical to prevent zombie containers from accumulating
    await this.cleanupK8sResources(agent);

    // Update final status to STOPPED
    const stoppedAgent = await this.prisma.agentInstance.update({
      where: { id },
      data: {
        status: AgentStatus.STOPPED,
        stoppedAt: new Date(),
        // Clear K8s resource names since they're deleted
        podName: null,
        secretName: null,
        configMapName: null,
      },
    });

    // Emit SSE event: agent.stopped - this disables audio processing in frontend
    if (this.sessionsService) {
      this.sessionsService.emitAgentStopped(agent.sessionId, id, agent.name);
    }

    this.logger.log(`Agent ${id} stopped successfully`);
    return stoppedAgent;
  }

  /**
   * Clean up Kubernetes resources for an agent.
   * Deletes pod, secret, and configmap if they exist.
   */
  private async cleanupK8sResources(agent: { id: string; podName: string | null; secretName: string | null; configMapName: string | null }): Promise<void> {
    const cleanupTasks: Promise<void>[] = [];

    if (agent.podName) {
      this.logger.log(`Deleting pod ${agent.podName} for agent ${agent.id}`);
      cleanupTasks.push(
        this.k8s.deletePod(agent.podName).catch(error => {
          this.logger.warn(`Failed to delete pod ${agent.podName}: ${error.message}`);
        })
      );
    }

    if (agent.secretName) {
      this.logger.log(`Deleting secret ${agent.secretName} for agent ${agent.id}`);
      cleanupTasks.push(
        this.k8s.deleteSecret(agent.secretName).catch(error => {
          this.logger.warn(`Failed to delete secret ${agent.secretName}: ${error.message}`);
        })
      );
    }

    if (agent.configMapName) {
      this.logger.log(`Deleting configmap ${agent.configMapName} for agent ${agent.id}`);
      cleanupTasks.push(
        this.k8s.deleteConfigMap(agent.configMapName).catch(error => {
          this.logger.warn(`Failed to delete configmap ${agent.configMapName}: ${error.message}`);
        })
      );
    }

    // Wait for all cleanup tasks to complete
    if (cleanupTasks.length > 0) {
      await Promise.all(cleanupTasks);
      this.logger.log(`K8s cleanup complete for agent ${agent.id}`);
    }
  }

  /**
   * Delete an agent - stops first if needed, then removes from DB.
   * Used by session deletion, manual cleanup, etc.
   */
  async deleteAgent(id: string): Promise<void> {
    const agent = await this.prisma.agentInstance.findUnique({
      where: { id },
    });

    if (!agent) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }

    // Stop if running (will handle K8s cleanup)
    if (agent.status === AgentStatus.RUNNING || agent.status === AgentStatus.STARTING) {
      await this.stopAgent(id);
    } else if (agent.status === AgentStatus.STOPPED || agent.status === AgentStatus.FAILED) {
      // For already stopped/failed agents, clean up K8s resources if they still exist
      // This catches any zombie containers that weren't cleaned up properly
      await this.cleanupK8sResources(agent);
    }

    // Delete from database
    await this.prisma.agentInstance.delete({
      where: { id },
    });

    this.logger.log(`Agent ${id} deleted from database`);
  }

  /**
   * Stop all agents for a session.
   * Used by session close and session delete.
   */
  async stopAllSessionAgents(sessionId: string): Promise<void> {
    this.logger.debug(`stopAllSessionAgents: querying agents for session ${sessionId}`);

    // Query ALL agents — not just running ones — so K8s resources are cleaned up
    // regardless of agent status. Agents in STOPPED/FAILED state may still have
    // orphaned K8s pods/secrets if their previous cleanup was incomplete.
    const agents = await this.prisma.agentInstance.findMany({
      where: { sessionId },
    });

    this.logger.debug(`stopAllSessionAgents: found ${agents.length} agents`);

    if (agents.length === 0) {
      this.logger.debug(`No agents to clean up for session ${sessionId}`);
      return;
    }

    const activeAgents = agents.filter(a =>
      a.status === AgentStatus.RUNNING || a.status === AgentStatus.STARTING
    );
    const inactiveAgents = agents.filter(a =>
      a.status !== AgentStatus.RUNNING && a.status !== AgentStatus.STARTING
    );

    this.logger.log(
      `Cleaning up ${agents.length} agents for session ${sessionId} ` +
      `(${activeAgents.length} active, ${inactiveAgents.length} inactive)`
    );

    // Stop active agents gracefully (with timeout)
    const STOP_TIMEOUT_MS = 30000; // 30 second timeout per agent

    const activeResults = await Promise.allSettled(
      activeAgents.map(async (agent) => {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout stopping agent ${agent.id}`)), STOP_TIMEOUT_MS)
        );

        try {
          return await Promise.race([
            this.stopAgent(agent.id),
            timeoutPromise,
          ]);
        } catch (error) {
          this.logger.error(`Error stopping agent ${agent.id}: ${error.message}`);
          // Force cleanup K8s resources even if stop failed
          await this.cleanupK8sResources(agent).catch(() => {});
          await this.prisma.agentInstance.update({
            where: { id: agent.id },
            data: { status: AgentStatus.STOPPED, stoppedAt: new Date() },
          }).catch(e => this.logger.error(`Failed to force-stop agent ${agent.id}: ${e.message}`));
          throw error;
        }
      })
    );

    // Clean up K8s resources for inactive agents (STOPPED/FAILED/STOPPING)
    // These may still have orphaned pods/secrets from incomplete cleanup
    const inactiveResults = await Promise.allSettled(
      inactiveAgents
        .filter(a => a.podName || a.secretName || a.configMapName)
        .map(async (agent) => {
          this.logger.log(`Cleaning up orphaned K8s resources for inactive agent ${agent.id} (status: ${agent.status})`);
          await this.cleanupK8sResources(agent);
        })
    );

    // Log any failures
    activeResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.error(`Failed to stop agent ${activeAgents[index].id}: ${result.reason}`);
      }
    });
    inactiveResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const agent = inactiveAgents.filter(a => a.podName || a.secretName || a.configMapName)[index];
        this.logger.error(`Failed to clean up inactive agent ${agent?.id}: ${result.reason}`);
      }
    });

    this.logger.log(`Finished cleaning up agents for session ${sessionId}`);
  }

  /**
   * Restart an agent - recreates pod/secret with same agent ID.
   * Used for config changes, troubleshooting, etc.
   * Unlike stopAgent(), this keeps the same agent ID and replaces it in-place.
   */
  async restartAgent(id: string): Promise<any> {
    const agent = await this.prisma.agentInstance.findUnique({
      where: { id },
      include: { session: { include: { room: true, project: true } } },
    });

    if (!agent) {
      throw new NotFoundException(`Agent with ID ${id} not found`);
    }

    if (!agent.session.room) {
      throw new Error('Session does not have an associated room');
    }

    this.logger.log(`Restarting agent ${id} (keeping same ID)`);

    // Delete Kubernetes resources (pod + secret) without updating DB status
    try {
      if (agent.podName) {
        await this.k8s.deletePod(agent.podName);
      }
      if (agent.secretName) {
        await this.k8s.deleteSecret(agent.secretName);
      }
    } catch (error) {
      this.logger.error(`K8s cleanup failed for agent ${id}: ${error.message}`);
    }

    // Update agent status to STARTING and clear old pod references
    // Clearing podName is critical: syncAgentStatus() would otherwise query K8s
    // for the deleted pod, get null back, and overwrite STARTING → STOPPED
    await this.prisma.agentInstance.update({
      where: { id },
      data: {
        status: AgentStatus.STARTING,
        stoppedAt: null,
        podName: null,
        secretName: null,
        configMapName: null,
      },
    });

    // Emit SSE event so frontend updates in real-time
    if (this.sessionsService) {
      this.sessionsService.emitAgentStarting(agent.sessionId, id, agent.name, agent.agentType || 'stella-light-agent');
    }

    // Get environment variables
    const livekitApiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    const livekitApiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');

    if (!livekitApiKey || !livekitApiSecret) {
      const missing: string[] = [];
      if (!livekitApiKey) missing.push('LIVEKIT_API_KEY');
      if (!livekitApiSecret) missing.push('LIVEKIT_API_SECRET');
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    const livekitUrl = this.configService.get<string>('LIVEKIT_URL', agent.session.room.serverUrl);

    this.logger.log(
      `🔗 Agent ${id} reconnecting to LiveKit room: "${agent.session.room.livekitRoomName}" at ${livekitUrl}`
    );

    // Get the user ID from the project membership (first owner/admin)
    const projectMembership = await this.prisma.projectMembership.findFirst({
      where: {
        projectId: agent.session.projectId,
        role: { in: ['OWNER', 'ADMIN'] },
      },
    });
    if (!projectMembership) {
      throw new NotFoundException(
        `No OWNER/ADMIN project membership found for project ${agent.session.projectId}`,
      );
    }

    // Register pending session so gRPC agent registration can match
    const agentType = agent.agentType || 'stella-light-agent';
    if (this.agentServerService) {
      const config: Record<string, string> = {
        sessionId: agent.sessionId,
        roomName: agent.session.room.livekitRoomName,
        projectId: agent.session.projectId,
      };
      this.agentServerService.registerPendingSession(agent.sessionId, agentType, config);
      this.logger.log(`Registered pending session ${agent.sessionId} for restarted agent type: ${agentType}`);
    }

    // Look up AgentType from DB for per-agent resource limits
    const agentTypeRecord = await this.prisma.agentType.findUnique({
      where: { slug: agentType },
      select: { resourceCpu: true, resourceMemory: true },
    });

    // Decrypt the stored manual vars so they can be re-merged through the same resolution
    // path as the original deploy — template vars decrypted + manual vars merged on top.
    const storedManualVars = agent.manualEnvVarsEncrypted
      ? this.encryptionService.decrypt(agent.manualEnvVarsEncrypted)
      : undefined;

    // Defence in depth: if both the persisted template and agent type are known,
    // re-assert their binding before re-resolving (legacy agents have a null
    // agentTypeId and are skipped — they were validated at original create time).
    if (agent.envVarTemplateId && agent.agentTypeId) {
      await this.envVarTemplatesService.assertCompatibleWithAgentType(
        agent.envVarTemplateId,
        projectMembership.userId,
        agent.agentTypeId,
      );
    }

    // Re-resolve env vars using the same code path as create() to guarantee the restarted pod
    // gets an identical secret to the original deployment.
    const { merged: resolvedEnvVars } = await this.envVarTemplatesService.resolveEnvVars(
      agent.envVarTemplateId ?? undefined,
      projectMembership.userId,
      storedManualVars,
    );

    // Recreate Kubernetes pod with SAME agent ID
    try {
      const { podName, secretName } = await this.k8s.createAgentPod({
        agentId: id, // SAME ID - pod/secret names are deterministic from agentId
        sessionId: agent.sessionId,
        projectId: agent.session.projectId,
        agentName: agent.name,
        agentIcon: agent.icon || '🤖',
        roomName: agent.session.room.livekitRoomName,
        livekitUrl,
        livekitApiKey,
        livekitApiSecret,
        ttsProvider: this.configService.get<string>('TTS_PROVIDER', 'opensource'),
        // Intentional asymmetry with env vars (re-resolved above): the persisted
        // agentConfig — including the pipeline_config injected at create() by
        // applyScopedConfiguration — is the deploy-time snapshot and is reused
        // verbatim on restart. A config later fixed from OUTDATED is NOT picked
        // up here; restart reproduces the original deployment, not the latest
        // configuration. Re-deploy the agent to adopt an updated config.
        agentConfig: (agent.agentConfig as Record<string, unknown>) || {},
        agentType,
        resolvedEnvVars,
        resourceCpuLimit: agentTypeRecord?.resourceCpu || undefined,
        resourceMemoryLimit: agentTypeRecord?.resourceMemory || undefined,
      });

      // Update agent with new pod info
      const updatedAgent = await this.prisma.agentInstance.update({
        where: { id },
        data: {
          podName,
          secretName,
        },
      });

      this.logger.log(`Agent ${id} restarted successfully with pod ${podName}`);
      return updatedAgent;
    } catch (error) {
      // Update agent status to FAILED
      await this.prisma.agentInstance.update({
        where: { id },
        data: {
          status: AgentStatus.FAILED,
          stoppedAt: new Date(),
        },
      });

      this.logger.error(`Failed to restart agent ${id}: ${error.message}`);
      throw new BadRequestException(`Failed to restart agent: ${error.message}`);
    }
  }

  // ============================================================================
  // Public API Endpoints (delegate to core functions)
  // ============================================================================

  async remove(id: string) {
    // Delegate to centralized stop logic
    await this.stopAgent(id);
    return { message: 'Agent stopped successfully' };
  }

  async delete(id: string) {
    // Delegate to centralized delete logic (handles stopping if needed)
    await this.deleteAgent(id);
    return { message: 'Agent deleted successfully' };
  }

  async restart(id: string) {
    // Delegate to centralized restart logic
    return await this.restartAgent(id);
  }

  // ============================================================================
  // Analytics / Metrics
  // ============================================================================

  /**
   * Unwrap the envelope nesting to get the full analytics data object.
   */
  private extractFullMetadata(metadata: any): Record<string, any> | null {
    return metadata?.envelope?.data ?? metadata?.data ?? metadata ?? null;
  }

  /**
   * Extract stage name and timing value from an analytics message's metadata.
   * Supports both old format (timing_ms) and new event format (elapsed_ms).
   */
  private extractStageTiming(metadata: any): { stage: string; timing_ms: number; isTimelineEvent: boolean } | null {
    const data = this.extractFullMetadata(metadata);
    const stage = data?.stage;
    const hasElapsed = typeof data?.elapsed_ms === 'number';
    const timingMs = hasElapsed ? data.elapsed_ms : data?.timing_ms;
    if (typeof stage === 'string' && typeof timingMs === 'number') {
      return { stage, timing_ms: timingMs, isTimelineEvent: hasElapsed };
    }
    return null;
  }

  /**
   * Compute per-stage latency statistics from a list of timing values.
   */
  private computeStageStats(stageTimings: Map<string, number[]>): StageLatencyDto[] {
    const stages: StageLatencyDto[] = [];

    for (const [stage, timings] of stageTimings) {
      const sorted = timings.slice().sort((a, b) => a - b);
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      const mean = sum / sorted.length;
      const variance = sorted.reduce((acc, v) => acc + (v - mean) ** 2, 0) / sorted.length;

      stages.push({
        stage,
        count: sorted.length,
        mean_ms: Math.round(mean * 100) / 100,
        p5_ms: percentile(sorted, 5),
        p25_ms: percentile(sorted, 25),
        p50_ms: percentile(sorted, 50),
        p75_ms: percentile(sorted, 75),
        p95_ms: percentile(sorted, 95),
        min_ms: sorted[0],
        max_ms: sorted[sorted.length - 1],
        stddev_ms: Math.round(Math.sqrt(variance) * 100) / 100,
      });
    }

    stages.sort((a, b) => a.stage.localeCompare(b.stage));
    return stages;
  }

  /**
   * Compute non-latency summary metrics from analytics messages.
   * Handles: safety_routing, state_transition, plan_completion, bridge_generation.
   */
  private computeMetricsSummary(
    messages: Array<{ sessionId: string; metadata: any }>,
  ): MetricsSummaryDto {
    const safetyMessages: Array<{ route: string }> = [];
    const transitionMessages: Array<{ wasExpected: boolean }> = [];
    const planMessages: Array<{ sessionId: string; completionRate: number; reachedEnd: boolean }> = [];
    const ttfabTimings: number[] = [];
    const bridgeDurationTimings: number[] = [];
    const ttfrTimings: number[] = [];
    // STT decode diagnostics — only present when the STT service runs with
    // STT_DECODE_DIAGNOSTICS on, so every field here stays optional.
    const decodeEvents: Array<{
      silenceFraction?: number;
      noSpeechWorst?: number;
      logprobWorst?: number;
      shadowIdentical?: boolean;
      shadowEarlierMs?: number;
      partialIdentical?: boolean;
    }> = [];

    for (const msg of messages) {
      const data = this.extractFullMetadata(msg.metadata);
      if (!data?.stage) continue;

      switch (data.stage) {
        case 'safety_routing':
          if (typeof data.route === 'string') {
            safetyMessages.push({ route: data.route });
          }
          break;
        // state_transition removed — not tracked for stella v2
        case 'plan_completion':
          if (typeof data.completion_rate === 'number') {
            planMessages.push({
              sessionId: msg.sessionId,
              completionRate: data.completion_rate,
              reachedEnd: data.plan_reached_end === true,
            });
          }
          break;
        // Old format (timing_ms)
        case 'ttfab_bridge':
        case 'ttfab_direct':
          if (typeof data.timing_ms === 'number' && data.timing_ms > 0) {
            ttfabTimings.push(data.timing_ms);
          }
          break;
        case 'bridge_duration':
          if (typeof data.timing_ms === 'number' && data.timing_ms > 0) {
            bridgeDurationTimings.push(data.timing_ms);
          }
          break;
        case 'ttfr':
          if (typeof data.timing_ms === 'number' && data.timing_ms > 0) {
            ttfrTimings.push(data.timing_ms);
          }
          break;
        // New format (elapsed_ms) — elapsed values are direct timeline positions
        case 'bridge_tts_first_byte':
          if (typeof data.elapsed_ms === 'number') {
            ttfabTimings.push(data.elapsed_ms);
          }
          break;
        case 'bridge_tts_done':
          if (typeof data.elapsed_ms === 'number') {
            bridgeDurationTimings.push(data.elapsed_ms);
          }
          break;
        case 'stt_decode':
          decodeEvents.push({
            silenceFraction: typeof data.silence_fraction === 'number' ? data.silence_fraction : undefined,
            noSpeechWorst: typeof data.no_speech_prob_worst === 'number' ? data.no_speech_prob_worst : undefined,
            logprobWorst: typeof data.avg_logprob_worst === 'number' ? data.avg_logprob_worst : undefined,
            shadowIdentical: typeof data.shadow_identical === 'boolean' ? data.shadow_identical : undefined,
            shadowEarlierMs:
              typeof data.shadow_available_earlier_ms === 'number' ? data.shadow_available_earlier_ms : undefined,
            partialIdentical: typeof data.partial_identical === 'boolean' ? data.partial_identical : undefined,
          });
          break;
        case 'response_tts_first_byte':
          if (typeof data.elapsed_ms === 'number') {
            ttfrTimings.push(data.elapsed_ms);
          }
          break;
      }
    }

    return {
      safetyRouting: safetyMessages.length > 0 ? {
        totalTurns: safetyMessages.length,
        safeTurns: safetyMessages.filter((m) => m.route === 'SAFE').length,
        unsafeTurns: safetyMessages.filter((m) => m.route !== 'SAFE').length,
        interceptionRate: Math.round(
          (safetyMessages.filter((m) => m.route !== 'SAFE').length / safetyMessages.length) * 10000,
        ) / 10000,
      } : null,

      stateTransitions: transitionMessages.length > 0 ? {
        totalTransitions: transitionMessages.length,
        expectedTransitions: transitionMessages.filter((m) => m.wasExpected).length,
        accuracy: Math.round(
          (transitionMessages.filter((m) => m.wasExpected).length / transitionMessages.length) * 10000,
        ) / 10000,
      } : null,

      planCompletion: planMessages.length > 0 ? (() => {
        // Deduplicate by session (take last per session)
        const bySession = new Map<string, typeof planMessages[0]>();
        for (const m of planMessages) bySession.set(m.sessionId, m);
        const unique = Array.from(bySession.values());
        const avgRate = unique.reduce((s, m) => s + m.completionRate, 0) / unique.length;
        return {
          totalSessions: unique.length,
          completedPlans: unique.filter((m) => m.reachedEnd).length,
          avgCompletionRate: Math.round(avgRate * 10000) / 10000,
        };
      })() : null,

      bridgeGeneration: ttfabTimings.length > 0 ? {
        totalBridges: ttfabTimings.length,
        avgBridgeDuration_ms: Math.round(
          (ttfabTimings.reduce((s, v) => s + v, 0) / ttfabTimings.length) * 100,
        ) / 100,
      } : null,

      bridgeDuration: bridgeDurationTimings.length > 0 ? {
        count: bridgeDurationTimings.length,
        avg_ms: Math.round(
          (bridgeDurationTimings.reduce((s, v) => s + v, 0) / bridgeDurationTimings.length) * 100,
        ) / 100,
      } : null,

      ttfr: ttfrTimings.length > 0 ? {
        count: ttfrTimings.length,
        avg_ms: Math.round(
          (ttfrTimings.reduce((s, v) => s + v, 0) / ttfrTimings.length) * 100,
        ) / 100,
      } : null,

      sttDecode: decodeEvents.length > 0 ? (() => {
        const mean = (values: number[]) =>
          values.length > 0 ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10000) / 10000 : null;
        const defined = <T>(values: Array<T | undefined>): T[] =>
          values.filter((v): v is T => v !== undefined);

        const shadow = defined(decodeEvents.map((e) => e.shadowIdentical));
        const partial = defined(decodeEvents.map((e) => e.partialIdentical));
        const earlier = defined(decodeEvents.map((e) => e.shadowEarlierMs));

        return {
          totalTurns: decodeEvents.length,
          avgSilenceFraction: mean(defined(decodeEvents.map((e) => e.silenceFraction))),
          // Worst-case per turn, averaged: a turn is suspicious if ANY segment
          // scored badly, so averaging the per-turn worst is the right rollup.
          avgNoSpeechWorst: mean(defined(decodeEvents.map((e) => e.noSpeechWorst))),
          avgLogprobWorst: mean(defined(decodeEvents.map((e) => e.logprobWorst))),
          // The decision number: how often the decode available a continuation
          // window earlier already matched what we shipped.
          shadowTurns: shadow.length,
          shadowAgreementRate:
            shadow.length > 0 ? Math.round((shadow.filter(Boolean).length / shadow.length) * 10000) / 10000 : null,
          avgShadowEarlier_ms: mean(earlier),
          partialTurns: partial.length,
          partialAgreementRate:
            partial.length > 0 ? Math.round((partial.filter(Boolean).length / partial.length) * 10000) / 10000 : null,
        };
      })() : null,
    };
  }

  /**
   * Get aggregated per-stage latency metrics for an agent type within a project.
   * Includes outlier session detection (sessions where any stage mean > 2x global p50).
   */
  async getAgentMetrics(
    projectId: string,
    agentSlug: string,
    from: Date,
    to: Date,
  ): Promise<AgentMetricsResponseDto> {
    // 1. Look up AgentType by slug
    const agentType = await this.prisma.agentType.findUnique({
      where: { slug: agentSlug },
    });

    if (!agentType) {
      throw new NotFoundException(`Agent type '${agentSlug}' not found`);
    }

    // 2. Find sessions that used this agent type within the date range
    const agentInstances = await this.prisma.agentInstance.findMany({
      where: {
        session: { projectId },
        OR: [
          { agentTypeId: agentType.id },
          { agentType: agentSlug },
        ],
        createdAt: { gte: from, lte: to },
      },
      select: { sessionId: true },
      distinct: ['sessionId'],
    });

    const sessionIds = agentInstances.map((a) => a.sessionId);

    if (sessionIds.length === 0) {
      return {
        agentSlug,
        projectId,
        dateRange: { from: from.toISOString(), to: to.toISOString() },
        totalSessions: 0,
        totalTurns: 0,
        stages: [],
        outlierSessions: [],
        summary: {
          planCompletion: null,
          safetyRouting: null,
          stateTransitions: null,
          bridgeGeneration: null,
          bridgeDuration: null,
          ttfr: null,
          sttDecode: null,
        },
      };
    }

    // 3. Query analytics messages for those sessions
    const analyticsMessages = await this.prisma.message.findMany({
      where: {
        sessionId: { in: sessionIds },
        messageType: 'analytics',
        timestamp: { gte: from, lte: to },
      },
      select: { sessionId: true, metadata: true },
      orderBy: { timestamp: 'asc' },
    });

    // 4. Count user turns for context
    const totalTurns = await this.prisma.message.count({
      where: {
        sessionId: { in: sessionIds },
        messageType: { in: ['transcript', 'user_text'] },
        role: 'user',
        timestamp: { gte: from, lte: to },
      },
    });

    // 5. Extract stage timings — global and per-session
    const globalTimings = new Map<string, number[]>();
    const perSessionTimings = new Map<string, Map<string, number[]>>();

    for (const msg of analyticsMessages) {
      const parsed = this.extractStageTiming(msg.metadata as any);
      if (!parsed) continue;

      // Skip non-timeline events (old format with timing_ms=0, e.g. safety_routing)
      // Timeline events with elapsed_ms=0 (stt_end) are valid and should pass through
      if (parsed.timing_ms === 0 && !parsed.isTimelineEvent) continue;

      // Skip anchor events — these are reference points, not pipeline stages
      if (parsed.stage === 'vad_trigger' || parsed.stage === 'stt_end') continue;

      // Global
      if (!globalTimings.has(parsed.stage)) {
        globalTimings.set(parsed.stage, []);
      }
      globalTimings.get(parsed.stage)!.push(parsed.timing_ms);

      // Per-session
      if (!perSessionTimings.has(msg.sessionId)) {
        perSessionTimings.set(msg.sessionId, new Map());
      }
      const sessionMap = perSessionTimings.get(msg.sessionId)!;
      if (!sessionMap.has(parsed.stage)) {
        sessionMap.set(parsed.stage, []);
      }
      sessionMap.get(parsed.stage)!.push(parsed.timing_ms);
    }

    // 6. Compute global stage statistics
    const stages = this.computeStageStats(globalTimings);

    // 7. Build p50 lookup for outlier detection
    const globalP50 = new Map<string, number>();
    for (const s of stages) {
      globalP50.set(s.stage, s.p50_ms);
    }

    // 8. Detect outlier sessions (any stage mean > 2x global p50)
    const outlierSessionIds: string[] = [];
    const outlierData = new Map<string, OutlierStageDto[]>();

    for (const [sessId, stageMap] of perSessionTimings) {
      const outlierStages: OutlierStageDto[] = [];

      for (const [stage, timings] of stageMap) {
        const p50 = globalP50.get(stage);
        if (p50 === undefined || p50 === 0) continue;

        const mean = timings.reduce((a, b) => a + b, 0) / timings.length;
        if (mean > 2 * p50) {
          outlierStages.push({
            stage,
            sessionMean_ms: Math.round(mean * 100) / 100,
            globalP50_ms: p50,
          });
        }
      }

      if (outlierStages.length > 0) {
        outlierSessionIds.push(sessId);
        outlierData.set(sessId, outlierStages);
      }
    }

    // 9. Fetch session names for outliers (single query)
    let outlierSessions: OutlierSessionDto[] = [];
    if (outlierSessionIds.length > 0) {
      const sessions = await this.prisma.session.findMany({
        where: { id: { in: outlierSessionIds } },
        select: { id: true, name: true, createdAt: true },
      });

      outlierSessions = sessions.map((s) => ({
        sessionId: s.id,
        sessionName: s.name || s.id,
        createdAt: s.createdAt.toISOString(),
        outlierStages: outlierData.get(s.id) || [],
      }));
    }

    return {
      agentSlug,
      projectId,
      dateRange: { from: from.toISOString(), to: to.toISOString() },
      totalSessions: sessionIds.length,
      totalTurns,
      stages,
      outlierSessions,
      summary: this.computeMetricsSummary(analyticsMessages),
    };
  }

  /**
   * Get per-stage latency analytics for a single session.
   */
  async getSessionAnalytics(sessionId: string, projectId?: string): Promise<SessionAnalyticsResponseDto> {
    if (projectId) {
      const session = await this.prisma.session.findFirst({
        where: { id: sessionId, projectId },
        select: { id: true },
      });
      if (!session) {
        throw new NotFoundException(`Session '${sessionId}' not found in project`);
      }
    }

    const analyticsMessages = await this.prisma.message.findMany({
      where: { sessionId, messageType: 'analytics' },
      select: { sessionId: true, metadata: true, timestamp: true },
    });

    const totalTurns = await this.prisma.message.count({
      where: {
        sessionId,
        messageType: { in: ['transcript', 'user_text'] },
        role: 'user',
      },
    });

    const stageTimings = new Map<string, number[]>();
    const rawPoints: SessionStagePointDto[] = [];

    for (const msg of analyticsMessages) {
      const parsed = this.extractStageTiming(msg.metadata as any);
      if (!parsed || (parsed.timing_ms === 0 && !parsed.isTimelineEvent)) continue;
      if (!stageTimings.has(parsed.stage)) {
        stageTimings.set(parsed.stage, []);
      }
      stageTimings.get(parsed.stage)!.push(parsed.timing_ms);
      rawPoints.push({
        stage: parsed.stage,
        timing_ms: parsed.timing_ms,
        timestamp: msg.timestamp.toISOString(),
      });
    }

    return {
      sessionId,
      totalTurns,
      stages: this.computeStageStats(stageTimings),
      summary: this.computeMetricsSummary(analyticsMessages),
      rawPoints,
    };
  }

  /**
   * Get raw TTFAB data points over time for a live timeline chart.
   * Returns individual measurements with timestamps, ordered chronologically.
   */
  async getMetricsTimeline(
    projectId: string,
    agentSlug: string,
    since: Date,
    stage: string = 'ttfab',
  ): Promise<{ points: Array<{ timestamp: string; timing_ms: number; sessionId: string }> }> {
    // 1. Find sessions for this agent type
    const agentType = await this.prisma.agentType.findUnique({
      where: { slug: agentSlug },
    });

    if (!agentType) {
      return { points: [] };
    }

    const agentInstances = await this.prisma.agentInstance.findMany({
      where: {
        session: { projectId },
        OR: [
          { agentTypeId: agentType.id },
          { agentType: agentSlug },
        ],
      },
      select: { sessionId: true },
      distinct: ['sessionId'],
    });

    const sessionIds = agentInstances.map((a) => a.sessionId);
    if (sessionIds.length === 0) {
      return { points: [] };
    }

    // 2. Query raw analytics messages for the target stage since the given time
    const messages = await this.prisma.message.findMany({
      where: {
        sessionId: { in: sessionIds },
        messageType: 'analytics',
        timestamp: { gte: since },
      },
      select: { sessionId: true, metadata: true, timestamp: true },
      orderBy: { timestamp: 'asc' },
    });

    // 3. Filter to the requested stage and extract timing
    const points: Array<{ timestamp: string; timing_ms: number; sessionId: string }> = [];
    for (const msg of messages) {
      const parsed = this.extractStageTiming(msg.metadata as any);
      if (parsed && parsed.stage === stage) {
        points.push({
          timestamp: msg.timestamp.toISOString(),
          timing_ms: parsed.timing_ms,
          sessionId: msg.sessionId,
        });
      }
    }

    return { points };
  }

  /**
   * Get per-session average timing for a specific stage.
   * Returns one data point per session (avg of all measurements in that session).
   */
  async getStageDataPoints(
    projectId: string,
    agentSlug: string,
    stageName: string,
    from: Date,
    to: Date,
  ): Promise<{ points: StageDataPointDto[] }> {
    const agentType = await this.prisma.agentType.findUnique({
      where: { slug: agentSlug },
    });

    if (!agentType) {
      return { points: [] };
    }

    const agentInstances = await this.prisma.agentInstance.findMany({
      where: {
        session: { projectId },
        OR: [
          { agentTypeId: agentType.id },
          { agentType: agentSlug },
        ],
        createdAt: { gte: from, lte: to },
      },
      select: { sessionId: true },
      distinct: ['sessionId'],
    });

    const sessionIds = agentInstances.map((a) => a.sessionId);
    if (sessionIds.length === 0) {
      return { points: [] };
    }

    const messages = await this.prisma.message.findMany({
      where: {
        sessionId: { in: sessionIds },
        messageType: 'analytics',
        timestamp: { gte: from, lte: to },
      },
      select: { sessionId: true, metadata: true, timestamp: true },
      orderBy: { timestamp: 'asc' },
    });

    // Group by session, compute per-session average
    const sessionData = new Map<string, { timings: number[]; lastTimestamp: Date }>();

    for (const msg of messages) {
      const parsed = this.extractStageTiming(msg.metadata as any);
      if (!parsed || parsed.stage !== stageName || (parsed.timing_ms === 0 && !parsed.isTimelineEvent)) continue;

      if (!sessionData.has(msg.sessionId)) {
        sessionData.set(msg.sessionId, { timings: [], lastTimestamp: msg.timestamp });
      }
      const entry = sessionData.get(msg.sessionId)!;
      entry.timings.push(parsed.timing_ms);
      entry.lastTimestamp = msg.timestamp;
    }

    // Fetch session names for all sessions that have data
    const sessionIdsWithData = Array.from(sessionData.keys());
    const sessions = sessionIdsWithData.length > 0
      ? await this.prisma.session.findMany({
          where: { id: { in: sessionIdsWithData } },
          select: { id: true, name: true },
        })
      : [];
    const sessionNames = new Map(sessions.map(s => [s.id, s.name || s.id]));

    const points: StageDataPointDto[] = [];
    for (const [sessionId, { timings, lastTimestamp }] of sessionData) {
      const avg = timings.reduce((s, v) => s + v, 0) / timings.length;
      points.push({
        sessionId,
        sessionName: sessionNames.get(sessionId) || sessionId,
        avg_timing_ms: Math.round(avg * 100) / 100,
        count: timings.length,
        timestamp: lastTimestamp.toISOString(),
      });
    }

    return { points };
  }

  /**
   * Get per-session plan completion data for drill-down.
   * Returns one row per session with final completion rate and whether the plan reached end.
   */
  async getPlanCompletionSessions(
    projectId: string,
    agentSlug: string,
    from: Date,
    to: Date,
  ): Promise<{ sessions: PlanCompletionSessionDto[] }> {
    const agentType = await this.prisma.agentType.findUnique({
      where: { slug: agentSlug },
    });

    if (!agentType) {
      return { sessions: [] };
    }

    const agentInstances = await this.prisma.agentInstance.findMany({
      where: {
        session: { projectId },
        OR: [
          { agentTypeId: agentType.id },
          { agentType: agentSlug },
        ],
        createdAt: { gte: from, lte: to },
      },
      select: { sessionId: true },
      distinct: ['sessionId'],
    });

    const sessionIds = agentInstances.map((a) => a.sessionId);
    if (sessionIds.length === 0) {
      return { sessions: [] };
    }

    const messages = await this.prisma.message.findMany({
      where: {
        sessionId: { in: sessionIds },
        messageType: 'analytics',
        timestamp: { gte: from, lte: to },
      },
      select: { sessionId: true, metadata: true, timestamp: true },
      orderBy: { timestamp: 'asc' },
    });

    // Deduplicate by session (take last plan_completion message per session)
    const bySession = new Map<string, { completionRate: number; reachedEnd: boolean; timestamp: Date }>();

    for (const msg of messages) {
      const data = this.extractFullMetadata(msg.metadata);
      if (!data || data.stage !== 'plan_completion' || typeof data.completion_rate !== 'number') continue;

      bySession.set(msg.sessionId, {
        completionRate: data.completion_rate,
        reachedEnd: data.plan_reached_end === true,
        timestamp: msg.timestamp,
      });
    }

    // Fetch session names
    const sessionIdsWithData = Array.from(bySession.keys());
    const sessions = sessionIdsWithData.length > 0
      ? await this.prisma.session.findMany({
          where: { id: { in: sessionIdsWithData } },
          select: { id: true, name: true },
        })
      : [];
    const sessionNames = new Map(sessions.map(s => [s.id, s.name || s.id]));

    const result: PlanCompletionSessionDto[] = [];
    for (const [sessionId, { completionRate, reachedEnd, timestamp }] of bySession) {
      result.push({
        sessionId,
        sessionName: sessionNames.get(sessionId) || sessionId,
        completionRate: Math.round(completionRate * 10000) / 10000,
        reachedEnd,
        timestamp: timestamp.toISOString(),
      });
    }

    // Sort by completion rate ascending (lowest first for easy outlier spotting)
    result.sort((a, b) => a.completionRate - b.completionRate);

    return { sessions: result };
  }
}

/**
 * Linear interpolation percentile on a pre-sorted array.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return Math.round((sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)) * 100) / 100;
}
