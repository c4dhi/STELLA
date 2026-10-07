import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentConfigurationsService } from './agent-configurations.service.js';

type ConfigRow = {
  id: string;
  userId: string;
  agentTypeId: string;
  configuration: Record<string, unknown>;
  compatibility: 'CURRENT' | 'COMPATIBLE' | 'OUTDATED';
  compatibilityNote: string | null;
  agentType?: unknown;
};

const agentTypeRecord = {
  version: '2.0.0',
  defaultConfig: { llm: { model: 'gpt-4o-mini', temperature: 0.7 } },
  pipelineSchema: {
    nodes: [{ id: 'planner' }],
    thresholds: [{ id: 'temperature', min: 0, max: 1 }],
  },
  configSchema: null,
};

function createService(row: ConfigRow) {
  const prisma = {
    agentConfiguration: {
      findUnique: jest.fn(async ({ where: { id } }: any) =>
        id === row.id ? { ...row, agentType: {} } : null,
      ),
    },
  } as unknown as PrismaService;
  return new AgentConfigurationsService(prisma);
}

const base: ConfigRow = {
  id: 'cfg-1',
  userId: 'user-1',
  agentTypeId: 'type-A',
  configuration: { nodes: { planner: { x: 1 } }, thresholds: { temperature: 0.3 } },
  compatibility: 'CURRENT',
  compatibilityNote: null,
};

describe('AgentConfigurationsService.resolveForDeploy', () => {
  it('rejects a configuration bound to a different agent type', async () => {
    const svc = createService(base);
    await expect(
      svc.resolveForDeploy('cfg-1', 'user-1', 'type-B', agentTypeRecord),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an OUTDATED configuration', async () => {
    const svc = createService({ ...base, compatibility: 'OUTDATED', compatibilityNote: 'unknown node' });
    await expect(
      svc.resolveForDeploy('cfg-1', 'user-1', 'type-A', agentTypeRecord),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('merges overrides over the agent type defaults on success', async () => {
    const svc = createService(base);
    const effective = await svc.resolveForDeploy('cfg-1', 'user-1', 'type-A', agentTypeRecord);
    // defaults preserved + overrides applied
    expect(effective).toEqual({
      llm: { model: 'gpt-4o-mini', temperature: 0.7 },
      nodes: { planner: { x: 1 } },
      thresholds: { temperature: 0.3 },
    });
  });

  it('rejects a config that no longer validates against the current schema', async () => {
    const svc = createService({
      ...base,
      // an out-of-range threshold cannot be pruned, so it still rejects
      configuration: { thresholds: { temperature: 5 } },
    });
    await expect(
      svc.resolveForDeploy('cfg-1', 'user-1', 'type-A', agentTypeRecord),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('prunes dangling refs (node the schema dropped) and accepts, matching reconciliation', async () => {
    const svc = createService({
      ...base,
      // `ghost` references a node the current schema no longer declares; pruning
      // drops it so the deploy succeeds (same outcome reconciliation would persist).
      configuration: { nodes: { planner: { x: 1 }, ghost: {} } },
    });
    const effective = await svc.resolveForDeploy('cfg-1', 'user-1', 'type-A', agentTypeRecord);
    expect(effective).toEqual({
      llm: { model: 'gpt-4o-mini', temperature: 0.7 },
      nodes: { planner: { x: 1 } },
    });
  });
});
