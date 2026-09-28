import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service.js';
import { MetricsController } from './metrics.controller.js';
import { PrismaModule } from '../prisma/prisma.module.js';

/**
 * MetricsModule - Real-time metrics and analytics
 *
 * Provides centralized metrics collection for:
 * - Project dashboards (sessions, agents, participants, messages)
 * - Future admin dashboard (global system metrics)
 * - Future alerting system
 */
@Module({
  imports: [PrismaModule],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
