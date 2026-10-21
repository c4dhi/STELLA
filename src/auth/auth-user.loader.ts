import { Injectable, UnauthorizedException } from '@nestjs/common';
import { MemberRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

/** What `request.user` holds for a signed-in user, however they authenticated. */
export interface AuthUser {
  userId: string;
  email: string;
  name: string | null;
  isSystemAdmin: boolean;
  projectIds: string[];
  projectRoles: Record<string, MemberRole>;
}

/**
 * Builds `request.user` for a user id. Shared by the JWT strategy and the
 * personal-access-token guard (#772) so both see the same user, with the same
 * checks: the user must exist and be approved by an administrator.
 */
@Injectable()
export class AuthUserLoader {
  constructor(private readonly prisma: PrismaService) {}

  async load(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        verified: true,
        isSystemAdmin: true,
        projectMemberships: {
          select: {
            projectId: true,
            role: true,
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.verified) {
      throw new UnauthorizedException('Your account is pending administrator approval. Please contact your administrator.');
    }

    return {
      userId: user.id,
      email: user.email,
      name: user.name,
      isSystemAdmin: user.isSystemAdmin,
      projectIds: user.projectMemberships.map((m) => m.projectId),
      projectRoles: user.projectMemberships.reduce(
        (acc, m) => ({ ...acc, [m.projectId]: m.role }),
        {} as Record<string, MemberRole>,
      ),
    };
  }
}
