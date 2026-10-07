import { Module } from '@nestjs/common'
import { StorageModule } from '../storage/storage.module.js'
import { AgentPackageService } from './agent-package.service.js'
import { ManifestValidator } from './validators/manifest.validator.js'
import { DockerfileValidator } from './validators/dockerfile.validator.js'

@Module({
  imports: [StorageModule],
  providers: [AgentPackageService, ManifestValidator, DockerfileValidator],
  exports: [AgentPackageService, ManifestValidator, DockerfileValidator],
})
export class AgentPackageModule {}
