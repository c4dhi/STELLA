import { BadRequestException, Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { SystemAdminGuard } from '../auth/guards/system-admin.guard.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { PlatformSettingsService, PlatformSettingsView } from './platform-settings.service.js';

/**
 * Platform defaults (Settings → Platform Defaults). Reading and writing both
 * need a system admin: the view lists deployments across every project.
 */
@Controller('admin/platform-settings')
@UseGuards(SystemAdminGuard)
export class PlatformSettingsController {
  constructor(private readonly platformSettings: PlatformSettingsService) {}

  /** GET /admin/platform-settings */
  @Get()
  get(): Promise<PlatformSettingsView> {
    return this.platformSettings.getView();
  }

  /**
   * PUT /admin/platform-settings
   * { ttsPlayback?: 'auto' | 'stream' | 'sentence' | null, mcpEnabled?: boolean, agentReviewRequired?: boolean }
   * Only the keys present are changed.
   */
  @Put()
  async update(
    @CurrentUser() user: { userId: string },
    @Body() body: { ttsPlayback?: unknown; mcpEnabled?: unknown; agentReviewRequired?: unknown },
  ): Promise<PlatformSettingsView> {
    const has = (key: string) => body != null && Object.prototype.hasOwnProperty.call(body, key);
    if (!has('ttsPlayback') && !has('mcpEnabled') && !has('agentReviewRequired')) {
      throw new BadRequestException('Send at least one of ttsPlayback, mcpEnabled, agentReviewRequired');
    }
    let view: PlatformSettingsView | undefined;
    if (has('ttsPlayback')) view = await this.platformSettings.setTtsPlayback(body.ttsPlayback, user.userId);
    if (has('mcpEnabled')) view = await this.platformSettings.setMcpEnabled(body.mcpEnabled, user.userId);
    if (has('agentReviewRequired')) {
      view = await this.platformSettings.setAgentReviewRequired(body.agentReviewRequired, user.userId);
    }
    return view!;
  }
}
