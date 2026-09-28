import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service.js';
import { Message, Prisma } from '@prisma/client';

export interface RecordMessageDto {
  sessionId: string;
  content: string;
  messageType: string;
  role?: string;
  status?: string;
  metadata?: any;
  timestamp: Date;
}

@Injectable()
export class MessageRecorderService {
  private readonly logger = new Logger(MessageRecorderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Record a message to the database
   */
  async recordMessage(data: RecordMessageDto): Promise<Message> {
    try {
      const message = await this.prisma.message.create({
        data: {
          sessionId: data.sessionId,
          content: data.content,
          messageType: data.messageType,
          role: data.role,
          status: data.status,
          metadata: data.metadata ? (data.metadata as Prisma.InputJsonValue) : Prisma.JsonNull,
          timestamp: data.timestamp,
        },
      });

      this.logger.debug(
        `Recorded message ${message.id} (${data.messageType}) for session ${data.sessionId}`,
      );

      // Anchor the max-duration cap on the first agent message (issue #198).
      // SessionTimeoutService dedupes via an in-memory guard, so emitting on every
      // agent message is cheap and only the first one arms the timer.
      if (data.role === 'assistant') {
        this.eventEmitter.emit('session.agent-message', { sessionId: data.sessionId });
      }

      return message;
    } catch (error) {
      this.logger.error(`Failed to record message: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Record a transcript chunk
   */
  async recordTranscript(
    sessionId: string,
    transcript: {
      text: string;
      participant_id?: string;
      is_final: boolean;
      timestamp?: string;
      role?: string;
    },
  ): Promise<Message | null> {
    // Only record final transcripts
    if (!transcript.is_final) {
      return null;
    }

    return this.recordMessage({
      sessionId,
      content: transcript.text,
      messageType: 'transcript',
      role: transcript.role || (transcript.participant_id === 'human' ? 'user' : 'assistant'),
      status: 'final',
      timestamp: transcript.timestamp ? new Date(transcript.timestamp) : new Date(),
    });
  }

  /**
   * Record a complete todo list update
   */
  async recordTodoListUpdate(
    sessionId: string,
    participantId: string,
    todoData: any,
  ): Promise<Message> {
    const summary = this.generateTodoListSummary(todoData);

    return this.recordMessage({
      sessionId,
      content: summary,
      messageType: 'task_update',
      role: 'system',
      status: 'final',
      metadata: todoData,
      timestamp: new Date(),
    });
  }

  /**
   * Record a deliverable update
   */
  async recordDeliverable(
    sessionId: string,
    participantId: string,
    deliverable: {
      deliverable_key: string;
      deliverable_value: string;
      state_id?: string;
      confidence?: number;
      reasoning?: string;
    },
  ): Promise<Message> {
    const content = `Deliverable collected: ${deliverable.deliverable_key} = ${deliverable.deliverable_value}`;

    return this.recordMessage({
      sessionId,
      content,
      messageType: 'deliverable',
      role: 'system',
      status: 'final',
      metadata: deliverable,
      timestamp: new Date(),
    });
  }

  /**
   * Record a state change notification
   */
  async recordStateChange(
    sessionId: string,
    participantId: string,
    stateChange: {
      previous_state: string;
      current_state: string;
      state_title: string;
    },
  ): Promise<Message> {
    const content = `State transition: ${stateChange.previous_state} → ${stateChange.current_state}: ${stateChange.state_title}`;

    return this.recordMessage({
      sessionId,
      content,
      messageType: 'state_change',
      role: 'system',
      status: 'final',
      metadata: stateChange,
      timestamp: new Date(),
    });
  }

  /**
   * Record a participant event (joined/left)
   */
  async recordParticipantEvent(
    sessionId: string,
    event: {
      type: 'joined' | 'left';
      participantId: string;
      participantName?: string;
    },
  ): Promise<Message> {
    const content = event.type === 'joined'
      ? `${event.participantName || event.participantId} joined the session`
      : `${event.participantName || event.participantId} left the session`;

    return this.recordMessage({
      sessionId,
      content,
      messageType: 'participant_event',
      role: 'system',
      status: 'final',
      metadata: event,
      timestamp: new Date(),
    });
  }

  /**
   * Generate a human-readable summary of a todo list
   */
  private generateTodoListSummary(todoData: any): string {
    if (!todoData || !todoData.todo_list) {
      return 'Task list updated';
    }

    const todoList = todoData.todo_list;
    const currentState = todoList.current_state;
    const totalStates = todoList.total_states || todoList.states?.length || 0;

    if (currentState) {
      return `Current task: ${currentState.title} (${currentState.completion_percentage || 0}% complete, ${totalStates} states total)`;
    }

    return `Task list with ${totalStates} states`;
  }
}
