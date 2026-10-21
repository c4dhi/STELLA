import { BadRequestException, CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AccessTokensService } from '../../access-tokens/access-tokens.service.js';
import { McpAuthContext } from '../mcp.types.js';

/**
 * Authenticates /mcp with a personal access token in the Authorization
 * header. Unlike JwtAuthGuard it never reads `?token=`: tokens in URLs end up
 * in logs, and the MCP spec forbids them.
 */
@Injectable()
export class PatAuthGuard implements CanActivate {
  constructor(private readonly accessTokens: AccessTokensService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    if (request.query?.token !== undefined) {
      throw new BadRequestException('Send the access token in the Authorization header, not in the URL');
    }

    const unauthorized = (message: string) => {
      response.setHeader('WWW-Authenticate', 'Bearer realm="stella", error="invalid_token"');
      return new UnauthorizedException(message);
    };

    const header = request.headers.authorization as string | undefined;
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match) throw unauthorized('Missing bearer token: send Authorization: Bearer stella_pat_…');

    let auth;
    try {
      auth = await this.accessTokens.authenticate(match[1]);
    } catch (error) {
      // The token is valid but its owner is gone or not approved.
      if (error instanceof UnauthorizedException) throw unauthorized(error.message);
      throw error;
    }
    if (!auth) throw unauthorized('Invalid, expired or revoked access token');

    const mcpAuth: McpAuthContext = { user: auth.user, tokenId: auth.tokenId, scopes: auth.scopes };
    request.user = auth.user;
    request.mcpAuth = mcpAuth;
    return true;
  }
}
