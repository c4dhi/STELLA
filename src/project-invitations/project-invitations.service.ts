import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { UserMessagesService } from '../user-messages/user-messages.service.js';
import { ProjectInvitationStatus, MemberRole } from '@prisma/client';
import {
  InviteCollaboratorDto,
  ProjectCollaboratorsResponseDto,
  CollaboratorResponseDto,
  PendingInvitationResponseDto,
  ProjectInvitationResponseDto,
} from './dto/project-invitation.dto.js';

@Injectable()
export class ProjectInvitationsService {
  private readonly logger = new Logger(ProjectInvitationsService.name);

  constructor(
    private prisma: PrismaService,
    private userMessagesService: UserMessagesService,
  ) {}

  /**
   * Get all collaborators and pending invitations for a project
   */
  async getCollaborators(
    projectId: string,
    userId: string,
  ): Promise<ProjectCollaboratorsResponseDto> {
    // Verify project exists and user has access
    await this.verifyProjectAccess(projectId, userId);

    // Get all memberships
    const memberships = await this.prisma.projectMembership.findMany({
      where: { projectId },
      include: {
        user: {
          select: { id: true, email: true, name: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Get pending invitations
    const pendingInvitations = await this.prisma.projectInvitation.findMany({
      where: {
        projectId,
        status: ProjectInvitationStatus.PENDING,
      },
      include: {
        invitee: {
          select: { id: true, email: true, name: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const collaborators: CollaboratorResponseDto[] = memberships.map((m) => ({
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role === MemberRole.OWNER ? 'OWNER' : 'COLLABORATOR',
      joinedAt: m.createdAt,
    }));

    const pending: PendingInvitationResponseDto[] = pendingInvitations.map(
      (inv) => ({
        invitationId: inv.id,
        email: inv.invitee.email,
        name: inv.invitee.name,
        status: 'PENDING' as const,
        invitedAt: inv.createdAt,
      }),
    );

    return {
      collaborators,
      pendingInvitations: pending,
    };
  }

  /**
   * Invite a user to collaborate on a project
   */
  async inviteCollaborator(
    projectId: string,
    inviterId: string,
    dto: InviteCollaboratorDto,
  ): Promise<ProjectInvitationResponseDto> {
    // Verify inviter is the project owner
    await this.verifyProjectOwner(projectId, inviterId);

    // Find the invitee by email
    const invitee = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase() },
    });

    if (!invitee) {
      throw new NotFoundException(
        `No user found with email "${dto.email}". They must register on the platform first.`,
      );
    }

    // Check if trying to invite self
    if (invitee.id === inviterId) {
      throw new BadRequestException('You cannot invite yourself to a project');
    }

    // Check if user is already a member
    const existingMembership = await this.prisma.projectMembership.findUnique({
      where: {
        userId_projectId: {
          userId: invitee.id,
          projectId,
        },
      },
    });

    if (existingMembership) {
      throw new ConflictException('This user is already a collaborator on this project');
    }

    // Check if there's already a pending invitation
    const existingInvitation = await this.prisma.projectInvitation.findUnique({
      where: {
        projectId_inviteeId: {
          projectId,
          inviteeId: invitee.id,
        },
      },
    });

    if (existingInvitation) {
      if (existingInvitation.status === ProjectInvitationStatus.PENDING) {
        throw new ConflictException('An invitation is already pending for this user');
      }
      // If declined, allow re-inviting by updating the existing invitation
      if (existingInvitation.status === ProjectInvitationStatus.DECLINED) {
        const updated = await this.prisma.projectInvitation.update({
          where: { id: existingInvitation.id },
          data: {
            status: ProjectInvitationStatus.PENDING,
            respondedAt: null,
            createdAt: new Date(),
          },
          include: {
            project: { select: { name: true } },
            inviter: { select: { name: true, email: true } },
            invitee: { select: { name: true, email: true } },
          },
        });

        // Create inbox message for invitee
        await this.userMessagesService.createProjectInvitationMessage(
          invitee.id,
          inviterId,
          projectId,
          updated.project.name,
          updated.inviter.name || updated.inviter.email,
          updated.id,
        );

        this.logger.log(
          `Re-invited user ${invitee.id} to project ${projectId} by ${inviterId}`,
        );

        return this.formatInvitationResponse(updated);
      }
    }

    // Get project and inviter details
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });

    const inviter = await this.prisma.user.findUnique({
      where: { id: inviterId },
    });

    // Create the invitation
    const invitation = await this.prisma.projectInvitation.create({
      data: {
        projectId,
        inviterId,
        inviteeId: invitee.id,
      },
      include: {
        project: { select: { name: true } },
        inviter: { select: { name: true, email: true } },
        invitee: { select: { name: true, email: true } },
      },
    });

    // Create inbox message for invitee
    await this.userMessagesService.createProjectInvitationMessage(
      invitee.id,
      inviterId,
      projectId,
      project!.name,
      inviter!.name || inviter!.email,
      invitation.id,
    );

    this.logger.log(
      `User ${inviterId} invited ${invitee.id} to project ${projectId}`,
    );

    return this.formatInvitationResponse(invitation);
  }

  /**
   * Remove a collaborator from a project
   */
  async removeCollaborator(
    projectId: string,
    requesterId: string,
    userIdToRemove: string,
  ): Promise<void> {
    // Verify requester is the project owner
    await this.verifyProjectOwner(projectId, requesterId);

    // Cannot remove self (owner)
    if (userIdToRemove === requesterId) {
      throw new BadRequestException('You cannot remove yourself as the project owner');
    }

    // Check if user is a member
    const membership = await this.prisma.projectMembership.findUnique({
      where: {
        userId_projectId: {
          userId: userIdToRemove,
          projectId,
        },
      },
    });

    if (!membership) {
      throw new NotFoundException('User is not a collaborator on this project');
    }

    // Delete the membership
    await this.prisma.projectMembership.delete({
      where: { id: membership.id },
    });

    // Also delete any pending invitation if exists
    await this.prisma.projectInvitation.deleteMany({
      where: {
        projectId,
        inviteeId: userIdToRemove,
      },
    });

    this.logger.log(
      `User ${requesterId} removed ${userIdToRemove} from project ${projectId}`,
    );
  }

  /**
   * Cancel a pending invitation
   */
  async cancelInvitation(
    invitationId: string,
    requesterId: string,
  ): Promise<void> {
    const invitation = await this.prisma.projectInvitation.findUnique({
      where: { id: invitationId },
      include: { project: true },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    // Verify requester is project owner
    await this.verifyProjectOwner(invitation.projectId, requesterId);

    if (invitation.status !== ProjectInvitationStatus.PENDING) {
      throw new BadRequestException('Only pending invitations can be cancelled');
    }

    // Delete the invitation
    await this.prisma.projectInvitation.delete({
      where: { id: invitationId },
    });

    // Delete associated inbox message
    await this.userMessagesService.deleteMessagesByEntity(
      invitationId,
      'ProjectInvitation',
    );

    this.logger.log(`Invitation ${invitationId} cancelled by ${requesterId}`);
  }

  /**
   * Accept a project invitation
   */
  async acceptInvitation(
    invitationId: string,
    userId: string,
  ): Promise<ProjectInvitationResponseDto> {
    const invitation = await this.prisma.projectInvitation.findUnique({
      where: { id: invitationId },
      include: {
        project: { select: { id: true, name: true } },
        inviter: { select: { name: true, email: true } },
        invitee: { select: { id: true, name: true, email: true } },
      },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.inviteeId !== userId) {
      throw new ForbiddenException('This invitation is not for you');
    }

    if (invitation.status !== ProjectInvitationStatus.PENDING) {
      throw new BadRequestException(
        `This invitation has already been ${invitation.status.toLowerCase()}`,
      );
    }

    // Use transaction to update invitation and create membership
    const [updatedInvitation] = await this.prisma.$transaction([
      this.prisma.projectInvitation.update({
        where: { id: invitationId },
        data: {
          status: ProjectInvitationStatus.ACCEPTED,
          respondedAt: new Date(),
        },
        include: {
          project: { select: { id: true, name: true } },
          inviter: { select: { name: true, email: true } },
          invitee: { select: { name: true, email: true } },
        },
      }),
      this.prisma.projectMembership.create({
        data: {
          userId,
          projectId: invitation.projectId,
          role: MemberRole.MEMBER, // All collaborators get MEMBER role
        },
      }),
    ]);

    // Delete the inbox message
    await this.userMessagesService.deleteMessagesByEntity(
      invitationId,
      'ProjectInvitation',
    );

    this.logger.log(
      `User ${userId} accepted invitation ${invitationId} for project ${invitation.projectId}`,
    );

    return this.formatInvitationResponse(updatedInvitation);
  }

  /**
   * Decline a project invitation
   */
  async declineInvitation(
    invitationId: string,
    userId: string,
  ): Promise<void> {
    const invitation = await this.prisma.projectInvitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }

    if (invitation.inviteeId !== userId) {
      throw new ForbiddenException('This invitation is not for you');
    }

    if (invitation.status !== ProjectInvitationStatus.PENDING) {
      throw new BadRequestException(
        `This invitation has already been ${invitation.status.toLowerCase()}`,
      );
    }

    // Update invitation status
    await this.prisma.projectInvitation.update({
      where: { id: invitationId },
      data: {
        status: ProjectInvitationStatus.DECLINED,
        respondedAt: new Date(),
      },
    });

    // Delete the inbox message
    await this.userMessagesService.deleteMessagesByEntity(
      invitationId,
      'ProjectInvitation',
    );

    this.logger.log(
      `User ${userId} declined invitation ${invitationId}`,
    );
  }

  /**
   * Verify that a user has access to a project
   */
  private async verifyProjectAccess(
    projectId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.prisma.projectMembership.findUnique({
      where: {
        userId_projectId: {
          userId,
          projectId,
        },
      },
    });

    if (!membership) {
      throw new ForbiddenException('You do not have access to this project');
    }
  }

  /**
   * Verify that a user is the owner of a project
   */
  private async verifyProjectOwner(
    projectId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.prisma.projectMembership.findUnique({
      where: {
        userId_projectId: {
          userId,
          projectId,
        },
      },
    });

    if (!membership || membership.role !== MemberRole.OWNER) {
      throw new ForbiddenException('Only the project owner can perform this action');
    }
  }

  /**
   * Format invitation response
   */
  private formatInvitationResponse(invitation: any): ProjectInvitationResponseDto {
    return {
      id: invitation.id,
      projectId: invitation.projectId,
      projectName: invitation.project.name,
      inviterId: invitation.inviterId,
      inviterName: invitation.inviter.name,
      inviterEmail: invitation.inviter.email,
      inviteeId: invitation.inviteeId,
      inviteeName: invitation.invitee.name,
      inviteeEmail: invitation.invitee.email,
      status: invitation.status,
      createdAt: invitation.createdAt,
      respondedAt: invitation.respondedAt,
    };
  }
}
