import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Persona } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePersonaDto } from './dto/create-persona.dto';
import { UpdatePersonaDto } from './dto/update-persona.dto';

/**
 * Personas — agent identity, separate from what the agent does (PlanTemplate) and
 * how it runs (AgentConfiguration). See docs/rfcs/2026-08-29_persona-separation.md.
 *
 * Scoping mirrors PlanTemplate: rows are private to their author, and a foreign
 * row 404s rather than 403s so its existence is not disclosed. The one addition is
 * the system default (userId null, isSystemDefault true), which every user can read
 * and duplicate but nobody can edit or delete — the resolution chain terminates
 * there, so it has to always exist.
 */
@Injectable()
export class PersonasService {
  private readonly logger = new Logger(PersonasService.name);

  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreatePersonaDto) {
    this.logger.log(`Creating persona "${dto.name}" for user ${userId}`);

    return this.prisma.persona.create({
      data: { ...dto, userId },
    });
  }

  /**
   * The user's own personas plus the system default, which is listed last so the
   * picker shows authored identities first and the fallback as the floor.
   */
  async findAllForUser(userId: string) {
    return this.prisma.persona.findMany({
      where: { OR: [{ userId }, { isSystemDefault: true }] },
      orderBy: [{ isSystemDefault: 'asc' }, { updatedAt: 'desc' }],
    });
  }

  async findOne(id: string, userId: string) {
    const persona = await this.prisma.persona.findUnique({ where: { id } });

    // A persona the caller does not own is reported as missing rather than
    // forbidden, matching PlanTemplatesService.
    if (!persona || (persona.userId !== userId && !persona.isSystemDefault)) {
      throw new NotFoundException(`Persona with ID ${id} not found`);
    }

    return persona;
  }

  async update(id: string, userId: string, dto: UpdatePersonaDto) {
    const persona = await this.findOne(id, userId);
    this.assertMutable(persona);

    return this.prisma.persona.update({ where: { id }, data: dto });
  }

  async remove(id: string, userId: string) {
    const persona = await this.findOne(id, userId);
    this.assertMutable(persona);

    this.logger.log(`Deleting persona ${id} (${persona.name}) for user ${userId}`);
    await this.prisma.persona.delete({ where: { id } });

    return { message: 'Persona deleted successfully' };
  }

  async duplicate(id: string, userId: string) {
    const persona = await this.findOne(id, userId);

    this.logger.log(`Duplicating persona ${id} (${persona.name}) for user ${userId}`);

    return this.prisma.persona.create({
      data: {
        name: `${persona.name} (Copy)`,
        description: persona.description,
        icon: persona.icon,
        systemPrompt: persona.systemPrompt,
        greeting: persona.greeting,
        voice: persona.voice,
        language: persona.language,
        userId,
        // A copy is always an ordinary persona, never a second system default.
        isSystemDefault: false,
      },
    });
  }

  /**
   * The system default persona — the terminus of the resolution chain.
   *
   * Used when a deployment names no persona, and when a persona's owner has been
   * deleted (userId is SET NULL, not cascaded, precisely so that degrades to this
   * rather than breaking a resumable session).
   */
  async findSystemDefault(): Promise<Persona | null> {
    return this.prisma.persona.findFirst({ where: { isSystemDefault: true } });
  }

  /**
   * Resolve the persona payload injected into an agent's deploy config.
   *
   * Snapshot semantics, matching pipeline_config: the caller writes the resolved
   * VALUES into agentConfig, so a later edit or deletion reaches the next
   * deployment and never a running or resuming one (see RFC §3).
   */
  async resolveForDeploy(
    personaId: string | undefined | null,
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    const persona = personaId
      ? await this.findOne(personaId, userId)
      : await this.findSystemDefault();

    if (!persona) {
      // Only reachable if the seeded default row was deleted out from under us.
      this.logger.warn(
        'No system default persona found; deploying without a persona so the agent falls back to its built-in default',
      );
      return null;
    }

    return {
      id: persona.id,
      name: persona.name,
      icon: persona.icon ?? undefined,
      system_prompt: persona.systemPrompt,
      greeting: persona.greeting ?? undefined,
      voice: persona.voice ?? undefined,
      language: persona.language ?? undefined,
      // Lets the agent tell "the operator chose this identity" from "nobody chose
      // one, here is the floor". Until the phase-2 clean cut, a deployment that
      // configured its persona in the Agent Configurator must keep winning over
      // the default — otherwise simply shipping this feature would change the
      // voice of every existing deployment.
      is_system_default: persona.isSystemDefault,
    };
  }

  private assertMutable(persona: Persona): void {
    if (persona.isSystemDefault) {
      throw new BadRequestException(
        'The system default persona cannot be modified or deleted. Duplicate it to make your own.',
      );
    }
  }
}
