import { jest } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import { reconcileAgentTypeConfigurations } from './configuration-reconciliation.js';

type ConfigRow = {
  id: string;
  configuration: Record<string, unknown>;
  agentVersion: string | null;
  compatibility?: string;
  compatibilityNote?: string | null;
};

function createPrisma(version: string, pipelineSchema: unknown, rows: ConfigRow[]) {
  const updates: Record<string, any> = {};
  const prisma = {
    agentType: {
      findUnique: jest.fn(async () => ({ version, pipelineSchema })),
    },
    agentConfiguration: {
      findMany: jest.fn(async () =>
        rows.map((r) => ({ id: r.id, configuration: r.configuration, agentVersion: r.agentVersion })),
      ),
      update: jest.fn(async ({ where: { id }, data }: any) => {
        updates[id] = data;
        return { id, ...data };
      }),
    },
  } as unknown as PrismaClient;
  return { prisma, updates };
}

const schema = {
  nodes: [{ id: 'planner' }],
  thresholds: [{ id: 'temperature', min: 0, max: 1 }],
};
const NOW = new Date('2026-06-02T00:00:00.000Z');

describe('reconcileAgentTypeConfigurations', () => {
  it('prunes a removed-node override and marks it COMPATIBLE (older version)', async () => {
    const { prisma, updates } = createPrisma('2.0.0', schema, [
      {
        id: 'c1',
        agentVersion: '1.0.0',
        configuration: { nodes: { planner: { x: 1 }, removed: {} } },
      },
    ]);
    const report = await reconcileAgentTypeConfigurations(prisma, 'type-A', NOW);

    expect(report.compatible).toBe(1);
    expect(report.outdated).toBe(0);
    expect(report.pruned).toBe(1);
    expect(updates.c1.compatibility).toBe('COMPATIBLE');
    expect(updates.c1.agentVersion).toBe('2.0.0');
    expect(updates.c1.configuration.nodes).toEqual({ planner: { x: 1 } });
  });

  it('marks an out-of-range threshold OUTDATED and leaves it untouched', async () => {
    const { prisma, updates } = createPrisma('2.0.0', schema, [
      { id: 'c2', agentVersion: '2.0.0', configuration: { thresholds: { temperature: 9 } } },
    ]);
    const report = await reconcileAgentTypeConfigurations(prisma, 'type-A', NOW);

    expect(report.outdated).toBe(1);
    expect(updates.c2.compatibility).toBe('OUTDATED');
    expect(updates.c2.compatibilityNote).toMatch(/above maximum/);
    // configuration/agentVersion are NOT overwritten for OUTDATED rows
    expect(updates.c2.configuration).toBeUndefined();
    expect(updates.c2.agentVersion).toBeUndefined();
  });

  it('counts a config that is pruned but still lands OUTDATED', async () => {
    const { prisma } = createPrisma('2.0.0', schema, [
      {
        id: 'c4',
        agentVersion: '2.0.0',
        // A removed-node override (gets pruned) AND an out-of-range threshold
        // (still fails validation → OUTDATED). The prune must be counted.
        configuration: {
          nodes: { planner: {}, removed: {} },
          thresholds: { temperature: 9 },
        },
      },
    ]);
    const report = await reconcileAgentTypeConfigurations(prisma, 'type-A', NOW);

    expect(report.outdated).toBe(1);
    expect(report.pruned).toBe(1);
  });

  it('marks a valid same-version config CURRENT', async () => {
    const { prisma, updates } = createPrisma('2.0.0', schema, [
      { id: 'c3', agentVersion: '2.0.0', configuration: { nodes: { planner: {} } } },
    ]);
    const report = await reconcileAgentTypeConfigurations(prisma, 'type-A', NOW);

    expect(report.current).toBe(1);
    expect(updates.c3.compatibility).toBe('CURRENT');
  });
});
