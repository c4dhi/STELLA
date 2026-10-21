import { jest } from '@jest/globals';
import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { SystemAdminGuard } from '../auth/guards/system-admin.guard.js';
import { PlatformSettingsController } from './platform-settings.controller.js';
import { PlatformSettingsService } from './platform-settings.service.js';

function contextFor(user: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as unknown as ExecutionContext;
}

describe('PlatformSettingsController access', () => {
  it('puts every endpoint behind SystemAdminGuard', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, PlatformSettingsController);
    expect(guards).toContain(SystemAdminGuard);
  });

  it('lets a system admin through and turns away everyone else', () => {
    const guard = new SystemAdminGuard();
    expect(guard.canActivate(contextFor({ userId: 'a', isSystemAdmin: true }))).toBe(true);
    expect(() => guard.canActivate(contextFor({ userId: 'u', isSystemAdmin: false }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor({ type: 'participant', isSystemAdmin: true }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
  });
});

function makeService(opts: {
  stored?: { value: string; updatedAt?: Date; updatedBy?: { name: string | null; email: string } | null } | null;
  publicProjects?: unknown[];
  agents?: unknown[];
  templates?: Record<string, string>;
  findUniqueError?: Error;
  messages?: { sessionId: string; timestamp: Date; metadata?: unknown }[];
  loadTest?: unknown;
  messageError?: Error;
} = {}) {
  const row = opts.stored
    ? { key: 'ttsPlayback', updatedAt: new Date('2026-10-12T14:20:00Z'), updatedBy: null, ...opts.stored }
    : null;
  const prisma = {
    platformSetting: {
      findUnique: jest.fn(async () => {
        if (opts.findUniqueError) throw opts.findUniqueError;
        return row;
      }),
      upsert: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
    project: { findMany: jest.fn(async () => opts.publicProjects ?? []) },
    message: {
      // Honours the stage filter the way the JSON path query does in Postgres.
      findMany: jest.fn(async (args: any) => {
        if (opts.messageError) throw opts.messageError;
        const stages: string[] | undefined = args.where.OR?.map((c: any) => c.metadata.equals);
        return (opts.messages ?? []).filter(m =>
          !stages || stages.includes((m.metadata as any)?.envelope?.data?.stage));
      }),
    },
    capacityMeasurement: { findFirst: jest.fn(async () => opts.loadTest ?? null) },
    agentInstance: { findMany: jest.fn(async () => opts.agents ?? []) },
    envVarTemplate: {
      findUnique: jest.fn(async (args: any) =>
        opts.templates?.[args.where.id] !== undefined ? { variables: opts.templates[args.where.id] } : null),
    },
  };
  // "enc:<json>" stands in for real ciphertext.
  const encryption = {
    decrypt: jest.fn((s: string) => {
      if (!s.startsWith('enc:')) throw new Error('bad ciphertext');
      return JSON.parse(s.slice(4));
    }),
  };
  const service = new PlatformSettingsService(prisma as any, encryption as any);
  return { service, prisma };
}

const enc = (vars: Record<string, string>) => `enc:${JSON.stringify(vars)}`;

describe('PlatformSettingsService', () => {
  it('saves a mode with who changed it, and clears it with null', async () => {
    const { service, prisma } = makeService();
    await service.setTtsPlayback('sentence', 'admin-1');
    expect(prisma.platformSetting.upsert).toHaveBeenCalledWith({
      where: { key: 'ttsPlayback' },
      create: { key: 'ttsPlayback', value: 'sentence', updatedById: 'admin-1' },
      update: { value: 'sentence', updatedById: 'admin-1' },
    });
    await service.setTtsPlayback(null, 'admin-1');
    expect(prisma.platformSetting.deleteMany).toHaveBeenCalledWith({ where: { key: 'ttsPlayback' } });
  });

  it('refuses an unknown mode without writing anything', async () => {
    const { service, prisma } = makeService();
    await expect(service.setTtsPlayback('loud', 'admin-1')).rejects.toThrow(BadRequestException);
    await expect(service.setTtsPlayback(undefined, 'admin-1')).rejects.toThrow(BadRequestException);
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
    expect(prisma.platformSetting.deleteMany).not.toHaveBeenCalled();
  });

  it('shows the stored default and who last changed it', async () => {
    const { service } = makeService({ stored: { value: 'stream', updatedBy: { name: 'Admin', email: 'a@x.test' } } });
    await expect(service.getView()).resolves.toEqual({
      ttsPlayback: 'stream',
      updatedAt: '2026-10-12T14:20:00.000Z',
      updatedBy: 'Admin',
      pinnedDeployments: [],
      hardwareFit: expect.objectContaining({ colour: null, sentencesSeen: 0 }),
    });
  });

  it('applies the platform default to an unpinned pod and logs nothing else into env', async () => {
    const { service } = makeService({ stored: { value: 'sentence' } });
    await expect(service.applyToPodEnv({ STELLA_TTS_PLAYBACK: 'auto', X: '1' }, 'agent-1')).resolves.toEqual({
      STELLA_TTS_PLAYBACK: 'sentence',
      STELLA_TTS_PLAYBACK_SOURCE: 'platform',
      X: '1',
    });
  });

  it('keeps a pod pinned to stream on stream', async () => {
    const { service } = makeService({ stored: { value: 'sentence' } });
    const env = await service.applyToPodEnv({ STELLA_TTS_PLAYBACK: 'stream' }, 'agent-1');
    expect(env.STELLA_TTS_PLAYBACK).toBe('stream');
    expect(env.STELLA_TTS_PLAYBACK_SOURCE).toBe('deployment');
  });

  it('still starts the agent when the settings read fails', async () => {
    const { service } = makeService({ findUniqueError: new Error('db down') });
    const env = await service.applyToPodEnv({}, 'agent-1');
    expect(env).toEqual({ STELLA_TTS_PLAYBACK: 'auto', STELLA_TTS_PLAYBACK_SOURCE: 'default' });
  });

  it('ignores a stored value that is no longer a mode', async () => {
    const { service } = makeService({ stored: { value: 'loud' } });
    await expect(service.getTtsPlayback()).resolves.toBeNull();
  });

  it('lists public projects and open-session agents that pin a mode, and only those', async () => {
    const { service } = makeService({
      templates: { t1: enc({ STELLA_TTS_PLAYBACK: 'sentence', OPENAI_API_KEY: 'secret' }) },
      publicProjects: [
        { name: 'Study A', publicAgentConfig: { name: 'Grace', envVars: { STELLA_TTS_PLAYBACK: 'stream' } }, publicAgentType: null },
        { name: 'Study B', publicAgentConfig: { envVarTemplateId: 't1' }, publicAgentType: { name: 'Stella v2' } },
        { name: 'Study C', publicAgentConfig: { envVars: { STELLA_TTS_PLAYBACK: 'auto' } }, publicAgentType: null },
      ],
      agents: [
        // Manual vars override the template, as at pod creation.
        { name: 'Agent 1', envVarTemplateId: 't1', manualEnvVarsEncrypted: enc({ STELLA_TTS_PLAYBACK: 'stream' }), session: { project: { name: 'P' } } },
        { name: 'Agent 2', envVarTemplateId: null, manualEnvVarsEncrypted: null, session: { project: { name: 'P' } } },
        { name: 'Agent 3', envVarTemplateId: null, manualEnvVarsEncrypted: 'garbage', session: { project: { name: 'P' } } },
      ],
    });
    const pinned = await service.listPinnedDeployments();
    expect(pinned).toEqual([
      { name: 'Grace', project: 'Study A', mode: 'stream' },
      { name: 'Stella v2', project: 'Study B', mode: 'sentence' },
      { name: 'Agent 1', project: 'P', mode: 'stream' },
    ]);
    // Only the mode leaves the service.
    expect(JSON.stringify(pinned)).not.toContain('secret');
  });

  describe('hardware fit (#93)', () => {
    const T0 = Date.parse('2026-10-20T10:00:00Z');
    const analytics = (sessionId: string, at: number, data: Record<string, unknown>) => ({
      sessionId,
      timestamp: new Date(at),
      metadata: { envelope: { type: 'analytics', data } },
    });
    // Three sessions talking at once, 80 sentences each at the given speed.
    const talk = (rtf: number) =>
      ['a', 'b', 'c'].flatMap(id =>
        Array.from({ length: 80 }, (_, i) =>
          analytics(id, T0 + i * 5000, { stage: 'tts_sentence_speed', turn_id: 't', rtf, playback: 'stream' })));

    it('scores the speeds agents published, at the sessions running alongside', async () => {
      const { service, prisma } = makeService({
        messages: [...talk(1.1), analytics('d', T0, { stage: 'stt_end', elapsed_ms: 0 })],
        loadTest: { maxSessions: 4, reachedTopLevel: false, gpuName: 'Tesla T4', ttsProvider: 'qwen3' },
      });
      const fit = await service.getHardwareFit(new Date(T0 + 3600_000));
      expect(fit).toMatchObject({ colour: 'yellow', usualSessions: 3, gpu: 'Tesla T4', ttsModel: 'qwen3' });
      expect(fit.sentencesSeen).toBe(240);
      // Session d was in conversation for the first minute only: 13 sentences each saw it.
      expect(fit.buckets.find(b => b.sessions === 4)).toMatchObject({ sentences: 39, source: 'load test' });
      // Fourteen days back, analytics only.
      const where = (prisma.message.findMany.mock.calls[1] as any)[0].where;
      expect(where.messageType).toBe('analytics');
      expect(where.timestamp.gte.toISOString()).toBe('2026-10-06T11:00:00.000Z');
    });

    it('counts a switch, and ignores a speed with no usable number', async () => {
      const { service } = makeService({
        messages: [
          ...talk(0.5),
          analytics('a', T0, { stage: 'tts_playback_switch', rtf: 1.2, slow_sentences: 3 }),
          analytics('a', T0, { stage: 'tts_sentence_speed', rtf: 'fast' }),
        ],
      });
      const fit = await service.getHardwareFit(new Date(T0 + 3600_000));
      expect(fit.sentencesSeen).toBe(240);
      expect(fit.buckets.find(b => b.sessions === 3)!.switchedShare).toBeCloseTo(1 / 3);
      expect(fit.colour).toBe('yellow');
    });

    it('leaves the rest of the page working when the fit cannot be read', async () => {
      const { service } = makeService({ messageError: new Error('db down') });
      const view = await service.getView();
      expect(view.hardwareFit).toBeNull();
      expect(view.ttsPlayback).toBeNull();
    });
  });
});
