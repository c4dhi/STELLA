import { Module } from '@nestjs/common'
import { EnvVarTemplatesModule } from '../env-var-templates/env-var-templates.module.js'
import { BackupController } from './backup.controller.js'
import { BackupService } from './backup.service.js'
import { AuditService } from './audit.service.js'

/**
 * Full-system data export/import (#378).
 *
 * PrismaService, StorageService and ConfigService are all global; this module
 * only needs EnvVarTemplatesModule for the EncryptionService key fingerprint.
 */
@Module({
  imports: [EnvVarTemplatesModule],
  controllers: [BackupController],
  providers: [BackupService, AuditService],
  exports: [BackupService, AuditService],
})
export class BackupModule {}
