import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentImageService } from './agent-image.service.js';
import { AgentTypeModule } from '../agent-type/agent-type.module.js';

@Module({
  imports: [ConfigModule, AgentTypeModule],
  providers: [AgentImageService],
  exports: [AgentImageService],
})
export class AgentImageModule {}
