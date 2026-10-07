import { PrismaClient, ConfigCompatibility, Prisma } from '@prisma/client';
import {
  validateConfigurationAgainstSchema,
  pruneRemovedOverrides,
  satisfiesMinCompilerVersion,
  type PipelineSchema,
} from './configuration-compat.util.js';

export interface ReconcileReport {
  agentTypeId: string;
  total: number;
  current: number;
  compatible: number;
  outdated: number;
  pruned: number;
}

/**
 * Re-evaluate every saved AgentConfiguration for one AgentType against that
 * type's CURRENT pipelineSchema, and persist the result on each row.
 *
 * This is the single auto-reconciliation pass. It is intentionally invoked ONLY
 * when an AgentType's version/schema actually changes (see prisma/seed.ts), so
 * deploy/read paths can rely on the precomputed `compatibility` flag instead of
 * re-validating on every request.
 *
 * Policy ("auto-reconcile + flag"):
 *  - prune dangling overrides for nodes/thresholds the new schema removed,
 *  - if the pruned overrides re-validate: stamp agentVersion to current and mark
 *    CURRENT (same version) or COMPATIBLE (older but valid),
 *  - if they still fail (e.g. an out-of-range threshold): mark OUTDATED with the
 *    reason and leave the stored overrides/version untouched for user review.
 *
 * DI-free so it can run both inside NestJS and from the plain `prisma/seed.ts`
 * script. Accepts any PrismaClient (PrismaService extends it).
 */
export async function reconcileAgentTypeConfigurations(
  prisma: PrismaClient,
  agentTypeId: string,
  now: Date = new Date(),
): Promise<ReconcileReport> {
  const agentType = await prisma.agentType.findUnique({
    where: { id: agentTypeId },
    select: { version: true, pipelineSchema: true, compilerVersion: true },
  });

  const report: ReconcileReport = {
    agentTypeId,
    total: 0,
    current: 0,
    compatible: 0,
    outdated: 0,
    pruned: 0,
  };

  if (!agentType) return report;

  const pipelineSchema = agentType.pipelineSchema as PipelineSchema;
  const configs = await prisma.agentConfiguration.findMany({
    where: { agentTypeId },
    select: {
      id: true,
      configuration: true,
      agentVersion: true,
      minCompilerVersion: true,
    },
  });

  report.total = configs.length;

  for (const cfg of configs) {
    const overrides = (cfg.configuration ?? {}) as Record<string, unknown>;
    const { sanitized, prunedKeys } = pruneRemovedOverrides(
      overrides,
      pipelineSchema,
    );

    // Count the prune itself regardless of whether the sanitized config then
    // re-validates — a config that gets pruned and still fails (→ OUTDATED) was
    // still pruned, and the operator report should reflect that.
    if (prunedKeys.length > 0) report.pruned += 1;

    try {
      // The agent's compiler must satisfy the config's required minimum.
      if (
        !satisfiesMinCompilerVersion(
          agentType.compilerVersion,
          cfg.minCompilerVersion,
        )
      ) {
        throw new Error(
          `requires prompt-compiler version >= ${cfg.minCompilerVersion}, ` +
            `agent provides ${agentType.compilerVersion ?? '(none)'}`,
        );
      }
      validateConfigurationAgainstSchema(sanitized, pipelineSchema);

      const status =
        cfg.agentVersion === agentType.version
          ? ConfigCompatibility.CURRENT
          : ConfigCompatibility.COMPATIBLE;

      await prisma.agentConfiguration.update({
        where: { id: cfg.id },
        data: {
          configuration: sanitized as Prisma.InputJsonValue,
          agentVersion: agentType.version,
          compatibility: status,
          compatibilityNote: null,
          lastReconciledAt: now,
        },
      });

      if (status === ConfigCompatibility.CURRENT) report.current += 1;
      else report.compatible += 1;
    } catch (e) {
      await prisma.agentConfiguration.update({
        where: { id: cfg.id },
        data: {
          compatibility: ConfigCompatibility.OUTDATED,
          compatibilityNote: (e as Error).message,
          lastReconciledAt: now,
        },
      });
      report.outdated += 1;
    }
  }

  return report;
}
