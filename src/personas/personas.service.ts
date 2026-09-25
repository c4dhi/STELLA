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
        voice: persona.voice,
        language: persona.language,
        variables: (persona.variables ?? undefined) as never,
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
   * Resolve the persona for a deployment, given its config.
   *
   * Order: an explicit `personaId`, then the persona the deployed plan spoke with
   * before identity moved out of plans (PlanTemplate.defaultPersonaId, linked by
   * the upgrade script), then the system default. The middle step is what keeps
   * an existing plan's personality across the 1.3.0 upgrade.
   *
   * Returns null when the plan still carries its own `system_prompt` and nothing
   * names a persona. That is a config saved before the upgrade (a paused session
   * waking up): stamping the system default here would make it win over the
   * plan's identity, so the agent falls back to the plan's own prompt instead.
   * TEMPORARY, together with that agent fallback — remove one release after 1.3.0.
   */
  async resolveForDeployConfig(
    agentConfig: Record<string, unknown>,
    personaId: string | undefined | null,
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    const plan =
      agentConfig.plan && typeof agentConfig.plan === 'object'
        ? (agentConfig.plan as { id?: unknown; system_prompt?: unknown })
        : null;

    const effectiveId =
      personaId ??
      (await this.findPlanDefaultPersonaId(plan?.id ?? agentConfig.plan_id, userId));

    const legacyPrompt = plan?.system_prompt;
    if (
      !effectiveId &&
      typeof legacyPrompt === 'string' &&
      legacyPrompt.trim().length > 0
    ) {
      this.logger.warn(
        'Config has no persona but its plan carries a system_prompt; leaving the persona unset so the plan keeps its own identity',
      );
      return null;
    }

    return this.resolveForDeploy(effectiveId, userId);
  }

  /**
   * Only plans the caller owns count, so a deploy config cannot borrow another
   * user's persona by naming their plan id.
   */
  private async findPlanDefaultPersonaId(
    planId: unknown,
    userId: string,
  ): Promise<string | undefined> {
    if (typeof planId !== 'string' || !planId) return undefined;
    const template = await this.prisma.planTemplate.findUnique({
      where: { id: planId },
      select: { userId: true, defaultPersonaId: true },
    });
    if (!template || template.userId !== userId) return undefined;
    return template.defaultPersonaId ?? undefined;
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
      voice: persona.voice ?? undefined,
      language: persona.language ?? undefined,
      // Referenced elsewhere as {{persona.<key>}} — in an AgentConfiguration's
      // prompts and in a plan's own text. Snapshotted with the rest of the
      // persona, so a variable is resolved against the values that were current
      // when the agent was deployed.
      variables: (persona.variables as Record<string, string> | null) ?? {},
      // Lets the agent tell "the operator chose this identity" from "nobody chose
      // one, here is the floor". Plans no longer carry an identity of their own
      // (#467 phase 2), so this is informational: the agent logs it.
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
