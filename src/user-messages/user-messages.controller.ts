import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Query,
  ValidationPipe,
  UsePipes,
  HttpCode,
  HttpStatus,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { UserMessagesService } from './user-messages.service.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { QueryMessagesDto } from './dto/user-message.dto.js';

@Controller('user/messages')
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class UserMessagesController {
  constructor(private readonly userMessagesService: UserMessagesService) {}

  /**
   * Get paginated messages for the current user
   */
  @Get()
  async getMessages(
    @CurrentUser() user: any,
    @Query() query: QueryMessagesDto,
  ) {
    return this.userMessagesService.getMessages(user.userId, query);
  }

  /**
   * Get unread message count for the current user
   */
  @Get('unread-count')
  async getUnreadCount(@CurrentUser() user: any) {
    return this.userMessagesService.getUnreadCount(user.userId);
  }

  /**
   * Mark a message as read
   */
  @Patch(':messageId/read')
  async markAsRead(
    @CurrentUser() user: any,
    @Param('messageId') messageId: string,
  ) {
    return this.userMessagesService.markAsRead(user.userId, messageId);
  }

  /**
   * Delete a message
   */
  @Delete(':messageId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMessage(
    @CurrentUser() user: any,
    @Param('messageId') messageId: string,
  ) {
    await this.userMessagesService.deleteMessage(user.userId, messageId);
  }

  /**
   * SSE endpoint for real-time user notifications.
   * Events include: message.created, message.deleted, unread_count.changed
   */
  @Sse('events')
  streamNotifications(@CurrentUser() user: any): Observable<MessageEvent> {
    return this.userMessagesService.getUserNotificationStream(user.userId);
  }
}
