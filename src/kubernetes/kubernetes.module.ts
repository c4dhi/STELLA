import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { KubernetesService } from './kubernetes.service.js';
import { AgentImageModule } from '../agent-image/agent-image.module.js';

// EnvVarTemplatesModule is intentionally NOT imported here.
// KubernetesService no longer resolves env vars — callers pass pre-resolved vars via AgentPodConfig.resolvedEnvVars.
@Module({
  imports: [ConfigModule, AgentImageModule],
  providers: [KubernetesService],
  exports: [KubernetesService],
})
export class KubernetesModule {}
