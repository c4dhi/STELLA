import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  AgentReviewService,
  REVIEW_STATES,
} from '../../agent-upload/agent-review.service.js';
import { McpToolProvider, READ_ONLY, UPDATES, defineTool, idArg } from '../mcp.types.js';

const agentTypeId = idArg('uploaded agent type', 'agent_reviews_list');

/**
 * Reviewing uploaded agents (Settings → Agent Review), for system admins only.
 * Approving lets an upload's code run in the cluster, which is why the tools
 * are hidden from everyone else, like SystemAdminGuard on the REST side.
 */
@Injectable()
export class AgentReviewsTools implements McpToolProvider {
  constructor(private readonly review: AgentReviewService) {}

  tools() {
    return [
      defineTool({
        name: 'agent_reviews_list',
        title: 'List uploaded agents by review state',
        description:
          'Uploaded agents in one review state: pending (waiting, oldest first), approved or rejected (newest ' +
          'first). Built-in agents are never listed. System admins only.',
        scope: 'mcp:read',
        systemAdminOnly: true,
        input: {
          status: z
            .enum(REVIEW_STATES)
            .optional()
            .describe('Which uploads to list; pending when left out'),
        },
        annotations: READ_ONLY,
        handler: async ({ status }) => ({ items: await this.review.list(status ?? 'pending') }),
      }),
      defineTool({
        name: 'agent_reviews_get',
        title: 'Get an uploaded agent for review',
        description:
          'Everything a reviewer looks at for one uploaded agent: owner, author, resources, capabilities, ' +
          'config schema, SDK version and its five latest builds. System admins only.',
        scope: 'mcp:read',
        systemAdminOnly: true,
        input: { agentTypeId },
        annotations: READ_ONLY,
        handler: async ({ agentTypeId }) => this.review.get(agentTypeId),
      }),
      defineTool({
        name: 'agent_reviews_approve',
        title: 'Approve an uploaded agent',
        description:
          'Approve an uploaded agent, so it can deploy (its code then runs in the cluster). Also approves one ' +
          'that was rejected before. Notes are optional. System admins only.',
        scope: 'mcp:write',
        systemAdminOnly: true,
        input: {
          agentTypeId,
          notes: z.string().optional().describe('What the reviewer noted, shown to the uploader'),
        },
        annotations: UPDATES,
        handler: async ({ agentTypeId, notes }, { auth }) => {
          await this.review.approve(agentTypeId, auth.user.userId, notes);
          return this.review.get(agentTypeId);
        },
      }),
      defineTool({
        name: 'agent_reviews_reject',
        title: 'Reject an uploaded agent',
        description:
          'Reject an uploaded agent, so it cannot deploy, and say why: the uploader sees the reason. Also ' +
          'withdraws an earlier approval. System admins only.',
        scope: 'mcp:write',
        systemAdminOnly: true,
        input: {
          agentTypeId,
          reason: z.string().describe('Why it is rejected, shown to the uploader; required'),
        },
        annotations: UPDATES,
        handler: async ({ agentTypeId, reason }, { auth }) => {
          await this.review.reject(agentTypeId, auth.user.userId, reason);
          return this.review.get(agentTypeId);
        },
      }),
    ];
  }
}
