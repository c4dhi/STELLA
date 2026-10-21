import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PlanTemplatesService } from '../../plan-templates/plan-templates.service.js';
import { CreatePlanTemplateDto } from '../../plan-templates/dto/create-plan-template.dto.js';
import { UpdatePlanTemplateDto } from '../../plan-templates/dto/update-plan-template.dto.js';
import { CREATES, McpToolProvider, READ_ONLY, UPDATES, defineTool } from '../mcp.types.js';

// Mirrors CreatePlanTemplateDto; IsPlanContent checks the content itself.
const planFields = {
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  content: z
    .record(z.string(), z.unknown())
    .describe(
      'The plan: states, their tasks and transitions, and deliverables. Read an existing plan with ' +
        'plan_templates_get first and follow its structure. A plan must not contain system_prompt or voice: ' +
        'those belong to a persona.',
    ),
};

/** Plan templates: what happens in a conversation. */
@Injectable()
export class PlanTemplatesTools implements McpToolProvider {
  constructor(private readonly plans: PlanTemplatesService) {}

  tools() {
    return [
      defineTool({
        name: 'plan_templates_list',
        title: 'List plan templates',
        description: "The user's plan templates.",
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async (_args, { auth }) => ({ items: await this.plans.findAllByUser(auth.user.userId) }),
      }),
      defineTool({
        name: 'plan_templates_get',
        title: 'Get a plan template',
        description: 'One plan template with its full content.',
        scope: 'mcp:read',
        input: { id: z.string() },
        annotations: READ_ONLY,
        handler: async ({ id }, { auth }) => this.plans.findOne(id, auth.user.userId),
      }),
      defineTool({
        name: 'plan_templates_create',
        title: 'Create a plan template',
        description: 'Create a plan template owned by the user.',
        scope: 'mcp:write',
        input: planFields,
        annotations: CREATES,
        handler: async (args, ctx) =>
          this.plans.create(ctx.auth.user.userId, await ctx.validate(CreatePlanTemplateDto, args)),
      }),
      defineTool({
        name: 'plan_templates_update',
        title: 'Update a plan template',
        description: 'Change fields of a plan template the user owns. content replaces the whole plan content.',
        scope: 'mcp:write',
        input: { id: z.string(), changes: z.object(planFields).partial() },
        annotations: UPDATES,
        handler: async ({ id, changes }, ctx) =>
          this.plans.update(id, ctx.auth.user.userId, await ctx.validate(UpdatePlanTemplateDto, changes)),
      }),
    ];
  }
}
