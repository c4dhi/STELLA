import { Controller, Get, Header, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/decorators/public.decorator.js';
import { HealthService } from './health.service.js';
import { MediaTestService } from './media-test.service.js';
import { PublicHealthResponse } from './dto/public-health.dto.js';
import { MediaTestSession } from './dto/media-test.dto.js';

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly health: HealthService,
    private readonly mediaTest: MediaTestService,
  ) {}

  @Public()
  @Post('media-test/start')
  async startMediaTest(@Req() req: Request): Promise<MediaTestSession> {
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ||
      req.socket?.remoteAddress ||
      undefined;
    return this.mediaTest.start(ip);
  }

  @Public()
  @Get('public')
  @Header('Cache-Control', 'public, max-age=15')
  async getPublic(): Promise<PublicHealthResponse> {
    try {
      return await this.health.getPublicHealth();
    } catch (err) {
      this.logger.error(`public-health probe failed: ${(err as Error).message}`);
      const generatedAt = (() => {
        const d = new Date();
        d.setMilliseconds(0);
        return d.toISOString();
      })();
      return {
        status: 'degraded',
        components: [
          { id: 'api', status: 'operational', lastCheckedAt: generatedAt },
          { id: 'database', status: 'down', lastCheckedAt: generatedAt },
          { id: 'realtime', status: 'down', lastCheckedAt: generatedAt },
          { id: 'stt', status: 'down', lastCheckedAt: generatedAt },
          { id: 'tts', status: 'down', lastCheckedAt: generatedAt },
        ],
        generatedAt,
      };
    }
  }
}
