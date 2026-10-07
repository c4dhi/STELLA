import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Room, RoomEvent, RemoteParticipant } from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { PrismaService } from '../prisma/prisma.service.js';
import { MessageRecorderService } from './message-recorder.service.js';

interface RoomConnection {
  room: Room;
  sessionId: string;
  reconnectAttempts: number;
}

export interface LogEntry {
  timestamp: Date;
  level: 'log' | 'debug' | 'warn' | 'error';
  message: string;
  sessionId?: string;
  data?: any;
}

@Injectable()
export class RoomMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomMonitorService.name);
  private readonly roomConnections = new Map<string, RoomConnection>();
  private readonly MONITOR_IDENTITY = 'message-recorder';
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private isShuttingDown = false;
  private readonly logBuffer: LogEntry[] = [];
  private readonly MAX_LOG_ENTRIES = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly messageRecorder: MessageRecorderService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit() {
    // Node.js monitor is disabled - message recording is handled by Python service
    this.addLog('log', 'Room Monitor Service initialized (disabled - using Python message recorder)');
  }

  async onModuleDestroy() {
    this.addLog('log', 'Room Monitor Service shutting down...');
    this.isShuttingDown = true;
    await this.disconnectAll();
  }

  /**
   * Start monitoring all active sessions
   */
  async startMonitoringAllActiveSessions() {
    try {
      const activeSessions = await this.prisma.session.findMany({
        where: { status: 'ACTIVE' },
        include: { room: true },
      });

      this.addLog('log', `Found ${activeSessions.length} active sessions to monitor`);

      for (const session of activeSessions) {
        if (session.room) {
          // Don't let one failure block others
          this.monitorSession(session.id, session.room.livekitRoomName).catch(error => {
            this.addLog('error', `Failed to start monitoring session ${session.id}`, session.id, { error: error.message });
          });
        }
      }
    } catch (error) {
      this.addLog('error', 'Failed to load active sessions', undefined, { error: error.message });
    }
  }

  /**
   * Start monitoring a specific session
   */
  async monitorSession(sessionId: string, roomName: string): Promise<boolean> {
    // Check if already monitoring
    if (this.roomConnections.has(sessionId)) {
      this.logger.warn(`Already monitoring session ${sessionId}`);
      return true;
    }

    try {
      this.addLog('log', `Starting to monitor session ${sessionId} in room ${roomName}`, sessionId);

      // Create LiveKit room connection
      const room = new Room();

      // Set up event handlers BEFORE connecting
      this.setupRoomEventHandlers(room, sessionId);

      // Generate access token for the monitor
      const token = await this.generateAccessToken(roomName);

      // Connect to the room - explicitly disable media track subscription
      const livekitUrl = this.configService.get<string>('LIVEKIT_URL') || 'ws://livekit:7880';
      await room.connect(livekitUrl, token, {
        autoSubscribe: false, // Don't auto-subscribe to any tracks
        dynacast: false, // Disable dynamic broadcasting
      });

      // Store connection
      this.roomConnections.set(sessionId, {
        room,
        sessionId,
        reconnectAttempts: 0,
      });

      this.addLog('log', `Successfully connected to room ${roomName} for session ${sessionId}`, sessionId);
      return true;
    } catch (error) {
      this.addLog('error', `Failed to monitor session ${sessionId}`, sessionId, { error: error.message, stack: error.stack });
      return false;
    }
  }

  /**
   * Stop monitoring a session
   */
  async stopMonitoring(sessionId: string): Promise<void> {
    const connection = this.roomConnections.get(sessionId);
    if (!connection) {
      return;
    }

    this.logger.log(`Stopping monitoring for session ${sessionId}`);

    try {
      await connection.room.disconnect();
    } catch (error) {
      this.logger.error(`Error disconnecting from session ${sessionId}:`, error.stack);
    } finally {
      this.roomConnections.delete(sessionId);
    }
  }

  /**
   * Disconnect from all rooms
   */
  private async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.roomConnections.keys()).map(sessionId =>
      this.stopMonitoring(sessionId),
    );

    await Promise.all(disconnectPromises);
    this.logger.log('Disconnected from all rooms');
  }

  /**
   * Set up event handlers for a room
   */
  private setupRoomEventHandlers(room: Room, sessionId: string): void {
    // Handle connection
    room.on(RoomEvent.Connected, () => {
      this.addLog('log', `✅ Connected to room for session ${sessionId}`, sessionId, {
        isConnected: true,
        participants: room.remoteParticipants.size,
      });
    });

    // Handle disconnection
    room.on(RoomEvent.Disconnected, async (reason) => {
      this.addLog('warn', `⚠️ Disconnected from session ${sessionId}: ${reason}`, sessionId);

      // Attempt reconnection if not shutting down
      if (!this.isShuttingDown) {
        await this.handleDisconnection(sessionId);
      }
    });

    // Handle incoming data messages (THIS IS THE CORE MESSAGE RECORDING LOGIC)
    room.on(RoomEvent.DataReceived, async (payload: Uint8Array, participant) => {
      try {
        const decoder = new TextDecoder();
        const messageText = decoder.decode(payload);
        const envelope = JSON.parse(messageText);

        this.addLog('debug', `📨 Data received in session ${sessionId}`, sessionId, {
          type: envelope.type,
          from: participant?.identity,
          size: payload.length,
        });

        await this.processMessage(sessionId, envelope, participant?.identity);
      } catch (error) {
        this.addLog('error', `❌ Error processing data for session ${sessionId}`, sessionId, {
          error: error.message,
        });
      }
    });

    // Track participant events
    room.on(RoomEvent.ParticipantConnected, async (participant) => {
      // Skip recording for the monitor itself
      if (participant.identity === this.MONITOR_IDENTITY) {
        return;
      }

      this.logger.debug(`Participant ${participant.identity} joined session ${sessionId}`);

      await this.messageRecorder.recordParticipantEvent(sessionId, {
        type: 'joined',
        participantId: participant.identity,
        participantName: participant.name,
      });
    });

    room.on(RoomEvent.ParticipantDisconnected, async (participant) => {
      // Skip recording for the monitor itself
      if (participant.identity === this.MONITOR_IDENTITY) {
        return;
      }

      this.logger.debug(`Participant ${participant.identity} left session ${sessionId}`);

      await this.messageRecorder.recordParticipantEvent(sessionId, {
        type: 'left',
        participantId: participant.identity,
        participantName: participant.name,
      });
    });
  }

  /**
   * Process an incoming message and decide whether to record it
   */
  private async processMessage(
    sessionId: string,
    envelope: any,
    participantIdentity?: string,
  ): Promise<void> {
    const messageType = envelope.type;

    try {
      switch (messageType) {
        case 'transcript':
        case 'transcript_chunk':
          await this.messageRecorder.recordTranscript(sessionId, envelope.data);
          break;

        case 'complete_todo_list':
          await this.messageRecorder.recordTodoListUpdate(
            sessionId,
            participantIdentity || 'system',
            envelope.data,
          );
          break;

        case 'plan_deliverable_update':
          await this.messageRecorder.recordDeliverable(
            sessionId,
            participantIdentity || 'system',
            envelope.data,
          );
          break;

        case 'state_change_notification':
          await this.messageRecorder.recordStateChange(
            sessionId,
            participantIdentity || 'system',
            envelope.data,
          );
          break;

        case 'progress_update':
          // Store SDK progress updates (stella-v2) as todo list updates
          // so historical replay and time machine work for closed sessions.
          // Store the full envelope so buildTaskUpdateTimeline can identify the type.
          await this.messageRecorder.recordTodoListUpdate(
            sessionId,
            participantIdentity || 'system',
            { envelope, participant_id: participantIdentity },
          );
          break;

        // Ignore these message types (don't record):
        case 'tts_start':
        case 'tts_stop':
        case 'tts_end':
        case 'tts_paused':
        case 'tts_resumed':
        case 'audio_stream_chunk':
        case 'audio_stream_start':
        case 'audio_stream_stop':
        case 'audio_stream_mute':
          // Skip audio control messages
          break;

        default:
          // Log unknown message types for debugging
          this.logger.debug(`Unknown message type: ${messageType}`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to process message type ${messageType} for session ${sessionId}:`,
        error.stack,
      );
    }
  }

  /**
   * Handle disconnection and attempt reconnection
   */
  private async handleDisconnection(sessionId: string): Promise<void> {
    const connection = this.roomConnections.get(sessionId);
    if (!connection) {
      return;
    }

    if (connection.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.logger.error(
        `Max reconnection attempts reached for session ${sessionId}, giving up`,
      );
      this.roomConnections.delete(sessionId);
      return;
    }

    connection.reconnectAttempts++;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s
    const backoffMs = Math.min(1000 * Math.pow(2, connection.reconnectAttempts - 1), 16000);

    this.logger.log(
      `Attempting reconnection ${connection.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} for session ${sessionId} in ${backoffMs}ms`,
    );

    setTimeout(async () => {
      try {
        // Get fresh session data
        const session = await this.prisma.session.findUnique({
          where: { id: sessionId },
          include: { room: true },
        });

        if (!session || session.status !== 'ACTIVE' || !session.room) {
          this.logger.log(`Session ${sessionId} is no longer active or has no room, stopping monitoring`);
          this.roomConnections.delete(sessionId);
          return;
        }

        // Remove old connection and create new one
        this.roomConnections.delete(sessionId);
        await this.monitorSession(sessionId, session.room.livekitRoomName);
      } catch (error) {
        this.logger.error(`Reconnection failed for session ${sessionId}:`, error.stack);
        await this.handleDisconnection(sessionId); // Retry
      }
    }, backoffMs);
  }

  /**
   * Generate access token for the monitor
   */
  private async generateAccessToken(roomName: string): Promise<string> {
    const apiKey = this.configService.get<string>('LIVEKIT_API_KEY') || 'devkey';
    const apiSecret = this.configService.get<string>('LIVEKIT_API_SECRET') || 'secret';

    const at = new AccessToken(apiKey, apiSecret, {
      identity: this.MONITOR_IDENTITY,
      name: 'Message Recorder',
    });

    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: false, // Monitor doesn't publish anything
      canSubscribe: false, // Don't subscribe to media tracks (audio/video)
      canPublishData: false, // Monitor only receives data
    });

    return at.toJwt();
  }

  /**
   * Check if a session is being monitored
   */
  isMonitoring(sessionId: string): boolean {
    return this.roomConnections.has(sessionId);
  }

  /**
   * Get monitoring statistics
   */
  getStats() {
    return {
      totalConnections: this.roomConnections.size,
      sessions: Array.from(this.roomConnections.entries()).map(([sessionId, conn]) => ({
        sessionId,
        reconnectAttempts: conn.reconnectAttempts,
        roomState: conn.room.isConnected ? 'connected' : 'disconnected',
        isConnected: conn.room.isConnected,
      })),
    };
  }

  /**
   * Get detailed status for a specific session
   */
  getSessionStatus(sessionId: string): {
    isMonitoring: boolean;
    isConnected: boolean;
    roomState: string;
    participantIdentity: string;
    reconnectAttempts: number;
    remoteParticipants?: number;
  } | null {
    const connection = this.roomConnections.get(sessionId);

    if (!connection) {
      return {
        isMonitoring: false,
        isConnected: false,
        roomState: 'not_monitoring',
        participantIdentity: this.MONITOR_IDENTITY,
        reconnectAttempts: 0,
      };
    }

    return {
      isMonitoring: true,
      isConnected: connection.room.isConnected,
      roomState: connection.room.isConnected ? 'connected' : 'disconnected',
      participantIdentity: this.MONITOR_IDENTITY,
      reconnectAttempts: connection.reconnectAttempts,
      remoteParticipants: connection.room.remoteParticipants.size,
    };
  }

  /**
   * Add a log entry to the buffer and also log to console
   * Public method to allow external services (like Python recorder) to submit logs
   */
  addLog(
    level: 'log' | 'debug' | 'warn' | 'error',
    message: string,
    sessionId?: string,
    data?: any,
  ): void {
    // Add to buffer
    this.logBuffer.push({
      timestamp: new Date(),
      level,
      message,
      sessionId,
      data,
    });

    // Trim buffer if too large
    if (this.logBuffer.length > this.MAX_LOG_ENTRIES) {
      this.logBuffer.shift();
    }

    // Also log to console using NestJS logger
    const logMessage = sessionId
      ? `[Session: ${sessionId}] ${message}`
      : message;

    if (data) {
      this.logger[level](logMessage, data);
    } else {
      this.logger[level](logMessage);
    }
  }

  /**
   * Get logs from the buffer, optionally filtered by session ID
   */
  getLogs(sessionId?: string): LogEntry[] {
    if (sessionId) {
      return this.logBuffer.filter(log => log.sessionId === sessionId);
    }
    return [...this.logBuffer];
  }
}
