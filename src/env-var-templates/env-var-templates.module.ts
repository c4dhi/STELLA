import { Module } from '@nestjs/common';
import { EnvVarTemplatesController } from './env-var-templates.controller.js';
import { EnvVarTemplatesService } from './env-var-templates.service.js';
import { EncryptionService } from './encryption.service.js';

@Module({
  controllers: [EnvVarTemplatesController],
  providers: [EnvVarTemplatesService, EncryptionService],
  exports: [EnvVarTemplatesService, EncryptionService],
})
export class EnvVarTemplatesModule {}
