import { jest } from '@jest/globals';
import { GoneException } from '@nestjs/common';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createInMemoryOAuthPrisma } from './in-memory-prisma.fixture-spec.js';
import { McpOAuthUrls } from './mcp-oauth.urls.js';
import {
  OAuthClientsStore,
  isAllowedRedirectUri,
} from './oauth-clients.store.js';
import { OAuthTokensService } from './oauth-tokens.service.js';
import { OAuthAuthorizationService } from './oauth-authorization.service.js';
import {
  CimdError,
  fetchClientMetadataDocument,
  isPublicAddress,
} from './cimd-fetcher.js';

const USER = {
  userId: 'u1',
  email: 'u@x.test',
  name: 'U',
  isSystemAdmin: false,
  projectIds: [],
  projectRoles: {},
};
const API = 'https://backend.stella.example';
const MCP = `${API}/mcp`;

function setup(opts: { mcpEnabled?: boolean } = {}) {
  const prisma = createInMemoryOAuthPrisma();
  const urls = new McpOAuthUrls({
    get: (k: string) =>
      (
        ({
          PUBLIC_API_URL: API,
          PUBLIC_FRONTEND_URL: 'https://stella.example',
        }) as any
      )[k],
  } as any);
  const encryption = {
    encrypt: (d: object) => `enc:${JSON.stringify(d)}`,
    decrypt: (s: string) => JSON.parse(s.slice(4)),
  };
  const store = new OAuthClientsStore(prisma as any, encryption as any);
  const tokens = new OAuthTokensService(
    prisma as any,
    { load: jest.fn(async () => USER) } as any,
    urls,
  );
  const authorization = new OAuthAuthorizationService(
    prisma as any,
    tokens,
    { isMcpEnabled: jest.fn(async () => opts.mcpEnabled ?? true) } as any,
    urls,
  );
  return { prisma, urls, store, tokens, authorization };
}

async function registerClient(
  store: OAuthClientsStore,
  over: Record<string, unknown> = {},
) {
  return store.registerClient({
    client_id: 'c1',
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
    ...over,
  } as any);
}

/** Runs /authorize → consent → code, as the HTTP flow would. */
async function approvedCode(
  s: ReturnType<typeof setup>,
  access: 'read' | 'read_write' = 'read_write',
  scopes?: string[],
) {
  const client = await s.store.getClient('c1');
  const consentUrl = await s.authorization.createRequest(client!, {
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    codeChallenge: 'challenge',
    state: 'xyz',
    scopes,
    resource: new URL(MCP),
  });
  const requestId = new URL(consentUrl).searchParams.get('request')!;
  const { redirectUrl } = await s.authorization.approve(
    requestId,
    'u1',
    access,
  );
  return { requestId, consentUrl, redirect: new URL(redirectUrl) };
}

describe('client registration (DCR)', () => {
  it('accepts https and loopback redirect URIs, nothing else', () => {
    expect(
      isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback'),
    ).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:53123/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:8080/cb')).toBe(true);
    expect(isAllowedRedirectUri('http://evil.example/cb')).toBe(false);
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isAllowedRedirectUri('https://x.example/cb#frag')).toBe(false);
  });

  it('refuses a client with a bad redirect URI', async () => {
    const { store } = setup();
    await expect(
      registerClient(store, { redirect_uris: ['http://evil.example/cb'] }),
    ).rejects.toThrow(InvalidClientMetadataError);
  });

  it('stores the secret encrypted and gives it back to the token endpoint', async () => {
    const { store, prisma } = setup();
    await registerClient(store, {
      token_endpoint_auth_method: 'client_secret_post',
      client_secret: 's3cret',
    });
    expect(JSON.stringify(prisma.oAuthClient.rows[0])).not.toContain(
      '"s3cret"',
    );
    expect((await store.getClient('c1'))?.client_secret).toBe('s3cret');
  });
});

describe('sign-in and code exchange', () => {
  it('sends the user to the consent page, then back to the app with a code, state and issuer', async () => {
    const s = setup();
    await registerClient(s.store);
    const { consentUrl, redirect } = await approvedCode(s);
    expect(consentUrl).toMatch(
      /^https:\/\/stella\.example\/oauth\/consent\?request=/,
    );
    expect(redirect.origin + redirect.pathname).toBe(
      'https://claude.ai/api/mcp/auth_callback',
    );
    expect(redirect.searchParams.get('code')).toMatch(/^stella_oac_/);
    expect(redirect.searchParams.get('state')).toBe('xyz');
    expect(redirect.searchParams.get('iss')).toBe(`${API}/`);
  });

  it('exchanges the code once for tokens bound to the approved access', async () => {
    const s = setup();
    await registerClient(s.store);
    const { redirect } = await approvedCode(s, 'read');
    const code = redirect.searchParams.get('code')!;
    expect(await s.authorization.challengeFor('c1', code)).toBe('challenge');
    const tokens = await s.authorization.exchange(
      'c1',
      code,
      'https://claude.ai/api/mcp/auth_callback',
      new URL(MCP),
    );
    expect(tokens.access_token).toMatch(/^stella_oat_/);
    expect(tokens.refresh_token).toMatch(/^stella_ort_/);
    expect(tokens.scope).toBe('mcp:read');
    await expect(
      s.tokens.authenticateAccessToken(tokens.access_token),
    ).resolves.toMatchObject({
      user: USER,
      scopes: ['mcp:read'],
      clientName: 'Claude',
    });
  });

  it('rejects a code used by another client, with another redirect URI, or twice', async () => {
    const s = setup();
    await registerClient(s.store);
    const { redirect } = await approvedCode(s);
    const code = redirect.searchParams.get('code')!;
    await expect(
      s.authorization.exchange('other', code, undefined, undefined),
    ).rejects.toThrow(InvalidGrantError);
    await expect(
      s.authorization.exchange(
        'c1',
        code,
        'https://evil.example/cb',
        undefined,
      ),
    ).rejects.toThrow(InvalidGrantError);
    const tokens = await s.authorization.exchange(
      'c1',
      code,
      undefined,
      undefined,
    );
    await expect(
      s.authorization.exchange('c1', code, undefined, undefined),
    ).rejects.toThrow(InvalidGrantError);
    // A replayed code means it leaked: what it bought is revoked.
    await expect(
      s.tokens.authenticateAccessToken(tokens.access_token),
    ).resolves.toBeNull();
  });

  it('tells the consent page whether the app name was checked', async () => {
    const s = setup();
    await registerClient(s.store);
    const client = (await s.store.getClient('c1'))!;
    const base = {
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: 'c',
    };
    const dcrUrl = await s.authorization.createRequest(client, base);
    await expect(
      s.authorization.view(new URL(dcrUrl).searchParams.get('request')!),
    ).resolves.toMatchObject({
      verifiedBy: 'registration',
      clientIdHost: null,
    });

    const cimdId = 'https://claude.ai/oauth/mcp-client.json';
    s.prisma.oAuthClient.rows.push({
      ...s.prisma.oAuthClient.rows[0],
      id: cimdId,
      source: 'CIMD',
    });
    const cimdUrl = await s.authorization.createRequest(
      { ...client, client_id: cimdId },
      base,
    );
    await expect(
      s.authorization.view(new URL(cimdUrl).searchParams.get('request')!),
    ).resolves.toMatchObject({
      verifiedBy: 'metadata_document',
      clientIdHost: 'claude.ai',
    });
  });

  it('refuses unknown scopes and tokens for another resource', async () => {
    const s = setup();
    await registerClient(s.store);
    const client = (await s.store.getClient('c1'))!;
    const base = {
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: 'c',
    };
    await expect(
      s.authorization.createRequest(client, { ...base, scopes: ['admin'] }),
    ).rejects.toThrow(InvalidScopeError);
    await expect(
      s.authorization.createRequest(client, {
        ...base,
        resource: new URL('https://other.example/mcp'),
      }),
    ).rejects.toThrow(InvalidTargetError);
  });

  it('lets a request be answered once, and not after it expired', async () => {
    const s = setup();
    await registerClient(s.store);
    const { requestId } = await approvedCode(s);
    await expect(s.authorization.deny(requestId, 'u1')).rejects.toThrow(
      GoneException,
    );

    const client = (await s.store.getClient('c1'))!;
    const url = await s.authorization.createRequest(client, {
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: 'c',
    });
    const id = new URL(url).searchParams.get('request')!;
    s.prisma.oAuthAuthorizationRequest.rows.find(
      (r) => r.id === id,
    )!.expiresAt = new Date(Date.now() - 1);
    await expect(s.authorization.view(id)).rejects.toThrow(GoneException);
  });

  it('sends a denial back to the app as access_denied', async () => {
    const s = setup();
    await registerClient(s.store);
    const client = (await s.store.getClient('c1'))!;
    const url = await s.authorization.createRequest(client, {
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: 'c',
      state: 's1',
    });
    const { redirectUrl } = await s.authorization.deny(
      new URL(url).searchParams.get('request')!,
      'u1',
    );
    const back = new URL(redirectUrl);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('s1');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('refuses consent while MCP is switched off', async () => {
    const s = setup({ mcpEnabled: false });
    await registerClient(s.store);
    const client = (await s.store.getClient('c1'))!;
    const url = await s.authorization.createRequest(client, {
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: 'c',
    });
    await expect(
      s.authorization.view(new URL(url).searchParams.get('request')!),
    ).rejects.toThrow('switched off');
  });
});

describe('tokens', () => {
  async function connected(s: ReturnType<typeof setup>) {
    await registerClient(s.store);
    const { redirect } = await approvedCode(s);
    return s.authorization.exchange(
      'c1',
      redirect.searchParams.get('code')!,
      undefined,
      new URL(MCP),
    );
  }

  it('rotates refresh tokens, and a reused one disconnects the app', async () => {
    const s = setup();
    const first = await connected(s);
    const second = await s.tokens.refresh(
      'c1',
      first.refresh_token!,
      undefined,
      undefined,
    );
    expect(second.access_token).not.toBe(first.access_token);
    await expect(
      s.tokens.refresh('c1', first.refresh_token!, undefined, undefined),
    ).rejects.toThrow(InvalidGrantError);
    await expect(
      s.tokens.authenticateAccessToken(second.access_token),
    ).resolves.toBeNull();
    await expect(
      s.tokens.refresh('c1', second.refresh_token!, undefined, undefined),
    ).rejects.toThrow(InvalidGrantError);
  });

  it('cannot widen access on refresh', async () => {
    const s = setup();
    await registerClient(s.store);
    const { redirect } = await approvedCode(s, 'read');
    const tokens = await s.authorization.exchange(
      'c1',
      redirect.searchParams.get('code')!,
      undefined,
      undefined,
    );
    await expect(
      s.tokens.refresh(
        'c1',
        tokens.refresh_token!,
        ['mcp:read', 'mcp:write'],
        undefined,
      ),
    ).rejects.toThrow(InvalidScopeError);
  });

  it('keeps a narrower scope asked for on refresh', async () => {
    const s = setup();
    const first = await connected(s);
    const narrowed = await s.tokens.refresh(
      'c1',
      first.refresh_token!,
      ['mcp:read'],
      undefined,
    );
    expect(narrowed.scope).toBe('mcp:read');
    expect(
      (await s.tokens.authenticateAccessToken(narrowed.access_token))?.scopes,
    ).toEqual(['mcp:read']);
    // A later refresh without a scope stays narrow.
    const next = await s.tokens.refresh(
      'c1',
      narrowed.refresh_token!,
      undefined,
      undefined,
    );
    expect(
      (await s.tokens.authenticateAccessToken(next.access_token))?.scopes,
    ).toEqual(['mcp:read']);
  });

  it('caps a token at its grant, and falls back to the grant for tokens without scopes', async () => {
    const s = setup();
    const tokens = await connected(s);
    const grant = s.prisma.oAuthGrant.rows[0];
    grant.scopes = ['mcp:read'];
    expect(
      (await s.tokens.authenticateAccessToken(tokens.access_token))?.scopes,
    ).toEqual(['mcp:read']);
    s.prisma.oAuthToken.rows.forEach((r) => (r.scopes = []));
    grant.scopes = ['mcp:read', 'mcp:write'];
    expect(
      (await s.tokens.authenticateAccessToken(tokens.access_token))?.scopes,
    ).toEqual(['mcp:read', 'mcp:write']);
  });

  it('refuses an access token issued for another resource', async () => {
    const s = setup();
    await connected(s);
    const grantId = s.prisma.oAuthGrant.rows[0].id;
    const own = await s.tokens.issueTokens(grantId, ['mcp:read'], MCP);
    const foreign = await s.tokens.issueTokens(
      grantId,
      ['mcp:read'],
      'https://other.example/mcp',
    );
    expect(
      await s.tokens.authenticateAccessToken(own.access_token),
    ).not.toBeNull();
    expect(
      await s.tokens.authenticateAccessToken(foreign.access_token),
    ).toBeNull();
  });

  it('stops expired access tokens and tokens of a disconnected app', async () => {
    const s = setup();
    const tokens = await connected(s);
    expect(
      await s.tokens.authenticateAccessToken(tokens.access_token),
    ).not.toBeNull();
    s.prisma.oAuthToken.rows.forEach(
      (r) => (r.expiresAt = new Date(Date.now() - 1)),
    );
    expect(
      await s.tokens.authenticateAccessToken(tokens.access_token),
    ).toBeNull();

    const again = await connected(s);
    const [app] = await s.tokens.listConnectedApps('u1');
    expect(app).toMatchObject({
      clientName: 'Claude',
      scopes: ['mcp:read', 'mcp:write'],
    });
    await expect(s.tokens.disconnect(app.id, 'someone-else')).rejects.toThrow(
      'not found',
    );
    await s.tokens.disconnect(app.id, 'u1');
    expect(
      await s.tokens.authenticateAccessToken(again.access_token),
    ).toBeNull();
    expect(await s.tokens.listConnectedApps('u1')).toEqual([]);
  });

  it('only accepts its own token format', async () => {
    const s = setup();
    expect(
      await s.tokens.authenticateAccessToken('stella_pat_whatever'),
    ).toBeNull();
  });
});

describe('Client ID Metadata Documents', () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    ...over,
  });
  const deps = (
    body: unknown,
    opts: { address?: string; status?: number } = {},
  ) => ({
    lookup: jest.fn(async () => [{ address: opts.address ?? '160.79.104.10' }]),
    fetch: jest.fn(
      async () =>
        new Response(JSON.stringify(body), { status: opts.status ?? 200 }),
    ) as any,
  });
  const url = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

  it('knows public from private addresses', () => {
    for (const a of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      'fd00::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPublicAddress(a)).toBe(false);
    }
    expect(isPublicAddress('160.79.104.10')).toBe(true);
    expect(isPublicAddress('2607:6bc0::10')).toBe(true);
  });

  it('accepts a document that names itself', async () => {
    await expect(
      fetchClientMetadataDocument(url, deps(doc())),
    ).resolves.toMatchObject({ client_name: 'Claude' });
  });

  it('refuses http, private hosts, a wrong client_id, errors and oversize documents', async () => {
    await expect(
      fetchClientMetadataDocument('http://claude.ai/x', deps(doc())),
    ).rejects.toThrow(CimdError);
    await expect(
      fetchClientMetadataDocument(url, deps(doc(), { address: '10.1.2.3' })),
    ).rejects.toThrow('not public');
    await expect(
      fetchClientMetadataDocument(
        url,
        deps(doc({ client_id: 'https://evil.example/x' })),
      ),
    ).rejects.toThrow('name itself');
    await expect(
      fetchClientMetadataDocument(url, deps(doc(), { status: 404 })),
    ).rejects.toThrow('404');
    await expect(
      fetchClientMetadataDocument(
        url,
        deps(doc({ client_name: 'x'.repeat(70_000) })),
      ),
    ).rejects.toThrow('too large');
  });

  it('caches a fetched client as a public client and refuses bad redirect URIs', async () => {
    const s = setup();
    s.store.cimdDeps = deps(doc());
    const client = await s.store.getClient(url);
    expect(client).toMatchObject({
      client_id: url,
      token_endpoint_auth_method: 'none',
    });
    expect(s.prisma.oAuthClient.rows[0]).toMatchObject({
      source: 'CIMD',
      name: 'Claude',
    });

    const bad = setup();
    bad.store.cimdDeps = deps(
      doc({ redirect_uris: ['http://evil.example/cb'] }),
    );
    await expect(bad.store.getClient(url)).resolves.toBeUndefined();
  });
});
