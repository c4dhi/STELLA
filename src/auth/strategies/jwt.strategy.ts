import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface JwtPayload {
  sub: string;
  email?: string; // Optional for participant tokens
  type?: 'participant'; // 'participant' for participant tokens, undefined for user tokens
  sessionId?: string; // Session ID for participant tokens
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    const jwtSecret = configService.get<string>('JWT_SECRET');
    if (!jwtSecret) {
      throw new Error('JWT_SECRET is not defined in environment variables');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
    });
  }

  async validate(payload: JwtPayload) {
    // Check if this is a participant token
    if (payload.type === 'participant') {
      const participant = await this.prisma.participant.findUnique({
        where: { id: payload.sub },
        include: {
          session: true,
        },
      });

      if (!participant) {
        throw new UnauthorizedException('Participant not found');
      }

      // Check if token has been revoked
      if (participant.tokenRevokedAt) {
        throw new UnauthorizedException('Participant token has been revoked');
      }

      return {
        participantId: participant.id,
        sessionId: participant.sessionId,
        type: 'participant',
        participantName: participant.name,
        identity: participant.identity,
      };
    }

    // Handle user token (existing logic)
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
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

    // Check if user is verified
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
        {},
      ),
    };
  }
}
