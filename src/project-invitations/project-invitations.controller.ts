import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  ValidationPipe,
  UsePipes,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ProjectInvitationsService } from './project-invitations.service.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { InviteCollaboratorDto } from './dto/project-invitation.dto.js';

@Controller()
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class ProjectInvitationsController {
  constructor(
    private readonly projectInvitationsService: ProjectInvitationsService,
  ) {}

  // ============================================================================
  // Project Collaborator Endpoints
  // ============================================================================

  /**
   * Get all collaborators and pending invitations for a project
   */
  @Get('projects/:projectId/collaborators')
  async getCollaborators(
    @Param('projectId') projectId: string,
    @CurrentUser() user: any,
  ) {
    return this.projectInvitationsService.getCollaborators(projectId, user.userId);
  }

  /**
   * Invite a user to collaborate on a project (owner only)
   */
  @Post('projects/:projectId/collaborators/invite')
  async inviteCollaborator(
    @Param('projectId') projectId: string,
    @Body() dto: InviteCollaboratorDto,
    @CurrentUser() user: any,
  ) {
    return this.projectInvitationsService.inviteCollaborator(
      projectId,
      user.userId,
      dto,
    );
  }

  /**
   * Remove a collaborator from a project (owner only)
   */
  @Delete('projects/:projectId/collaborators/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeCollaborator(
    @Param('projectId') projectId: string,
    @Param('userId') userIdToRemove: string,
    @CurrentUser() user: any,
  ) {
    await this.projectInvitationsService.removeCollaborator(
      projectId,
      user.userId,
      userIdToRemove,
    );
  }

  /**
   * Cancel a pending invitation (owner only)
   */
  @Delete('project-invitations/:invitationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancelInvitation(
    @Param('invitationId') invitationId: string,
    @CurrentUser() user: any,
  ) {
    await this.projectInvitationsService.cancelInvitation(
      invitationId,
      user.userId,
    );
  }

  // ============================================================================
  // Invitation Response Endpoints (for invitee)
  // ============================================================================

  /**
   * Accept a project invitation
   */
  @Post('project-invitations/:invitationId/accept')
  async acceptInvitation(
    @Param('invitationId') invitationId: string,
    @CurrentUser() user: any,
  ) {
    return this.projectInvitationsService.acceptInvitation(
      invitationId,
      user.userId,
    );
  }

  /**
   * Decline a project invitation
   */
  @Post('project-invitations/:invitationId/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  async declineInvitation(
    @Param('invitationId') invitationId: string,
    @CurrentUser() user: any,
  ) {
    await this.projectInvitationsService.declineInvitation(
      invitationId,
      user.userId,
    );
  }
}
