import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { SessionsModule } from './sessions/sessions.module.js';
import { InvitationsModule } from './invitations/invitations.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { LiveKitModule } from './livekit/livekit.module.js';
import { KubernetesModule } from './kubernetes/kubernetes.module.js';
import { MessageRecorderModule } from './message-recorder/message-recorder.module.js';
import { AgentServerModule } from './agent-server/agent-server.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard.js';
import { StorageModule } from './storage/storage.module.js';
import { AgentPackageModule } from './agent-package/agent-package.module.js';
import { AgentBuildModule } from './agent-build/agent-build.module.js';
import { AgentImageModule } from './agent-image/agent-image.module.js';
import { AgentUploadModule } from './agent-upload/agent-upload.module.js';
import { PlanTemplatesModule } from './plan-templates/plan-templates.module.js';
import { PersonasModule } from './personas/personas.module.js';
import { EnvVarTemplatesModule } from './env-var-templates/env-var-templates.module.js';
import { PublicProjectsModule } from './public-projects/public-projects.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { UserMessagesModule } from './user-messages/user-messages.module.js';
import { ProjectInvitationsModule } from './project-invitations/project-invitations.module.js';
import { AgentRegistryModule } from './agent-registry/agent-registry.module.js';
import { StateMachineModule } from './state-machine/state-machine.module.js';
import { AdminModule } from './admin/admin.module.js';
import { AgentConfigurationsModule } from './agent-configurations/agent-configurations.module.js';
import { HealthModule } from './health/health.module.js';
import { TtsModule } from './tts/tts.module.js';
import { BackupModule } from './backup/backup.module.js';

const envFilePath = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.local';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath,
    }),
    PrismaModule,
    AuthModule,
    ProjectsModule,
    SessionsModule,
    InvitationsModule,
    AgentsModule,
    LiveKitModule,
    KubernetesModule,
    MessageRecorderModule,
    AgentServerModule,
    WebhooksModule,
    StorageModule,
    AgentPackageModule,
    AgentBuildModule,
    AgentImageModule,
    AgentUploadModule,
    PlanTemplatesModule,
    PersonasModule,
    EnvVarTemplatesModule,
    PublicProjectsModule,
    MetricsModule,
    UserMessagesModule,
    ProjectInvitationsModule,
    AgentRegistryModule,
    StateMachineModule,
    AdminModule,
    AgentConfigurationsModule,
    HealthModule,
    TtsModule,
    BackupModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
