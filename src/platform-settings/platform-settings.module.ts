import { Module } from '@nestjs/common';
import { EnvVarTemplatesModule } from '../env-var-templates/env-var-templates.module.js';
import { PlatformFeaturesController } from './platform-features.controller.js';
import { PlatformSettingsController } from './platform-settings.controller.js';
import { PlatformSettingsService } from './platform-settings.service.js';

@Module({
  // EncryptionService, to read which deployments pin their own playback mode.
  imports: [EnvVarTemplatesModule],
  controllers: [PlatformSettingsController, PlatformFeaturesController],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
