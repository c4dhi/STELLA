import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AdminService } from '../../admin/admin.service.js';
import { CapacityService } from '../../admin/services/capacity.service.js';
import { RecordCapacityDto } from '../../admin/dto/capacity.dto.js';
import {
  CREATES,
  McpToolProvider,
  READ_ONLY,
  UPDATES,
  defineTool,
  idArg,
} from '../mcp.types.js';

const targetUserId = idArg('user', 'admin_users_list');

/**
 * Platform-wide admin tools: live metrics, user management and measured
 * voice capacity. Mirrors admin.controller.ts's users/capacity/dashboard
 * endpoints only — admin/sessions, sessions/activity, server-metrics and
 * usage/history are not in #202's scope, and the dashboard/server-metrics
 * SSE streams have no one-shot MCP shape. System admins only.
 */
@Injectable()
export class AdminTools implements McpToolProvider {
  constructor(
    private readonly admin: AdminService,
    private readonly capacity: CapacityService,
  ) {}

  tools() {
    return [
      defineTool({
        name: 'admin_dashboard_get',
        title: 'Get platform dashboard metrics',
        description:
          'A snapshot of the whole platform: participants, sessions, agents by state, and messages. The ' +
          'same numbers the admin dashboard streams live.',
        scope: 'mcp:read',
        systemAdminOnly: true,
        input: {},
        annotations: READ_ONLY,
        handler: async () => ({ ...(await this.admin.getDashboardMetrics()) }),
      }),
      defineTool({
        name: 'admin_users_list',
        title: 'List users',
        description:
          'Every registered user, newest first, with their project count and admin/verified status.',
        scope: 'mcp:read',
        systemAdminOnly: true,
        input: {
          page: z.number().int().min(1).optional().describe('Default 1'),
          limit: z
            .number()
            .int()
            .min(1)
            .max(200)
            .optional()
            .describe('Default 50'),
        },
        annotations: READ_ONLY,
        handler: async ({ page, limit }) => ({
          ...(await this.admin.listUsers(page, limit)),
        }),
      }),
      defineTool({
        name: 'admin_users_verify',
        title: 'Verify a user',
        description: "Mark a user's account verified.",
        scope: 'mcp:write',
        systemAdminOnly: true,
        input: { userId: targetUserId },
        annotations: UPDATES,
        handler: async ({ userId }) => ({
          ...(await this.admin.verifyUser(userId)),
        }),
      }),
      defineTool({
        name: 'admin_users_set_admin',
        title: "Set a user's admin status",
        description:
          'Grant or revoke system admin on a user. Can revoke your own.',
        scope: 'mcp:write',
        systemAdminOnly: true,
        input: { userId: targetUserId, isAdmin: z.boolean() },
        annotations: UPDATES,
        handler: async ({ userId, isAdmin }) => ({
          ...(await this.admin.toggleAdminStatus(userId, isAdmin)),
        }),
      }),
      defineTool({
        name: 'admin_capacity_get',
        title: 'Get measured voice capacity',
        description:
          'The newest load-test result for each environment + GPU pair: the most simultaneous conversations ' +
          'that kept the voice fluent, from a real run, never computed.',
        scope: 'mcp:read',
        systemAdminOnly: true,
        input: {},
        annotations: READ_ONLY,
        handler: async () => ({ items: await this.capacity.latest() }),
      }),
      defineTool({
        name: 'admin_capacity_record',
        title: 'Record a load-test capacity result',
        description:
          'Record one finished load-test run (normally posted by scripts/load-test/load_test.py itself). ' +
          "Field names match that script's JSON output.",
        scope: 'mcp:write',
        systemAdminOnly: true,
        input: {
          measuredAt: z.string().datetime(),
          gpuName: z.string().max(200),
          gpuMemoryMb: z.number().int().min(0).nullable().optional(),
          sttProvider: z.string().max(100).optional(),
          ttsProvider: z.string().max(100).optional(),
          environment: z
            .string()
            .max(100)
            .describe('e.g. "development" or "production"'),
          gitRevision: z.string().max(64).optional(),
          maxSessions: z
            .number()
            .int()
            .min(0)
            .describe(
              'Highest simultaneous session count that kept the voice fluent',
            ),
          limitedBy: z
            .array(z.string())
            .describe(
              'Why the next level failed; empty when the top level passed',
            ),
          reachedTopLevel: z
            .boolean()
            .describe('True when even the highest level tried passed'),
          durationSeconds: z.number().int().min(1),
          criteria: z.record(z.string(), z.unknown()),
          levels: z.array(z.record(z.string(), z.unknown())),
        },
        annotations: CREATES,
        handler: async (args, ctx) => ({
          ...(await this.capacity.record(
            await ctx.validate(RecordCapacityDto, args),
          )),
        }),
      }),
    ];
  }
}
