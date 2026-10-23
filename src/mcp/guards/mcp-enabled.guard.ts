import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { PlatformSettingsService } from '../../platform-settings/platform-settings.service.js';

/** /mcp does not exist while a system admin has MCP switched off. */
@Injectable()
export class McpEnabledGuard implements CanActivate {
  constructor(private readonly platformSettings: PlatformSettingsService) {}

  async canActivate(): Promise<boolean> {
    if (!(await this.platformSettings.isMcpEnabled())) {
      throw new NotFoundException();
    }
    return true;
  }
}
