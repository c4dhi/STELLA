import { Injectable } from '@nestjs/common';
import { AgentImageService } from '../../agent-image/agent-image.service.js';
import { McpToolProvider, READ_ONLY, defineTool } from '../mcp.types.js';

/** Who the caller is, and what agent types exist to configure. */
@Injectable()
export class CatalogTools implements McpToolProvider {
  constructor(private readonly agentImages: AgentImageService) {}

  tools() {
    return [
      defineTool({
        name: 'whoami',
        title: 'Who am I',
        description: 'The STELLA user this access token belongs to, the projects they are a member of, and what the token may do.',
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
        }),
      }),
      defineTool({
        name: 'agent_types_list',
        title: 'List agent types',
        description:
          'Agent types available on this platform, with their pipeline schema and defaults. An agent configuration ' +
          'always belongs to one agent type: use its id as agentTypeId.',
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async () => ({ items: await this.agentImages.getAgentTypesWithInfo() }),
      }),
    ];
  }
}
