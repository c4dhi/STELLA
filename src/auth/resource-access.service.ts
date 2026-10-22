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
}
