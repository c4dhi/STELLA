import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { EnvVarTemplatesService } from '../../env-var-templates/env-var-templates.service.js';
import { CreateEnvVarTemplateDto } from '../../env-var-templates/dto/create-env-var-template.dto.js';
import { UpdateEnvVarTemplateDto } from '../../env-var-templates/dto/update-env-var-template.dto.js';
import {
  CREATES,
  McpToolProvider,
  READ_ONLY,
  UPDATES,
  defineTool,
  idArg,
} from '../mcp.types.js';

const envVarTemplateId = idArg('env var template', 'env_var_templates_list');

const variables = z
  .record(z.string(), z.string())
  .describe(
    'Variable name to value. Values are secrets: they pass through this chat and are stored encrypted, ' +
      'never returned by any tool.',
  );

/** Env var templates: the API keys and settings an agent type's env declares. */
@Injectable()
export class EnvVarTemplatesTools implements McpToolProvider {
  constructor(private readonly envVarTemplates: EnvVarTemplatesService) {}

  tools() {
    return [
      defineTool({
        name: 'env_var_templates_list',
        title: 'List env var templates',
        description:
          "The user's env var templates (API keys for agents), with variable names only, never values. " +
          "Pass one as envVarTemplateId to agents_deploy when the agent type's required env vars need it; " +
          'a template only fits agents of its agentTypeId. invalid names the settings whose stored value does ' +
          'not fit their type or range (agents_deploy refuses those until they are fixed in the app); ' +
          'needsCheck is true for a template not saved since settings became typed.',
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async (_args, { auth }) => ({
          items: (
            await this.envVarTemplates.findAllByUser(auth.user.userId)
          ).map(
            ({
              id,
              name,
              description,
              variableKeys,
              agentTypeId,
              invalid,
              needsCheck,
            }) => ({
              id,
              name,
              description,
              variableKeys,
              agentTypeId,
              invalid,
              needsCheck,
            }),
          ),
        }),
      }),
      defineTool({
        name: 'env_var_templates_get',
        title: 'Get an env var template',
        description:
          'One env var template: its declared settings whose type is readable (string, boolean, integer, ' +
          'number, enum) show their stored value; secrets and custom variables show as variableKeys only.',
        scope: 'mcp:read',
        input: { envVarTemplateId },
        annotations: READ_ONLY,
        handler: async ({ envVarTemplateId }, { auth }) => ({
          ...(await this.envVarTemplates.findOne(
            envVarTemplateId,
            auth.user.userId,
          )),
        }),
      }),
      defineTool({
        name: 'env_var_templates_create',
        title: 'Create an env var template',
        description:
          'Create an env var template holding the variables an agent type needs, scoped to exactly that ' +
          "agentTypeId. Refused, naming each one, when a value doesn't fit what the type declares for it.",
        scope: 'mcp:write',
        input: {
          name: z.string().min(1).max(255),
          description: z.string().max(2000).optional(),
          variables,
          agentTypeId: idArg('agent type', 'agent_types_list'),
        },
        annotations: CREATES,
        handler: async (args, ctx) => ({
          ...(await this.envVarTemplates.create(
            ctx.auth.user.userId,
            await ctx.validate(CreateEnvVarTemplateDto, args),
          )),
        }),
      }),
      defineTool({
        name: 'env_var_templates_duplicate',
        title: 'Duplicate an env var template',
        description:
          'Copy an env var template the user owns into a new one, named "`<name>` (Copy)", for the same ' +
          'agentTypeId. The variables themselves are carried over without being re-entered; env_var_templates_update ' +
          'changes the copy.',
        scope: 'mcp:write',
        input: { envVarTemplateId },
        annotations: CREATES,
        handler: async ({ envVarTemplateId }, ctx) => {
          const copy = await this.envVarTemplates.duplicate(
            envVarTemplateId,
            ctx.auth.user.userId,
          );
          return {
            ...(await this.envVarTemplates.findOne(
              copy.id,
              ctx.auth.user.userId,
            )),
          };
        },
      }),
      defineTool({
        name: 'env_var_templates_update',
        title: 'Update an env var template',
        description:
          "Change a template's name, description or variables. variables adds or overwrites by name; " +
          'removeKeys deletes by name. Both are merged onto the existing values, so untouched secrets keep ' +
          "their stored value and are never re-sent. The template's agentTypeId can't change; duplicate it " +
          'under the desired type instead.',
        scope: 'mcp:write',
        input: {
          envVarTemplateId,
          name: z.string().min(1).max(255).optional(),
          description: z.string().max(2000).optional(),
          variables: variables.optional(),
          removeKeys: z.array(z.string()).optional(),
        },
        annotations: UPDATES,
        handler: async ({ envVarTemplateId, ...fields }, ctx) => ({
          ...(await this.envVarTemplates.update(
            envVarTemplateId,
            ctx.auth.user.userId,
            await ctx.validate(UpdateEnvVarTemplateDto, fields),
          )),
        }),
      }),
    ];
  }
}
