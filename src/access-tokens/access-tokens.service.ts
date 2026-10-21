import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuthUser, AuthUserLoader } from '../auth/auth-user.loader.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import { CreateAccessTokenDto } from './dto/create-access-token.dto.js';
import {
  PatScope,
  displayPrefixOf,
  generatePatSecret,
  hashPatSecret,
  looksLikePat,
} from './access-token.util.js';

const DEFAULT_EXPIRY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
// lastUsedAt is for the owner's eyes; writing it on every call would cost a
// write per MCP request for nothing.
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/** A token as its owner sees it. The hash never leaves this service. */
export interface AccessTokenView {
  id: string;
  name: string;
  displayPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface AuthenticatedToken {
  user: AuthUser;
  tokenId: string;
  scopes: PatScope[];
}

const VIEW_SELECT = {
  id: true,
  name: true,
  displayPrefix: true,
  scopes: true,
  expiresAt: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

function toView(row: {
  id: string;
  name: string;
  displayPrefix: string;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}): AccessTokenView {
  return {
    id: row.id,
    name: row.name,
    displayPrefix: row.displayPrefix,
    scopes: row.scopes,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Personal access tokens (#772): how an AI client reaches /mcp as a user.
 * The secret is returned once, by create(); only its sha256 is stored.
 */
@Injectable()
export class AccessTokensService {
  private readonly logger = new Logger(AccessTokensService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authUserLoader: AuthUserLoader,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  async create(
    userId: string,
    dto: CreateAccessTokenDto,
  ): Promise<{ token: string; accessToken: AccessTokenView }> {
    if (!(await this.platformSettings.isMcpEnabled())) {
      throw new ForbiddenException(
        'MCP access is switched off for this platform',
      );
    }
    const secret = generatePatSecret();
    const scopes: PatScope[] =
      dto.access === 'read' ? ['mcp:read'] : ['mcp:read', 'mcp:write'];
    const days = dto.expiresInDays ?? DEFAULT_EXPIRY_DAYS;
    const row = await this.prisma.personalAccessToken.create({
      data: {
        userId,
        name: dto.name.trim(),
        displayPrefix: displayPrefixOf(secret),
        tokenHash: hashPatSecret(secret),
        scopes,
        expiresAt: new Date(Date.now() + days * DAY_MS),
      },
      select: VIEW_SELECT,
    });
    this.logger.log(
      `User ${userId} created access token ${row.id} (${scopes.join(', ')}, ${days} days)`,
    );
    return { token: secret, accessToken: toView(row) };
  }

  async list(userId: string): Promise<AccessTokenView[]> {
    const rows = await this.prisma.personalAccessToken.findMany({
      where: { userId },
      select: VIEW_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toView);
  }

  /** Revoking keeps the row, so the audit log still names the token. */
  async revoke(id: string, userId: string): Promise<AccessTokenView> {
    const existing = await this.prisma.personalAccessToken.findUnique({
      where: { id },
      select: { userId: true, revokedAt: true },
    });
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException('Access token not found');
    }
    const row = await this.prisma.personalAccessToken.update({
      where: { id },
      data: { revokedAt: existing.revokedAt ?? new Date() },
      select: VIEW_SELECT,
    });
    this.logger.log(`User ${userId} revoked access token ${id}`);
    return toView(row);
  }

  /**
   * Resolve a presented secret to its owner, or null when it is malformed,
   * unknown, revoked or expired. The owner must still be an approved user
   * (AuthUserLoader throws otherwise).
   */
  async authenticate(secret: string): Promise<AuthenticatedToken | null> {
    if (!looksLikePat(secret)) return null;
    const row = await this.prisma.personalAccessToken.findUnique({
      where: { tokenHash: hashPatSecret(secret) },
      select: {
        id: true,
        userId: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
      },
    });
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

    const user = await this.authUserLoader.load(row.userId);

    if (
      !row.lastUsedAt ||
      Date.now() - row.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS
    ) {
      // Not awaited into the request's outcome: a failed bookkeeping write must not refuse the call.
      this.prisma.personalAccessToken
        .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
        .catch((error) =>
          this.logger.warn(
            `Could not record use of token ${row.id}: ${error.message}`,
          ),
        );
    }

    return {
      user,
      tokenId: row.id,
      scopes: row.scopes.filter(
        (s): s is PatScope => s === 'mcp:read' || s === 'mcp:write',
      ),
    };
  }
}
