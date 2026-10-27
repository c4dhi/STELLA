import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PersonasService } from '../../personas/personas.service.js';
import { CreatePersonaDto } from '../../personas/dto/create-persona.dto.js';
import { UpdatePersonaDto } from '../../personas/dto/update-persona.dto.js';
import {
  CREATES,
  McpToolProvider,
  READ_ONLY,
  UPDATES,
  defineTool,
  idArg,
} from '../mcp.types.js';

// Mirrors CreatePersonaDto / UpdatePersonaDto, which do the real validation.
const personaFields = {
  name: z.string().min(1).max(255).describe('Display name, e.g. "Grace"'),
  description: z.string().max(2000).optional(),
  icon: z.string().max(16).optional().describe('An emoji'),
  systemPrompt: z
    .string()
    .min(1)
    .max(20000)
    .describe(
      'Who the agent is. Injected verbatim; {{placeholders}} are not resolved here.',
    ),
  voice: z
    .string()
    .max(128)
    .optional()
    .describe('TTS voice id; empty means the provider default'),
  language: z
    .string()
    .max(16)
    .optional()
    .describe('Fallback language when no plan sets one, e.g. "de"'),
  variables: z
    .record(z.string(), z.string())
    .optional()
    .describe('Values other prompts reference as {{persona.<key>}}'),
};

const personaId = idArg('persona', 'personas_list');

/** What personas_list shows of one: everything but the prompt and its variables. */
function personaSummary(persona: Record<string, any>) {
  return {
    id: persona.id,
    name: persona.name,
    description: persona.description,
    icon: persona.icon,
    voice: persona.voice,
    language: persona.language,
    isSystemDefault: persona.isSystemDefault,
    updatedAt: persona.updatedAt,
  };
}

/** Personas: who the agent is (system prompt, voice, language). */
@Injectable()
export class PersonasTools implements McpToolProvider {
  constructor(private readonly personas: PersonasService) {}

  tools() {
    return [
      defineTool({
        name: 'personas_list',
        title: 'List personas',
        description:
          "The user's personas plus the system defaults (isSystemDefault: true, read-only). personas_get has " +
          'the system prompt.',
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async (_args, { auth }) => ({
          items: (await this.personas.findAllForUser(auth.user.userId)).map(
            personaSummary,
          ),
        }),
      }),
      defineTool({
        name: 'personas_get',
        title: 'Get a persona',
        description: 'One persona, including its full system prompt.',
        scope: 'mcp:read',
        input: { personaId },
        annotations: READ_ONLY,
        handler: async ({ personaId }, { auth }) =>
          this.personas.findOne(personaId, auth.user.userId),
      }),
      defineTool({
        name: 'personas_create',
        title: 'Create a persona',
        description: 'Create a persona owned by the user.',
        scope: 'mcp:write',
        input: personaFields,
        annotations: CREATES,
        handler: async (args, ctx) =>
          this.personas.create(
            ctx.auth.user.userId,
            await ctx.validate(CreatePersonaDto, args),
          ),
      }),
      defineTool({
        name: 'personas_update',
        title: 'Update a persona',
        description:
          'Change fields of a persona the user owns. Omitted fields stay as they are. System defaults cannot be changed.',
        scope: 'mcp:write',
        input: { personaId, ...z.object(personaFields).partial().shape },
        annotations: UPDATES,
        handler: async ({ personaId, ...changes }, ctx) =>
          this.personas.update(
            personaId,
            ctx.auth.user.userId,
            await ctx.validate(UpdatePersonaDto, changes),
          ),
      }),
    ];
  }
}
