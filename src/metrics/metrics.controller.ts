import { Controller, Get, Param, Sse, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';
import { MetricsService } from './metrics.service.js';
import { ProjectMetricsDto } from './dto/project-metrics.dto.js';

interface MessageEvent {
  data: string;
  id?: string;
  type?: string;
  retry?: number;
}

/**
 * MetricsController - REST and SSE endpoints for metrics
 *
 * Provides project-level metrics with both REST (snapshot) and SSE (real-time) access.
 * Future extensions will add global system metrics for admin dashboard.
 */
@Controller('metrics')
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);

  constructor(private readonly metricsService: MetricsService) {}

  /**
   * Get current metrics snapshot for a project
   * GET /metrics/projects/:projectId
   */
  @Get('projects/:projectId')
  async getProjectMetrics(
    @Param('projectId') projectId: string,
  ): Promise<ProjectMetricsDto> {
    this.logger.log(`Getting metrics for project ${projectId}`);
    return this.metricsService.getProjectMetrics(projectId);
  }

  /**
   * SSE stream for real-time project metrics
   * GET /metrics/projects/:projectId/stream
   *
   * Updates every 5 seconds or immediately when project data changes
   */
  @Sse('projects/:projectId/stream')
  streamProjectMetrics(
    @Param('projectId') projectId: string,
  ): Observable<MessageEvent> {
    this.logger.log(`SSE connection opened for project ${projectId} metrics`);
    return this.metricsService.getProjectMetricsStream(projectId);
  }
}
