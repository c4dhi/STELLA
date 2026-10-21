import { BadRequestException, CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AccessTokensService } from '../../access-tokens/access-tokens.service.js';
import { PAT_PREFIX } from '../../access-tokens/access-token.util.js';
import { McpOAuthUrls } from '../../mcp-oauth/mcp-oauth.urls.js';
import { OAuthTokensService } from '../../mcp-oauth/oauth-tokens.service.js';
import { McpAuthContext } from '../mcp.types.js';

/**
 * Authenticates /mcp with a bearer token in the Authorization header: a
 * personal access token (stella_pat_…) or an access token from MCP sign-in
 * (stella_oat_…). Every 401 points at the protected-resource metadata, which
 * is how Claude and ChatGPT discover the sign-in flow (RFC 9728).
 * Never reads `?token=`: tokens in URLs end up in logs, and the spec forbids them.
 */
@Injectable()
export class McpBearerGuard implements CanActivate {
  constructor(
    private readonly accessTokens: AccessTokensService,
    private readonly oauthTokens: OAuthTokensService,
    private readonly urls: McpOAuthUrls,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    if (request.query?.token !== undefined) {
      throw new BadRequestException('Send the access token in the Authorization header, not in the URL');
    }

    const unauthorized = (message: string, invalidToken: boolean) => {
      const error = invalidToken ? ', error="invalid_token"' : '';
      response.setHeader('WWW-Authenticate', `Bearer resource_metadata="${this.urls.resourceMetadataUrl}"${error}`);
      return new UnauthorizedException(message);
    };

    const header = request.headers.authorization as string | undefined;
    const match = header?.match(/^Bearer\s+(\S+)$/i);
    if (!match) throw unauthorized('Sign in to STELLA, or send Authorization: Bearer <token>', false);
    const secret = match[1];

    let auth: McpAuthContext | null = null;
    try {
      if (secret.startsWith(PAT_PREFIX)) {
        const pat = await this.accessTokens.authenticate(secret);
        if (pat) auth = { user: pat.user, tokenId: pat.tokenId, scopes: pat.scopes };
      } else {
        const grant = await this.oauthTokens.authenticateAccessToken(secret);
        if (grant) auth = { user: grant.user, oauthGrantId: grant.grantId, clientName: grant.clientName, scopes: grant.scopes };
      }
    } catch (error) {
      // The token is valid but its owner is gone or not approved.
      if (error instanceof UnauthorizedException) throw unauthorized(error.message, true);
      throw error;
    }
    if (!auth) throw unauthorized('Invalid, expired or revoked access token', true);

    request.user = auth.user;
    request.mcpAuth = auth;
    return true;
  }
}
