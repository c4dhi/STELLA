import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { Prisma, ConfigCompatibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateAgentConfigurationDto } from './dto/create-agent-configuration.dto.js';
import { UpdateAgentConfigurationDto } from './dto/update-agent-configuration.dto.js';
import { sanitizeAgentConfig } from '../common/utils/sanitize-config.js';
import {
  validateConfigurationAgainstSchema,
  pruneRemovedOverrides,
  satisfiesMinCompilerVersion,
  type PipelineSchema,
} from './configuration-compat.util.js';
import { deriveEffectiveAgentConfig } from '../kubernetes/utils/agent-config-injection.util.js';

@Injectable()
export class AgentConfigurationsService {
  private readonly logger = new Logger(AgentConfigurationsService.name);

  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateAgentConfigurationDto) {
    this.logger.log(`Creating agent configuration "${dto.name}" for user ${userId}`);

    // Verify agent type exists
    const agentType = await this.prisma.agentType.findUnique({
      where: { id: dto.agentTypeId },
    });
    if (!agentType) {
      throw new BadRequestException(`Agent type with ID ${dto.agentTypeId} not found`);
    }

    // Sanitize the configuration payload
    const sanitized = sanitizeAgentConfig(dto.configuration as Record<string, unknown>);

    // Validate against pipeline schema if available
    if (agentType.pipelineSchema) {
      this.validateConfiguration(sanitized, agentType.pipelineSchema as Record<string, unknown>);
    }

    return this.prisma.agentConfiguration.create({
      data: {
        name: dto.name,
        description: dto.description,
        agentTypeId: dto.agentTypeId,
        configuration: sanitized as Prisma.InputJsonValue,
        agentVersion: dto.agentVersion || agentType.version,
        // Default the required minimum compiler version to the type's current one
        // (the version available when this config was authored).
        minCompilerVersion: dto.minCompilerVersion ?? agentType.compilerVersion,
        userId,
      },
    });
  }

  async findAllByUser(userId: string, agentTypeId?: string) {
    const where: Prisma.AgentConfigurationWhereInput = { userId };
    if (agentTypeId) {
      where.agentTypeId = agentTypeId;
    }

    return this.prisma.agentConfiguration.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        agentType: {
          select: { id: true, slug: true, name: true, icon: true },
        },
      },
    });
  }

  async findOne(id: string, userId: string) {
    const config = await this.prisma.agentConfiguration.findUnique({
      where: { id },
      include: {
        agentType: {
          select: { id: true, slug: true, name: true, icon: true, pipelineSchema: true },
        },
      },
    });

    if (!config) {
      throw new NotFoundException(`Agent configuration with ID ${id} not found`);
    }

    if (config.userId !== userId) {
      throw new NotFoundException(`Agent configuration with ID ${id} not found`);
    }

    return config;
  }

  async update(id: string, userId: string, dto: UpdateAgentConfigurationDto) {
    const existing = await this.findOne(id, userId);

    const data: Prisma.AgentConfigurationUpdateInput = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;

    if (dto.configuration !== undefined) {
      // A re-save is the user's remediation path for an OUTDATED config, so we must
      // recompute compatibility here (the seed-time reconciliation pass only runs on
      // version/schema changes). Mirror that pass for this single row: prune dangling
      // refs, re-validate against the CURRENT schema, and re-stamp the state so a
      // fixed config flips back to CURRENT and clears its note.
      const sanitized = sanitizeAgentConfig(dto.configuration as Record<string, unknown>);
      const agentType = await this.prisma.agentType.findUnique({
        where: { id: existing.agentTypeId },
        select: { version: true, pipelineSchema: true, compilerVersion: true },
      });

      const recomputed = this.recomputeCompatibility(
        sanitized,
        existing.minCompilerVersion,
        existing.agentVersion,
        agentType,
      );
      data.configuration = recomputed.configuration as Prisma.InputJsonValue;
      data.compatibility = recomputed.compatibility;
      data.compatibilityNote = recomputed.compatibilityNote;
      data.agentVersion = recomputed.agentVersion;
      data.lastReconciledAt = recomputed.lastReconciledAt;
    } else if (dto.agentVersion !== undefined) {
      data.agentVersion = dto.agentVersion;
    }

    return this.prisma.agentConfiguration.update({
      where: { id },
      data,
    });
  }

  /**
   * Single-row equivalent of {@link reconcileAgentTypeConfigurations}: validate a
   * (just-edited) override payload against the agent type's CURRENT schema and
   * derive the persisted reconciliation state.
   *
   *  - prune dangling node/threshold refs the schema no longer declares,
   *  - if the pruned overrides satisfy the compiler floor and re-validate: mark
   *    CURRENT and stamp agentVersion to the type's current version,
   *  - otherwise: mark OUTDATED with the reason and leave agentVersion untouched.
   *
   * When the type carries no schema we cannot judge compatibility, so we accept the
   * payload as-is and keep it CURRENT.
   */
  private recomputeCompatibility(
    overrides: Record<string, unknown>,
    minCompilerVersion: string | null,
    existingAgentVersion: string | null,
    agentType: {
      version: string | null;
      pipelineSchema: Prisma.JsonValue | null;
      compilerVersion: string | null;
    } | null,
    now: Date = new Date(),
  ): {
    configuration: Record<string, unknown>;
    compatibility: ConfigCompatibility;
    compatibilityNote: string | null;
    agentVersion: string | null;
    lastReconciledAt: Date;
  } {
    if (!agentType) {
      return {
        configuration: overrides,
        compatibility: ConfigCompatibility.CURRENT,
        compatibilityNote: null,
        agentVersion: existingAgentVersion,
        lastReconciledAt: now,
      };
    }

    const pipelineSchema = agentType.pipelineSchema as PipelineSchema;
    const { sanitized } = pruneRemovedOverrides(overrides, pipelineSchema);

    try {
      if (!satisfiesMinCompilerVersion(agentType.compilerVersion, minCompilerVersion)) {
        throw new Error(
          `requires prompt-compiler version >= ${minCompilerVersion}, ` +
            `agent provides ${agentType.compilerVersion ?? '(none)'}`,
        );
      }
      validateConfigurationAgainstSchema(sanitized, pipelineSchema);

      return {
        configuration: sanitized,
        compatibility: ConfigCompatibility.CURRENT,
        compatibilityNote: null,
        agentVersion: agentType.version,
        lastReconciledAt: now,
      };
    } catch (e) {
      return {
        configuration: sanitized,
        compatibility: ConfigCompatibility.OUTDATED,
        compatibilityNote: (e as Error).message,
        agentVersion: existingAgentVersion,
        lastReconciledAt: now,
      };
    }
  }

  async remove(id: string, userId: string) {
    const config = await this.findOne(id, userId);

    this.logger.log(
      `Deleting agent configuration ${id} (${config.name}) for user ${userId}`,
    );

    await this.prisma.agentConfiguration.delete({
      where: { id },
    });

    return { message: 'Agent configuration deleted successfully' };
  }

  async duplicate(id: string, userId: string) {
    const config = await this.findOne(id, userId);

    this.logger.log(
      `Duplicating agent configuration ${id} (${config.name}) for user ${userId}`,
    );

    // A duplicate is a faithful copy: carry the compiler-version floor and the
    // reconciliation state so the copy doesn't silently lose its requirements (a
    // dropped minCompilerVersion would default to "no requirement") or masquerade
    // as CURRENT when the source was OUTDATED.
    return this.prisma.agentConfiguration.create({
      data: {
        name: `${config.name} (Copy)`,
        description: config.description,
        agentTypeId: config.agentTypeId,
        configuration: config.configuration as Prisma.InputJsonValue,
        agentVersion: config.agentVersion,
        minCompilerVersion: config.minCompilerVersion,
        compatibility: config.compatibility,
        compatibilityNote: config.compatibilityNote,
        lastReconciledAt: config.lastReconciledAt,
        userId,
      },
    });
  }

  /**
   * Resolve a stored configuration for deployment to an agent of a given type.
   *
   * Enforces type + version pinning and guarantees the agent receives a complete,
   * current-schema-valid config:
   *   1. ownership (404 via findOne),
   *   2. agent-type match (400 on mismatch),
   *   3. not OUTDATED (400; precomputed by reconciliation, so this is an O(1) read),
   *   4. re-validate the overrides against the CURRENT pipelineSchema (defence in depth),
   *   5. deep-merge over the AgentType defaults so the pod always gets a full config.
   *
   * Returns the effective config object to inject as `pipeline_config`.
   */
  async resolveForDeploy(
    configId: string,
    userId: string,
    agentTypeId: string,
    agentTypeRecord: {
      version?: string | null;
      compilerVersion?: string | null;
      defaultConfig?: Prisma.JsonValue | null;
      pipelineSchema?: Prisma.JsonValue | null;
      configSchema?: Prisma.JsonValue | null;
    },
  ): Promise<Record<string, unknown>> {
    const cfg = await this.findOne(configId, userId); // 404 on bad ownership

    if (cfg.agentTypeId !== agentTypeId) {
      throw new BadRequestException(
        `Agent configuration ${configId} is bound to agent type ${cfg.agentTypeId}, not ${agentTypeId}`,
      );
    }

    if (cfg.compatibility === 'OUTDATED') {
      throw new BadRequestException(
        `Agent configuration ${configId} is outdated for the current agent version` +
          (agentTypeRecord.version ? ` (${agentTypeRecord.version})` : '') +
          (cfg.compatibilityNote ? `: ${cfg.compatibilityNote}` : '') +
          '. Open it in settings to review and re-save.',
      );
    }

    // The target agent's prompt compiler must be new enough for this config's prompts.
    if (
      !satisfiesMinCompilerVersion(
        agentTypeRecord.compilerVersion,
        cfg.minCompilerVersion,
      )
    ) {
      throw new BadRequestException(
        `Agent configuration ${configId} requires prompt-compiler version >= ${cfg.minCompilerVersion}, ` +
          `but the agent provides ${agentTypeRecord.compilerVersion ?? '(none)'}. Upgrade the agent or re-save the configuration.`,
      );
    }

    // Defence in depth: re-validate against the current schema before applying.
    // Prune dangling node/threshold refs FIRST, exactly as the reconciliation pass
    // does, so the two paths agree: a config reconciliation would have pruned and
    // accepted (e.g. a node the schema dropped after the last re-seed) deploys here
    // too, instead of 400-ing with "Unknown node ID." Pruning never clamps values,
    // so genuinely invalid overrides (e.g. out-of-range thresholds) still reject.
    const stored = (cfg.configuration ?? {}) as Record<string, unknown>;
    const { sanitized: overrides } = pruneRemovedOverrides(
      stored,
      agentTypeRecord.pipelineSchema as PipelineSchema,
    );
    try {
      validateConfigurationAgainstSchema(
        overrides,
        agentTypeRecord.pipelineSchema as Record<string, unknown> | null,
      );
    } catch (e) {
      throw new BadRequestException(
        `Agent configuration ${configId} is incompatible with the current agent schema: ${
          (e as Error).message
        }`,
      );
    }

    // Always merge over defaults so the agent receives a complete config.
    return deriveEffectiveAgentConfig(
      {
        slug: '',
        defaultConfig: (agentTypeRecord.defaultConfig ?? null) as
          | Record<string, unknown>
          | null,
        configSchema: (agentTypeRecord.configSchema ?? null) as
          | Record<string, unknown>
          | null,
      },
      { configuration: overrides },
    );
  }

  /**
   * Validate configuration against the agent type's pipeline schema.
   * Delegates to the shared (DI-free) checker and maps failures to HTTP 400.
   */
  private validateConfiguration(
    config: Record<string, unknown>,
    pipelineSchema: Record<string, unknown>,
  ) {
    try {
      validateConfigurationAgainstSchema(config, pipelineSchema);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
}
