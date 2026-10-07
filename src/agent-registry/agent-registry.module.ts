import { Module } from '@nestjs/common'
import { AgentPackageModule } from '../agent-package/agent-package.module.js'
import { BuiltinAgentDiscoveryService } from './builtin-agent-discovery.service.js'

@Module({
  imports: [AgentPackageModule],
  providers: [BuiltinAgentDiscoveryService],
  exports: [BuiltinAgentDiscoveryService],
})
export class AgentRegistryModule {}
