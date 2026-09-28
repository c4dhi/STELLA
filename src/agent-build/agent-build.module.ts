import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PrismaModule } from '../prisma/prisma.module.js'
import { AgentPackageModule } from '../agent-package/agent-package.module.js'
import { AgentBuildService } from './agent-build.service.js'

@Module({
  imports: [ConfigModule, PrismaModule, AgentPackageModule],
  providers: [AgentBuildService],
  exports: [AgentBuildService],
})
export class AgentBuildModule {}
