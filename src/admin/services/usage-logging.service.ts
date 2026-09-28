import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ServerMetricsService } from './server-metrics.service.js';

/**
 * UsageLoggingService - Automated metrics logging for historical data
 *
 * Responsibilities:
 * - Hourly snapshots of usage metrics for historical charts
 * - Server metrics collection every 5 seconds
 * - Session activity logging (triggered by session events)
 * - Cleanup of old data (retention policy)
 */
@Injectable()
export class UsageLoggingService {
  private readonly logger = new Logger(UsageLoggingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly serverMetricsService: ServerMetricsService,
  ) {}

  /**
   * Create hourly usage metrics snapshot
   * Runs at the start of every hour
   */
  @Cron(CronExpression.EVERY_HOUR)
  async createHourlySnapshot() {
    this.logger.log('Creating hourly usage metrics snapshot...');

    try {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      // Gather all metrics in parallel
      const [
        totalSessions,
        activeSessions,
        agents,
        totalParticipants,
        activeParticipants,
        totalMessages,
        recentMessages,
      ] = await Promise.all([
        this.prisma.session.count(),
        this.prisma.session.count({ where: { status: 'ACTIVE' } }),
        this.prisma.agentInstance.findMany({
          select: { status: true },
        }),
        this.prisma.participant.count(),
        this.prisma.participant.count({
          where: {
            session: { status: 'ACTIVE' },
            leftAt: null,
          },
        }),
        this.prisma.message.count(),
        this.prisma.message.count({
          where: { timestamp: { gte: oneHourAgo } },
        }),
      ]);

      // Count agents by status
      const runningAgents = agents.filter(
        (a) => a.status === 'RUNNING' || a.status === 'STARTING',
      ).length;
      const failedAgents = agents.filter((a) => a.status === 'FAILED').length;

      // Create snapshot
      await this.prisma.usageMetricsSnapshot.create({
        data: {
          timestamp: now,
          totalSessions,
          activeSessions,
          totalAgents: agents.length,
          runningAgents,
          failedAgents,
          totalParticipants,
          activeParticipants,
          peakParticipants: activeParticipants, // Current count as peak (simplified)
          totalMessages,
          messagesThisHour: recentMessages,
        },
      });

      this.logger.log('Hourly usage snapshot created successfully');
    } catch (error) {
      this.logger.error('Failed to create hourly snapshot:', error);
    }
  }

  /**
   * Collect and store server metrics
   * Runs every 5 seconds
   */
  @Cron('*/5 * * * * *') // Every 5 seconds
  async collectServerMetrics() {
    try {
      const metrics = await this.serverMetricsService.collectMetrics();

      await this.prisma.serverMetricsSnapshot.create({
        data: {
          timestamp: new Date(metrics.timestamp),
          cpuUsage: metrics.cpuUsage,
          cpuCores: metrics.cpuCores,
          memoryTotal: metrics.memoryTotal,
          memoryUsed: metrics.memoryUsed,
          memoryFree: metrics.memoryFree,
          gpuUsage: metrics.gpuUsage,
          gpuMemoryUsed: metrics.gpuMemoryUsed,
          gpuMemoryTotal: metrics.gpuMemoryTotal,
          gpuAvailable: metrics.gpuAvailable,
          k8sNodeCount: metrics.k8sNodeCount,
          k8sPodCount: metrics.k8sPodCount,
          k8sCpuRequests: metrics.k8sCpuRequests,
          k8sMemoryUsed: metrics.k8sMemoryUsed,
        },
      });
    } catch (error) {
      this.logger.error('Failed to collect server metrics:', error);
    }
  }

  /**
   * Log session activity for the activity grid
   * Called when sessions are created/closed
   */
  async logSessionActivity(
    sessionId: string,
    projectId: string,
    status: 'active' | 'closed' | 'error',
    hasAgentError = false,
    closedAt?: Date,
  ) {
    try {
      // Check if entry already exists
      const existing = await this.prisma.sessionActivityLog.findFirst({
        where: { sessionId },
      });

      if (existing) {
        // Update existing entry
        await this.prisma.sessionActivityLog.update({
          where: { id: existing.id },
          data: {
            status,
            hasAgentError,
            closedAt,
          },
        });
      } else {
        // Create new entry
        await this.prisma.sessionActivityLog.create({
          data: {
            sessionId,
            projectId,
            status,
            hasAgentError,
            closedAt,
          },
        });
      }
    } catch (error) {
      this.logger.error('Failed to log session activity:', error);
    }
  }

  /**
   * Cleanup old metrics data
   * Runs daily at 2 AM
   * - Server metrics: Keep 7 days
   * - Usage snapshots: Keep 365 days
   * - Session activity: Keep 90 days
   */
  @Cron('0 2 * * *') // Daily at 2 AM
  async cleanupOldData() {
    this.logger.log('Starting metrics data cleanup...');

    try {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

      const [serverMetricsDeleted, usageSnapshotsDeleted, activityLogsDeleted] =
        await Promise.all([
          this.prisma.serverMetricsSnapshot.deleteMany({
            where: { timestamp: { lt: sevenDaysAgo } },
          }),
          this.prisma.usageMetricsSnapshot.deleteMany({
            where: { timestamp: { lt: oneYearAgo } },
          }),
          this.prisma.sessionActivityLog.deleteMany({
            where: { createdAt: { lt: ninetyDaysAgo } },
          }),
        ]);

      this.logger.log(
        `Cleanup complete: ${serverMetricsDeleted.count} server metrics, ` +
          `${usageSnapshotsDeleted.count} usage snapshots, ` +
          `${activityLogsDeleted.count} activity logs deleted`,
      );
    } catch (error) {
      this.logger.error('Failed to cleanup old metrics:', error);
    }
  }
}
