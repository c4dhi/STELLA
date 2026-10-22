import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OAuthClientsStore } from './oauth-clients.store.js';
import { OAuthAuthorizationService } from './oauth-authorization.service.js';
import { OAuthTokensService } from './oauth-tokens.service.js';

/**
 * Adapter between the MCP SDK's OAuth handlers (/authorize, /token,
 * /register, /revoke) and STELLA's services. No logic of its own.
 */
@Injectable()
export class StellaOAuthProvider implements OAuthServerProvider {
  constructor(
    readonly clientsStore: OAuthClientsStore,
    private readonly authorization: OAuthAuthorizationService,
    private readonly tokens: OAuthTokensService,
  ) {}

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    res.redirect(302, await this.authorization.createRequest(client, params));
  }

  challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ): Promise<string> {
    return this.authorization.challengeFor(client.client_id, code);
  }

  exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    return this.authorization.exchange(
      client.client_id,
      code,
      redirectUri,
      resource,
    );
  }

  exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    return this.tokens.refresh(
      client.client_id,
      refreshToken,
      scopes,
      resource,
    );
  }

  /** /mcp authenticates through McpBearerGuard; this exists for the SDK's interface. */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const grant = await this.tokens.authenticateAccessToken(token);
    if (!grant) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: grant.clientName,
      scopes: grant.scopes,
      extra: { grantId: grant.grantId },
    };
  }

  revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    return this.tokens.revokeToken(client.client_id, request.token);
  }
}
