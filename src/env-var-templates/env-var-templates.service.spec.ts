import { jest } from '@jest/globals';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from './encryption.service.js';
import { EnvVarTemplatesService } from './env-var-templates.service.js';

type TemplateRow = {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  variables: string;
  agentTypeId: string;
  createdAt: Date;
  updatedAt: Date;
};

function makeRow(over: Partial<TemplateRow> = {}): TemplateRow {
  const now = new Date();
  return {
    id: 'tpl-1',
    userId: 'user-1',
    name: 'Keys',
    description: null,
    variables: 'enc',
    agentTypeId: 'type-A',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function createService(rows: TemplateRow[], agentTypeIds: string[] = ['type-A', 'type-B']) {
  const prisma = {
    envVarTemplate: {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter(
          (r) =>
            r.userId === where.userId &&
            (where.agentTypeId === undefined || r.agentTypeId === where.agentTypeId),
        ),
      ),
      findUnique: jest.fn(async ({ where: { id } }: any) =>
        rows.find((r) => r.id === id) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => makeRow(data)),
    },
    agentType: {
      findUnique: jest.fn(async ({ where: { id } }: any) =>
        agentTypeIds.includes(id) ? { id } : null,
      ),
    },
  } as unknown as PrismaService;

  const encryption = {
    encrypt: jest.fn(() => 'enc'),
    decrypt: jest.fn(() => ({})),
    getKeys: jest.fn(() => ['OPENAI_API_KEY']),
  } as unknown as EncryptionService;

  return new EnvVarTemplatesService(prisma, encryption);
}

describe('EnvVarTemplatesService', () => {
  describe('findByAgentType', () => {
    it('returns only templates matching the agent type (no generic fallthrough)', async () => {
      const rows = [
        makeRow({ id: 't1', agentTypeId: 'type-A' }),
        makeRow({ id: 't2', agentTypeId: 'type-B' }),
      ];
      const svc = createService(rows);
      const result = await svc.findByAgentType('user-1', 'type-A');
      expect(result.map((r) => r.id)).toEqual(['t1']);
    });
  });

  describe('create', () => {
    it('rejects an unknown agentTypeId', async () => {
      const svc = createService([]);
      await expect(
        svc.create('user-1', {
          name: 'X',
          variables: { K: 'v' },
          agentTypeId: 'does-not-exist',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates when the agentTypeId exists', async () => {
      const svc = createService([]);
      const created = await svc.create('user-1', {
        name: 'X',
        variables: { K: 'v' },
        agentTypeId: 'type-A',
      });
      expect(created.agentTypeId).toBe('type-A');
    });
  });

  describe('assertCompatibleWithAgentType', () => {
    it('passes when the template matches the target type', async () => {
      const svc = createService([makeRow({ id: 't1', agentTypeId: 'type-A' })]);
      await expect(
        svc.assertCompatibleWithAgentType('t1', 'user-1', 'type-A'),
      ).resolves.toBeUndefined();
    });

    it('throws 400 on a type mismatch', async () => {
      const svc = createService([makeRow({ id: 't1', agentTypeId: 'type-A' })]);
      await expect(
        svc.assertCompatibleWithAgentType('t1', 'user-1', 'type-B'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws 404 when the template is not owned by the user', async () => {
      const svc = createService([makeRow({ id: 't1', userId: 'someone-else' })]);
      await expect(
        svc.assertCompatibleWithAgentType('t1', 'user-1', 'type-A'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('update (merge semantics)', () => {
    // Build a service whose encryption round-trips a real object so we can assert
    // exactly what the merged, re-encrypted variable set contains.
    function createMergeService(existing: Record<string, string>) {
      const row = makeRow({ id: 't1', userId: 'user-1' });
      const encrypt = jest.fn((obj: Record<string, string>) => JSON.stringify(obj)) as jest.Mock;
      const prisma = {
        envVarTemplate: {
          findUnique: jest.fn(async () => row),
          update: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
        },
      } as unknown as PrismaService;
      const encryption = {
        encrypt,
        decrypt: jest.fn(() => existing),
        getKeys: jest.fn(() => Object.keys(existing)),
      } as unknown as EncryptionService;
      return { svc: new EnvVarTemplatesService(prisma, encryption), encrypt };
    }

    it('keeps untouched secrets, applies overrides, and removes deleted keys', async () => {
      const { svc, encrypt } = createMergeService({
        OPENAI_API_KEY: 'sk-existing',
        BARGE_IN_EVAL_TIMEOUT_MS: '',
      });

      await svc.update('t1', 'user-1', {
        name: 'Keys',
        variables: { EXTRA: 'new' }, // add/override only what changed
        removeKeys: ['BARGE_IN_EVAL_TIMEOUT_MS'], // delete the empty optional var
      });

      // encrypt() receives the merged plaintext map as its first argument:
      // untouched OPENAI_API_KEY preserved, EXTRA added, the removed key gone —
      // the OpenAI key never had to be re-sent.
      const merged = encrypt.mock.calls[0][0];
      expect(merged).toEqual({ OPENAI_API_KEY: 'sk-existing', EXTRA: 'new' });
    });

    it('does not rewrite the encrypted blob when neither variables nor removeKeys are given', async () => {
      const { svc, encrypt } = createMergeService({ OPENAI_API_KEY: 'sk-existing' });
      await svc.update('t1', 'user-1', { name: 'Renamed' });
      expect(encrypt).not.toHaveBeenCalled();
    });
  });
});
