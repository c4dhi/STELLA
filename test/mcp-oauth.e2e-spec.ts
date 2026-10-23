import { jest } from '@jest/globals';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  Injectable,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as express from 'express';
import { createServer } from 'net';
import { createHash, randomBytes } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { PrismaService } from '../src/prisma/prisma.service';
import { EncryptionService } from '../src/env-var-templates/encryption.service';
import { AuthUserLoader } from '../src/auth/auth-user.loader';
import { AccessTokensService } from '../src/access-tokens/access-tokens.service';
import { PlatformSettingsService } from '../src/platform-settings/platform-settings.service';
import { McpController } from '../src/mcp/mcp.controller';
import { McpServerFactory } from '../src/mcp/mcp-server.factory';
import { McpAuditService } from '../src/mcp/mcp-audit.service';
import { McpEnabledGuard } from '../src/mcp/guards/mcp-enabled.guard';
import { McpOriginGuard } from '../src/mcp/guards/mcp-origin.guard';
import { McpBearerGuard } from '../src/mcp/guards/mcp-bearer.guard';
import { MCP_TOOL_PROVIDERS } from '../src/mcp/mcp.types';
import { PersonasTools } from '../src/mcp/tools/personas.tools';
import { McpOAuthUrls } from '../src/mcp-oauth/mcp-oauth.urls';
import { OAuthClientsStore } from '../src/mcp-oauth/oauth-clients.store';
import { OAuthTokensService } from '../src/mcp-oauth/oauth-tokens.service';
import { OAuthAuthorizationService } from '../src/mcp-oauth/oauth-authorization.service';
import { StellaOAuthProvider } from '../src/mcp-oauth/stella-oauth.provider';
import { OAuthConsentController } from '../src/mcp-oauth/oauth-consent.controller';
import { setupMcpOAuth } from '../src/mcp-oauth/mcp-oauth.setup';
import { createInMemoryOAuthPrisma } from '../src/mcp-oauth/in-memory-prisma.fixture-spec';

/**
 * MCP sign-in over real HTTP, as Claude, ChatGPT or Claude Code would do it:
 * discovery from the 401, registration, /authorize with PKCE, the consent
 * API the STELLA page calls, the code exchange, then MCP calls. The real
 * OAuth services and SDK handlers run against an in-memory database.
 */
const USER = {
  userId: 'u1',
  email: 'u@x.test',
  name: 'U',
  isSystemAdmin: false,
  projectIds: [],
  projectRoles: {},
};
const REDIRECT = 'http://localhost:53123/callback';

// Stands in for the global JWT guard: the consent page's requests carry x-test-user.
@Injectable()
class TestUserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (req.headers['x-test-user']) req.user = USER;
    return true;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

const b64url = (b: Buffer) => b.toString('base64url');

describe('MCP sign-in (e2e)', () => {
  let app: INestApplication;
  let base: string;
  let mcpEnabled = true;
  const personas = {
    findAllForUser: jest.fn(async () => [{ id: 'pe1', name: 'Grace' }]),
  };

  beforeAll(async () => {
    const port = await freePort();
    base = `http://localhost:${port}`;
    const config = {
      get: (k: string) =>
        (
          ({
            PUBLIC_API_URL: base,
            PUBLIC_FRONTEND_URL: 'http://localhost:8180',
            NODE_ENV: 'test',
          }) as any
        )[k],
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [McpController, OAuthConsentController],
      providers: [
        { provide: APP_GUARD, useClass: TestUserGuard },
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: createInMemoryOAuthPrisma() },
        {
          provide: EncryptionService,
          useValue: {
            encrypt: (d: object) => JSON.stringify(d),
            decrypt: (s: string) => JSON.parse(s),
          },
        },
        { provide: AuthUserLoader, useValue: { load: async () => USER } },
        {
          provide: AccessTokensService,
          useValue: { authenticate: async () => null },
        },
        {
          provide: PlatformSettingsService,
          useValue: { isMcpEnabled: async () => mcpEnabled },
        },
        {
          provide: McpAuditService,
          useValue: { record: async () => undefined },
        },
        {
          provide: MCP_TOOL_PROVIDERS,
          useValue: [new PersonasTools(personas as any)],
        },
        McpOAuthUrls,
        OAuthClientsStore,
        OAuthTokensService,
        OAuthAuthorizationService,
        StellaOAuthProvider,
        McpServerFactory,
        McpEnabledGuard,
        McpOriginGuard,
        McpBearerGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    setupMcpOAuth(app);
    await app.listen(port);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mcpEnabled = true;
  });

  /** The STELLA consent page: the signed-in user clicks Allow. */
  async function allow(consentUrl: string, access = 'read_write') {
    const requestId = new URL(consentUrl).searchParams.get('request')!;
    const view = await fetch(`${base}/oauth/requests/${requestId}`, {
      headers: { 'x-test-user': '1' },
    }).then((r) => r.json());
    const res = await fetch(`${base}/oauth/requests/${requestId}/approve`, {
      method: 'POST',
      headers: { 'x-test-user': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ access }),
    });
    return {
      view,
      redirect: new URL(
        ((await res.json()) as { redirectUrl: string }).redirectUrl,
      ),
    };
  }

  it('walks the whole flow by hand: discovery, registration, consent, PKCE, MCP, refresh', async () => {
    // 1. An unauthenticated MCP call says where to sign in.
    const unauth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(unauth.status).toBe(401);
    const prmUrl = unauth.headers
      .get('www-authenticate')!
      .match(/resource_metadata="([^"]+)"/)![1];
    expect(prmUrl).toBe(`${base}/.well-known/oauth-protected-resource/mcp`);

    // 2. Metadata.
    const prm = await fetch(prmUrl).then((r) => r.json());
    expect(prm.resource).toBe(`${base}/mcp`);
    const asMeta = await fetch(
      `${base}/.well-known/oauth-authorization-server`,
    ).then((r) => r.json());
    expect(asMeta).toMatchObject({
      issuer: prm.authorization_servers[0],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });

    // 3. Dynamic registration.
    const reg = await fetch(asMeta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'E2E App',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();

    // 4. /authorize with PKCE sends the browser to the STELLA consent page.
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const authorize = new URL(asMeta.authorization_endpoint);
    Object.entries({
      response_type: 'code',
      client_id,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st8',
      scope: 'mcp:read mcp:write',
      resource: prm.resource,
    }).forEach(([k, v]) => authorize.searchParams.set(k, v));
    const toConsent = await fetch(authorize, { redirect: 'manual' });
    expect(toConsent.status).toBe(302);
    const consentUrl = toConsent.headers.get('location')!;
    expect(consentUrl).toMatch(
      /^http:\/\/localhost:8180\/oauth\/consent\?request=/,
    );

    // 5. Consent page: what the user sees, then Allow (read only).
    const { view, redirect } = await allow(consentUrl, 'read');
    expect(view).toMatchObject({
      clientName: 'E2E App',
      redirectHost: 'localhost:53123',
      verifiedBy: 'registration',
      clientIdHost: null,
    });
    expect(redirect.searchParams.get('state')).toBe('st8');
    const code = redirect.searchParams.get('code')!;

    // 6. A wrong verifier fails; the right one gets tokens.
    const exchange = (codeVerifier: string) =>
      fetch(asMeta.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          client_id,
          redirect_uri: REDIRECT,
          resource: prm.resource,
        }),
      });
    expect((await exchange(b64url(randomBytes(32)))).status).toBe(400);
    const tokenRes = await exchange(verifier);
    expect(tokenRes.status).toBe(200);
    const tokens = await tokenRes.json();
    expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'mcp:read' });

    // 7. The access token works on /mcp; read-only shows no write tools.
    const client = new Client({ name: 'e2e', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        },
      }),
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('personas_list');
    expect(names).not.toContain('personas_create');
    expect(
      (await client.callTool({ name: 'personas_list', arguments: {} })).isError,
    ).toBeFalsy();
    await client.close();

    // 8. Refresh rotates; replaying the old refresh token disconnects the app.
    const refresh = (rt: string) =>
      fetch(asMeta.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: rt,
          client_id,
        }),
      });
    const rotated = await (await refresh(tokens.refresh_token)).json();
    expect(rotated.access_token).toBeDefined();
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
    const after = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rotated.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(after.status).toBe(401);
  });

  it('works with the SDK client auth flow, the way Claude Code signs in', async () => {
    let authorizationUrl: URL | undefined;
    let clientInfo: any;
    let saved: any;
    let verifier = '';
    const provider: OAuthClientProvider = {
      redirectUrl: REDIRECT,
      clientMetadata: {
        client_name: 'SDK client',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      clientInformation: () => clientInfo,
      saveClientInformation: (info) => {
        clientInfo = info;
      },
      tokens: () => saved,
      saveTokens: (t) => {
        saved = t;
      },
      redirectToAuthorization: (url) => {
        authorizationUrl = url;
      },
      saveCodeVerifier: (v) => {
        verifier = v;
      },
      codeVerifier: () => verifier,
    };
    const transport = new StreamableHTTPClientTransport(
      new URL(`${base}/mcp`),
      { authProvider: provider },
    );
    const client = new Client({ name: 'sdk', version: '1' });
    await expect(client.connect(transport)).rejects.toThrow();
    expect(authorizationUrl).toBeDefined();

    // The browser opens /authorize, lands on the consent page, the user allows.
    const toConsent = await fetch(authorizationUrl!, { redirect: 'manual' });
    const { redirect } = await allow(toConsent.headers.get('location')!);
    await transport.finishAuth(redirect.searchParams.get('code')!);

    const connected = new Client({ name: 'sdk', version: '1' });
    await connected.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        authProvider: provider,
      }),
    );
    expect((await connected.listTools()).tools.map((t) => t.name)).toContain(
      'personas_list',
    );
    await connected.close();

    // It shows up in Settings → MCP Access, and disconnecting it locks it out.
    const apps = await fetch(`${base}/me/connected-apps`, {
      headers: { 'x-test-user': '1' },
    }).then((r) => r.json());
    const app = apps.find((a: any) => a.clientName === 'SDK client');
    expect(app).toBeDefined();
    expect(
      (
        await fetch(`${base}/me/connected-apps/${app.id}`, {
          method: 'DELETE',
          headers: { 'x-test-user': '1' },
        })
      ).status,
    ).toBe(204);
    const locked = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${saved.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(locked.status).toBe(401);
  });

  it('hides every sign-in endpoint while MCP is switched off', async () => {
    mcpEnabled = false;
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource/mcp',
      '/authorize?client_id=x',
    ]) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect(
      (
        await fetch(`${base}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(404);
  });

  it('refuses consent without a signed-in STELLA user', async () => {
    const res = await fetch(`${base}/oauth/requests/whatever/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access: 'read' }),
    });
    expect(res.status).toBe(403);
  });
});
