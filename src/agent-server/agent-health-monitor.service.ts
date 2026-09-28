import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentServerService } from './agent-server.service.js';
import { AgentHealthStatus, AgentState } from './agent.types.js';

/**
 * AgentHealthMonitorService - User-presence-aware health monitoring.
 *
 * This service performs health checks on agents ONLY when a user is
 * actively connected to the same session. This reduces unnecessary
 * polling and load on agents.
 *
 * Health checks are performed every 5 seconds while a user is present.
 * When all users leave, health monitoring stops.
 */
@Injectable()
export class AgentHealthMonitorService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentHealthMonitorService.name);
  private readonly healthCheckInterval = 5000; // 5 seconds
  private activeMonitors: Map<string, NodeJS.Timeout> = new Map();
  private consecutiveFailures: Map<string, number> = new Map();
  private readonly maxConsecutiveFailures = 3;

  constructor(
    private readonly agentServer: AgentServerService,
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Start health monitoring for a session.
   * Called when a user joins a LiveKit room.
   */
  startMonitoring(sessionId: string): void {
    if (this.activeMonitors.has(sessionId)) {
      this.logger.debug(`Health monitoring already active for session ${sessionId}`);
      return;
    }

    this.logger.log(`Starting health monitoring for session ${sessionId}`);
    this.consecutiveFailures.set(sessionId, 0);

    const interval = setInterval(async () => {
      await this.performHealthCheck(sessionId);
    }, this.healthCheckInterval);

    this.activeMonitors.set(sessionId, interval);

    // Perform immediate health check
    this.performHealthCheck(sessionId);
  }

  /**
   * Stop health monitoring for a session.
   * Called when all users leave a LiveKit room.
   */
  stopMonitoring(sessionId: string): void {
    const interval = this.activeMonitors.get(sessionId);
    if (interval) {
      this.logger.log(`Stopping health monitoring for session ${sessionId}`);
      clearInterval(interval);
      this.activeMonitors.delete(sessionId);
      this.consecutiveFailures.delete(sessionId);
    }
  }

  /**
   * Perform a single health check for a session.
   */
  private async performHealthCheck(sessionId: string): Promise<void> {
    try {
      // Check if agent is connected
      if (!this.agentServer.isAgentConnected(sessionId)) {
        this.logger.debug(`Agent not connected for session ${sessionId}, skipping health check`);
        return;
      }

      const health = await this.agentServer.requestHealthCheck(sessionId);
      this.consecutiveFailures.set(sessionId, 0);

      // Update agent instance in database
      await this.updateAgentHealth(sessionId, health);

      // Emit health status event
      this.eventEmitter.emit('agent.health.updated', {
        sessionId,
        health,
      });

      // Log warnings for error states
      if (health.state === AgentState.ERROR) {
        this.logger.warn(`Agent in ERROR state for session ${sessionId}: ${health.lastError}`);
      }
    } catch (error) {
      const failures = (this.consecutiveFailures.get(sessionId) || 0) + 1;
      this.consecutiveFailures.set(sessionId, failures);

      this.logger.error(`Health check failed for session ${sessionId}: ${error.message}`);

      // Handle consecutive failures
      if (failures >= this.maxConsecutiveFailures) {
        await this.handleHealthCheckFailure(sessionId, error);
      }
    }
  }

  /**
   * Update agent health status in database.
   */
  private async updateAgentHealth(
    sessionId: string,
    health: AgentHealthStatus,
  ): Promise<void> {
    try {
      await this.prisma.agentInstance.updateMany({
        where: {
          sessionId,
          status: 'RUNNING',
        },
        data: {
          healthState: health.state,
          lastHealthCheck: new Date(),
          lastError: health.lastError || null,
          messagesProcessed: health.messagesProcessed,
        },
      });
    } catch (error) {
      this.logger.error(`Failed to update agent health in database: ${error.message}`);
    }
  }

  /**
   * Handle repeated health check failures.
   */
  private async handleHealthCheckFailure(
    sessionId: string,
    error: Error,
  ): Promise<void> {
    this.logger.error(`Agent health check failed ${this.maxConsecutiveFailures} times for session ${sessionId}`);

    // Update agent status to FAILED
    try {
      await this.prisma.agentInstance.updateMany({
        where: {
          sessionId,
          status: 'RUNNING',
        },
        data: {
          healthState: 'error',
          lastError: `Health check failed: ${error.message}`,
          lastHealthCheck: new Date(),
        },
      });
    } catch (dbError) {
      this.logger.error(`Failed to update agent status: ${dbError.message}`);
    }

    // Emit failure event
    this.eventEmitter.emit('agent.health.failed', {
      sessionId,
      error: error.message,
      consecutiveFailures: this.maxConsecutiveFailures,
    });

    // Stop monitoring this session
    this.stopMonitoring(sessionId);
  }

  /**
   * Get current health status for a session (from cache/database).
   */
  async getHealth(sessionId: string): Promise<AgentHealthStatus | null> {
    if (this.agentServer.isAgentConnected(sessionId)) {
      try {
        return await this.agentServer.requestHealthCheck(sessionId);
      } catch {
        // Fall through to database lookup
      }
    }

    // Get from database
    const agent = await this.prisma.agentInstance.findFirst({
      where: {
        sessionId,
        status: { in: ['RUNNING', 'STARTING'] },
      },
    });

    if (!agent) {
      return null;
    }

    return {
      requestId: '',
      state: this.parseAgentState(agent.healthState),
      sessionId,
      agentType: agent.name,
      agentVersion: '1.0.0',
      uptimeSeconds: 0,
      messagesProcessed: agent.messagesProcessed,
      lastError: agent.lastError || undefined,
    };
  }

  /**
   * Check if monitoring is active for a session.
   */
  isMonitoring(sessionId: string): boolean {
    return this.activeMonitors.has(sessionId);
  }

  /**
   * Get all sessions being monitored.
   */
  getMonitoredSessions(): string[] {
    return Array.from(this.activeMonitors.keys());
  }

  /**
   * Parse health state string to AgentState enum.
   */
  private parseAgentState(state: string | null): AgentState {
    if (!state) return AgentState.UNKNOWN;
    const normalized = state.toLowerCase();
    const stateMap: Record<string, AgentState> = {
      unknown: AgentState.UNKNOWN,
      initializing: AgentState.INITIALIZING,
      ready: AgentState.READY,
      processing: AgentState.PROCESSING,
      interrupted: AgentState.INTERRUPTED,
      error: AgentState.ERROR,
      shutting_down: AgentState.SHUTTING_DOWN,
    };
    return stateMap[normalized] || AgentState.UNKNOWN;
  }

  /**
   * Event handler: User joined a session.
   */
  @OnEvent('livekit.participant.joined')
  handleUserJoined(payload: { sessionId: string; participantId: string; isAgent: boolean }): void {
    if (!payload.isAgent) {
      this.startMonitoring(payload.sessionId);
    }
  }

  /**
   * Event handler: User left a session.
   */
  @OnEvent('livekit.participant.left')
  handleUserLeft(payload: { sessionId: string; participantId: string; hasRemainingUsers: boolean }): void {
    if (!payload.hasRemainingUsers) {
      this.stopMonitoring(payload.sessionId);
    }
  }

  /**
   * Cleanup on module destroy.
   */
  onModuleDestroy(): void {
    for (const interval of this.activeMonitors.values()) {
      clearInterval(interval);
    }
    this.activeMonitors.clear();
    this.consecutiveFailures.clear();
  }
}
