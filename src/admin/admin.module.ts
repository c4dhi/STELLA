import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ServerMetricsService } from './services/server-metrics.service';
import { UsageLoggingService } from './services/usage-logging.service';
import { CapacityService } from './services/capacity.service';
import { PrismaModule } from '../prisma/prisma.module';
import { KubernetesModule } from '../kubernetes/kubernetes.module';

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
