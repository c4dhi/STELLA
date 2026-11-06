import { Module } from '@nestjs/common'
import { AgentTypeService } from './agent-type.service.js'
import { PrismaModule } from '../prisma/prisma.module.js'
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module.js'

@Module({
  imports: [PrismaModule, PlatformSettingsModule],
  providers: [AgentTypeService],
  exports: [AgentTypeService],
})
export class AgentTypeModule {}
