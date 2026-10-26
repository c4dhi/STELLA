import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AgentsService } from '../../agents/agents.service.js';
import { CreateAgentDto } from '../../agents/dto/create-agent.dto.js';
import { ResourceAccessService } from '../../auth/resource-access.service.js';
import { EnvVarTemplatesService } from '../../env-var-templates/env-var-templates.service.js';
import {
  CREATES,
  ENDS,
  McpToolProvider,
  READ_ONLY,
  defineTool,
} from '../mcp.types.js';

/**
 * What a client needs to follow an agent. Leaves out the deployment snapshot
 * (agentConfig), Kubernetes object names and the encrypted env vars.
 */
export function agentSummary(agent: Record<string, any>) {
  return {
    id: agent.id,
    sessionId: agent.sessionId,
    name: agent.name,
    icon: agent.icon,
    agentType: agent.agentType,
    status: agent.status,
    healthState: agent.healthState,
    lastError: agent.lastError,
    createdAt: agent.createdAt,
    stoppedAt: agent.stoppedAt,
    pausedAt: agent.pausedAt,
    pauseReason: agent.pauseReason,
    ...(agent.podStatus !== undefined ? { podStatus: agent.podStatus } : {}),
  };
}

/** Agents in sessions: deploy, follow, restart and stop them. */
@Injectable()
export class AgentsTools implements McpToolProvider {
  constructor(
    private readonly agents: AgentsService,
    private readonly envVarTemplates: EnvVarTemplatesService,
    private readonly access: ResourceAccessService,
  ) {}

  tools() {
    return [
      defineTool({
        name: 'env_var_templates_list',
        title: 'List env var templates',
        description:
          "The user's env var templates (API keys for agents), with variable names only, never values. " +
          "Pass one as envVarTemplateId to agents_deploy when the agent type's required env vars need it; " +
          'a template only fits agents of its agentTypeId.',
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async (_args, { auth }) => ({
          items: (
            await this.envVarTemplates.findAllByUser(auth.user.userId)
          ).map(({ id, name, description, variableKeys, agentTypeId }) => ({
            id,
            name,
            description,
            variableKeys,
            agentTypeId,
          })),
        }),
      }),
      defineTool({
        name: 'agents_deploy',
        title: 'Deploy an agent into a session',
        description:
          'Start an agent in an active session. Starting the pod takes a while: poll agents_get until status is ' +
          'RUNNING. Plan mode follows planId; companion mode offers availablePlanIds instead. personaId omitted = ' +
          'the default persona. stella-v2-agent needs an agentConfigurationId for its type (agent_configurations_list).',
        scope: 'mcp:write',
        input: {
          sessionId: z.string(),
          name: z.string().min(1).max(255),
          icon: z.string().max(10).optional().describe('One emoji'),
          agentType: z
            .string()
            .optional()
            .describe(
              'Agent type slug from agent_types_list; default stella-v2-agent',
            ),
          planId: z.string().optional().describe('Plan template to follow'),
          personaId: z.string().optional(),
          agentConfigurationId: z.string().optional(),
          mode: z.enum(['plan', 'companion']).optional(),
          availablePlanIds: z.array(z.string()).max(20).optional(),
          envVarTemplateId: z.string().optional(),
        },
        annotations: CREATES,
        handler: async (args, ctx) => {
          await this.access.assertSessionAccess(ctx.auth.user, args.sessionId);
          // Named one by one: raw config and env var values never come in over MCP.
          const fields = {
            name: args.name,
            icon: args.icon,
            agentType: args.agentType,
            planId: args.planId,
            personaId: args.personaId,
            agentConfigurationId: args.agentConfigurationId,
            mode: args.mode,
            availablePlanIds: args.availablePlanIds,
            envVarTemplateId: args.envVarTemplateId,
          };
          const agent = await this.agents.create(
            args.sessionId,
            await ctx.validate(CreateAgentDto, fields),
            ctx.auth.user.userId,
          );
          return agentSummary(agent);
        },
      }),
      defineTool({
        name: 'agents_get',
        title: 'Get an agent',
        description: 'Status and health of one agent, with its pod status.',
        scope: 'mcp:read',
        input: { agentId: z.string() },
        annotations: READ_ONLY,
        handler: async ({ agentId }, { auth }) => {
          await this.access.assertAgentAccess(auth.user, agentId);
          return agentSummary(await this.agents.findOne(agentId));
        },
      }),
      defineTool({
        name: 'agent_logs_get',
        title: 'Get agent logs',
        description:
          "The last 100 lines of the agent pod's log. Empty when the pod is gone.",
        scope: 'mcp:read',
        input: { agentId: z.string() },
        annotations: READ_ONLY,
        handler: async ({ agentId }, { auth }) => {
          await this.access.assertAgentAccess(auth.user, agentId);
          return { logs: await this.agents.getLogs(agentId) };
        },
      }),
      defineTool({
        name: 'agents_restart',
        title: 'Restart an agent',
        description:
          'Restart an agent with the configuration it was deployed with. Its current conversation turn is cut off.',
        scope: 'mcp:write',
        input: { agentId: z.string() },
        annotations: { ...ENDS, idempotentHint: false },
        handler: async ({ agentId }, { auth }) => {
          await this.access.assertAgentAccess(auth.user, agentId);
          return agentSummary(await this.agents.restart(agentId));
        },
      }),
      defineTool({
        name: 'agents_stop',
        title: 'Stop an agent',
        description:
          'Stop an agent and remove its pod. The agent and its messages stay; agents_restart brings it back.',
        scope: 'mcp:write',
        input: { agentId: z.string() },
        annotations: ENDS,
        handler: async ({ agentId }, { auth }) => {
          await this.access.assertAgentAccess(auth.user, agentId);
          return this.agents.remove(agentId);
        },
      }),
    ];
  }
}
