import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Sse,
  UseGuards,
  ValidationPipe,
  UsePipes,
} from '@nestjs/common';
import { Observable, interval } from 'rxjs';
import { map } from 'rxjs/operators';
import { AgentsService } from './agents.service.js';
import { AgentImageService } from '../agent-image/agent-image.service.js';
import { CreateAgentDto } from './dto/create-agent.dto.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { ProjectAccessGuard } from '../auth/guards/project-access.guard.js';

interface MessageEvent {
  data: string;
  id?: string;
  type?: string;
  retry?: number;
}

@Controller()
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class AgentsController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly agentImageService: AgentImageService,
  ) {}

  @Get('agent-types')
  async getAgentTypes() {
    return this.agentImageService.getAgentTypesWithInfo();
  }

  @Post('sessions/:sessionId/agents')
  create(
    @Param('sessionId') sessionId: string,
    @Body() createAgentDto: CreateAgentDto,
    @CurrentUser() user: any,
  ) {
    return this.agentsService.create(sessionId, createAgentDto, user.userId);
  }

  @Get('agents/:agentId')
  findOne(@Param('agentId') id: string) {
    return this.agentsService.findOne(id);
  }

  @Get('agents/:agentId/logs')
  getLogs(@Param('agentId') id: string) {
    return this.agentsService.getLogs(id);
  }

  @Sse('agents/:agentId/logs/stream')
  streamLogs(@Param('agentId') id: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((observer) => {
      let cleanup: (() => void) | null = null;

      // Start streaming logs
      this.agentsService.streamLogs(
        id,
        (logs) => {
          // Send logs to client
          observer.next({
            data: logs,
          });
        },
        (error) => {
          // Handle errors
          observer.error(error);
        }
      ).then((cleanupFn) => {
        cleanup = cleanupFn;
      }).catch((error) => {
        observer.error(error);
      });

      // Cleanup when client disconnects
      return () => {
        if (cleanup) {
          cleanup();
        }
      };
    });
  }

  @Delete('agents/:agentId')
  remove(@Param('agentId') id: string) {
    return this.agentsService.remove(id);
  }

  @Delete('agents/:agentId/permanent')
  permanentDelete(@Param('agentId') id: string) {
    return this.agentsService.delete(id);
  }

  @Post('agents/:agentId/restart')
  restart(@Param('agentId') id: string) {
    return this.agentsService.restart(id);
  }

  /**
   * Get aggregated per-stage latency metrics for an agent type.
   *
   * Query params:
   *   - from: ISO date string (defaults to 30 days ago)
   *   - to: ISO date string (defaults to now)
   *
   * Returns per-stage stats: { stage, count, mean_ms, p50_ms, p95_ms, min_ms, max_ms }
   */
  @Get('projects/:projectId/agents/:agentSlug/metrics')
  @UseGuards(ProjectAccessGuard)
  async getAgentMetrics(
    @Param('projectId') projectId: string,
    @Param('agentSlug') agentSlug: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
    const toDate = to ? new Date(to) : new Date();
    return this.agentsService.getAgentMetrics(projectId, agentSlug, fromDate, toDate);
  }

  /**
   * Get raw TTFAB data points over time for a live timeline chart.
   *
   * Query params:
   *   - since: ISO date string (defaults to 1 hour ago)
   *   - stage: stage name to filter (defaults to 'ttfab')
   */
  @Get('projects/:projectId/agents/:agentSlug/metrics/timeline')
  @UseGuards(ProjectAccessGuard)
  async getMetricsTimeline(
    @Param('projectId') projectId: string,
    @Param('agentSlug') agentSlug: string,
    @Query('since') since?: string,
    @Query('stage') stage?: string,
  ) {
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 3600000);
    return this.agentsService.getMetricsTimeline(projectId, agentSlug, sinceDate, stage || 'ttfab');
  }

  /**
   * Get per-session average data points for a specific stage (for drill-down).
   *
   * Query params:
   *   - from: ISO date string (defaults to 30 days ago)
   *   - to: ISO date string (defaults to now)
   */
  @Get('projects/:projectId/agents/:agentSlug/metrics/stages/:stageName/points')
  @UseGuards(ProjectAccessGuard)
  async getStageDataPoints(
    @Param('projectId') projectId: string,
    @Param('agentSlug') agentSlug: string,
    @Param('stageName') stageName: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
    const toDate = to ? new Date(to) : new Date();
    return this.agentsService.getStageDataPoints(projectId, agentSlug, stageName, fromDate, toDate);
  }

  /**
   * Get per-session plan completion data for drill-down.
   *
   * Query params:
   *   - from: ISO date string (defaults to 30 days ago)
   *   - to: ISO date string (defaults to now)
   */
  @Get('projects/:projectId/agents/:agentSlug/metrics/plan-completion/sessions')
  @UseGuards(ProjectAccessGuard)
  async getPlanCompletionSessions(
    @Param('projectId') projectId: string,
    @Param('agentSlug') agentSlug: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400000);
    const toDate = to ? new Date(to) : new Date();
    return this.agentsService.getPlanCompletionSessions(projectId, agentSlug, fromDate, toDate);
  }

  /**
   * Get per-stage latency analytics for a single session.
   */
  @Get('projects/:projectId/sessions/:sessionId/analytics')
  @UseGuards(ProjectAccessGuard)
  async getSessionAnalytics(
    @Param('projectId') projectId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.agentsService.getSessionAnalytics(sessionId, projectId);
  }
}
