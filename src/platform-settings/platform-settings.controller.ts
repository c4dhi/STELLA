import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
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

  /** PUT /admin/platform-settings { ttsPlayback: 'auto' | 'stream' | 'sentence' | null } */
  @Put()
  update(
    @CurrentUser() user: { userId: string },
    @Body() body: { ttsPlayback?: unknown },
  ): Promise<PlatformSettingsView> {
    return this.platformSettings.setTtsPlayback(body?.ttsPlayback, user.userId);
  }
}
