import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { ConnectorsService } from '../../connectors/connectors.service.js';
import {
  CreateConnectorDto,
  SetConnectorSharesDto,
  UpdateConnectorDto,
} from '../../connectors/dto/connector.dto.js';
import {
  CREATES,
  McpToolProvider,
  READ_ONLY,
  UPDATES,
  defineTool,
  idArg,
} from '../mcp.types.js';

// Mirrors CreateConnectorDto / UpdateConnectorDto, which do the real validation.
const connectorFields = {
  name: z
    .string()
    .min(1)
    .max(100)
    .describe(
      'Shown in Settings and the deploy wizard, e.g. "ELIAS interview questions"',
    ),
  handle: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,39}$/)
    .describe(
      'How agents address it: lowercase letters, digits, hyphens, max 40. Unique per user.',
    ),
  url: z
    .string()
    .min(1)
    .max(2048)
    .describe(
      'The MCP endpoint (Streamable HTTP), e.g. https://example.org/mcp',
    ),
  authType: z.enum(['bearer', 'none']).optional().describe('Default bearer'),
  token: z
    .string()
    .min(1)
    .max(8192)
    .optional()
    .describe(
      'The bearer token. Stored encrypted and never returned by any tool. It passes through this chat, so ' +
        'only send it if the user gave it to you for this.',
    ),
};

const connectorId = idArg('connector', 'connectors_list');

/** Connectors: outside MCP servers the user's agents call through STELLA. */
@Injectable()
export class ConnectorsTools implements McpToolProvider {
  constructor(private readonly connectors: ConnectorsService) {}

  tools() {
    return [
      defineTool({
        name: 'connectors_list',
        title: 'List connectors',
        description:
          "The user's own connectors (outside MCP servers their agents can call). With projectId: the ones " +
          'that can be bound to an agent in that project, the own ones plus those other members shared with it ' +
          '(owned: false). Credentials are never returned.',
        scope: 'mcp:read',
        input: {
          projectId: idArg('project', 'projects_list').optional(),
        },
        annotations: READ_ONLY,
        handler: async ({ projectId }, { auth }) => ({
          items: projectId
            ? await this.connectors.listAvailable(auth.user.userId, projectId)
            : await this.connectors.list(auth.user.userId),
        }),
      }),
      defineTool({
        name: 'connectors_get',
        title: 'Get a connector',
        description:
          "One of the user's own connectors: status, last error, tool list from the last test, and the projects " +
          'it is shared with. hasCredential says whether a token is stored; the token itself is never returned.',
        scope: 'mcp:read',
        input: { connectorId },
        annotations: READ_ONLY,
        handler: async ({ connectorId }, { auth }) =>
          this.connectors.get(connectorId, auth.user.userId),
      }),
      defineTool({
        name: 'connectors_create',
        title: 'Add a connector',
        description:
          'Add an outside MCP server. Run connectors_test next to check the token and load its tool list. ' +
          'Private and cluster-internal addresses are refused.',
        scope: 'mcp:write',
        input: connectorFields,
        annotations: CREATES,
        handler: async (args, ctx) =>
          this.connectors.create(
            ctx.auth.user.userId,
            await ctx.validate(CreateConnectorDto, args),
          ),
      }),
      defineTool({
        name: 'connectors_update',
        title: 'Update a connector',
        description:
          'Change fields of a connector the user owns. Omitted fields stay as they are; leave out token to keep ' +
          'the stored one. Changing url, authType or token resets the status to untested.',
        scope: 'mcp:write',
        input: { connectorId, ...z.object(connectorFields).partial().shape },
        annotations: UPDATES,
        handler: async ({ connectorId, ...changes }, ctx) =>
          this.connectors.update(
            connectorId,
            ctx.auth.user.userId,
            await ctx.validate(UpdateConnectorDto, changes),
          ),
      }),
      defineTool({
        name: 'connectors_test',
        title: 'Test a connector',
        description:
          'Connect to the server (MCP initialize + tools/list) with the stored token and store the result. ' +
          'Returns { ok, errorCode?, error?, connector }.',
        scope: 'mcp:write',
        input: { connectorId },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        handler: async ({ connectorId }, { auth }) =>
          this.connectors.test(
            connectorId,
            auth.user.userId,
          ) as unknown as Promise<Record<string, unknown>>,
      }),
      defineTool({
        name: 'connector_shares_set',
        title: 'Share a connector with projects',
        description:
          'Replace the set of projects a connector the user owns is shared with; [] unshares it everywhere. ' +
          "Only projects the user is a member of. Members' agents can then call it with the owner's token " +
          '(they never see the token), and calls stop at once when it is unshared.',
        scope: 'mcp:write',
        input: {
          connectorId,
          projectIds: z
            .array(z.string())
            .max(100)
            .describe('Project ids from projects_list'),
        },
        annotations: UPDATES,
        handler: async ({ connectorId, projectIds }, ctx) => {
          const dto = await ctx.validate(SetConnectorSharesDto, { projectIds });
          return this.connectors.setShares(
            connectorId,
            ctx.auth.user.userId,
            dto.projectIds,
          );
        },
      }),
    ];
  }
}
