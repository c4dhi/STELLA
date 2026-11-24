import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { UserMessagesService } from '../../user-messages/user-messages.service.js';
import { QueryMessagesDto } from '../../user-messages/dto/user-message.dto.js';
import {
  McpToolProvider,
  READ_ONLY,
  UPDATES,
  defineTool,
  idArg,
} from '../mcp.types.js';

const messageId = idArg('message', 'user_messages_list');

/** The user's own inbox: project invitations and similar notifications. Nothing here deletes. */
@Injectable()
export class UserMessagesTools implements McpToolProvider {
  constructor(private readonly userMessages: UserMessagesService) {}

  tools() {
    return [
      defineTool({
        name: 'user_messages_list',
        title: 'List inbox messages',
        description:
          "The caller's own inbox (project invitations and similar notifications), newest first. Page with " +
          'page and limit (at most 100).',
        scope: 'mcp:read',
        input: {
          page: z.number().int().min(1).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        },
        annotations: READ_ONLY,
        handler: async (query, ctx) => {
          const page = await this.userMessages.getMessages(
            ctx.auth.user.userId,
            await ctx.validate(QueryMessagesDto, query),
          );
          return { ...page };
        },
      }),
      defineTool({
        name: 'user_messages_unread_count_get',
        title: 'Get unread inbox count',
        description: "The caller's number of unread inbox messages.",
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async (_args, ctx) => {
          return { ...(await this.userMessages.getUnreadCount(ctx.auth.user.userId)) };
        },
      }),
      defineTool({
        name: 'user_messages_mark_read',
        title: 'Mark an inbox message read',
        description: 'Mark one of the caller\'s own inbox messages as read.',
        scope: 'mcp:write',
        input: { messageId },
        annotations: UPDATES,
        handler: async ({ messageId }, ctx) => {
          return {
            ...(await this.userMessages.markAsRead(
              ctx.auth.user.userId,
              messageId,
            )),
          };
        },
      }),
    ];
  }
}
