import { Injectable, Logger, NotFoundException, ForbiddenException, MessageEvent } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { UserMessageType } from '@prisma/client';
import { Observable, Subject, ReplaySubject, filter, map, finalize } from 'rxjs';
import {
  QueryMessagesDto,
  UserMessageResponseDto,
  PaginatedMessagesResponseDto,
} from './dto/user-message.dto.js';

// Event types for user notifications
export interface UserNotificationEvent {
  type: 'message.created' | 'message.deleted' | 'unread_count.changed';
  userId: string;
  message?: UserMessageResponseDto;
  unreadCount?: number;
  timestamp: Date;
}

@Injectable()
export class UserMessagesService {
  private readonly logger = new Logger(UserMessagesService.name);

  // Maps userId -> Subject for SSE streaming
  private userEventSubjects = new Map<string, ReplaySubject<UserNotificationEvent>>();
  private subscriberCounts = new Map<string, number>();

  constructor(private prisma: PrismaService) {}

  /**
   * Get paginated messages for a user
   */
  async getMessages(
    userId: string,
    query: QueryMessagesDto,
  ): Promise<PaginatedMessagesResponseDto> {
    const { page = 1, limit = 20 } = query;
    const skip = (page - 1) * limit;

    const [messages, total] = await Promise.all([
      this.prisma.userMessage.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.userMessage.count({ where: { userId } }),
    ]);

    // Enrich messages with additional metadata based on type
    const enrichedMessages = await Promise.all(
      messages.map(async (msg) => await this.enrichMessage(msg)),
    );

    return {
      messages: enrichedMessages,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get unread message count for a user
   */
  async getUnreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma.userMessage.count({
      where: { userId, read: false },
    });
    return { count };
  }

  /**
   * Mark a message as read
   */
  async markAsRead(userId: string, messageId: string): Promise<UserMessageResponseDto> {
    const message = await this.prisma.userMessage.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      throw new NotFoundException(`Message with ID ${messageId} not found`);
    }

    if (message.userId !== userId) {
      throw new ForbiddenException('You do not have access to this message');
    }

    const updated = await this.prisma.userMessage.update({
      where: { id: messageId },
      data: { read: true },
    });

    return this.enrichMessage(updated);
  }

  /**
   * Delete a message
   */
  async deleteMessage(userId: string, messageId: string): Promise<void> {
    const message = await this.prisma.userMessage.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      throw new NotFoundException(`Message with ID ${messageId} not found`);
    }

    if (message.userId !== userId) {
      throw new ForbiddenException('You do not have access to this message');
    }

    await this.prisma.userMessage.delete({
      where: { id: messageId },
    });

    this.logger.log(`Message ${messageId} deleted by user ${userId}`);
  }

  /**
   * Create a project invitation message for a user
   */
  async createProjectInvitationMessage(
    inviteeId: string,
    inviterId: string,
    projectId: string,
    projectName: string,
    inviterName: string,
    invitationId: string,
  ): Promise<void> {
    const message = await this.prisma.userMessage.create({
      data: {
        userId: inviteeId,
        type: UserMessageType.PROJECT_INVITATION,
        title: `Invitation to collaborate on "${projectName}"`,
        body: `${inviterName} has invited you to collaborate on their project.`,
        relatedEntityId: invitationId,
        relatedEntityType: 'ProjectInvitation',
      },
    });

    this.logger.log(
      `Created project invitation message for user ${inviteeId} from ${inviterId} for project ${projectId}`,
    );

    // Emit real-time notification event
    const enrichedMessage = await this.enrichMessage(message);
    const unreadCount = await this.getUnreadCount(inviteeId);
    this.emitUserEvent(inviteeId, {
      type: 'message.created',
      userId: inviteeId,
      message: enrichedMessage,
      unreadCount: unreadCount.count,
      timestamp: new Date(),
    });
  }

  /**
   * Delete messages related to a specific entity
   */
  async deleteMessagesByEntity(
    entityId: string,
    entityType: string,
  ): Promise<void> {
    await this.prisma.userMessage.deleteMany({
      where: {
        relatedEntityId: entityId,
        relatedEntityType: entityType,
      },
    });
  }

  /**
   * Enrich a message with additional metadata based on its type
   */
  private async enrichMessage(message: any): Promise<UserMessageResponseDto> {
    const result: UserMessageResponseDto = {
      id: message.id,
      type: message.type,
      title: message.title,
      body: message.body,
      read: message.read,
      createdAt: message.createdAt,
      relatedEntityId: message.relatedEntityId,
      relatedEntityType: message.relatedEntityType,
    };

    // Enrich based on message type
    if (
      message.type === UserMessageType.PROJECT_INVITATION &&
      message.relatedEntityId
    ) {
      const invitation = await this.prisma.projectInvitation.findUnique({
        where: { id: message.relatedEntityId },
        include: {
          project: { select: { id: true, name: true } },
          inviter: { select: { name: true, email: true } },
        },
      });

      if (invitation) {
        result.metadata = {
          projectId: invitation.project.id,
          projectName: invitation.project.name,
          inviterName: invitation.inviter.name || invitation.inviter.email,
          inviterEmail: invitation.inviter.email,
          invitationId: invitation.id,
        };
      }
    }

    return result;
  }

  // ============================================================================
  // SSE Real-time Notification Methods
  // ============================================================================

  /**
   * Get an Observable stream of user notification events for SSE.
   * Events include message.created, message.deleted, unread_count.changed
   */
  getUserNotificationStream(userId: string): Observable<MessageEvent> {
    let subject = this.userEventSubjects.get(userId);
    if (!subject) {
      subject = new ReplaySubject<UserNotificationEvent>(5, 30000); // Buffer 5 events, 30 second window
      this.userEventSubjects.set(userId, subject);
      this.subscriberCounts.set(userId, 0);
    }

    const currentCount = this.subscriberCounts.get(userId) || 0;
    this.subscriberCounts.set(userId, currentCount + 1);
    this.logger.log(`SSE subscriber added for user ${userId} notifications (total: ${currentCount + 1})`);

    return subject.asObservable().pipe(
      filter((event) => event.userId === userId),
      map((event) => ({
        data: JSON.stringify(event),
        id: `${Date.now()}`,
      })),
      finalize(() => {
        const count = this.subscriberCounts.get(userId) || 1;
        this.subscriberCounts.set(userId, count - 1);
        this.logger.log(`SSE subscriber removed for user ${userId} notifications (remaining: ${count - 1})`);

        if (count - 1 <= 0) {
          this.userEventSubjects.delete(userId);
          this.subscriberCounts.delete(userId);
          this.logger.log(`SSE subject cleaned up for user ${userId} notifications`);
        }
      }),
    );
  }

  /**
   * Emit an event to all subscribers for a user
   */
  private emitUserEvent(userId: string, event: UserNotificationEvent): void {
    const subject = this.userEventSubjects.get(userId);
    if (subject) {
      subject.next(event);
      this.logger.debug(`Emitted ${event.type} event for user ${userId}`);
    }
  }

  /**
   * Emit unread count changed event (can be called externally)
   */
  async emitUnreadCountChanged(userId: string): Promise<void> {
    const unreadCount = await this.getUnreadCount(userId);
    this.emitUserEvent(userId, {
      type: 'unread_count.changed',
      userId,
      unreadCount: unreadCount.count,
      timestamp: new Date(),
    });
  }
}
