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
  idArg,
} from '../mcp.types.js';
import { agentSummary } from './agents.tools.js';

const projectId = idArg('project', 'projects_list');
const sessionId = idArg('session', 'sessions_list');
const invitationId = idArg('invitation', 'session_invitations_list');

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

  /** A session as sessions_get shows it; every session write returns this too. */
  private async sessionDetail(id: string) {
    const session = await this.sessions.findOne(id);
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
  }

  tools() {
    return [
      defineTool({
        name: 'projects_list',
        title: 'List projects',
        description:
          'Projects the user is a member of, with session counts. Sessions live in projects.',
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async (_args, { auth }) => ({
          items: (await this.projects.findAll(auth.user.userId)).map(
            (project: Record<string, any>) => ({
              id: project.id,
              name: project.name,
              isOwner: project.isOwner,
              isPublic: project.isPublic,
              agentInactivityTimeoutMinutes:
                project.agentInactivityTimeoutMinutes,
              activeSessions: project.activeSessions,
              activeAgents: project.activeAgents,
              totalSessions: project.totalSessions,
              createdAt: project.createdAt,
            }),
          ),
        }),
      }),
      defineTool({
        name: 'sessions_list',
        title: 'List sessions',
        description:
          'Sessions in a project, newest first, with counts. Page with skip and take (at most 100); ' +
          'sessions_get has the agents and participants of one.',
        scope: 'mcp:read',
        input: {
          projectId,
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
          const page = await this.sessions.findAll(
            projectId,
            await ctx.validate(QuerySessionsDto, query),
          );
          // Not lastAgentConfig: it holds the deploy snapshot with encrypted env vars,
          // and runs to tens of kilobytes per session.
          return {
            items: page.data.map((session) => ({
              id: session.id,
              name: session.name,
              status: session.status,
              createdAt: session.createdAt,
              closedAt: session.closedAt,
              hasHumanParticipant: session.hasHumanParticipant,
              humanJoinedAt: session.humanJoinedAt,
              humanLeftAt: session.humanLeftAt,
              firstAgentMessageAt: session.firstAgentMessageAt,
              agentCount: session._count.agents,
              participantCount: session._count.participants,
              messageCount: session._count.messages,
            })),
            total: page.total,
            skip: page.skip,
            take: page.take,
          };
        },
      }),
      defineTool({
        name: 'sessions_get',
        title: 'Get a session',
        description:
          'One session with its agents and the participants currently in it. Agent ids are for agents_get, ' +
          'agent_logs_get, agents_restart and agents_stop.',
        scope: 'mcp:read',
        input: { sessionId },
        annotations: READ_ONLY,
        handler: async ({ sessionId }, { auth }) => {
          await this.access.assertSessionAccess(auth.user, sessionId);
          return this.sessionDetail(sessionId);
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
          projectId,
          name: z.string().max(255).optional(),
        },
        annotations: CREATES,
        handler: async ({ projectId, ...fields }, ctx) => {
          this.access.assertProjectMember(ctx.auth.user, projectId);
          const session = await this.sessions.create(
            projectId,
            await ctx.validate(CreateSessionDto, fields),
          );
          return this.sessionDetail(session.id);
        },
      }),
      defineTool({
        name: 'sessions_update',
        title: 'Rename a session',
        description: 'Change fields of a session; for now that is its name.',
        scope: 'mcp:write',
        input: { sessionId, name: z.string().max(255).optional() },
        annotations: UPDATES,
        handler: async ({ sessionId, ...fields }, ctx) => {
          await this.access.assertSessionAccess(ctx.auth.user, sessionId);
          await this.sessions.update(
            sessionId,
            await ctx.validate(UpdateSessionDto, fields),
          );
          return this.sessionDetail(sessionId);
        },
      }),
      defineTool({
        name: 'sessions_close',
        title: 'Close a session',
        description:
          'End a session: its agents stop and nobody can join any more. The transcript stays readable. ' +
          'Cannot be undone.',
        scope: 'mcp:write',
        input: { sessionId },
        annotations: ENDS,
        handler: async ({ sessionId }, { auth }) => {
          await this.access.assertSessionAccess(auth.user, sessionId);
          await this.sessions.close(sessionId);
          return this.sessionDetail(sessionId);
        },
      }),
      defineTool({
        name: 'session_invitations_list',
        title: 'List session invitations',
        description:
          'Invitations of a session with their join links, newest first.',
        scope: 'mcp:read',
        input: { sessionId },
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
          sessionId,
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
        input: { invitationId },
        annotations: ENDS,
        handler: async ({ invitationId }, { auth }) => {
          await this.access.assertInvitationAccess(auth.user, invitationId);
          await this.invitations.revoke(invitationId);
          return this.invitationSummary(
            await this.invitations.findOne(invitationId),
          );
        },
      }),
      defineTool({
        name: 'session_transcript_get',
        title: 'Get a session transcript',
        description:
          'Messages (items) of a session in time order, oldest first, one page at a time. Pass nextCursor back as cursor ' +
          'to get the page before. includeDebug adds agent-internal messages (expert decisions, plan updates).',
        scope: 'mcp:read',
        input: {
          sessionId,
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
            items: page.messages.map((m) => ({
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
        input: { sessionId },
        annotations: READ_ONLY,
        handler: async ({ sessionId }, { auth }) => {
          await this.access.assertSessionAccess(auth.user, sessionId);
          return { state: await this.stateMachine.getFullState(sessionId) };
        },
      }),
    ];
  }
}
