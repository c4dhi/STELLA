import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { ServerMetricsService } from './services/server-metrics.service.js';
import { UsageLoggingService } from './services/usage-logging.service.js';
import { CapacityService } from './services/capacity.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { KubernetesModule } from '../kubernetes/kubernetes.module.js';

/**
 * AdminModule - System Administration Dashboard
 *
 * Provides system-wide metrics, monitoring, and user management for system administrators.
 * All endpoints are protected by SystemAdminGuard requiring isSystemAdmin flag.
 *
 * Features:
 * - Real-time dashboard metrics (sessions, agents, participants)
 * - Server performance monitoring (CPU, RAM, GPU, K8s)
 * - Session activity visualization (90-day grid)
 * - Historical usage charts
 * - User management (verification, admin status)
 */
@Module({
  imports: [
    PrismaModule,
    KubernetesModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [AdminController],
  providers: [AdminService, ServerMetricsService, UsageLoggingService, CapacityService],
  exports: [AdminService],
})
export class AdminModule {}
