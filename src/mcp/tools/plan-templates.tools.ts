import { Injectable } from '@nestjs/common';
import type { PlanTemplate } from '@prisma/client';
import { z } from 'zod';
import { PlanTemplatesService } from '../../plan-templates/plan-templates.service.js';
import { PlanGeneratorService } from '../../plan-templates/plan-generator.service.js';
import { CreatePlanTemplateDto } from '../../plan-templates/dto/create-plan-template.dto.js';
import { UpdatePlanTemplateDto } from '../../plan-templates/dto/update-plan-template.dto.js';
import { GeneratePlanTemplateDto } from '../../plan-templates/dto/generate-plan-template.dto.js';
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
  constructor(
    private readonly plans: PlanTemplatesService,
    private readonly generator: PlanGeneratorService,
  ) {}

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
        name: 'plan_templates_generate',
        title: 'Generate a plan template',
        description:
          'Draft a plan from a plain-language description, using the plan generator. Returns a ' +
          'suggested name, description and content; nothing is saved. Pass content to ' +
          'plan_templates_create to keep it.',
        scope: 'mcp:write',
        input: {
          prompt: z
            .string()
            .min(1)
            .max(5000)
            .describe('What the plan should accomplish.'),
          context: z.string().max(500).optional(),
        },
        annotations: CREATES,
        handler: async (args, ctx) => {
          const generated = await this.generator.generate(
            await ctx.validate(GeneratePlanTemplateDto, args),
          );
          return { ...generated };
        },
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
        name: 'plan_templates_duplicate',
        title: 'Duplicate a plan template',
        description:
          'Copy a plan template the user owns into a new one, named "<name> (Copy)". Edit the copy with ' +
          'plan_templates_update; the original is untouched.',
        scope: 'mcp:write',
        input: { planId },
        annotations: CREATES,
        handler: async ({ planId }, ctx) => {
          const copy = await this.plans.duplicate(planId, ctx.auth.user.userId);
          return this.full(copy.id, ctx.auth.user.userId);
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
