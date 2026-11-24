import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { AgentImageService } from '../../agent-image/agent-image.service.js';
import { AgentsService } from '../../agents/agents.service.js';
import { CreateAgentDto } from '../../agents/dto/create-agent.dto.js';
import { ResourceAccessService } from '../../auth/resource-access.service.js';
import {
  CREATES,
  ENDS,
  McpToolProvider,
  READ_ONLY,
  defineTool,
  idArg,
} from '../mcp.types.js';

const agentId = idArg('agent', 'sessions_get (agents)');
const projectId = idArg('project', 'projects_list');
const sessionId = idArg('session', 'sessions_list');
const agentTypeId = idArg('agent type', 'agent_types_list');
const dateRangeFields = {
  from: z
    .string()
    .datetime()
    .optional()
    .describe('ISO date; defaults to 30 days ago'),
  to: z.string().datetime().optional().describe('ISO date; defaults to now'),
};

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
    private readonly agentImages: AgentImageService,
    private readonly access: ResourceAccessService,
  ) {}

  /** The slug AgentsService deploys by, for an agent type id. */
  private async agentTypeSlug(agentTypeId: string): Promise<string> {
    const type = (await this.agentImages.getAgentTypesWithInfo()).find(
      (t) => t.id === agentTypeId,
    );
    if (!type) {
      throw new NotFoundException(`Agent type ${agentTypeId} not found`);
    }
    return type.slug;
  }

  tools() {
    return [
      defineTool({
        name: 'agents_deploy',
        title: 'Deploy an agent into a session',
        description:
          'Start an agent in an active session. Starting the pod takes a while: poll agents_get until status is ' +
          'RUNNING. Plan mode (the default) follows planId; without one the agent runs with no plan. Companion ' +
          'mode offers availablePlanIds instead and ignores planId. personaId omitted = the default persona. ' +
          'The STELLA V2 agent type (the default) needs an agentConfigurationId for its type.',
        scope: 'mcp:write',
        input: {
          sessionId: idArg('session', 'sessions_list'),
          name: z.string().min(1).max(255),
          icon: z.string().max(10).optional().describe('One emoji'),
          agentTypeId: idArg('agent type', 'agent_types_list')
            .optional()
            .describe(
              'Id of the agent type, from agent_types_list; default STELLA V2',
            ),
          planId: idArg('plan template', 'plan_templates_list')
            .optional()
            .describe(
              'Id of the plan template to follow in plan mode, from plan_templates_list; ignored in companion mode',
            ),
          personaId: idArg('persona', 'personas_list').optional(),
          agentConfigurationId: idArg(
            'agent configuration',
            'agent_configurations_list',
          ).optional(),
          mode: z.enum(['plan', 'companion']).optional(),
          availablePlanIds: z
            .array(z.string())
            .max(20)
            .optional()
            .describe('Plan template ids from plan_templates_list'),
          envVarTemplateId: idArg(
            'env var template',
            'env_var_templates_list',
          ).optional(),
          connectorBindings: z
            .array(
              z
                .object({
                  connectorId: idArg(
                    'connector',
                    'connectors_list with this projectId',
                  ),
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
                })
                .strict(),
            )
            .max(20)
            .optional()
            .describe(
              'Outside MCP servers the agent may call. Every required slot of the agent type needs one; ' +
                'the agent never receives their tokens.',
            ),
        },
        annotations: CREATES,
        handler: async (args, ctx) => {
          await this.access.assertSessionAccess(ctx.auth.user, args.sessionId);
          // Named one by one: raw config and env var values never come in over MCP.
          const fields = {
            name: args.name,
            icon: args.icon,
            agentType: args.agentTypeId
              ? await this.agentTypeSlug(args.agentTypeId)
              : undefined,
            planId: args.planId,
            personaId: args.personaId,
            agentConfigurationId: args.agentConfigurationId,
            mode: args.mode,
            availablePlanIds: args.availablePlanIds,
            envVarTemplateId: args.envVarTemplateId,
            connectorBindings: args.connectorBindings,
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
        input: { agentId },
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
        input: { agentId },
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
        input: { agentId },
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
        input: { agentId },
        annotations: ENDS,
        handler: async ({ agentId }, { auth }) => {
          await this.access.assertAgentAccess(auth.user, agentId);
          await this.agents.remove(agentId);
          return agentSummary(await this.agents.findOne(agentId));
        },
      }),
      defineTool({
        name: 'agent_metrics_get',
        title: 'Get agent type metrics',
        description:
          'Per-stage latency stats (mean/p50/p95/min/max) for every session of one agent type in a project over ' +
          'a date range, with outlier sessions (any stage over 2x the global p50) and a summary across stages.',
        scope: 'mcp:read',
        input: { projectId, agentTypeId, ...dateRangeFields },
        annotations: READ_ONLY,
        handler: async ({ projectId, agentTypeId, from, to }, { auth }) => {
          this.access.assertProjectMember(auth.user, projectId);
          const slug = await this.agentTypeSlug(agentTypeId);
          return {
            ...(await this.agents.getAgentMetrics(
              projectId,
              slug,
              from ? new Date(from) : undefined,
              to ? new Date(to) : undefined,
            )),
          };
        },
      }),
      defineTool({
        name: 'session_analytics_get',
        title: "Get a session's latency analytics",
        description:
          "Per-stage latency for one session's turns, with a summary across stages. Different from " +
          'session_state_get (plan progress) and session_transcript_get (the messages themselves).',
        scope: 'mcp:read',
        input: { sessionId },
        annotations: READ_ONLY,
        handler: async ({ sessionId }, { auth }) => {
          await this.access.assertSessionAccess(auth.user, sessionId);
          return { ...(await this.agents.getSessionAnalytics(sessionId)) };
        },
      }),
    ];
  }
}
