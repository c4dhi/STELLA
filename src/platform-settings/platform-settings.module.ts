import { Module } from '@nestjs/common';
import { EnvVarTemplatesModule } from '../env-var-templates/env-var-templates.module.js';
import { PlatformSettingsController } from './platform-settings.controller.js';
import { PlatformSettingsService } from './platform-settings.service.js';

@Module({
  // EncryptionService, to read which deployments pin their own playback mode.
  imports: [EnvVarTemplatesModule],
  controllers: [PlatformSettingsController],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
