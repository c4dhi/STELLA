import { Controller, Get } from '@nestjs/common';
import { PlatformSettingsService } from './platform-settings.service.js';

export interface PlatformFeatures {
  mcpEnabled: boolean;
}

/**
 * Which optional features are switched on, for any signed-in user. The
 * frontend hides what is off (e.g. Settings → MCP access).
 */
@Controller('platform/features')
export class PlatformFeaturesController {
  constructor(private readonly platformSettings: PlatformSettingsService) {}

  /** GET /platform/features */
  @Get()
  async get(): Promise<PlatformFeatures> {
    return { mcpEnabled: await this.platformSettings.isMcpEnabled() };
  }
}
