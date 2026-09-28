import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Observable, ReplaySubject, interval, merge } from 'rxjs';
import { map, finalize, switchMap, startWith } from 'rxjs/operators';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectMetricsDto } from './dto/project-metrics.dto.js';

interface MessageEvent {
  data: string;
  id?: string;
  type?: string;
  retry?: number;
}

/**
 * MetricsService - Centralized metrics collection and streaming
 *
 * This service provides the foundation for real-time metrics across the platform.
 * It's designed to be extended for future admin dashboard features including:
 * - Global system metrics
 * - Historical data collection
 * - Alerting based on thresholds
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  // SSE stream management for project metrics
  private projectMetricsSubjects: Map<string, ReplaySubject<ProjectMetricsDto>> =
    new Map();
  private projectSubscriberCounts: Map<string, number> = new Map();

  // Refresh triggers - used to immediately update metrics when events occur
  private refreshTriggers: Map<string, ReplaySubject<void>> = new Map();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get current metrics snapshot for a project
   */
  async getProjectMetrics(projectId: string): Promise<ProjectMetricsDto> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        publicAgentType: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    // Get plan template name if configured
    let planTemplateName: string | null = null;
    if (project.publicAgentConfig) {
      const config = project.publicAgentConfig as Record<string, unknown>;
      if (config.planTemplateId) {
        // Plan template from database
        const planTemplate = await this.prisma.planTemplate.findUnique({
          where: { id: config.planTemplateId as string },
          select: { name: true },
        });
        planTemplateName = planTemplate?.name || null;
      } else if (config.name) {
        // Inline plan with name in config
        planTemplateName = config.name as string;
      } else if (
        config.plan &&
        typeof config.plan === 'object' &&
        (config.plan as Record<string, unknown>).system_prompt
      ) {
        // Has inline plan but no name - use generic label
        planTemplateName = 'Custom Plan';
      }
    }

    // Parallel queries for efficiency
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const onlineThreshold = new Date(now.getTime() - 60 * 1000); // 60 seconds ago

    const [
      sessionsTotal,
      sessionsActive,
      sessionsClosed,
      agents,
      participantsTotal,
      participantsOnline,
      messagesTotal,
      messagesToday,
    ] = await Promise.all([
      // Session counts
      this.prisma.session.count({
        where: { projectId },
      }),
      this.prisma.session.count({
        where: { projectId, status: 'ACTIVE' },
      }),
      this.prisma.session.count({
        where: { projectId, status: 'CLOSED' },
      }),

      // Agent status breakdown
      this.prisma.agentInstance.findMany({
        where: {
          session: { projectId },
        },
        select: { status: true },
      }),

      // Participant counts
      this.prisma.participant.count({
        where: {
          session: { projectId },
        },
      }),
      this.prisma.participant.count({
        where: {
          session: { projectId },
          lastSeenAt: { gte: onlineThreshold },
        },
      }),

      // Message counts
      this.prisma.message.count({
        where: {
          session: { projectId },
        },
      }),
      this.prisma.message.count({
        where: {
          session: { projectId },
          timestamp: { gte: todayStart },
        },
      }),
    ]);

    // Count agents by status
    const agentCounts = {
      total: agents.length,
      running: agents.filter((a) => a.status === 'RUNNING').length,
      starting: agents.filter((a) => a.status === 'STARTING').length,
      failed: agents.filter((a) => a.status === 'FAILED').length,
      stopped: agents.filter(
        (a) => a.status === 'STOPPED' || a.status === 'STOPPING',
      ).length,
    };

    return {
      projectId,
      timestamp: new Date().toISOString(),
      sessions: {
        total: sessionsTotal,
        active: sessionsActive,
        closed: sessionsClosed,
      },
      agents: agentCounts,
      participants: {
        total: participantsTotal,
        online: participantsOnline,
      },
      messages: {
        total: messagesTotal,
        todayCount: messagesToday,
      },
      project: {
        name: project.name,
        agentType: project.publicAgentType?.id || null,
        agentTypeName: project.publicAgentType?.name || null,
        planTemplateName,
        isPublic: project.isPublic,
        createdAt: project.createdAt.toISOString(),
      },
    };
  }

  /**
   * Get an SSE stream of project metrics with automatic updates
   * Updates every 5 seconds OR immediately when refreshProjectMetrics() is called
   */
  getProjectMetricsStream(projectId: string): Observable<MessageEvent> {
    // Get or create refresh trigger for this project
    let refreshTrigger = this.refreshTriggers.get(projectId);
    if (!refreshTrigger) {
      refreshTrigger = new ReplaySubject<void>(1);
      this.refreshTriggers.set(projectId, refreshTrigger);
    }

    // Track subscriber count
    const currentCount = this.projectSubscriberCounts.get(projectId) || 0;
    this.projectSubscriberCounts.set(projectId, currentCount + 1);
    this.logger.log(
      `Metrics SSE subscriber added for project ${projectId} (total: ${currentCount + 1})`,
    );

    // Merge periodic updates (every 5s) with refresh triggers
    const periodicUpdates = interval(5000);
    const combined = merge(
      periodicUpdates.pipe(map(() => 'periodic')),
      refreshTrigger.pipe(map(() => 'refresh')),
    );

    return combined.pipe(
      startWith('initial'),
      switchMap(async () => {
        try {
          const metrics = await this.getProjectMetrics(projectId);
          return {
            data: JSON.stringify(metrics),
            id: `${Date.now()}`,
          };
        } catch (error) {
          this.logger.error(
            `Failed to get metrics for project ${projectId}:`,
            error,
          );
          return {
            data: JSON.stringify({ error: 'Failed to fetch metrics' }),
            id: `${Date.now()}`,
          };
        }
      }),
      finalize(() => {
        const count = this.projectSubscriberCounts.get(projectId) || 1;
        this.projectSubscriberCounts.set(projectId, count - 1);
        this.logger.log(
          `Metrics SSE subscriber removed for project ${projectId} (remaining: ${count - 1})`,
        );

        // Cleanup when no more subscribers
        if (count - 1 <= 0) {
          this.projectSubscriberCounts.delete(projectId);
          this.refreshTriggers.delete(projectId);
          this.logger.log(`Metrics cleanup for project ${projectId}`);
        }
      }),
    );
  }

  /**
   * Trigger an immediate metrics refresh for a project
   * Called when session/agent/participant changes occur
   */
  refreshProjectMetrics(projectId: string): void {
    const trigger = this.refreshTriggers.get(projectId);
    if (trigger) {
      this.logger.debug(`Triggering metrics refresh for project ${projectId}`);
      trigger.next();
    }
  }

  /**
   * Get count of active subscribers for a project's metrics stream
   * Useful for debugging and monitoring
   */
  getSubscriberCount(projectId: string): number {
    return this.projectSubscriberCounts.get(projectId) || 0;
  }
}
