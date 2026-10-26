import { Injectable } from '@nestjs/common';
import { SessionStatus } from '@prisma/client';
import { z } from 'zod';
import { ResourceAccessService } from '../../auth/resource-access.service.js';
import { ProjectsService } from '../../projects/projects.service.js';
import { SessionsService } from '../../sessions/sessions.service.js';
import { QuerySessionsDto } from '../../sessions/dto/query-sessions.dto.js';
import { CreateSessionDto } from '../../sessions/dto/create-session.dto.js';
import { UpdateSessionDto } from '../../sessions/dto/update-session.dto.js';
import { InvitationsService } from '../../invitations/invitations.service.js';
import { CreateInvitationDto } from '../../invitations/dto/create-invitation.dto.js';
import { StateMachineService } from '../../state-machine/state-machine.service.js';
import {
  CREATES,
  ENDS,
  McpToolProvider,
  READ_ONLY,
  UPDATES,
  defineTool,
} from '../mcp.types.js';
import { agentSummary } from './agents.tools.js';

/** Projects and their sessions, only where the user is a member. */
@Injectable()
export class SessionsTools implements McpToolProvider {
  constructor(
    private readonly projects: ProjectsService,
    private readonly sessions: SessionsService,
    private readonly stateMachine: StateMachineService,
    private readonly invitations: InvitationsService,
    private readonly access: ResourceAccessService,
  ) {}

  private invitationSummary(invitation: Record<string, any>) {
    return {
      id: invitation.id,
      status: invitation.status,
      participantName: invitation.participantName,
      customMessage: invitation.customMessage,
      visualizerType: invitation.visualizerType,
      visualizerLocked: invitation.visualizerLocked,
      maxSessionDurationSeconds: invitation.maxSessionDurationSeconds,
      createdAt: invitation.createdAt,
      expiresAt: invitation.expiresAt,
      acceptedAt: invitation.acceptedAt,
      joinUrl: this.invitations.joinUrl(invitation.token),
    };
  }

  tools() {
    return [
      defineTool({
        name: 'projects_list',
        title: 'List projects',
        description:
          'Projects the user is a member of. Sessions live in projects.',
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async (_args, { auth }) => ({
          items: await this.projects.findAll(auth.user.userId),
        }),
      }),
      defineTool({
        name: 'sessions_list',
        title: 'List sessions',
        description:
          'Sessions in a project, newest first. Page with skip and take (at most 100).',
        scope: 'mcp:read',
        input: {
          projectId: z.string(),
          status: z
            .enum(
              Object.values(SessionStatus) as [
                SessionStatus,
                ...SessionStatus[],
              ],
            )
            .optional(),
          search: z
            .string()
            .optional()
            .describe('Matches the session or room name'),
          skip: z.number().int().min(0).optional(),
          take: z.number().int().min(1).max(100).optional(),
        },
        annotations: READ_ONLY,
        handler: async ({ projectId, ...query }, ctx) => {
          this.access.assertProjectMember(ctx.auth.user, projectId);
          return this.sessions.findAll(
            projectId,
            await ctx.validate(QuerySessionsDto, query),
          );
        },
      }),
      defineTool({
        name: 'sessions_get',
        title: 'Get a session',
        description:
          'One session with its agents and the participants currently in it. Agent ids are for agents_get, ' +
          'agent_logs_get, agents_restart and agents_stop.',
        scope: 'mcp:read',
        input: { sessionId: z.string() },
        annotations: READ_ONLY,
        handler: async ({ sessionId }, { auth }) => {
          await this.access.assertSessionAccess(auth.user, sessionId);
          const session = await this.sessions.findOne(sessionId);
          return {
            id: session.id,
            projectId: session.projectId,
            name: session.name,
            status: session.status,
            createdAt: session.createdAt,
            closedAt: session.closedAt,
            agentSpawnMode: session.agentSpawnMode,
            hasHumanParticipant: session.hasHumanParticipant,
            maxSessionDurationSeconds: session.maxSessionDurationSeconds,
            agents: session.agents.map(agentSummary),
            participants: session.participants.map((p) => ({
              id: p.id,
              name: p.name,
              joinedAt: p.joinedAt,
            })),
            messageCount: session._count.messages,
          };
        },
      }),
      defineTool({
        name: 'sessions_create',
        title: 'Create a session',
        description:
          'Create an empty session (a room) in a project. Then deploy an agent with agents_deploy and invite ' +
          'a participant with session_invitations_create.',
        scope: 'mcp:write',
        input: {
          projectId: z.string(),
          name: z.string().max(255).optional(),
        },
        annotations: CREATES,
        handler: async ({ projectId, ...fields }, ctx) => {
          this.access.assertProjectMember(ctx.auth.user, projectId);
          const session = await this.sessions.create(
            projectId,
            await ctx.validate(CreateSessionDto, fields),
          );
          return {
            id: session.id,
            projectId: session.projectId,
            name: session.name,
            status: session.status,
            createdAt: session.createdAt,
          };
        },
      }),
      defineTool({
        name: 'sessions_update',
        title: 'Rename a session',
        description: 'Change the name of a session.',
        scope: 'mcp:write',
        input: { sessionId: z.string(), name: z.string().max(255) },
        annotations: UPDATES,
        handler: async ({ sessionId, ...fields }, ctx) => {
          await this.access.assertSessionAccess(ctx.auth.user, sessionId);
          const session = await this.sessions.update(
            sessionId,
            await ctx.validate(UpdateSessionDto, fields),
          );
          return { id: session.id, name: session.name };
        },
      }),
      defineTool({
        name: 'sessions_close',
        title: 'Close a session',
        description:
          'End a session: its agents stop and nobody can join any more. The transcript stays readable. ' +
          'Cannot be undone.',
        scope: 'mcp:write',
        input: { sessionId: z.string() },
        annotations: ENDS,
        handler: async ({ sessionId }, { auth }) => {
          await this.access.assertSessionAccess(auth.user, sessionId);
          return this.sessions.close(sessionId);
        },
      }),
      defineTool({
        name: 'session_invitations_list',
        title: 'List session invitations',
        description:
          'Invitations of a session with their join links, newest first.',
        scope: 'mcp:read',
        input: { sessionId: z.string() },
        annotations: READ_ONLY,
        handler: async ({ sessionId }, { auth }) => {
          await this.access.assertSessionAccess(auth.user, sessionId);
          const items = await this.invitations.findBySession(sessionId);
          return { items: items.map((i) => this.invitationSummary(i)) };
        },
      }),
      defineTool({
        name: 'session_invitations_create',
        title: 'Create an invitation link',
        description:
          'Create the link a participant opens to join an active session, without an account. A session has at ' +
          'most one open invitation: revoke it first to make a new one. maxSessionDurationSeconds (60 to 7200) ' +
          'caps the conversation from the first agent message.',
        scope: 'mcp:write',
        input: {
          sessionId: z.string(),
          participantName: z.string().optional(),
          customMessage: z
            .string()
            .optional()
            .describe('Shown to the participant before they join'),
          visualizerType: z
            .string()
            .optional()
            .describe('e.g. sphere, face, galaxy'),
          visualizerLocked: z.boolean().optional(),
          expiresInHours: z.number().min(1).max(8760).optional(),
          maxSessionDurationSeconds: z.number().min(60).max(7200).optional(),
        },
        annotations: CREATES,
        handler: async ({ sessionId, ...fields }, ctx) => {
          await this.access.assertSessionAccess(ctx.auth.user, sessionId);
          const { invitation } = await this.invitations.create(
            sessionId,
            await ctx.validate(CreateInvitationDto, fields),
          );
          return this.invitationSummary(invitation);
        },
      }),
      defineTool({
        name: 'session_invitations_revoke',
        title: 'Revoke an invitation link',
        description:
          'Make an open invitation link stop working. A participant who already joined is not removed.',
        scope: 'mcp:write',
        input: { invitationId: z.string() },
        annotations: ENDS,
        handler: async ({ invitationId }, { auth }) => {
          await this.access.assertInvitationAccess(auth.user, invitationId);
          return this.invitations.revoke(invitationId);
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
        handler: async (
          { sessionId, cursor, limit, includeDebug },
          { auth },
        ) => {
          await this.access.assertSessionAccess(auth.user, sessionId);
          const page = await this.sessions.getMessages(sessionId, {
            cursor,
            limit: limit ?? 50,
            includeDebug,
          });
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
