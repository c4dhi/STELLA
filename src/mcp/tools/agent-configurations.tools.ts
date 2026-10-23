import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AgentConfigurationsService } from '../../agent-configurations/agent-configurations.service.js';
import { CreateAgentConfigurationDto } from '../../agent-configurations/dto/create-agent-configuration.dto.js';
import { UpdateAgentConfigurationDto } from '../../agent-configurations/dto/update-agent-configuration.dto.js';
import {
  CREATES,
  McpToolProvider,
  READ_ONLY,
  UPDATES,
  defineTool,
} from '../mcp.types.js';

const configurationField = z
  .record(z.string(), z.unknown())
  .describe(
    "Sparse overrides of the agent type's pipeline defaults. See the pipelineSchema in agent_types_list " +
      'and an existing configuration for the shape.',
  );

/** Agent configurations: pipeline settings for one agent type. */
@Injectable()
export class AgentConfigurationsTools implements McpToolProvider {
  constructor(private readonly configurations: AgentConfigurationsService) {}

  tools() {
    return [
      defineTool({
        name: 'agent_configurations_list',
        title: 'List agent configurations',
        description:
          "The user's agent configurations, optionally only those for one agent type.",
        scope: 'mcp:read',
        input: { agentTypeId: z.string().optional() },
        annotations: READ_ONLY,
        handler: async ({ agentTypeId }, { auth }) => ({
          items: await this.configurations.findAllByUser(
            auth.user.userId,
            agentTypeId,
          ),
        }),
      }),
      defineTool({
        name: 'agent_configurations_get',
        title: 'Get an agent configuration',
        description:
          'One agent configuration, including whether it is still compatible with its agent type.',
        scope: 'mcp:read',
        input: { id: z.string() },
        annotations: READ_ONLY,
        handler: async ({ id }, { auth }) =>
          this.configurations.findOne(id, auth.user.userId),
      }),
      defineTool({
        name: 'agent_configurations_create',
        title: 'Create an agent configuration',
        description:
          'Create an agent configuration for one agent type, owned by the user.',
        scope: 'mcp:write',
        input: {
          name: z.string().min(1).max(255),
          description: z.string().max(2000).optional(),
          agentTypeId: z.string(),
          configuration: configurationField,
        },
        annotations: CREATES,
        handler: async (args, ctx) =>
          this.configurations.create(
            ctx.auth.user.userId,
            await ctx.validate(CreateAgentConfigurationDto, args),
          ),
      }),
      defineTool({
        name: 'agent_configurations_update',
        title: 'Update an agent configuration',
        description:
          'Change fields of an agent configuration the user owns. configuration replaces all overrides.',
        scope: 'mcp:write',
        input: {
          id: z.string(),
          changes: z
            .object({
              name: z.string().min(1).max(255),
              description: z.string().max(2000),
              configuration: configurationField,
            })
            .partial(),
        },
        annotations: UPDATES,
        handler: async ({ id, changes }, ctx) =>
          this.configurations.update(
            id,
            ctx.auth.user.userId,
            await ctx.validate(UpdateAgentConfigurationDto, changes),
          ),
      }),
    ];
  }
}
