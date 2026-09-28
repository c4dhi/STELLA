import { Module } from '@nestjs/common';
import { AgentConfigurationsService } from './agent-configurations.service.js';
import { AgentConfigurationsController } from './agent-configurations.controller.js';

@Module({
  controllers: [AgentConfigurationsController],
  providers: [AgentConfigurationsService],
  exports: [AgentConfigurationsService],
})
export class AgentConfigurationsModule {}
