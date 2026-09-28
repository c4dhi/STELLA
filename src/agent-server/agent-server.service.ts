import { Injectable, Logger, OnModuleDestroy, Inject, forwardRef, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as grpc from '@grpc/grpc-js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { AgentSessionStream } from './agent-session-stream.js';
import {
  AgentInput,
  AgentOutput,
  AgentHealthStatus,
  InputType,
  OutputType,
  RegisterAgentRequest,
  RegisterAgentResponse,
} from './agent.types.js';

/**
 * AgentServerService - Core gRPC server for agent connections.
 *
 * NOTE: In the new architecture, agents connect directly to LiveKit rooms
 * and communicate with STT/TTS services via gRPC. This service is simplified to:
 * - Handle agent registration (assigns agents to sessions)
 * - Manage bidirectional streams per session (for health checks)
 * - Track agent connection state
 *
 * The actual audio/text flow is now handled by the Agent SDK.
 */
@Injectable()
export class AgentServerService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentServerService.name);
  private sessions: Map<string, AgentSessionStream> = new Map();
  private pendingRegistrations: Map<string, {
    resolve: (sessionId: string, config: Record<string, string>) => void;
    agentType: string;
    config: Record<string, string>;
    createdAt: Date;
  }> = new Map();

  // Typed `any` on the constructor parameter (assigned to the field above) so
  // TS's emitDecoratorMetadata doesn't reference the still-circularly-importing
  // class eagerly in design:paramtypes, which throws a TDZ ReferenceError under
  // ESM depending on module evaluation order. forwardRef already handles the
  // actual lazy DI resolution.
  private sessionsService?: SessionsService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    @Optional() @Inject(forwardRef(() => SessionsService)) sessionsService?: any,
  ) {
    this.sessionsService = sessionsService;
  }

  /**
   * Register a pending session that needs an agent.
   * Called when AgentsService starts an agent pod/process.
   * Returns immediately - does not wait for agent to connect.
   */
  registerPendingSession(
    sessionId: string,
    agentType: string,
    config: Record<string, string>,
  ): void {
    this.logger.log(`Registering pending session ${sessionId} for agent type: ${agentType}`);

    this.pendingRegistrations.set(sessionId, {
      resolve: () => {}, // No-op - we don't need to wait for registration
      agentType,
      config,
      createdAt: new Date(),
    });
  }

  /**
   * Handle agent registration request (gRPC: RegisterAgent).
   * Called when an agent connects and wants to join a session.
   * Updates agent status to RUNNING and sends "Agent joined" message via LiveKit.
   */
  async handleRegisterAgent(
    request: RegisterAgentRequest,
  ): Promise<RegisterAgentResponse> {
    this.logger.log(`Agent registration request: ${request.agentType} v${request.agentVersion}`);

    // Find a pending session that matches this agent type
    let matchedSessionId: string | null = null;
    let matchedConfig: Record<string, string> = {};
    let agentName: string = 'Agent';
    let agentId: string | undefined;

    for (const [sessionId, pending] of this.pendingRegistrations) {
      if (pending.agentType === request.agentType) {
        matchedSessionId = sessionId;
        matchedConfig = pending.config;
        agentName = pending.config.agentName || 'Agent';
        agentId = pending.config.agentId;

        // Remove from pending
        this.pendingRegistrations.delete(sessionId);
        pending.resolve(sessionId, matchedConfig);
        break;
      }
    }

    if (!matchedSessionId) {
      this.logger.warn(`No pending session for agent type: ${request.agentType}`);
      return {
        success: false,
        message: `No pending session for agent type: ${request.agentType}`,
      };
    }

    // Update agent instance in database to RUNNING
    const updateResult = await this.prisma.agentInstance.updateMany({
      where: { sessionId: matchedSessionId, status: 'STARTING' },
      data: {
        status: 'RUNNING',
        healthState: 'ready',
        lastHealthCheck: new Date(),
      },
    });

    this.logger.log(`Agent registered for session ${matchedSessionId} - updated ${updateResult.count} agent(s) to RUNNING`);

    // Emit SSE event: agent.ready
    if (this.sessionsService && agentId) {
      this.sessionsService.emitAgentReady(matchedSessionId, agentId, agentName, request.agentType);
    }

    // Emit internal EventEmitter event for PublicProjectsService to catch
    // This allows event-based waiting instead of DB polling
    this.eventEmitter.emit(`agent.ready.${matchedSessionId}`, { agentId });

    // NOTE: In the new architecture, agents publish their own "joined" message
    // via LiveKit when they connect directly to the room

    return {
      success: true,
      sessionId: matchedSessionId,
      config: matchedConfig,
    };
  }

  /**
   * Handle bidirectional agent stream (gRPC: AgentStream).
   * Server sends AgentInputProto, agent sends AgentOutputProto.
   */
  handleAgentStream(
    call: grpc.ServerDuplexStream<any, any>,
  ): void {
    let sessionStream: AgentSessionStream | null = null;

    // Handle outputs from agent
    call.on('data', async (output: any) => {
      try {
        const sessionId = output.session_id;

        // First message establishes the session
        if (!sessionStream && sessionId) {
          sessionStream = new AgentSessionStream(sessionId, call);
          this.sessions.set(sessionId, sessionStream);

          this.logger.log(`Agent stream established for session: ${sessionId}`);

          // Emit connection event
          this.eventEmitter.emit(`agent.connected.${sessionId}`, sessionStream);
        }

        if (sessionStream) {
          sessionStream.handleOutput(output);
          await this.handleAgentOutput(sessionStream.sessionId, output);
        }
      } catch (error) {
        this.logger.error(`Error handling agent output: ${error.message}`);
      }
    });

    call.on('end', () => {
      if (sessionStream) {
        this.logger.log(`Agent stream ended for session: ${sessionStream.sessionId}`);
        this.sessions.delete(sessionStream.sessionId);
        this.eventEmitter.emit(`agent.disconnected.${sessionStream.sessionId}`);
      }
      call.end();
    });

    call.on('error', (err: Error) => {
      this.logger.error(`Agent stream error: ${err.message}`);
      if (sessionStream) {
        this.sessions.delete(sessionStream.sessionId);
        this.eventEmitter.emit(`agent.disconnected.${sessionStream.sessionId}`);
      }
    });
  }

  /**
   * Handle output from agent - emit events for orchestrator.
   */
  private async handleAgentOutput(sessionId: string, output: any): Promise<void> {
    const outputType = output.type;

    // Skip health status outputs (handled by AgentSessionStream)
    if (outputType === OutputType.HEALTH_STATUS) {
      return;
    }

    // Re-emit as an agent.output.<sessionId> event for any in-process listeners.
    this.eventEmitter.emit(`agent.output.${sessionId}`, {
      sessionId,
      type: outputType,
      content: output.content,
      isFinal: output.is_final,
      transcriptId: output.transcript_id,
      statusSubtype: output.status_subtype,
      metadataSubtype: output.metadata_subtype,
      metadata: output.metadata,
      timestampMs: Number(output.timestamp_ms || Date.now()),
    });
  }

  /**
   * Send interrupt signal to agent (gRPC: SendInterrupt).
   */
  async sendInterrupt(sessionId: string, reason: string): Promise<{ success: boolean; wasProcessing: boolean }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, wasProcessing: false };
    }

    session.sendInterrupt(reason);
    this.logger.log(`Sent interrupt to agent for session ${sessionId}: ${reason}`);

    return { success: true, wasProcessing: true }; // TODO: Track actual processing state
  }

  /**
   * Send session start signal to agent.
   */
  async sendSessionStart(sessionId: string, config: Record<string, string>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No agent connected for session ${sessionId}`);
    }

    session.sendSessionStart(config);
    this.logger.log(`Sent session start to agent for session ${sessionId}`);
  }

  /**
   * Send session end signal to agent.
   */
  async sendSessionEnd(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.logger.warn(`No agent connected for session ${sessionId}, skipping session end`);
      return;
    }

    session.sendSessionEnd();
    this.logger.log(`Sent session end to agent for session ${sessionId}`);
  }

  /**
   * Request health check from agent.
   */
  async requestHealthCheck(sessionId: string): Promise<AgentHealthStatus> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No agent connected for session ${sessionId}`);
    }

    return session.requestHealthCheck();
  }

  /**
   * Check if agent is connected for a session.
   */
  isAgentConnected(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.connected ?? false;
  }

  /**
   * Get connected session IDs.
   */
  getConnectedSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Subscribe to agent outputs for a session.
   */
  onAgentOutput(sessionId: string, listener: (output: AgentOutput) => void): () => void {
    const session = this.sessions.get(sessionId);
    if (session) {
      return session.onOutput(listener);
    }

    // If session not yet connected, wait for it
    const handler = (stream: AgentSessionStream) => {
      stream.onOutput(listener);
    };
    this.eventEmitter.once(`agent.connected.${sessionId}`, handler);

    return () => {
      this.eventEmitter.removeListener(`agent.connected.${sessionId}`, handler);
    };
  }

  /**
   * Cleanup on module destroy.
   */
  onModuleDestroy(): void {
    // End all active sessions
    for (const [sessionId, session] of this.sessions) {
      this.logger.log(`Ending session ${sessionId} on module destroy`);
      session.end();
    }
    this.sessions.clear();
    this.pendingRegistrations.clear();
  }
}
