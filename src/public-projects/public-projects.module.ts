import { Module } from '@nestjs/common';
import { PublicProjectsController } from './public-projects.controller.js';
import { PublicProjectsService } from './public-projects.service.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { AgentsModule } from '../agents/agents.module.js';
import { InvitationsModule } from '../invitations/invitations.module.js';

@Module({
  imports: [SessionsModule, AgentsModule, InvitationsModule],
  controllers: [PublicProjectsController],
  providers: [PublicProjectsService],
  exports: [PublicProjectsService],
})
export class PublicProjectsModule {}
