import { Injectable } from '@nestjs/common';
import type { PlanTemplate } from '@prisma/client';
import { z } from 'zod';
import { PlanTemplatesService } from '../../plan-templates/plan-templates.service.js';
import { CreatePlanTemplateDto } from '../../plan-templates/dto/create-plan-template.dto.js';
import { UpdatePlanTemplateDto } from '../../plan-templates/dto/update-plan-template.dto.js';
import {
  CREATES,
  McpToolProvider,
  READ_ONLY,
  UPDATES,
  defineTool,
  idArg,
} from '../mcp.types.js';

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

const planId = idArg('plan template', 'plan_templates_list');

/** What plan_templates_list shows of one: everything but its content. */
function planSummary(plan: PlanTemplate) {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    defaultPersonaId: plan.defaultPersonaId,
    updatedAt: plan.updatedAt,
  };
}

/** Plan templates: what happens in a conversation. */
@Injectable()
export class PlanTemplatesTools implements McpToolProvider {
  constructor(private readonly plans: PlanTemplatesService) {}

  /** A plan as plan_templates_get shows it; creates and updates return this too. */
  private full(planId: string, userId: string) {
    return this.plans.findOne(planId, userId);
  }

  tools() {
    return [
      defineTool({
        name: 'plan_templates_list',
        title: 'List plan templates',
        description:
          "The user's plan templates. plan_templates_get has the content of one.",
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async (_args, { auth }) => ({
          items: (await this.plans.findAllByUser(auth.user.userId)).map(
            planSummary,
          ),
        }),
      }),
      defineTool({
        name: 'plan_templates_get',
        title: 'Get a plan template',
        description: 'One plan template with its full content.',
        scope: 'mcp:read',
        input: { planId },
        annotations: READ_ONLY,
        handler: async ({ planId }, { auth }) =>
          this.full(planId, auth.user.userId),
      }),
      defineTool({
        name: 'plan_templates_create',
        title: 'Create a plan template',
        description: 'Create a plan template owned by the user.',
        scope: 'mcp:write',
        input: planFields,
        annotations: CREATES,
        handler: async (args, ctx) => {
          const plan = await this.plans.create(
            ctx.auth.user.userId,
            await ctx.validate(CreatePlanTemplateDto, args),
          );
          return this.full(plan.id, ctx.auth.user.userId);
        },
      }),
      defineTool({
        name: 'plan_templates_update',
        title: 'Update a plan template',
        description:
          'Change fields of a plan template the user owns. content replaces the whole plan content.',
        scope: 'mcp:write',
        input: { planId, ...z.object(planFields).partial().shape },
        annotations: UPDATES,
        handler: async ({ planId, ...changes }, ctx) => {
          await this.plans.update(
            planId,
            ctx.auth.user.userId,
            await ctx.validate(UpdatePlanTemplateDto, changes),
          );
          return this.full(planId, ctx.auth.user.userId);
        },
      }),
    ];
  }
}
