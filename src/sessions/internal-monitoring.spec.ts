import { jest } from '@jest/globals';
import 'reflect-metadata';
import {
  BadRequestException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
// Same module cuts as the other sessions specs.
jest.mock('../agents/agents.service', () => ({ AgentsService: class {} }));
jest.mock('../livekit/livekit.service', () => ({ LiveKitService: class {} }));
jest.mock('../message-recorder/room-monitor.service', () => ({
  RoomMonitorService: class {},
}));

import { SessionsController } from './sessions.controller.js';
import { InternalKeyGuard } from '../auth/guards/internal-key.guard.js';
import { internalKeyMatches } from '../auth/internal-key.js';
import { MonitoringLogDto, MonitoringStatusDto } from './dto/monitoring.dto.js';

/**
 * The message recorder's monitoring endpoints (#145, GitHub 889): without the
 * internal key a request is a 401, and a log level outside the allow-list is a
 * 400, where it used to reach logger[level] and give a 500.
 */
const KEY = 'k'.repeat(48);
const ctx = (headers: Record<string, string>) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as any;
// The global pipe from main.ts.
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});
const validate = (metatype: any, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype });

describe('internal monitoring endpoints (#145)', () => {
  const saved = process.env.INTERNAL_API_KEY;
  beforeEach(() => {
    process.env.INTERNAL_API_KEY = KEY;
  });
  afterAll(() => {
    process.env.INTERNAL_API_KEY = saved;
  });

  it.each(['storeMonitoringLog', 'updateMonitoringStatus'])(
    '%s is guarded by the internal key',
    (method) => {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        (SessionsController.prototype as any)[method],
      );
      expect(guards).toContain(InternalKeyGuard);
    },
  );

  describe('the key', () => {
    const guard = new InternalKeyGuard();
    it('lets the recorder through with the key', () => {
      expect(guard.canActivate(ctx({ 'x-internal-key': KEY }))).toBe(true);
    });
    it('refuses a request without it, or with a wrong one, with 401', () => {
      expect(() => guard.canActivate(ctx({}))).toThrow(UnauthorizedException);
      expect(() =>
        guard.canActivate(ctx({ 'x-internal-key': 'nope' })),
      ).toThrow(UnauthorizedException);
      expect(() =>
        guard.canActivate(ctx({ 'x-internal-key': KEY.slice(1) + 'x' })),
      ).toThrow(UnauthorizedException);
    });
    it('refuses everything when the backend has no key configured', () => {
      delete process.env.INTERNAL_API_KEY;
      expect(() => guard.canActivate(ctx({ 'x-internal-key': '' }))).toThrow(
        UnauthorizedException,
      );
      expect(internalKeyMatches(undefined, 'anything')).toBe(false);
      expect(internalKeyMatches('', '')).toBe(false);
    });
  });

  describe('the body', () => {
    it("accepts the recorder's own log and status payloads", async () => {
      // As message_client.py post_log / update_monitoring_status send them.
      for (const level of ['log', 'debug', 'warn', 'error']) {
        await expect(
          validate(MonitoringLogDto, {
            level,
            message: 'joined room',
            sessionId: 's1',
            data: { room: 'r' },
          }),
        ).resolves.toMatchObject({ level });
      }
      await expect(
        validate(MonitoringLogDto, { level: 'log', message: 'no session' }),
      ).resolves.toBeInstanceOf(MonitoringLogDto);
      await expect(
        validate(MonitoringStatusDto, { connectedSessions: ['s1', 's2'] }),
      ).resolves.toMatchObject({ connectedSessions: ['s1', 's2'] });
      await expect(
        validate(MonitoringStatusDto, { connectedSessions: [] }),
      ).resolves.toBeInstanceOf(MonitoringStatusDto);
    });

    it.each(['constructor', 'verbose', 'fatal', 'LOG', '', '__proto__'])(
      'refuses level %p with 400',
      async (level) => {
        await expect(
          validate(MonitoringLogDto, { level, message: 'x' }),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it('refuses malformed bodies with 400', async () => {
      await expect(
        validate(MonitoringLogDto, { level: 'log' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        validate(MonitoringLogDto, { level: 'log', message: 'x', data: 'str' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        validate(MonitoringStatusDto, { connectedSessions: 's1' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        validate(MonitoringStatusDto, { connectedSessions: [1] }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
