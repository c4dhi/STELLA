import { Module, forwardRef } from '@nestjs/common';
import { SessionsService } from './sessions.service.js';
import { SessionTimeoutService } from './session-timeout.service.js';
import { SessionsController } from './sessions.controller.js';
import { LiveKitModule } from '../livekit/livekit.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { MessageRecorderModule } from '../message-recorder/message-recorder.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [LiveKitModule, forwardRef(() => AgentsModule), MessageRecorderModule, AuthModule],
  controllers: [SessionsController],
  providers: [SessionsService, SessionTimeoutService],
  exports: [SessionsService],
})
export class SessionsModule {}
