import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** The part of the signed-in user a membership check needs. */
export interface ProjectMember {
  projectIds: string[];
}

/**
 * Membership checks for project-scoped reads, the same rule ProjectAccessGuard
 * applies to `:projectId` routes. Something the user cannot see answers "not
 * found", so its existence does not leak.
 */
@Injectable()
export class ResourceAccessService {
  constructor(private readonly prisma: PrismaService) {}

  assertProjectMember(user: ProjectMember, projectId: string): void {
    if (!user.projectIds.includes(projectId)) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
  }

  async assertSessionAccess(
    user: ProjectMember,
    sessionId: string,
  ): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { projectId: true },
    });
    if (!session || !user.projectIds.includes(session.projectId)) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
  }

  async assertAgentAccess(user: ProjectMember, agentId: string): Promise<void> {
    const agent = await this.prisma.agentInstance.findUnique({
      where: { id: agentId },
      select: { session: { select: { projectId: true } } },
    });
    if (!agent || !user.projectIds.includes(agent.session.projectId)) {
      throw new NotFoundException(`Agent ${agentId} not found`);
    }
  }

  async assertInvitationAccess(
    user: ProjectMember,
    invitationId: string,
  ): Promise<void> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
      select: { session: { select: { projectId: true } } },
    });
    if (
      !invitation ||
      !user.projectIds.includes(invitation.session.projectId)
    ) {
      throw new NotFoundException(`Invitation ${invitationId} not found`);
    }
  }

  async assertParticipantAccess(
    user: ProjectMember,
    participantId: string,
  ): Promise<void> {
    const participant = await this.prisma.participant.findUnique({
      where: { id: participantId },
      select: { session: { select: { projectId: true } } },
    });
    if (
      !participant ||
      !user.projectIds.includes(participant.session.projectId)
    ) {
      throw new NotFoundException(
        `Participant with ID ${participantId} not found`,
      );
    }
  }
}
