import {
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { OAuthRequestStatus } from '@prisma/client';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import {
  generateSecret,
  hashSecret,
} from '../access-tokens/access-token.util.js';
import {
  AUTHORIZATION_CODE_PREFIX,
  AUTHORIZATION_CODE_TTL_MS,
  AUTHORIZATION_REQUEST_TTL_MS,
  OAUTH_SCOPES,
} from './mcp-oauth.constants.js';
import { McpOAuthUrls } from './mcp-oauth.urls.js';
import { OAuthTokensService } from './oauth-tokens.service.js';

export type ConsentAccess = 'read' | 'read_write';

/** What the consent page shows about a pending sign-in. */
export interface AuthorizationRequestView {
  id: string;
  clientName: string;
  clientUri: string | null;
  logoUri: string | null;
  // Where the user's browser goes next: the user should recognise it.
  redirectHost: string;
  verifiedBy: 'registration' | 'metadata_document';
  requestedScopes: string[];
  expiresAt: string;
}

const scopesFor = (access: ConsentAccess): string[] =>
  access === 'read' ? ['mcp:read'] : ['mcp:read', 'mcp:write'];

/**
 * The authorization-code half of MCP sign-in: /authorize parks a request,
 * the user approves or denies it on the consent page, and the client trades
 * the one-time code for tokens.
 */
@Injectable()
export class OAuthAuthorizationService {
  private readonly logger = new Logger(OAuthAuthorizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: OAuthTokensService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly urls: McpOAuthUrls,
  ) {}

  /** Called from /authorize once the SDK validated client, redirect URI and PKCE. Returns the consent page URL. */
  async createRequest(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
  ): Promise<string> {
    const unknown = (params.scopes ?? []).filter(
      (s) => !(OAUTH_SCOPES as readonly string[]).includes(s),
    );
    if (unknown.length)
      throw new InvalidScopeError(`Unknown scope: ${unknown.join(' ')}`);
    if (params.resource && !this.urls.isOwnResource(params.resource)) {
      throw new InvalidTargetError(
        `This server only issues tokens for ${this.urls.mcpResource.href}`,
      );
    }
    const request = await this.prisma.oAuthAuthorizationRequest.create({
      data: {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state ?? null,
        // No scope asked for means everything STELLA offers; the user can narrow it.
        scopes: params.scopes?.length ? params.scopes : [...OAUTH_SCOPES],
        resource: params.resource?.href ?? null,
        expiresAt: new Date(Date.now() + AUTHORIZATION_REQUEST_TTL_MS),
      },
    });
    return this.urls.consentUrl(request.id);
  }

  async view(requestId: string): Promise<AuthorizationRequestView> {
    const request = await this.pendingRequest(requestId);
    const metadata = (request.client.metadata ?? {}) as {
      client_uri?: string;
      logo_uri?: string;
    };
    return {
      id: request.id,
      clientName: request.client.name,
      clientUri: metadata.client_uri ?? null,
      logoUri: metadata.logo_uri ?? null,
      redirectHost: new URL(request.redirectUri).host,
      verifiedBy:
        request.client.source === 'CIMD' ? 'metadata_document' : 'registration',
      requestedScopes: request.scopes,
      expiresAt: request.expiresAt.toISOString(),
    };
  }

  /** The user said yes: bind the request to them and hand back the redirect carrying a one-time code. */
  async approve(
    requestId: string,
    userId: string,
    access: ConsentAccess,
  ): Promise<{ redirectUrl: string }> {
    const request = await this.pendingRequest(requestId);
    const approvedScopes = scopesFor(access).filter((s) =>
      request.scopes.includes(s),
    );
    if (approvedScopes.length === 0)
      throw new ForbiddenException('Choose an access level the app asked for');
    const code = generateSecret(AUTHORIZATION_CODE_PREFIX);
    // Only one approval or denial wins, even with two tabs open.
    const { count } = await this.prisma.oAuthAuthorizationRequest.updateMany({
      where: { id: requestId, status: OAuthRequestStatus.PENDING },
      data: {
        status: OAuthRequestStatus.APPROVED,
        userId,
        approvedScopes,
        codeHash: hashSecret(code),
        codeExpiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS),
      },
    });
    if (count === 0)
      throw new GoneException('This sign-in request was already answered');
    this.logger.log(
      `User ${userId} approved ${request.client.name} (${approvedScopes.join(' ')})`,
    );
    return {
      redirectUrl: this.redirect(request.redirectUri, {
        code,
        state: request.state,
      }),
    };
  }

  async deny(
    requestId: string,
    userId: string,
  ): Promise<{ redirectUrl: string }> {
    const request = await this.pendingRequest(requestId);
    const { count } = await this.prisma.oAuthAuthorizationRequest.updateMany({
      where: { id: requestId, status: OAuthRequestStatus.PENDING },
      data: { status: OAuthRequestStatus.DENIED, userId },
    });
    if (count === 0)
      throw new GoneException('This sign-in request was already answered');
    return {
      redirectUrl: this.redirect(request.redirectUri, {
        error: 'access_denied',
        error_description: 'The user declined access',
        state: request.state,
      }),
    };
  }

  /** For the SDK's PKCE check at /token. */
  async challengeFor(clientId: string, code: string): Promise<string> {
    const request = await this.issuedCode(clientId, code);
    return request.codeChallenge;
  }

  /**
   * Trade a code for tokens. A code works once; a replayed code means it
   * leaked, so whatever it was exchanged into is revoked (OAuth 2.1 §4.1.3).
   */
  async exchange(
    clientId: string,
    code: string,
    redirectUri: string | undefined,
    resource: URL | undefined,
  ): Promise<OAuthTokens> {
    const request = await this.issuedCode(clientId, code);
    if (redirectUri !== undefined && redirectUri !== request.redirectUri) {
      throw new InvalidGrantError(
        'redirect_uri does not match the authorization request',
      );
    }
    if (resource && request.resource && resource.href !== request.resource) {
      throw new InvalidTargetError(
        'resource does not match the authorization request',
      );
    }
    const { count } = await this.prisma.oAuthAuthorizationRequest.updateMany({
      where: { id: request.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count === 0) {
      if (request.grantId)
        await this.tokens.revokeGrant(
          request.grantId,
          'authorization code replayed',
        );
      throw new InvalidGrantError('Authorization code already used');
    }
    const grantId = await this.tokens.upsertGrant(
      request.userId!,
      request.clientId,
      request.approvedScopes,
    );
    await this.prisma.oAuthAuthorizationRequest.update({
      where: { id: request.id },
      data: { grantId },
    });
    return this.tokens.issueTokens(
      grantId,
      request.approvedScopes,
      request.resource ?? resource?.href ?? null,
    );
  }

  private async issuedCode(clientId: string, code: string) {
    const request = await this.prisma.oAuthAuthorizationRequest.findUnique({
      where: { codeHash: hashSecret(code) },
    });
    if (
      !request ||
      request.clientId !== clientId ||
      request.status !== OAuthRequestStatus.APPROVED ||
      !request.userId
    ) {
      throw new InvalidGrantError('Invalid authorization code');
    }
    if (request.consumedAt) {
      if (request.grantId)
        await this.tokens.revokeGrant(
          request.grantId,
          'authorization code replayed',
        );
      throw new InvalidGrantError('Authorization code already used');
    }
    if (
      !request.codeExpiresAt ||
      request.codeExpiresAt.getTime() <= Date.now()
    ) {
      throw new InvalidGrantError('Authorization code expired');
    }
    return request;
  }

  private async pendingRequest(requestId: string) {
    if (!(await this.platformSettings.isMcpEnabled())) {
      throw new ForbiddenException(
        'MCP access is switched off for this platform',
      );
    }
    const request = await this.prisma.oAuthAuthorizationRequest.findUnique({
      where: { id: requestId },
      include: { client: true },
    });
    if (!request) throw new NotFoundException('Sign-in request not found');
    if (request.status !== OAuthRequestStatus.PENDING)
      throw new GoneException('This sign-in request was already answered');
    if (request.expiresAt.getTime() <= Date.now())
      throw new GoneException(
        'This sign-in request expired. Start again from the app.',
      );
    return request;
  }

  private redirect(
    redirectUri: string,
    params: Record<string, string | null>,
  ): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params))
      if (value) url.searchParams.set(key, value);
    // RFC 9207: say who issued the response, so clients can spot mix-ups.
    url.searchParams.set('iss', this.urls.issuer.href);
    return url.toString();
  }
}
