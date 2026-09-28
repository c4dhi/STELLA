import { Module } from '@nestjs/common';
import { InvitationsService } from './invitations.service.js';
import { InvitationsController } from './invitations.controller.js';
import { LiveKitModule } from '../livekit/livekit.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [LiveKitModule, AuthModule],
  controllers: [InvitationsController],
  providers: [InvitationsService],
  exports: [InvitationsService],
})
export class InvitationsModule {}
