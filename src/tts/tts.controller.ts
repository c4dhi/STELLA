import { Controller, Get, Header } from '@nestjs/common';
import { TtsService } from './tts.service.js';
import { TtsCapabilities } from './grpc/tts-capabilities.client.js';

@Controller('tts')
export class TtsController {
  constructor(private readonly tts: TtsService) {}

  /**
   * Voices and languages the active TTS provider can synthesize. Consumed by
   * the deploy UI so an agent is only offered provider-valid choices.
   * Authenticated via the global JwtAuthGuard (no @Public).
   *
   * max-age mirrors TtsService's server-side cache TTL (60s); the catalog only
   * changes on a tts-service redeploy, so both freshness windows can be wide.
   */
  @Get('capabilities')
  @Header('Cache-Control', 'private, max-age=60')
  async getCapabilities(): Promise<TtsCapabilities> {
    return this.tts.getCapabilities();
  }
}
