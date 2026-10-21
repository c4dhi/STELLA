import { Injectable } from '@nestjs/common';
import { SessionStatus } from '@prisma/client';
import { z } from 'zod';
import { ResourceAccessService } from '../../auth/resource-access.service.js';
import { ProjectsService } from '../../projects/projects.service.js';
import { SessionsService } from '../../sessions/sessions.service.js';
import { QuerySessionsDto } from '../../sessions/dto/query-sessions.dto.js';
import { StateMachineService } from '../../state-machine/state-machine.service.js';
import { McpToolProvider, READ_ONLY, defineTool } from '../mcp.types.js';

/** Projects and their sessions: read-only, and only where the user is a member. */
@Injectable()
export class SessionsTools implements McpToolProvider {
  constructor(
    private readonly projects: ProjectsService,
    private readonly sessions: SessionsService,
    private readonly stateMachine: StateMachineService,
    private readonly access: ResourceAccessService,
  ) {}

  tools() {
    return [
      defineTool({
        name: 'projects_list',
        title: 'List projects',
        description: 'Projects the user is a member of. Sessions live in projects.',
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async (_args, { auth }) => ({ items: await this.projects.findAll(auth.user.userId) }),
      }),
      defineTool({
        name: 'sessions_list',
        title: 'List sessions',
        description: 'Sessions in a project, newest first. Page with skip and take (at most 100).',
        scope: 'mcp:read',
        input: {
          projectId: z.string(),
          status: z.enum(Object.values(SessionStatus) as [SessionStatus, ...SessionStatus[]]).optional(),
          search: z.string().optional().describe('Matches the session or room name'),
          skip: z.number().int().min(0).optional(),
          take: z.number().int().min(1).max(100).optional(),
        },
        annotations: READ_ONLY,
        handler: async ({ projectId, ...query }, ctx) => {
          this.access.assertProjectMember(ctx.auth.user, projectId);
          return this.sessions.findAll(projectId, await ctx.validate(QuerySessionsDto, query));
        },
      }),
      defineTool({
        name: 'session_transcript_get',
        title: 'Get a session transcript',
        description:
          'Messages of a session in time order, oldest first, one page at a time. Pass nextCursor back as cursor ' +
          'to get the page before. includeDebug adds agent-internal messages (expert decisions, plan updates).',
        scope: 'mcp:read',
        input: {
          sessionId: z.string(),
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          includeDebug: z.boolean().optional(),
        },
        annotations: READ_ONLY,
        handler: async ({ sessionId, cursor, limit, includeDebug }, { auth }) => {
          await this.access.assertSessionAccess(auth.user, sessionId);
          const page = await this.sessions.getMessages(sessionId, { cursor, limit: limit ?? 50, includeDebug });
          return {
            messages: page.messages.map((m) => ({
              id: m.id,
              timestamp: m.timestamp,
              role: m.role,
              messageType: m.messageType,
              content: m.content,
              ...(includeDebug ? { metadata: m.metadata } : {}),
            })),
            hasMore: page.hasMore,
            nextCursor: page.nextCursor,
          };
        },
      }),
      defineTool({
        name: 'session_state_get',
        title: 'Get a session plan state',
        description:
          'Where a session stands in its plan: current state, progress, turn counters, task status per state ' +
          'and collected deliverables. null when the session never ran a plan.',
        scope: 'mcp:read',
        input: { sessionId: z.string() },
        annotations: READ_ONLY,
        handler: async ({ sessionId }, { auth }) => {
          await this.access.assertSessionAccess(auth.user, sessionId);
          return { state: await this.stateMachine.getFullState(sessionId) };
        },
      }),
    ];
  }
}
