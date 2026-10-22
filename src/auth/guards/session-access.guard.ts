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
 * For `:sessionId` routes: the signed-in user must be a member of the session's
 * project. Anything else answers "not found", like a session that does not exist.
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
    const sessionId: string = request.params.sessionId;

    if (user?.type === 'participant') {
      const allowed = this.reflector.getAllAndOverride<boolean>(
        ALLOW_SESSION_PARTICIPANT,
        [context.getHandler(), context.getClass()],
      );
      if (allowed && user.sessionId === sessionId) {
        return true;
      }
      throw new NotFoundException(`Session ${sessionId} not found`);
    }

    await this.access.assertSessionAccess(
      { projectIds: user?.projectIds ?? [] },
      sessionId,
    );
    return true;
  }
}
