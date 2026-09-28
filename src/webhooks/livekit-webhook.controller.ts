import {
  Controller,
  Post,
  Headers,
  Logger,
  HttpCode,
  HttpStatus,
  Body,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Public } from '../common/decorators/public.decorator.js';
import { WebhookReceiver } from 'livekit-server-sdk';
import type { Request } from 'express';

/**
 * LiveKit webhook event types
 * https://docs.livekit.io/server/webhooks/
 */
interface LiveKitWebhookEvent {
  event: string;
  room?: {
    name: string;
    sid: string;
    emptyTimeout: number;
    maxParticipants: number;
    creationTime: number;
    metadata: string;
    numParticipants: number;
    numPublishers: number;
  };
  participant?: {
    sid: string;
    identity: string;
    name: string;
    state: string;
    metadata: string;
    joinedAt: number;
    permission?: {
      canSubscribe: boolean;
      canPublish: boolean;
      canPublishData: boolean;
    };
  };
  track?: {
    sid: string;
    type: string;
    source: string;
    mimeType: string;
    muted: boolean;
  };
  id: string;
  createdAt: number;
}

/**
 * LiveKit Webhook Controller
 *
 * Handles webhook events from LiveKit server for participant tracking.
 * This replaces the need for session-management-server to join LiveKit rooms.
 *
 * Events handled:
 * - participant_joined: User joined the room
 * - participant_left: User left the room
 * - room_started: Room was created
 * - room_finished: Room was destroyed (all participants left)
 * - track_published: Participant published a track
 * - track_unpublished: Participant unpublished a track
 *
 * Configure LiveKit to send webhooks to:
 * POST /webhooks/livekit
 */
@Controller('webhooks/livekit')
export class LiveKitWebhookController {
  private readonly logger = new Logger(LiveKitWebhookController.name);
  private readonly webhookReceiver: WebhookReceiver;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    const apiKey = this.configService.get<string>('LIVEKIT_API_KEY', '');
    const apiSecret = this.configService.get<string>('LIVEKIT_API_SECRET', '');

    this.webhookReceiver = new WebhookReceiver(apiKey, apiSecret);

    if (!apiKey || !apiSecret) {
      this.logger.warn(
        'LIVEKIT_API_KEY or LIVEKIT_API_SECRET not set - webhook verification may fail',
      );
    }
  }

  @Public()
  @Post()
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Req() req: Request,
    @Body() body: string | Buffer | object,
    @Headers('authorization') authHeader: string,
    @Headers('content-type') contentType: string,
  ): Promise<{ received: boolean }> {
    // Debug logging
    this.logger.debug(`Webhook content-type: ${contentType}`);
    this.logger.debug(`Webhook body type: ${typeof body}`);
    this.logger.debug(`Webhook body: ${JSON.stringify(body)?.substring(0, 200)}`);
    this.logger.debug(`Webhook req.body type: ${typeof req.body}`);
    this.logger.debug(`Webhook req.body: ${JSON.stringify(req.body)?.substring(0, 200)}`);
    this.logger.debug(`Webhook authHeader: ${authHeader?.substring(0, 50)}...`);

    // Get raw body as string - LiveKit sends webhooks as JWT-encoded data
    let rawBody: string;
    if (typeof body === 'string') {
      rawBody = body;
    } else if (Buffer.isBuffer(body)) {
      rawBody = body.toString('utf-8');
    } else if (typeof req.body === 'string') {
      rawBody = req.body;
    } else if (body && typeof body === 'object') {
      // Body was already parsed as JSON - this shouldn't happen with proper config
      // but handle it just in case
      rawBody = JSON.stringify(body);
    } else {
      rawBody = '';
    }

    if (!rawBody || rawBody === '{}') {
      this.logger.warn('Empty webhook body received');
      return { received: false };
    }

    this.logger.debug(`Webhook raw body (first 200 chars): ${rawBody.substring(0, 200)}`);

    // Decode and verify the webhook using LiveKit SDK
    let event: LiveKitWebhookEvent;
    try {
      const webhookEvent = await this.webhookReceiver.receive(
        rawBody,
        authHeader,
      );
      event = webhookEvent as unknown as LiveKitWebhookEvent;
    } catch (error) {
      this.logger.error(`Failed to verify webhook: ${error.message}`);
      return { received: false };
    }

    this.logger.log(`Received LiveKit webhook: ${event.event}`);

    try {
      switch (event.event) {
        case 'participant_joined':
          await this.handleParticipantJoined(event);
          break;

        case 'participant_left':
          await this.handleParticipantLeft(event);
          break;

        case 'room_started':
          await this.handleRoomStarted(event);
          break;

        case 'room_finished':
          await this.handleRoomFinished(event);
          break;

        case 'track_published':
          await this.handleTrackPublished(event);
          break;

        case 'track_unpublished':
          await this.handleTrackUnpublished(event);
          break;

        default:
          this.logger.debug(`Unhandled webhook event: ${event.event}`);
      }
    } catch (error) {
      this.logger.error(`Error handling webhook: ${error.message}`);
    }

    return { received: true };
  }

  private async handleParticipantJoined(
    event: LiveKitWebhookEvent,
  ): Promise<void> {
    const { room, participant } = event;
    if (!room || !participant) return;

    this.logger.log(
      `Participant joined: ${participant.identity} in room ${room.name}`,
    );

    // Skip message-recorder (it's infrastructure, not a real participant)
    if (participant.identity === 'message-recorder') {
      this.logger.debug(`Message recorder joined - skipping event emission`);
      return;
    }

    // Emit event for WebhooksService to handle (for ALL participants including agents)
    // This is needed for recorder join state tracking (agents are meaningful participants)
    this.eventEmitter.emit('livekit.participant.joined', {
      roomName: room.name,
      participantIdentity: participant.identity,
      participantSid: participant.sid,
      participantName: participant.name,
      metadata: participant.metadata,
      joinedAt: participant.joinedAt,
    });

    // Emit SSE event for frontend (skip agents - they're tracked differently)
    if (!participant.identity.startsWith('agent-')) {
      this.eventEmitter.emit('sse.event', {
        sessionId: room.name, // Room name is typically the session ID
        event: 'participant.joined',
        data: {
          identity: participant.identity,
          name: participant.name,
        },
      });
    }
  }

  private async handleParticipantLeft(
    event: LiveKitWebhookEvent,
  ): Promise<void> {
    const { room, participant } = event;
    if (!room || !participant) return;

    this.logger.log(
      `Participant left: ${participant.identity} from room ${room.name}`,
    );

    // Skip message-recorder (it's infrastructure, not a real participant)
    if (participant.identity === 'message-recorder') {
      this.logger.debug(`Message recorder left - skipping event emission`);
      return;
    }

    // Emit event for WebhooksService to handle (for ALL participants including agents)
    // This is needed for recorder leave state tracking
    this.eventEmitter.emit('livekit.participant.left', {
      roomName: room.name,
      participantIdentity: participant.identity,
      participantSid: participant.sid,
    });

    // Emit SSE event for frontend (skip agents - they're tracked differently)
    if (!participant.identity.startsWith('agent-')) {
      this.eventEmitter.emit('sse.event', {
        sessionId: room.name,
        event: 'participant.left',
        data: {
          identity: participant.identity,
        },
      });
    }

    // Check if room is now empty (no users, only agents or empty)
    // Note: numParticipants includes the message-recorder, so we check <= 1
    if (room.numParticipants <= 1) {
      this.logger.log(`Room ${room.name} has no meaningful participants left`);
      this.eventEmitter.emit('livekit.room.empty', {
        roomName: room.name,
      });
    }
  }

  private async handleRoomStarted(event: LiveKitWebhookEvent): Promise<void> {
    const { room } = event;
    if (!room) return;

    this.logger.log(`Room started: ${room.name}`);

    this.eventEmitter.emit('livekit.room.started', {
      roomName: room.name,
      roomSid: room.sid,
      creationTime: room.creationTime,
    });
  }

  private async handleRoomFinished(event: LiveKitWebhookEvent): Promise<void> {
    const { room } = event;
    if (!room) return;

    this.logger.log(`Room finished: ${room.name}`);

    // Room is destroyed - trigger cleanup
    this.eventEmitter.emit('livekit.room.finished', {
      roomName: room.name,
      roomSid: room.sid,
    });

    // Emit SSE event for frontend
    this.eventEmitter.emit('sse.event', {
      sessionId: room.name,
      event: 'session.ended',
      data: {
        reason: 'room_finished',
      },
    });
  }

  private async handleTrackPublished(
    event: LiveKitWebhookEvent,
  ): Promise<void> {
    const { room, participant, track } = event;
    if (!room || !participant || !track) return;

    this.logger.debug(
      `Track published: ${track.type} by ${participant.identity} in ${room.name}`,
    );

    // Track events can be used for monitoring but typically don't require action
    this.eventEmitter.emit('livekit.track.published', {
      roomName: room.name,
      participantIdentity: participant.identity,
      trackSid: track.sid,
      trackType: track.type,
      trackSource: track.source,
    });
  }

  private async handleTrackUnpublished(
    event: LiveKitWebhookEvent,
  ): Promise<void> {
    const { room, participant, track } = event;
    if (!room || !participant || !track) return;

    this.logger.debug(
      `Track unpublished: ${track.type} by ${participant.identity} in ${room.name}`,
    );

    this.eventEmitter.emit('livekit.track.unpublished', {
      roomName: room.name,
      participantIdentity: participant.identity,
      trackSid: track.sid,
    });
  }
}
