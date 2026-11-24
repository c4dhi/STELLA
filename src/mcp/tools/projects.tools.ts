import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { ResourceAccessService } from '../../auth/resource-access.service.js';
import { ProjectsService } from '../../projects/projects.service.js';
import { ProjectInvitationsService } from '../../project-invitations/project-invitations.service.js';
import { CreateProjectDto } from '../../projects/dto/create-project.dto.js';
import { UpdateProjectDto } from '../../projects/dto/update-project.dto.js';
import { UpdatePublicConfigDto } from '../../projects/dto/update-public-config.dto.js';
import { InviteCollaboratorDto } from '../../project-invitations/dto/project-invitation.dto.js';
import {
  CREATES,
  ENDS,
  McpToolProvider,
  READ_ONLY,
  UPDATES,
  defineTool,
  idArg,
} from '../mcp.types.js';

const projectId = idArg('project', 'projects_list');
const userId = idArg('user', 'project_collaborators_list');

// Same shape as agents_deploy's connectorBindings: raw config and env var
// values never come in over MCP, only ids.
const connectorBindings = z
  .array(
    z.object({
      connectorId: idArg('connector', 'connectors_list with this projectId'),
      slot: z
        .string()
        .optional()
        .describe(
          'A connector slot the agent type declares in agent.yaml (connectors)',
        ),
      handle: z
        .string()
        .optional()
        .describe(
          'Name the agent uses; defaults to the slot, then the connector handle',
        ),
    }),
  )
  .max(20)
  .optional()
  .describe(
    'Outside MCP servers the public agent may call. The agent is deployed as the project owner, so each ' +
      "must be the owner's own connector or shared with the project.",
  );

/** Projects: their settings, public setup and link, and collaborators. */
@Injectable()
export class ProjectsTools implements McpToolProvider {
  constructor(
    private readonly projects: ProjectsService,
    private readonly collaborators: ProjectInvitationsService,
    private readonly access: ResourceAccessService,
    private readonly config: ConfigService,
  ) {}

  private baseUrl(): string {
    return (
      this.config.get<string>('PUBLIC_FRONTEND_URL') || 'http://localhost:8080'
    );
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
            (project) => ({
              id: project.id,
              name: project.name,
              isOwner: project.isOwner,
              isPublic: project.isPublic,
              agentInactivityTimeoutMinutes:
                project.agentInactivityTimeoutMinutes,
              closeSessionWhenEmpty: project.closeSessionWhenEmpty,
              activeSessions: project.activeSessions,
              activeAgents: project.activeAgents,
              totalSessions: project.totalSessions,
              createdAt: project.createdAt,
            }),
          ),
        }),
      }),
      defineTool({
        name: 'projects_get',
        title: 'Get a project',
        description:
          'One project: its settings, public setup, and its 10 most recent sessions with agent and ' +
          'participant counts. sessions_list has every session.',
        scope: 'mcp:read',
        input: { projectId },
        annotations: READ_ONLY,
        handler: async ({ projectId }, { auth }) => {
          this.access.assertProjectMember(auth.user, projectId);
          return this.projects.findOne(projectId);
        },
      }),
      defineTool({
        name: 'projects_stats',
        title: 'Get project stats',
        description:
          'Totals for a project: sessions (and how many are active), agents (and how many are running), ' +
          'messages and participants.',
        scope: 'mcp:read',
        input: { projectId },
        annotations: READ_ONLY,
        handler: async ({ projectId }, { auth }) => {
          this.access.assertProjectMember(auth.user, projectId);
          return { ...(await this.projects.getStats(projectId)) };
        },
      }),
      defineTool({
        name: 'projects_create',
        title: 'Create a project',
        description:
          'Create a project, owned by the caller. Sessions, collaborators and the public link live under it.',
        scope: 'mcp:write',
        input: {
          name: z.string().min(1).max(255),
          agentInactivityTimeoutMinutes: z
            .number()
            .int()
            .min(1)
            .max(1440)
            .nullable()
            .optional()
            .describe(
              'Auto-stop an idle agent after this many minutes; null disables it',
            ),
          closeSessionWhenEmpty: z
            .boolean()
            .optional()
            .describe(
              'Close a session when everyone has left it; default false',
            ),
        },
        annotations: CREATES,
        handler: async (args, ctx) =>
          this.projects.create(
            await ctx.validate(CreateProjectDto, args),
            ctx.auth.user.userId,
          ),
      }),
      defineTool({
        name: 'projects_update',
        title: 'Update a project',
        description: "Change a project's name or its session settings.",
        scope: 'mcp:write',
        input: {
          projectId,
          name: z.string().min(1).max(255).optional(),
          agentInactivityTimeoutMinutes: z
            .number()
            .int()
            .min(1)
            .max(1440)
            .nullable()
            .optional(),
          closeSessionWhenEmpty: z.boolean().optional(),
        },
        annotations: UPDATES,
        handler: async ({ projectId, ...fields }, ctx) => {
          this.access.assertProjectMember(ctx.auth.user, projectId);
          return this.projects.update(
            projectId,
            await ctx.validate(UpdateProjectDto, fields),
          );
        },
      }),
      defineTool({
        name: 'projects_public_update',
        title: 'Update a project’s public setup',
        description:
          'Turn a project public or private, and configure the agent a visitor gets on the public link: its ' +
          'name, icon, agent configuration, persona, env var template and connector bindings, the visualizer ' +
          '(e.g. sphere, face, galaxy, text) and whether it is locked, and the maximum session length (60 to ' +
          '7200 seconds). The public agent runs as the project owner, so only the owner may bind or move ' +
          'connectors; enabled pauses the link without losing its configuration.',
        scope: 'mcp:write',
        input: {
          projectId,
          isPublic: z.boolean(),
          agentTypeId: idArg('agent type', 'agent_types_list').optional(),
          name: z
            .string()
            .max(255)
            .optional()
            .describe(
              "The public agent's display name; required the first time any of the fields below is set",
            ),
          icon: z.string().max(10).optional().describe('One emoji'),
          agentConfigurationId: idArg(
            'agent configuration',
            'agent_configurations_list',
          ).optional(),
          personaId: idArg('persona', 'personas_list').optional(),
          envVarTemplateId: idArg(
            'env var template',
            'env_var_templates_list',
          ).optional(),
          connectorBindings,
          visualizerType: z.string().max(50).optional(),
          visualizerLocked: z.boolean().optional(),
          maxSessionDurationSeconds: z
            .number()
            .int()
            .min(60)
            .max(7200)
            .nullable()
            .optional(),
          enabled: z
            .boolean()
            .optional()
            .describe(
              'Pause or resume the public link without reconfiguring it',
            ),
        },
        annotations: UPDATES,
        handler: async (
          {
            projectId,
            isPublic,
            agentTypeId,
            name,
            icon,
            agentConfigurationId,
            personaId,
            envVarTemplateId,
            connectorBindings,
            visualizerType,
            visualizerLocked,
            maxSessionDurationSeconds,
            enabled,
          },
          ctx,
        ) => {
          this.access.assertProjectMember(ctx.auth.user, projectId);
          const agentConfigGiven = [
            name,
            icon,
            agentConfigurationId,
            personaId,
            envVarTemplateId,
            connectorBindings,
          ].some((v) => v !== undefined);
          const dto = await ctx.validate(UpdatePublicConfigDto, {
            isPublic,
            agentTypeId,
            visualizerType,
            visualizerLocked,
            maxSessionDurationSeconds,
            enabled,
            ...(agentConfigGiven
              ? {
                  agentConfig: {
                    name,
                    icon,
                    agentConfigurationId,
                    personaId,
                    envVarTemplateId,
                    connectorBindings,
                  },
                }
              : {}),
          });
          return this.projects.updatePublicConfig(
            projectId,
            dto,
            ctx.auth.user.userId,
          );
        },
      }),
      defineTool({
        name: 'projects_public_link_get',
        title: "Get a project's public link",
        description:
          'The link anyone can open to join a public project, and whether it is currently enabled. ' +
          'null when the project is not public.',
        scope: 'mcp:read',
        input: { projectId },
        annotations: READ_ONLY,
        handler: async ({ projectId }, { auth }) => {
          this.access.assertProjectMember(auth.user, projectId);
          return this.projects.getPublicLink(projectId, this.baseUrl());
        },
      }),
      defineTool({
        name: 'project_collaborators_list',
        title: 'List a project’s collaborators',
        description:
          'Members of a project (the owner and collaborators) and anyone invited but not yet responded.',
        scope: 'mcp:read',
        input: { projectId },
        annotations: READ_ONLY,
        handler: async ({ projectId }, { auth }) => ({
          ...(await this.collaborators.getCollaborators(
            projectId,
            auth.user.userId,
          )),
        }),
      }),
      defineTool({
        name: 'project_collaborators_invite',
        title: 'Invite a collaborator',
        description:
          'Invite a registered user to a project by email. Only the project owner can invite. The invitee gets ' +
          'an inbox message and becomes a member once they accept.',
        scope: 'mcp:write',
        input: {
          projectId,
          email: z.string().email(),
        },
        annotations: CREATES,
        handler: async ({ projectId, email }, ctx) => ({
          ...(await this.collaborators.inviteCollaborator(
            projectId,
            ctx.auth.user.userId,
            await ctx.validate(InviteCollaboratorDto, { email }),
          )),
        }),
      }),
      defineTool({
        name: 'project_collaborators_remove',
        title: 'Remove a collaborator',
        description:
          'Remove a collaborator from a project, and any invitation still pending for them. Only the project ' +
          "owner can remove, and the owner can't remove themself. Returns the project's collaborators afterward.",
        scope: 'mcp:write',
        input: { projectId, userId },
        annotations: ENDS,
        handler: async ({ projectId, userId }, ctx) => {
          await this.collaborators.removeCollaborator(
            projectId,
            ctx.auth.user.userId,
            userId,
          );
          return {
            ...(await this.collaborators.getCollaborators(
              projectId,
              ctx.auth.user.userId,
            )),
          };
        },
      }),
    ];
  }
}
