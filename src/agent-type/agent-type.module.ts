import { Module } from '@nestjs/common'
import { AgentTypeService } from './agent-type.service.js'
import { PrismaModule } from '../prisma/prisma.module.js'

@Module({
  imports: [PrismaModule],
  providers: [AgentTypeService],
  exports: [AgentTypeService],
})
export class AgentTypeModule {}
