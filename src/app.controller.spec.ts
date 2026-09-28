import { jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { LiveKitService } from './livekit/livekit.service.js';
import { AgentImageService } from './agent-image/agent-image.service.js';

describe('AppController', () => {
  let appController: AppController;
  const checkContainerdHealth = jest.fn();

  beforeEach(async () => {
    checkContainerdHealth.mockReset();
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        { provide: LiveKitService, useValue: { getPublicServerUrl: () => 'ws://test' } },
        { provide: AgentImageService, useValue: { checkContainerdHealth } },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('GET /health/ready', () => {
    it('returns ready when containerd is healthy', async () => {
      checkContainerdHealth.mockResolvedValue({ ok: true });

      await expect(appController.ready()).resolves.toEqual({
        status: 'ready',
        containerd: { ok: true },
      });
    });

    it('throws 503 with error detail when containerd is unhealthy', async () => {
      checkContainerdHealth.mockResolvedValue({ ok: false, error: 'connection refused' });

      await expect(appController.ready()).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        response: { status: 'unready', containerd: { ok: false, error: 'connection refused' } },
      });
    });

    it('propagates a thrown HttpException with 503 status', async () => {
      checkContainerdHealth.mockResolvedValue({ ok: false, error: 'boom' });

      await expect(appController.ready()).rejects.toBeInstanceOf(HttpException);
    });
  });
});
