import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Headers,
  Sse,
  Res,
  ValidationPipe,
  UsePipes,
  Logger,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Request,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { SessionsService } from './sessions.service.js';
import { CreateSessionDto } from './dto/create-session.dto.js';
import { UpdateSessionDto } from './dto/update-session.dto.js';
import { CreateTokenDto } from './dto/create-token.dto.js';
import { QuerySessionsDto } from './dto/query-sessions.dto.js';
import { BatchListenerStatusDto } from './dto/batch-listener-status.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Public } from '../common/decorators/public.decorator.js';
import type { LogEntry } from '../message-recorder/room-monitor.service.js';

interface MessageEvent {
  data: string;
  id?: string;
  type?: string;
  retry?: number;
}

@Controller()
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class SessionsController {
  private readonly logger = new Logger(SessionsController.name);

  constructor(
    private readonly sessionsService: SessionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('projects/:projectId/sessions')
  create(
    @Param('projectId') projectId: string,
    @Body() createSessionDto: CreateSessionDto,
  ) {
    return this.sessionsService.create(projectId, createSessionDto);
  }

  @Get('projects/:projectId/sessions')
  findAll(
    @Param('projectId') projectId: string,
    @Query() query: QuerySessionsDto,
  ) {
    return this.sessionsService.findAll(projectId, query);
  }

  @Get('sessions/:sessionId')
  findOne(@Param('sessionId') id: string) {
    return this.sessionsService.findOne(id);
  }

  @Post('sessions/:sessionId/joinToken')
  createJoinToken(
    @Param('sessionId') sessionId: string,
    @Body() createTokenDto: CreateTokenDto,
  ) {
    return this.sessionsService.createJoinToken(sessionId, createTokenDto);
  }

  @Get('sessions/:sessionId/timeline')
  getTimeline(
    @Param('sessionId') sessionId: string,
    @Query('skip') skip?: number,
    @Query('take') take?: number,
  ) {
    return this.sessionsService.getTimeline(sessionId, skip, take);
  }

  @Patch('sessions/:sessionId')
  update(
    @Param('sessionId') id: string,
    @Body() updateSessionDto: UpdateSessionDto,
  ) {
    return this.sessionsService.update(id, updateSessionDto);
  }

  @Patch('sessions/:sessionId/close')
  close(@Param('sessionId') id: string) {
    return this.sessionsService.close(id);
  }

  @Delete('sessions/:sessionId')
  delete(@Param('sessionId') id: string) {
    return this.sessionsService.delete(id);
  }

  // Participant management endpoints
  @Post('sessions/:sessionId/participants')
  registerParticipant(
    @Param('sessionId') sessionId: string,
    @Body('name') name: string,
  ) {
    return this.sessionsService.registerParticipant(sessionId, name);
  }

  @Get('sessions/:sessionId/participants')
  listParticipants(@Param('sessionId') sessionId: string) {
    return this.sessionsService.listParticipants(sessionId);
  }

  // Dashboard endpoint: Get participant connection info by ID (user-authenticated)
  @Get('participants/:participantId/connection-info')
  getParticipantConnectionInfoById(@Param('participantId') participantId: string) {
    // User-authenticated - dashboard uses this to generate QR codes
    return this.sessionsService.getParticipantConnectionInfoWithToken(participantId);
  }

  // Mobile app endpoint: Get own connection info (participant-authenticated)
  // This endpoint also serves as token refresh - returns a fresh LiveKit token (24h TTL)
  @Get('participants/connection-info')
  getParticipantConnectionInfo(@Request() req) {
    // Extract participantId from participant JWT token
    const participantId = req.user.participantId;
    if (!participantId) {
      throw new BadRequestException('Invalid participant token');
    }
    return this.sessionsService.getParticipantConnectionInfo(participantId);
  }

  // Explicit token refresh endpoint for mobile apps
  // Returns fresh LiveKit token (24h TTL) for indefinite connection
  @Post('participants/refresh')
  refreshLivekitToken(@Request() req) {
    // Extract participantId from participant JWT token
    const participantId = req.user.participantId;
    if (!participantId) {
      throw new BadRequestException('Invalid participant token');
    }
    return this.sessionsService.getParticipantConnectionInfo(participantId);
  }

  // Heartbeat endpoint for participant presence tracking
  // Called periodically by participant clients to update lastSeenAt
  @Post('participants/heartbeat')
  participantHeartbeat(@Request() req) {
    const participantId = req.user.participantId;
    if (!participantId) {
      throw new BadRequestException('Invalid participant token');
    }
    return this.sessionsService.participantHeartbeat(participantId);
  }

  @Delete('participants/:participantId')
  removeParticipant(@Param('participantId') participantId: string) {
    return this.sessionsService.removeParticipant(participantId);
  }

  // Message retrieval endpoints
  @Get('sessions/:sessionId/messages')
  async getMessages(
    @Param('sessionId') sessionId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitStr?: string,
    @Query('before') before?: string,
    @Query('include_debug') includeDebug?: string,
  ) {
    try {
      // Validate and cap limit
      const limit = limitStr ? Math.min(parseInt(limitStr, 10), 100) : 50;

      if (isNaN(limit) || limit < 1) {
        throw new BadRequestException('Invalid limit parameter');
      }

      // Validate session exists before querying messages
      const session = await this.prisma.session.findUnique({
        where: { id: sessionId },
      });

      if (!session) {
        throw new NotFoundException(`Session ${sessionId} not found`);
      }

      this.logger.debug(
        `Fetching messages for session ${sessionId} (cursor: ${cursor || 'none'}, limit: ${limit}, includeDebug: ${includeDebug === 'true'})`,
      );

      return await this.sessionsService.getMessages(sessionId, {
        cursor,
        limit,
        before,
        includeDebug: includeDebug === 'true',
      });
    } catch (error) {
      this.logger.error(
        `Failed to get messages for session ${sessionId}:`,
        error.stack,
      );
      throw error;
    }
  }

  @Get('sessions/:sessionId/messages/latest')
  getLatestMessages(
    @Param('sessionId') sessionId: string,
    @Query('since') since?: string,
  ) {
    if (!since) {
      return { messages: [] };
    }
    return this.sessionsService.getMessagesSince(sessionId, since);
  }

  @Get('sessions/:sessionId/transcript/types')
  async getTranscriptMessageTypes(@Param('sessionId') sessionId: string) {
    return this.sessionsService.getTranscriptMessageTypes(sessionId);
  }

  @Get('sessions/:sessionId/transcript')
  async exportTranscript(
    @Param('sessionId') sessionId: string,
    @Res() res: Response,
    @Query('includeDebug') includeDebug?: string,
    @Query('includeMetadata') includeMetadata?: string,
    @Query('includeDeliverables') includeDeliverables?: string,
    @Query('mode') mode?: string,
    @Query('types') types?: string,
  ) {
    try {
      const allowedModes = ['transcript', 'verdicts', 'full', 'custom'] as const;
      type TranscriptMode = (typeof allowedModes)[number];
      const resolvedMode: TranscriptMode | undefined = allowedModes.includes(
        mode as TranscriptMode,
      )
        ? (mode as TranscriptMode)
        : undefined;

      const parsedTypes = types
        ? types.split(',').map((t) => t.trim()).filter(Boolean)
        : undefined;

      const transcript = await this.sessionsService.exportTranscript(sessionId, {
        includeDebug: includeDebug === 'true',
        includeMetadata: includeMetadata === 'true',
        includeDeliverables: includeDeliverables !== 'false',
        mode: resolvedMode,
        types: parsedTypes,
      });

      // Generate filename with session name or ID; suffix reflects export mode.
      const sessionName = transcript.meta.sessionName || sessionId;
      const safeName = sessionName.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
      const modeSuffix =
        transcript.meta.mode === 'verdicts'
          ? '-with-verdicts'
          : transcript.meta.mode === 'full'
            ? '-full'
            : transcript.meta.mode === 'custom'
              ? '-custom'
              : '';
      const filename = `transcript-${safeName}${modeSuffix}-${new Date().toISOString().split('T')[0]}.json`;

      // Set response headers for file download
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      // Send the JSON data
      res.send(JSON.stringify(transcript, null, 2));
    } catch (error) {
      this.logger.error(
        `Failed to export transcript for session ${sessionId}:`,
        error.stack,
      );
      throw error;
    }
  }

  // Listener monitoring endpoint
  @Get('sessions/:sessionId/listener-status')
  getListenerStatus(@Param('sessionId') sessionId: string) {
    return this.sessionsService.getListenerStatus(sessionId);
  }

  // Batch listener status endpoint - reduces N requests to 1
  @Post('sessions/listener-status/batch')
  getBatchListenerStatus(@Body() dto: BatchListenerStatusDto) {
    return this.sessionsService.getBatchListenerStatus(dto.sessionIds);
  }

  // SSE endpoint for real-time session events (agent ready, agent failed, etc.)
  @Sse('sessions/:sessionId/events')
  streamSessionEvents(@Param('sessionId') sessionId: string): Observable<MessageEvent> {
    this.logger.log(`SSE connection opened for session ${sessionId}`);
    return this.sessionsService.getSessionEventStream(sessionId);
  }

  /**
   * SSE endpoint for real-time project events (session created, closed, deleted).
   * Used by SessionsDashboard for real-time updates when new participants join.
   */
  @Sse('projects/:projectId/sessions/events')
  streamProjectEvents(@Param('projectId') projectId: string): Observable<MessageEvent> {
    this.logger.log(`SSE connection opened for project ${projectId} session events`);
    return this.sessionsService.getProjectEventStream(projectId);
  }

  // Get monitoring logs
  @Get('monitoring/logs')
  getMonitoringLogs(@Query('sessionId') sessionId?: string): Promise<{
    logs: LogEntry[];
    total: number;
    sessionId: string | null;
  }> {
    return this.sessionsService.getMonitoringLogs(sessionId);
  }

  // Get global monitoring status
  @Get('monitoring/status')
  getMonitoringStatus() {
    return this.sessionsService.getMonitoringStatus();
  }

  // ============================================================================
  // Internal API Endpoints (for Python message recorder service)
  // Note: These routes are at /internal/* (excluded from global /api prefix)
  // ============================================================================

  /**
   * Get all active sessions that need monitoring.
   * Used by the Python message recorder to discover rooms to join.
   */
  @Public()
  @Get('internal/active-sessions')
  async getActiveSessions() {
    return this.sessionsService.findActiveSessions();
  }

  /**
   * Get rooms that the message recorder should join (smart sync mode).
   * Returns only sessions where recorderShouldJoin = true.
   * Used by Python message recorder for efficient room management.
   */
  @Public()
  @Get('internal/rooms-to-join')
  async getRoomsToJoin() {
    return this.sessionsService.findRoomsToJoin();
  }

  /**
   * Store a recorded message from the Python message recorder.
   * This replaces the WebRTC-based recording from the Node.js monitor.
   */
  @Public()
  @Post('internal/sessions/:sessionId/messages')
  async storeRecordedMessage(
    @Param('sessionId') sessionId: string,
    @Body() data: {
      message: any;
      participantIdentity?: string;
      participantName?: string;
    },
  ) {
    return this.sessionsService.storeRecordedMessage(
      sessionId,
      data.message,
      data.participantIdentity,
      data.participantName,
    );
  }

  /**
   * Store log entries from the Python message recorder.
   * Allows Python service to submit logs for display in the dashboard.
   */
  @Public()
  @Post('internal/monitoring/logs')
  async storeMonitoringLog(
    @Body() logData: {
      level: 'log' | 'debug' | 'warn' | 'error';
      message: string;
      sessionId?: string;
      data?: any;
    },
  ) {
    return this.sessionsService.storeMonitoringLog(logData);
  }

  /**
   * Update connection status from Python message recorder.
   * Allows Python service to report which sessions it's actively monitoring.
   */
  @Public()
  @Post('internal/monitoring/status')
  async updateMonitoringStatus(
    @Body() statusData: {
      connectedSessions: string[];
    },
  ) {
    return this.sessionsService.updateMonitoringStatus(statusData);
  }

  /**
   * Store participant join/leave events from Python message recorder.
   * Creates timeline messages for conversation playback.
   */
  @Public()
  @Post('internal/sessions/:sessionId/participant-events')
  async storeParticipantEvent(
    @Param('sessionId') sessionId: string,
    @Body() eventData: {
      eventType: 'joined' | 'left';
      participantIdentity: string;
      participantName?: string;
    },
  ) {
    return this.sessionsService.storeParticipantEvent(sessionId, eventData);
  }

  /**
   * Get chat history for an agent.
   *
   * This endpoint allows agents to fetch conversation history for their session.
   * The agent must provide a valid LiveKit JWT token in the Authorization header.
   *
   * Unlike other /internal/* endpoints, this one validates the agent's token
   * to ensure agents can only access their own session's history.
   *
   * Headers:
   *   - Authorization: Bearer <token> - Agent's LiveKit JWT token (required)
   *
   * Query parameters:
   *   - include_debug: boolean - Include debug/processing messages (default: false)
   *   - limit: number - Max messages to return (default: 100, max: 500)
   *   - before: string - ISO timestamp cursor for pagination
   *
   * Response:
   *   - messages: Array of messages with full envelope data
   *   - hasMore: boolean - Whether more messages exist
   *   - nextCursor: string | null - Cursor for next page
   */
  @Public()
  @Get('internal/sessions/:sessionId/chat-history')
  async getChatHistory(
    @Param('sessionId') sessionId: string,
    @Headers('authorization') authHeader: string,
    @Query('include_debug') includeDebug?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    // Extract token from Authorization header
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header. Expected: Bearer <token>');
    }
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix

    // Validate the agent's token and verify access to this session
    await this.sessionsService.validateAgentToken(token, sessionId);

    // Fetch and return chat history
    return this.sessionsService.getChatHistory(sessionId, {
      includeDebug: includeDebug === 'true',
      limit: limit ? parseInt(limit, 10) : undefined,
      before: before,
    });
  }
}
