import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ResourceAccessService } from '../resource-access.service.js';

const ALLOW_SESSION_PARTICIPANT = 'allowSessionParticipant';

/**
 * Lets a participant token through on this route, but only for its own session.
 * The phone app reads its session's messages this way.
 */
export const AllowSessionParticipant = () =>
  SetMetadata(ALLOW_SESSION_PARTICIPANT, true);

/**
 * For routes that name a session or something inside one (`:sessionId`,
 * `:agentId`, `:invitationId`, `:participantId`): the signed-in user must be a
 * member of that session's project. Anything else answers "not found", like
 * something that does not exist.
 */
@Injectable()
export class SessionAccessGuard implements CanActivate {
  constructor(
    private readonly access: ResourceAccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const { sessionId, agentId, invitationId, participantId } = request.params;

    if (user?.type === 'participant') {
      const allowed = this.reflector.getAllAndOverride<boolean>(
        ALLOW_SESSION_PARTICIPANT,
        [context.getHandler(), context.getClass()],
      );
      if (allowed && sessionId && user.sessionId === sessionId) {
        return true;
      }
      throw new NotFoundException('Not found');
    }

    const member = { projectIds: user?.projectIds ?? [] };
    if (sessionId) {
      await this.access.assertSessionAccess(member, sessionId);
    } else if (agentId) {
      await this.access.assertAgentAccess(member, agentId);
    } else if (invitationId) {
      await this.access.assertInvitationAccess(member, invitationId);
    } else if (participantId) {
      await this.access.assertParticipantAccess(member, participantId);
    } else {
      throw new NotFoundException('Not found');
    }
    return true;
  }
}
