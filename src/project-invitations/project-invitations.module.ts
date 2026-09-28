import { Module } from '@nestjs/common';
import { ProjectInvitationsService } from './project-invitations.service.js';
import { ProjectInvitationsController } from './project-invitations.controller.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { UserMessagesModule } from '../user-messages/user-messages.module.js';

@Module({
  imports: [PrismaModule, UserMessagesModule],
  controllers: [ProjectInvitationsController],
  providers: [ProjectInvitationsService],
  exports: [ProjectInvitationsService],
})
export class ProjectInvitationsModule {}
