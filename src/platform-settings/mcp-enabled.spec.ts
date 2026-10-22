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
              key: 'mcp.enabled',
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

describe('MCP switch', () => {
  it('is off when never set, and off when the read fails', async () => {
    await expect(makeService(null).service.isMcpEnabled()).resolves.toBe(false);
    await expect(
      makeService(null, new Error('db down')).service.isMcpEnabled(),
    ).resolves.toBe(false);
  });

  it('is on only for a stored "true"', async () => {
    await expect(makeService('true').service.isMcpEnabled()).resolves.toBe(
      true,
    );
    await expect(makeService('yes').service.isMcpEnabled()).resolves.toBe(
      false,
    );
  });

  it('caches reads, and a write clears the cache', async () => {
    const { service, prisma } = makeService('true');
    await service.isMcpEnabled();
    await service.isMcpEnabled();
    expect(prisma.platformSetting.findUnique).toHaveBeenCalledTimes(1);
    await service.setMcpEnabled(false, 'admin-1');
    await service.isMcpEnabled();
    expect(prisma.platformSetting.findUnique.mock.calls.length).toBeGreaterThan(
      1,
    );
  });

  it('stores the switch as text with who changed it, and accepts only booleans', async () => {
    const { service, prisma } = makeService(null);
    await service.setMcpEnabled(true, 'admin-1');
    expect(prisma.platformSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'mcp.enabled' },
      create: { key: 'mcp.enabled', value: 'true', updatedById: 'admin-1' },
      update: { value: 'true', updatedById: 'admin-1' },
    });
    await expect(service.setMcpEnabled('true', 'admin-1')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('PUT /admin/platform-settings', () => {
  const view = { mcpEnabled: true } as any;
  const make = () => {
    const service = {
      setTtsPlayback: jest.fn(async () => view),
      setMcpEnabled: jest.fn(async () => view),
    };
    return {
      controller: new PlatformSettingsController(service as any),
      service,
    };
  };

  it('changes only the keys it is sent', async () => {
    const { controller, service } = make();
    await controller.update({ userId: 'a' }, { mcpEnabled: true });
    expect(service.setMcpEnabled).toHaveBeenCalledWith(true, 'a');
    expect(service.setTtsPlayback).not.toHaveBeenCalled();
  });

  it('still clears the TTS default with ttsPlayback: null', async () => {
    const { controller, service } = make();
    await controller.update({ userId: 'a' }, { ttsPlayback: null });
    expect(service.setTtsPlayback).toHaveBeenCalledWith(null, 'a');
    expect(service.setMcpEnabled).not.toHaveBeenCalled();
  });

  it('refuses an empty body', async () => {
    const { controller } = make();
    await expect(controller.update({ userId: 'a' }, {})).rejects.toThrow(
      BadRequestException,
    );
  });
});
