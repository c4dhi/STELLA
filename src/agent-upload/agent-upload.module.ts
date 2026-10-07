import { Module } from '@nestjs/common'
import { MulterModule } from '@nestjs/platform-express'
import { PrismaModule } from '../prisma/prisma.module.js'
import { StorageModule } from '../storage/storage.module.js'
import { AgentPackageModule } from '../agent-package/agent-package.module.js'
import { AgentBuildModule } from '../agent-build/agent-build.module.js'
import { AgentUploadController } from './agent-upload.controller.js'
import { AgentAdminController } from './agent-admin.controller.js'

@Module({
  imports: [
    MulterModule.register({
      limits: {
        fileSize: 50 * 1024 * 1024, // 50MB max file size
      },
    }),
    PrismaModule,
    StorageModule,
    AgentPackageModule,
    AgentBuildModule,
  ],
  controllers: [AgentUploadController, AgentAdminController],
})
export class AgentUploadModule {}
