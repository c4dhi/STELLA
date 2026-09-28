import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  HttpStatus,
  Sse,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { Public } from '../common/decorators/public.decorator.js';
import { PublicProjectsService } from './public-projects.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { PublicProjectInfoDto, JoinPublicProjectResponseDto, StartJoinPublicProjectResponseDto, JoinProgressDto } from './dto/public-project-info.dto.js';

interface MessageEvent {
  data: string | object;
  id?: string;
  type?: string;
  retry?: number;
}

/**
 * Controller for public project endpoints
 * These endpoints are PUBLIC (no auth required) and accessible to anyone with the token
 */
@Controller('p')
export class PublicProjectsController {
  private readonly logger = new Logger(PublicProjectsController.name);

  constructor(
    private readonly publicProjectsService: PublicProjectsService,
    private readonly sessionsService: SessionsService,
  ) {}

  /**
   * GET /p/:publicToken
   * Get public project info for display on the waiting screen
   * Returns project name, agent info, visualizer settings
   */
  @Public()
  @Get(':publicToken')
  async getPublicProjectInfo(
    @Param('publicToken') publicToken: string,
  ): Promise<PublicProjectInfoDto> {
    return this.publicProjectsService.getPublicProjectInfo(publicToken);
  }

  /**
   * POST /p/:publicToken/join
   * Join a public project (blocking - deprecated)
   * Creates session, deploys agent, waits for ready, creates invitation
   * Returns invitation token for redirect to /join/:invitationToken
   * @deprecated Use POST /p/:publicToken/start-join with SSE instead for better UX
   */
  @Public()
  @Post(':publicToken/join')
  @HttpCode(HttpStatus.OK)
  async joinPublicProject(
    @Param('publicToken') publicToken: string,
  ): Promise<JoinPublicProjectResponseDto> {
    return this.publicProjectsService.joinPublicProject(publicToken);
  }

  /**
   * POST /p/:publicToken/start-join
   * Start joining a public project (non-blocking)
   * Creates session and deploys agent, returns immediately
   * Frontend subscribes to SSE for progress updates
   */
  @Public()
  @Post(':publicToken/start-join')
  @HttpCode(HttpStatus.OK)
  async startJoinPublicProject(
    @Param('publicToken') publicToken: string,
  ): Promise<StartJoinPublicProjectResponseDto> {
    return this.publicProjectsService.startJoinPublicProject(publicToken);
  }

  /**
   * GET /p/:publicToken/join/:sessionId/status
   * Poll for join progress status
   * Returns current step, status, and invitationToken when complete
   */
  @Public()
  @Get(':publicToken/join/:sessionId/status')
  getJoinProgress(
    @Param('sessionId') sessionId: string,
  ): JoinProgressDto {
    return this.publicProjectsService.getJoinProgress(sessionId);
  }

  /**
   * SSE /p/:publicToken/join/:sessionId/events
   * Stream join progress events
   * Events: join.session_created, join.agent_deploying, join.agent_starting,
   *         join.agent_ready, join.invitation_created, join.complete, join.failed
   */
  @Public()
  @Sse(':publicToken/join/:sessionId/events')
  streamJoinProgress(
    @Param('publicToken') _publicToken: string,
    @Param('sessionId') sessionId: string,
  ): Observable<MessageEvent> {
    this.logger.log(`SSE connection opened for public join progress: session ${sessionId}`);
    return this.sessionsService.getSessionEventStream(sessionId);
  }
}
