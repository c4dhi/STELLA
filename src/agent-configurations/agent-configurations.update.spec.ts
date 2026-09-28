import { jest } from '@jest/globals';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentConfigurationsService } from './agent-configurations.service.js';

type ConfigRow = {
  id: string;
  userId: string;
  agentTypeId: string;
  configuration: Record<string, unknown>;
  agentVersion: string | null;
  minCompilerVersion: string | null;
  compatibility: 'CURRENT' | 'COMPATIBLE' | 'OUTDATED';
  compatibilityNote: string | null;
  lastReconciledAt: Date | null;
};

const agentTypeRow = {
  id: 'type-A',
  version: '2.0.0',
  compilerVersion: '1.0.0',
  pipelineSchema: {
    nodes: [{ id: 'planner' }],
    thresholds: [{ id: 'temperature', min: 0, max: 1 }],
  },
};

function createService(row: ConfigRow) {
  const update = jest.fn(async ({ data }: any) => ({ ...row, ...data }));
  const create = jest.fn(async ({ data }: any) => ({ id: 'copy-1', ...data }));
  const prisma = {
    agentConfiguration: {
      findUnique: jest.fn(async ({ where: { id } }: any) =>
        id === row.id ? { ...row, agentType: {} } : null,
      ),
      update,
      create,
    },
    agentType: {
      findUnique: jest.fn(async () => agentTypeRow),
    },
  } as unknown as PrismaService;
  return { svc: new AgentConfigurationsService(prisma), update, create };
}

const outdatedRow: ConfigRow = {
  id: 'cfg-1',
  userId: 'user-1',
  agentTypeId: 'type-A',
  configuration: { thresholds: { temperature: 5 } }, // out of range -> was OUTDATED
  agentVersion: '1.0.0',
  minCompilerVersion: '1.0.0',
  compatibility: 'OUTDATED',
  compatibilityNote: 'Threshold temperature value 5 is above maximum 1',
  lastReconciledAt: null,
};

describe('AgentConfigurationsService.update — compatibility recompute', () => {
  it('clears OUTDATED and stamps current version when the re-saved config validates', async () => {
    const { svc, update } = createService(outdatedRow);

    await svc.update('cfg-1', 'user-1', {
      configuration: { thresholds: { temperature: 0.5 } },
    } as any);

    const data = update.mock.calls[0][0].data;
    expect(data.compatibility).toBe('CURRENT');
    expect(data.compatibilityNote).toBeNull();
    expect(data.agentVersion).toBe('2.0.0'); // re-stamped to the type's current version
    expect(data.lastReconciledAt).toBeInstanceOf(Date);
  });

  it('stays OUTDATED with a note when the re-saved config is still invalid', async () => {
    const { svc, update } = createService(outdatedRow);

    await svc.update('cfg-1', 'user-1', {
      configuration: { thresholds: { temperature: 9 } }, // still out of range
    } as any);

    const data = update.mock.calls[0][0].data;
    expect(data.compatibility).toBe('OUTDATED');
    expect(data.compatibilityNote).toMatch(/above maximum/);
    expect(data.agentVersion).toBe('1.0.0'); // not advanced while invalid
  });

  it('prunes dangling node refs on re-save', async () => {
    const { svc, update } = createService(outdatedRow);

    await svc.update('cfg-1', 'user-1', {
      configuration: { nodes: { planner: { x: 1 }, ghost: {} } },
    } as any);

    const data = update.mock.calls[0][0].data;
    expect(data.compatibility).toBe('CURRENT');
    expect(data.configuration).toEqual({ nodes: { planner: { x: 1 } } });
  });

  it('does not recompute when only name/description change', async () => {
    const { svc, update } = createService(outdatedRow);

    await svc.update('cfg-1', 'user-1', { name: 'Renamed' } as any);

    const data = update.mock.calls[0][0].data;
    expect(data.name).toBe('Renamed');
    expect(data.compatibility).toBeUndefined();
  });
});

describe('AgentConfigurationsService.duplicate — preserves fields', () => {
  it('carries minCompilerVersion and compatibility state to the copy', async () => {
    const { svc, create } = createService(outdatedRow);

    await svc.duplicate('cfg-1', 'user-1');

    const data = create.mock.calls[0][0].data;
    expect(data.minCompilerVersion).toBe('1.0.0');
    expect(data.compatibility).toBe('OUTDATED');
    expect(data.compatibilityNote).toBe(outdatedRow.compatibilityNote);
    expect(data.agentVersion).toBe('1.0.0');
  });
});
