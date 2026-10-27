import { Injectable, NotFoundException } from '@nestjs/common';
import { AgentImageService } from '../../agent-image/agent-image.service.js';
import {
  McpToolProvider,
  READ_ONLY,
  defineTool,
  idArg,
} from '../mcp.types.js';

/** Who the caller is, and what agent types exist to configure. */
@Injectable()
export class CatalogTools implements McpToolProvider {
  constructor(private readonly agentImages: AgentImageService) {}

  tools() {
    return [
      defineTool({
        name: 'whoami',
        title: 'Who am I',
        description:
          'The STELLA user this connection acts as, the projects they are a member of, what it may do, and how it ' +
          'was connected (an app the user signed in to, or a personal access token).',
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async (_args, { auth }) => ({
          userId: auth.user.userId,
          email: auth.user.email,
          name: auth.user.name,
          isSystemAdmin: auth.user.isSystemAdmin,
          projectRoles: auth.user.projectRoles,
          scopes: auth.scopes,
          connectedVia: auth.oauthGrantId
            ? { app: auth.clientName }
            : { personalAccessToken: auth.tokenId },
        }),
      }),
      defineTool({
        name: 'agent_types_list',
        title: 'List agent types',
        description:
          'Agent types available on this platform. An agent configuration always belongs to one agent type: ' +
          'use its id as agentTypeId. agent_types_get has the pipeline schema and defaults of one.',
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async () => ({
          items: (await this.agentImages.getAgentTypesWithInfo()).map(
            ({ id, slug, name, description, icon, version, capabilities }) => ({
              id,
              slug,
              name,
              description,
              icon,
              version,
              capabilities,
            }),
          ),
        }),
      }),
      defineTool({
        name: 'agent_types_get',
        title: 'Get an agent type',
        description:
          'One agent type with its pipeline schema (configSchema) and defaults: what an agent configuration ' +
          'for it can override.',
        scope: 'mcp:read',
        input: { agentTypeId: idArg('agent type', 'agent_types_list') },
        annotations: READ_ONLY,
        handler: async ({ agentTypeId }) => {
          const type = (await this.agentImages.getAgentTypesWithInfo()).find(
            (t) => t.id === agentTypeId,
          );
          if (!type) {
            throw new NotFoundException(`Agent type ${agentTypeId} not found`);
          }
          return { ...type };
        },
      }),
    ];
  }
}
