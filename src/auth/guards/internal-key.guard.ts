import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { INTERNAL_KEY_HEADER, internalKeyMatches } from '../internal-key.js';

/**
 * Lets a request through only with the internal key in `X-Internal-Key` (#145).
 * For `@Public()` internal endpoints called by STELLA's own services, which
 * carry no user token.
 */
@Injectable()
export class InternalKeyGuard implements CanActivate {
  private readonly logger = new Logger(InternalKeyGuard.name);
  private warnedUnset = false;

  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.INTERNAL_API_KEY;
    if (!expected && !this.warnedUnset) {
      this.warnedUnset = true;
      this.logger.warn(
        'INTERNAL_API_KEY is not set: internal endpoints that need it refuse every request',
      );
    }
    const request = context.switchToHttp().getRequest<Request>();
    if (!internalKeyMatches(expected, request.headers[INTERNAL_KEY_HEADER])) {
      throw new UnauthorizedException('Missing or wrong internal key');
    }
    return true;
  }
}
