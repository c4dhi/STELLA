import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { PlatformSettingsController } from './platform-settings.controller.js';
import { PlatformSettingsService } from './platform-settings.service.js';

function makeService(stored: string | null, findError?: Error) {
  const prisma = {
    platformSetting: {
      findUnique: jest.fn(async () => {
        if (findError) throw findError;
        return stored === null
          ? null
          : {
              key: 'agents.requireReview',
              value: stored,
              updatedAt: new Date(),
              updatedBy: null,
            };
      }),
      upsert: jest.fn(async () => ({})),
    },
    project: { findMany: jest.fn(async () => []) },
    agentInstance: { findMany: jest.fn(async () => []) },
  };
  return {
    service: new PlatformSettingsService(
      prisma as any,
      { decrypt: jest.fn() } as any,
    ),
    prisma,
  };
}

describe('agent review switch', () => {
  it('is on when never set: uploaded pods still get the platform LiveKit secret', async () => {
    await expect(makeService(null).service.isAgentReviewRequired()).resolves.toBe(true);
  });

  it('is on when the read fails: unreviewed code does not run when the setting is unknown', async () => {
    await expect(
      makeService(null, new Error('db down')).service.isAgentReviewRequired(),
    ).resolves.toBe(true);
  });

  it('is off only for a stored "false"', async () => {
    await expect(makeService('false').service.isAgentReviewRequired()).resolves.toBe(false);
    await expect(makeService('true').service.isAgentReviewRequired()).resolves.toBe(true);
    await expect(makeService('no').service.isAgentReviewRequired()).resolves.toBe(true);
  });

  it('caches reads, and a write clears the cache', async () => {
    const { service, prisma } = makeService('true');
    await service.isAgentReviewRequired();
    await service.isAgentReviewRequired();
    expect(prisma.platformSetting.findUnique).toHaveBeenCalledTimes(1);
    await service.setAgentReviewRequired(false, 'admin-1');
    await service.isAgentReviewRequired();
    expect(prisma.platformSetting.findUnique.mock.calls.length).toBeGreaterThan(1);
  });

  it('stores the switch as text with who changed it, and accepts only booleans', async () => {
    const { service, prisma } = makeService(null);
    await service.setAgentReviewRequired(true, 'admin-1');
    expect(prisma.platformSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'agents.requireReview' },
      create: { key: 'agents.requireReview', value: 'true', updatedById: 'admin-1' },
      update: { value: 'true', updatedById: 'admin-1' },
    });
    await expect(service.setAgentReviewRequired('true', 'admin-1')).rejects.toThrow(BadRequestException);
  });
});

describe('PUT /admin/platform-settings agentReviewRequired', () => {
  it('changes only the review switch when that is all it is sent', async () => {
    const service = {
      setTtsPlayback: jest.fn(async () => ({}) as any),
      setMcpEnabled: jest.fn(async () => ({}) as any),
      setAgentReviewRequired: jest.fn(async () => ({}) as any),
    };
    const controller = new PlatformSettingsController(service as any);
    await controller.update({ userId: 'a' }, { agentReviewRequired: true });
    expect(service.setAgentReviewRequired).toHaveBeenCalledWith(true, 'a');
    expect(service.setMcpEnabled).not.toHaveBeenCalled();
    expect(service.setTtsPlayback).not.toHaveBeenCalled();
  });
});
