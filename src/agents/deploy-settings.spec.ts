import { jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { AgentsService } from './agents.service.js';

const configSchema = {
  'x-stella-optional-env-vars': [{ name: 'TTS_SPEED', type: 'number', min: 0.5, max: 2 }],
};

// Everything before the agent record is written; the record itself is the
// point past which a bad setting would already have reached a deployment.
function service(merged: Record<string, string>) {
  const s = Object.create(AgentsService.prototype);
  s.prisma = {
    session: {
      findUnique: jest.fn(async () => ({
        id: 's1',
        status: 'ACTIVE',
        room: { id: 'r1' },
        project: { id: 'p1' },
      })),
    },
    agentType: {
      findUnique: jest.fn(async () => ({ id: 'type-v2', configSchema })),
    },
    agentInstance: {
      create: jest.fn(async () => {
        throw new Error('record written');
      }),
    },
  };
  s.applyScopedConfiguration = jest.fn(async () => undefined);
  s.validateRuntimeConfigForAgentType = jest.fn();
  s.encryptManualEnvVarsForStorage = jest.fn(() => null);
  s.envVarTemplatesService = { resolveEnvVars: jest.fn(async () => ({ merged })) };
  s.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return s;
}

describe('AgentsService.create with typed settings (#585)', () => {
  it('refuses a deployment whose template or overrides put a setting out of range', async () => {
    const s = service({ TTS_SPEED: '3' });
    const deploy = s.create('s1', { name: 'Grace', envVarTemplateId: 'tpl-1' }, 'user-1');
    await expect(deploy).rejects.toThrow(BadRequestException);
    await expect(
      service({ TTS_SPEED: '3' }).create('s1', { name: 'Grace' }, 'user-1'),
    ).rejects.toThrow('TTS_SPEED must be between 0.5 and 2');
    expect(s.prisma.agentInstance.create).not.toHaveBeenCalled();
  });

  it('lets a deployment with fitting settings and any custom variables through', async () => {
    const s = service({ TTS_SPEED: '0.95', STUDY_ARM: '???' });
    await expect(s.create('s1', { name: 'Grace' }, 'user-1')).rejects.toThrow('record written');
  });
});
