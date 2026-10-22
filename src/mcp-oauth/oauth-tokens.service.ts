import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OAuthTokenKind } from '@prisma/client';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthUser, AuthUserLoader } from '../auth/auth-user.loader.js';
import { PatScope } from '../access-tokens/access-token.util.js';
import {
  generateSecret,
  hashSecret,
} from '../access-tokens/access-token.util.js';
import {
  ACCESS_TOKEN_PREFIX,
  ACCESS_TOKEN_TTL_MS,
  OAUTH_SCOPES,
  REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_MS,
} from './mcp-oauth.constants.js';
import { McpOAuthUrls } from './mcp-oauth.urls.js';

const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;
// Unused self-registered clients are dropped after this long.
const UNUSED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthenticatedGrant {
  user: AuthUser;
  grantId: string;
  clientName: string;
  scopes: PatScope[];
}

/** An app the user connected, as shown in Settings → MCP Access. */
export interface ConnectedApp {
  id: string;
  clientName: string;
  clientUri: string | null;
  scopes: string[];
  connectedAt: string;
  lastUsedAt: string | null;
}

const knownScopes = (scopes: string[]): PatScope[] =>
  scopes.filter((s): s is PatScope =>
    (OAUTH_SCOPES as readonly string[]).includes(s),
  );

/**
 * What a token allows: its own scopes, capped by its grant (the user may have
 * narrowed the grant since). Tokens from before tokens carried scopes have
 * none and get the grant's.
 */
const tokenScopes = (token: string[], grant: string[]): string[] =>
  token.length ? token.filter((s) => grant.includes(s)) : grant;

/**
 * Grants and the tokens issued under them (#772 sign-in). A grant is one
 * user's consent for one app; tokens are opaque, stored as sha256, and die
 * with their grant.
 */
@Injectable()
export class OAuthTokensService {
  private readonly logger = new Logger(OAuthTokensService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authUserLoader: AuthUserLoader,
    private readonly urls: McpOAuthUrls,
  ) {}

  /** The user's grant for this app, widened or narrowed to what they just approved. */
  async upsertGrant(
    userId: string,
    clientId: string,
    scopes: string[],
  ): Promise<string> {
    const existing = await this.prisma.oAuthGrant.findFirst({
      where: { userId, clientId, revokedAt: null },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.oAuthGrant.update({
        where: { id: existing.id },
        data: { scopes },
      });
      return existing.id;
    }
    const grant = await this.prisma.oAuthGrant.create({
      data: { userId, clientId, scopes },
      select: { id: true },
    });
    return grant.id;
  }

  async issueTokens(
    grantId: string,
    scopes: string[],
    resource: string | null,
  ): Promise<OAuthTokens> {
    const access = generateSecret(ACCESS_TOKEN_PREFIX);
    const refresh = generateSecret(REFRESH_TOKEN_PREFIX);
    const now = Date.now();
    await this.prisma.oAuthToken.createMany({
      data: [
        {
          grantId,
          kind: OAuthTokenKind.ACCESS,
          tokenHash: hashSecret(access),
          resource,
          scopes,
          expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
        },
        {
          grantId,
          kind: OAuthTokenKind.REFRESH,
          tokenHash: hashSecret(refresh),
          resource,
          scopes,
          expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
        },
      ],
    });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  /**
   * Refresh-token rotation: each refresh token works once. Presenting one
   * that was already used means it leaked, so the whole grant is revoked.
   */
  async refresh(
    clientId: string,
    refreshToken: string,
    requestedScopes: string[] | undefined,
    resource: URL | undefined,
  ): Promise<OAuthTokens> {
    const row = await this.prisma.oAuthToken.findUnique({
      where: { tokenHash: hashSecret(refreshToken) },
      include: { grant: true },
    });
    if (
      !row ||
      row.kind !== OAuthTokenKind.REFRESH ||
      row.grant.clientId !== clientId
    ) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    if (row.grant.revokedAt)
      throw new InvalidGrantError('This app was disconnected');
    if (row.rotatedAt) {
      await this.revokeGrant(row.grantId, 'refresh token reused');
      throw new InvalidGrantError(
        'Refresh token already used; the connection was revoked',
      );
    }
    if (row.expiresAt.getTime() <= Date.now())
      throw new InvalidGrantError('Refresh token expired');
    if (resource && !this.urls.isOwnResource(resource))
      throw new InvalidTargetError('Unknown resource');

    // No scope asked for keeps what this refresh token had (RFC 6749 §6).
    const scopes = requestedScopes?.length
      ? requestedScopes
      : tokenScopes(row.scopes, row.grant.scopes);
    if (!scopes.every((s) => row.grant.scopes.includes(s))) {
      throw new InvalidScopeError('Cannot widen access on refresh');
    }
    const { count } = await this.prisma.oAuthToken.updateMany({
      where: { id: row.id, rotatedAt: null },
      data: { rotatedAt: new Date() },
    });
    if (count === 0) {
      // Lost a race with another use of the same token: treat it as reuse.
      await this.revokeGrant(row.grantId, 'refresh token reused');
      throw new InvalidGrantError(
        'Refresh token already used; the connection was revoked',
      );
    }
    return this.issueTokens(row.grantId, scopes, row.resource);
  }

  /**
   * Resolve an access token for /mcp, or null if it is unknown, expired,
   * revoked, or was issued for a different resource.
   */
  async authenticateAccessToken(
    token: string,
  ): Promise<AuthenticatedGrant | null> {
    if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null;
    const row = await this.prisma.oAuthToken.findUnique({
      where: { tokenHash: hashSecret(token) },
      include: { grant: { include: { client: { select: { name: true } } } } },
    });
    if (!row || row.kind !== OAuthTokenKind.ACCESS) return null;
    if (row.grant.revokedAt || row.expiresAt.getTime() <= Date.now())
      return null;
    if (!this.urls.isOwnResource(row.resource)) return null;

    const user = await this.authUserLoader.load(row.grant.userId);
    const lastUsed = row.grant.lastUsedAt?.getTime() ?? 0;
    if (Date.now() - lastUsed > LAST_USED_WRITE_INTERVAL_MS) {
      this.prisma.oAuthGrant
        .update({
          where: { id: row.grantId },
          data: { lastUsedAt: new Date() },
        })
        .catch((error) =>
          this.logger.warn(
            `Could not record use of grant ${row.grantId}: ${error.message}`,
          ),
        );
    }
    return {
      user,
      grantId: row.grantId,
      clientName: row.grant.client.name,
      scopes: knownScopes(tokenScopes(row.scopes, row.grant.scopes)),
    };
  }

  /** RFC 7009. Revoking a refresh token disconnects the app; an access token just stops working. */
  async revokeToken(clientId: string, token: string): Promise<void> {
    const row = await this.prisma.oAuthToken.findUnique({
      where: { tokenHash: hashSecret(token) },
      include: { grant: true },
    });
    // Unknown tokens are not an error (RFC 7009 §2.2).
    if (!row || row.grant.clientId !== clientId) return;
    if (row.kind === OAuthTokenKind.REFRESH) {
      await this.revokeGrant(row.grantId, 'revoked by the app');
    } else {
      await this.prisma.oAuthToken.update({
        where: { id: row.id },
        data: { expiresAt: new Date() },
      });
    }
  }

  async revokeGrant(grantId: string, reason: string): Promise<void> {
    await this.prisma.oAuthGrant.updateMany({
      where: { id: grantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.logger.log(`Revoked OAuth grant ${grantId}: ${reason}`);
  }

  async listConnectedApps(userId: string): Promise<ConnectedApp[]> {
    const grants = await this.prisma.oAuthGrant.findMany({
      where: { userId, revokedAt: null },
      include: { client: { select: { name: true, metadata: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return grants.map((g) => ({
      id: g.id,
      clientName: g.client.name,
      clientUri:
        (g.client.metadata as { client_uri?: string } | null)?.client_uri ??
        null,
      scopes: g.scopes,
      connectedAt: g.createdAt.toISOString(),
      lastUsedAt: g.lastUsedAt?.toISOString() ?? null,
    }));
  }

  async disconnect(grantId: string, userId: string): Promise<void> {
    const grant = await this.prisma.oAuthGrant.findUnique({
      where: { id: grantId },
      select: { userId: true },
    });
    if (!grant || grant.userId !== userId)
      throw new NotFoundException('Connected app not found');
    await this.revokeGrant(grantId, `disconnected by user ${userId}`);
  }

  /** Drop what can never be used again, and self-registered apps nobody connected. */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeExpired(): Promise<void> {
    const now = new Date();
    const tokens = await this.prisma.oAuthToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    const requests = await this.prisma.oAuthAuthorizationRequest.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    const clients = await this.prisma.oAuthClient.deleteMany({
      where: {
        createdAt: { lt: new Date(now.getTime() - UNUSED_CLIENT_TTL_MS) },
        grants: { none: {} },
      },
    });
    this.logger.log(
      `Purged ${tokens.count} expired tokens, ${requests.count} old sign-in requests, ${clients.count} unused apps`,
    );
  }
}
