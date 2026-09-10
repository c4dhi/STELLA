import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { ProjectsModule } from './projects/projects.module';
import { SessionsModule } from './sessions/sessions.module';
import { InvitationsModule } from './invitations/invitations.module';
import { AgentsModule } from './agents/agents.module';
import { LiveKitModule } from './livekit/livekit.module';
import { KubernetesModule } from './kubernetes/kubernetes.module';
import { MessageRecorderModule } from './message-recorder/message-recorder.module';
import { AgentServerModule } from './agent-server/agent-server.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { StorageModule } from './storage/storage.module';
import { AgentPackageModule } from './agent-package/agent-package.module';
import { AgentBuildModule } from './agent-build/agent-build.module';
import { AgentImageModule } from './agent-image/agent-image.module';
import { AgentUploadModule } from './agent-upload/agent-upload.module';
import { PlanTemplatesModule } from './plan-templates/plan-templates.module';
import { PersonasModule } from './personas/personas.module';
import { EnvVarTemplatesModule } from './env-var-templates/env-var-templates.module';
import { PublicProjectsModule } from './public-projects/public-projects.module';
import { MetricsModule } from './metrics/metrics.module';
import { UserMessagesModule } from './user-messages/user-messages.module';
import { ProjectInvitationsModule } from './project-invitations/project-invitations.module';
import { AgentRegistryModule } from './agent-registry/agent-registry.module';
import { StateMachineModule } from './state-machine/state-machine.module';
import { AdminModule } from './admin/admin.module';
import { AgentConfigurationsModule } from './agent-configurations/agent-configurations.module';
import { HealthModule } from './health/health.module';
import { TtsModule } from './tts/tts.module';
import { BackupModule } from './backup/backup.module';

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
