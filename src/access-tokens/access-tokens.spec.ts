import { jest } from '@jest/globals';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AccessTokensService } from './access-tokens.service.js';
import {
  PAT_PREFIX,
  generatePatSecret,
  hashPatSecret,
  looksLikePat,
} from './access-token.util.js';

const USER = {
  userId: 'u1',
  email: 'u@x.test',
  name: 'U',
  isSystemAdmin: false,
  projectIds: [],
  projectRoles: {},
};

function makeService(
  opts: { mcpEnabled?: boolean; row?: any; loadError?: Error } = {},
) {
  const created: any[] = [];
  const prisma = {
    personalAccessToken: {
      create: jest.fn(async (args: any) => {
        created.push(args.data);
        return {
          id: 't1',
          revokedAt: null,
          lastUsedAt: null,
          createdAt: new Date(),
          ...args.data,
        };
      }),
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => opts.row ?? null),
      update: jest.fn(async (args: any) => ({
        id: 't1',
        name: 'n',
        displayPrefix: 'p',
        scopes: [],
        expiresAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
        revokedAt: args.data.revokedAt ?? null,
      })),
    },
  };
  const loader = {
    load: jest.fn(async () => {
      if (opts.loadError) throw opts.loadError;
      return USER;
    }),
  };
  const settings = {
    isMcpEnabled: jest.fn(async () => opts.mcpEnabled ?? true),
  };
  const service = new AccessTokensService(
    prisma as any,
    loader as any,
    settings as any,
  );
  return { service, prisma, created, loader };
}

const tokenRow = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  userId: 'u1',
  scopes: ['mcp:read'],
  expiresAt: new Date(Date.now() + 60_000),
  revokedAt: null,
  lastUsedAt: new Date(),
  ...over,
});

describe('personal access token secrets', () => {
  it('start with the prefix, carry 43 base62 characters, and differ every time', () => {
    const a = generatePatSecret();
    const b = generatePatSecret();
    expect(a).toMatch(new RegExp(`^${PAT_PREFIX}[0-9A-Za-z]{43}$`));
    expect(a).not.toBe(b);
    expect(looksLikePat(a)).toBe(true);
    expect(looksLikePat('stella_pat_short')).toBe(false);
    expect(looksLikePat('eyJhbGciOi.jwt.token')).toBe(false);
  });
});

describe('AccessTokensService', () => {
  it('returns the secret once and stores only its hash', async () => {
    const { service, created } = makeService();
    const { token, accessToken } = await service.create('u1', {
      name: ' laptop ',
    });
    expect(created[0].tokenHash).toBe(hashPatSecret(token));
    expect(JSON.stringify(created[0])).not.toContain(token);
    expect(JSON.stringify(accessToken)).not.toContain(token);
    expect(accessToken.displayPrefix).toBe(
      token.slice(0, PAT_PREFIX.length + 6),
    );
    expect(created[0].name).toBe('laptop');
  });

  it('defaults to read and write for 90 days; read access gets only mcp:read', async () => {
    const { service, created } = makeService();
    await service.create('u1', { name: 'a' });
    await service.create('u1', { name: 'b', access: 'read', expiresInDays: 7 });
    expect(created[0].scopes).toEqual(['mcp:read', 'mcp:write']);
    expect(created[1].scopes).toEqual(['mcp:read']);
    const days = (d: Date) =>
      Math.round((d.getTime() - Date.now()) / 86_400_000);
    expect(days(created[0].expiresAt)).toBe(90);
    expect(days(created[1].expiresAt)).toBe(7);
  });

  it('refuses to create tokens while MCP is switched off', async () => {
    const { service, prisma } = makeService({ mcpEnabled: false });
    await expect(service.create('u1', { name: 'a' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.personalAccessToken.create).not.toHaveBeenCalled();
  });

  it("will not revoke someone else's token", async () => {
    const { service, prisma } = makeService({
      row: { userId: 'other', revokedAt: null },
    });
    await expect(service.revoke('t1', 'u1')).rejects.toThrow(NotFoundException);
    expect(prisma.personalAccessToken.update).not.toHaveBeenCalled();
  });

  it('authenticates a live token to its owner with its scopes', async () => {
    const { service, prisma } = makeService({ row: tokenRow() });
    const secret = generatePatSecret();
    await expect(service.authenticate(secret)).resolves.toEqual({
      user: USER,
      tokenId: 't1',
      scopes: ['mcp:read'],
    });
    expect(prisma.personalAccessToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashPatSecret(secret) } }),
    );
  });

  it('rejects malformed, unknown, revoked and expired tokens', async () => {
    expect(
      await makeService({ row: tokenRow() }).service.authenticate(
        'not-a-token',
      ),
    ).toBeNull();
    expect(
      await makeService({ row: null }).service.authenticate(
        generatePatSecret(),
      ),
    ).toBeNull();
    expect(
      await makeService({
        row: tokenRow({ revokedAt: new Date() }),
      }).service.authenticate(generatePatSecret()),
    ).toBeNull();
    expect(
      await makeService({
        row: tokenRow({ expiresAt: new Date(Date.now() - 1) }),
      }).service.authenticate(generatePatSecret()),
    ).toBeNull();
  });

  it('rejects a token whose owner is no longer approved', async () => {
    const { service } = makeService({
      row: tokenRow(),
      loadError: new UnauthorizedException('pending approval'),
    });
    await expect(service.authenticate(generatePatSecret())).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('records use at most every five minutes', async () => {
    const recent = makeService({
      row: tokenRow({ lastUsedAt: new Date(Date.now() - 60_000) }),
    });
    await recent.service.authenticate(generatePatSecret());
    expect(recent.prisma.personalAccessToken.update).not.toHaveBeenCalled();

    const stale = makeService({
      row: tokenRow({ lastUsedAt: new Date(Date.now() - 10 * 60_000) }),
    });
    await stale.service.authenticate(generatePatSecret());
    expect(stale.prisma.personalAccessToken.update).toHaveBeenCalled();
  });
});
