import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LiveKitWebhookController } from './livekit-webhook.controller.js';
import { WebhooksService } from './webhooks.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { LiveKitModule } from '../livekit/livekit.module.js';
import { EnvVarTemplatesModule } from '../env-var-templates/env-var-templates.module.js';

/**
 * Webhooks Module
 *
 * Handles incoming webhook events from external services.
 * Currently supports:
 * - LiveKit webhooks for participant and room events
 *
 * Features:
 * - Message-recorder optimization: webhook-driven room management
 * - Agent pausing: on-demand spawning when humans join
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    LiveKitModule,
    // EncryptionService is needed to decrypt manualEnvVarsEncrypted when recreating paused agents.
    EnvVarTemplatesModule,
    forwardRef(() => AgentsModule),
    forwardRef(() => SessionsModule),
  ],
  controllers: [LiveKitWebhookController],
  providers: [WebhooksService],
  exports: [WebhooksService],
})
export class WebhooksModule {}
