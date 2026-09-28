import { Module, forwardRef } from '@nestjs/common';
import { AgentsService } from './agents.service.js';
import { AgentsController } from './agents.controller.js';
import { KubernetesModule } from '../kubernetes/kubernetes.module.js';
import { AgentServerModule } from '../agent-server/agent-server.module.js';
import { AgentImageModule } from '../agent-image/agent-image.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { EnvVarTemplatesModule } from '../env-var-templates/env-var-templates.module.js';
import { AgentConfigurationsModule } from '../agent-configurations/agent-configurations.module.js';
import { PersonasModule } from '../personas/personas.module.js';

/**
 * AgentsModule - Manages agent lifecycle.
 *
 * In the new architecture:
 * - Agents connect directly to LiveKit rooms via SDK
 * - Session-management-server only deploys K8s pods
 * - No RoomAgentModule needed (agents handle audio directly)
 */
@Module({
  imports: [
    KubernetesModule,
    AgentImageModule,
    // Import encryption provider so manual env vars can be persisted securely for restart reuse.
    EnvVarTemplatesModule,
    // Resolve + validate stored pipeline configurations at deploy time.
    AgentConfigurationsModule,
    // Resolve the persona (agent identity) snapshot at deploy time.
    PersonasModule,
    forwardRef(() => AgentServerModule),
    forwardRef(() => SessionsModule),
  ],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService],
})
export class AgentsModule {}
