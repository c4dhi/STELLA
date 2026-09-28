import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { Observable, interval, ReplaySubject, merge } from 'rxjs';
import { map, switchMap, startWith, finalize } from 'rxjs/operators';
import { PrismaService } from '../prisma/prisma.service.js';
import { ServerMetricsService, ServerMetrics } from './services/server-metrics.service.js';
import { KubernetesService } from '../kubernetes/kubernetes.service.js';

interface MessageEvent {
  data: string;
  id?: string;
  type?: string;
  retry?: number;
}

export interface DashboardMetrics {
  timestamp: string;
  activeParticipants: number;
  totalParticipants: number;
  activeSessions: number;
  totalSessions: number;
  runningAgents: number;
  startingAgents: number;
  failedAgents: number;
  pausedAgents: number;  // Agents paused due to inactivity
  stoppedAgents: number; // Agents that are stopped (not paused)
  totalAgents: number;
  totalMessages: number;
  messagesToday: number;
  // Auto-stop feature metrics
  sessionsWithTimeout: number;  // Sessions with inactivity timeout configured
}

export interface SessionActivityDay {
  date: string; // YYYY-MM-DD
  activeCount: number;
  closedCount: number;
  errorCount: number;
}

export interface HistoricalUsageData {
  date: string;
  sessionsCreated: number;
  peakParticipants: number;
}

export interface UserListItem {
  id: string;
  email: string;
  name: string | null;
  verified: boolean;
  isSystemAdmin: boolean;
  createdAt: Date;
  projectCount: number;
}

export interface SessionResourceUsage {
  cpuMillicores: number;
  memoryBytes: number;
  cpuPercent: number;
  memoryPercent: number;
}

export interface SessionAgentError {
  agentName: string;
  status: string;
  lastError: string | null;
  healthState: string | null;
}

export interface SessionStatusItem {
  id: string;
  status: string; // 'ACTIVE', 'CLOSED'
  hasError: boolean;
  isIdle: boolean;
  resourceUsage: SessionResourceUsage | null;
  hasResourceWarning: boolean;
  errors: SessionAgentError[];
  projectId: string;
  createdAt: Date;
}

/**
 * AdminService - Core business logic for admin dashboard
 *
 * Provides:
 * - Real-time dashboard metrics
 * - SSE streams for live updates
 * - Session activity data for visualization
 * - Historical usage data for charts
 * - User management operations
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  // SSE stream management
  private dashboardSubscriberCount = 0;
  private dashboardRefreshTrigger = new ReplaySubject<void>(1);
  private serverMetricsSubscriberCount = 0;

  // In-memory cache for K8s pod metrics (30s TTL)
  private metricsCache: { data: Map<string, { cpuMillicores: number; memoryBytes: number }>; fetchedAt: number } | null = null;
  private readonly METRICS_CACHE_TTL = 30_000; // 30 seconds

  // Known resource limits per agent pod (from pod spec)
  private readonly AGENT_CPU_LIMIT_MILLICORES = 1000; // 1000m
  private readonly AGENT_MEMORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024; // 2Gi

  constructor(
    private readonly prisma: PrismaService,
    private readonly serverMetricsService: ServerMetricsService,
    private readonly kubernetesService: KubernetesService,
  ) {}

  /**
   * Get current dashboard metrics snapshot
   */
  async getDashboardMetrics(): Promise<DashboardMetrics> {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [
      activeSessions,
      totalSessions,
      sessionsWithTimeout,
      agents,
      activeParticipants,
      totalParticipants,
      totalMessages,
      messagesToday,
    ] = await Promise.all([
      this.prisma.session.count({ where: { status: 'ACTIVE' } }),
      this.prisma.session.count(),
      this.prisma.session.count({
        where: {
          status: 'ACTIVE',
          agentInactivityTimeoutMinutes: { not: null }
        }
      }),
      this.prisma.agentInstance.findMany({ select: { status: true, pausedAt: true } }),
      this.prisma.participant.count({
        where: {
          session: { status: 'ACTIVE' },
          leftAt: null,
        },
      }),
      this.prisma.participant.count(),
      this.prisma.message.count(),
      this.prisma.message.count({
        where: { timestamp: { gte: todayStart } },
      }),
    ]);

    // Count agents by status
    const runningAgents = agents.filter((a) => a.status === 'RUNNING').length;
    const startingAgents = agents.filter((a) => a.status === 'STARTING').length;
    const failedAgents = agents.filter((a) => a.status === 'FAILED').length;
    // Paused agents: STOPPED status with pausedAt set (stopped due to inactivity)
    const pausedAgents = agents.filter((a) => a.status === 'STOPPED' && a.pausedAt !== null).length;
    // Stopped agents: STOPPED status without pausedAt (manually stopped or completed)
    const stoppedAgents = agents.filter((a) => a.status === 'STOPPED' && a.pausedAt === null).length;

    return {
      timestamp: now.toISOString(),
      activeParticipants,
      totalParticipants,
      activeSessions,
      totalSessions,
      runningAgents,
      startingAgents,
      failedAgents,
      pausedAgents,
      stoppedAgents,
      totalAgents: agents.length,
      totalMessages,
      messagesToday,
      sessionsWithTimeout,
    };
  }

  /**
   * SSE stream for dashboard metrics (3s interval)
   */
  getDashboardStream(): Observable<MessageEvent> {
    this.dashboardSubscriberCount++;
    this.logger.log(`Dashboard SSE subscriber added (total: ${this.dashboardSubscriberCount})`);

    const periodicUpdates = interval(10000);
    const combined = merge(
      periodicUpdates.pipe(map(() => 'periodic')),
      this.dashboardRefreshTrigger.pipe(map(() => 'refresh')),
    );

    return combined.pipe(
      startWith('initial'),
      switchMap(async () => {
        try {
          const metrics = await this.getDashboardMetrics();
          return {
            data: JSON.stringify(metrics),
            id: `${Date.now()}`,
          };
        } catch (error) {
          this.logger.error('Failed to get dashboard metrics:', error);
          return {
            data: JSON.stringify({ error: 'Failed to fetch metrics' }),
            id: `${Date.now()}`,
          };
        }
      }),
      finalize(() => {
        this.dashboardSubscriberCount--;
        this.logger.log(`Dashboard SSE subscriber removed (remaining: ${this.dashboardSubscriberCount})`);
      }),
    );
  }

  /**
   * Trigger immediate dashboard refresh
   */
  refreshDashboard(): void {
    this.dashboardRefreshTrigger.next();
  }

  /**
   * Get cached agent pod metrics (30s TTL)
   */
  private async getCachedAgentPodMetrics(): Promise<Map<string, { cpuMillicores: number; memoryBytes: number }>> {
    const now = Date.now();
    if (this.metricsCache && (now - this.metricsCache.fetchedAt) < this.METRICS_CACHE_TTL) {
      return this.metricsCache.data;
    }

    const data = await this.kubernetesService.getAgentPodMetrics();
    this.metricsCache = { data, fetchedAt: now };
    return data;
  }

  /**
   * Get all sessions with their current status for the sessions grid
   */
  async getAllSessions(): Promise<SessionStatusItem[]> {
    const [sessions, metricsMap] = await Promise.all([
      this.prisma.session.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200, // Limit to most recent 200 sessions
        select: {
          id: true,
          status: true,
          projectId: true,
          createdAt: true,
          agents: {
            select: {
              id: true,
              name: true,
              status: true,
              podName: true,
              lastError: true,
              healthState: true,
            },
          },
          participants: {
            where: { leftAt: null },
            select: { id: true },
          },
        },
      }),
      this.getCachedAgentPodMetrics(),
    ]);

    return sessions.map((session) => {
      // Collect agents with errors: FAILED status or healthState 'error'
      const errorAgents: SessionAgentError[] = session.agents
        .filter((agent) => agent.status === 'FAILED' || agent.healthState === 'error')
        .map((agent) => ({
          agentName: agent.name,
          status: agent.status,
          lastError: agent.lastError,
          healthState: agent.healthState,
        }));
      const hasError = errorAgents.length > 0;
      const hasRunningOrStartingAgent = session.agents.some(
        (agent) => agent.status === 'RUNNING' || agent.status === 'STARTING',
      );
      const hasOnlineParticipants = session.participants.length > 0;
      const isIdle = session.status === 'ACTIVE' && !hasRunningOrStartingAgent && !hasOnlineParticipants;

      // Aggregate resource usage for this session's running agents
      let resourceUsage: SessionResourceUsage | null = null;
      const runningAgents = session.agents.filter((a) => a.status === 'RUNNING' || a.status === 'STARTING');

      if (runningAgents.length > 0 && metricsMap.size > 0) {
        let totalCpu = 0;
        let totalMem = 0;
        let agentsWithMetrics = 0;

        for (const agent of runningAgents) {
          const metrics = metricsMap.get(agent.id);
          if (metrics) {
            totalCpu += metrics.cpuMillicores;
            totalMem += metrics.memoryBytes;
            agentsWithMetrics++;
          }
        }

        if (agentsWithMetrics > 0) {
          const totalCpuLimit = runningAgents.length * this.AGENT_CPU_LIMIT_MILLICORES;
          const totalMemLimit = runningAgents.length * this.AGENT_MEMORY_LIMIT_BYTES;
          resourceUsage = {
            cpuMillicores: totalCpu,
            memoryBytes: totalMem,
            cpuPercent: Math.round((totalCpu / totalCpuLimit) * 100),
            memoryPercent: Math.round((totalMem / totalMemLimit) * 100),
          };
        }
      }

      const hasResourceWarning = resourceUsage !== null &&
        (resourceUsage.cpuPercent > 80 || resourceUsage.memoryPercent > 80);

      return {
        id: session.id,
        status: session.status,
        hasError,
        isIdle,
        resourceUsage,
        hasResourceWarning,
        errors: errorAgents,
        projectId: session.projectId,
        createdAt: session.createdAt,
      };
    });
  }

  /**
   * Get session activity data for the last 90 days (for activity grid)
   */
  async getSessionActivity(): Promise<SessionActivityDay[]> {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const activities = await this.prisma.sessionActivityLog.findMany({
      where: {
        createdAt: { gte: ninetyDaysAgo },
      },
      select: {
        createdAt: true,
        status: true,
        hasAgentError: true,
      },
    });

    // Group by date
    const groupedByDate = new Map<string, { active: number; closed: number; error: number }>();

    // Initialize all 90 days
    for (let i = 0; i < 90; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      groupedByDate.set(dateStr, { active: 0, closed: 0, error: 0 });
    }

    // Count activities
    for (const activity of activities) {
      const dateStr = activity.createdAt.toISOString().split('T')[0];
      const existing = groupedByDate.get(dateStr);
      if (existing) {
        if (activity.hasAgentError) {
          existing.error++;
        } else if (activity.status === 'active') {
          existing.active++;
        } else {
          existing.closed++;
        }
      }
    }

    // Convert to array sorted by date (oldest first)
    return Array.from(groupedByDate.entries())
      .map(([date, counts]) => ({
        date,
        activeCount: counts.active,
        closedCount: counts.closed,
        errorCount: counts.error,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Get current server metrics
   */
  async getServerMetrics(): Promise<ServerMetrics> {
    return this.serverMetricsService.collectMetrics();
  }

  /**
   * SSE stream for server metrics (2s interval)
   */
  getServerMetricsStream(): Observable<MessageEvent> {
    this.serverMetricsSubscriberCount++;
    this.logger.log(`Server metrics SSE subscriber added (total: ${this.serverMetricsSubscriberCount})`);

    return interval(2000).pipe(
      startWith(0),
      switchMap(async () => {
        try {
          const metrics = await this.serverMetricsService.collectMetrics();
          // Convert BigInt to string for JSON serialization
          const serializableMetrics = {
            ...metrics,
            memoryTotal: metrics.memoryTotal.toString(),
            memoryUsed: metrics.memoryUsed.toString(),
            memoryFree: metrics.memoryFree.toString(),
            gpuMemoryUsed: metrics.gpuMemoryUsed?.toString() || null,
            gpuMemoryTotal: metrics.gpuMemoryTotal?.toString() || null,
            gpus: metrics.gpus.map((gpu) => ({
              ...gpu,
              memoryUsed: gpu.memoryUsed.toString(),
              memoryTotal: gpu.memoryTotal.toString(),
            })),
            k8sMemoryUsed: metrics.k8sMemoryUsed?.toString() || null,
          };
          return {
            data: JSON.stringify(serializableMetrics),
            id: `${Date.now()}`,
          };
        } catch (error) {
          this.logger.error('Failed to get server metrics:', error);
          return {
            data: JSON.stringify({ error: 'Failed to fetch metrics' }),
            id: `${Date.now()}`,
          };
        }
      }),
      finalize(() => {
        this.serverMetricsSubscriberCount--;
        this.logger.log(`Server metrics SSE subscriber removed (remaining: ${this.serverMetricsSubscriberCount})`);
      }),
    );
  }

  /**
   * Get historical usage data for charts
   */
  async getUsageHistory(days: number = 30): Promise<HistoricalUsageData[]> {
    if (days < 1 || days > 365) {
      throw new BadRequestException('Days must be between 1 and 365');
    }

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const snapshots = await this.prisma.usageMetricsSnapshot.findMany({
      where: {
        timestamp: { gte: startDate },
      },
      orderBy: { timestamp: 'asc' },
    });

    // Group by date and aggregate
    const groupedByDate = new Map<string, { sessions: number; peakParticipants: number }>();

    for (const snapshot of snapshots) {
      const dateStr = snapshot.timestamp.toISOString().split('T')[0];
      const existing = groupedByDate.get(dateStr);

      if (existing) {
        existing.sessions += snapshot.activeSessions;
        existing.peakParticipants = Math.max(existing.peakParticipants, snapshot.peakParticipants);
      } else {
        groupedByDate.set(dateStr, {
          sessions: snapshot.activeSessions,
          peakParticipants: snapshot.peakParticipants,
        });
      }
    }

    // Fill in missing dates with zeros
    const result: HistoricalUsageData[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const data = groupedByDate.get(dateStr);

      result.push({
        date: dateStr,
        sessionsCreated: data?.sessions || 0,
        peakParticipants: data?.peakParticipants || 0,
      });
    }

    return result;
  }

  /**
   * List all users with pagination
   */
  async listUsers(page: number = 1, limit: number = 50): Promise<{
    users: UserListItem[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          name: true,
          verified: true,
          isSystemAdmin: true,
          createdAt: true,
          _count: {
            select: { projectMemberships: true },
          },
        },
      }),
      this.prisma.user.count(),
    ]);

    return {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        verified: u.verified,
        isSystemAdmin: u.isSystemAdmin,
        createdAt: u.createdAt,
        projectCount: u._count.projectMemberships,
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Verify a user
   */
  async verifyUser(userId: string): Promise<UserListItem> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { verified: true },
      select: {
        id: true,
        email: true,
        name: true,
        verified: true,
        isSystemAdmin: true,
        createdAt: true,
        _count: {
          select: { projectMemberships: true },
        },
      },
    });

    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      verified: updated.verified,
      isSystemAdmin: updated.isSystemAdmin,
      createdAt: updated.createdAt,
      projectCount: updated._count.projectMemberships,
    };
  }

  /**
   * Toggle system admin status for a user
   */
  async toggleAdminStatus(userId: string, isAdmin: boolean): Promise<UserListItem> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { isSystemAdmin: isAdmin },
      select: {
        id: true,
        email: true,
        name: true,
        verified: true,
        isSystemAdmin: true,
        createdAt: true,
        _count: {
          select: { projectMemberships: true },
        },
      },
    });

    return {
      id: updated.id,
      email: updated.email,
      name: updated.name,
      verified: updated.verified,
      isSystemAdmin: updated.isSystemAdmin,
      createdAt: updated.createdAt,
      projectCount: updated._count.projectMemberships,
    };
  }
}
