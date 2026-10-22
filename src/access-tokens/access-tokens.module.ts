import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module.js';
import { AccessTokensController } from './access-tokens.controller.js';
import { AccessTokensService } from './access-tokens.service.js';

@Module({
  imports: [AuthModule, PlatformSettingsModule],
  controllers: [AccessTokensController],
  providers: [AccessTokensService],
  exports: [AccessTokensService],
})
export class AccessTokensModule {}
