import { jest } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard';
import { AccessTokensService } from '../src/access-tokens/access-tokens.service';
import { PlatformSettingsService } from '../src/platform-settings/platform-settings.service';
import { McpController } from '../src/mcp/mcp.controller';
import { McpServerFactory } from '../src/mcp/mcp-server.factory';
import { McpAuditService } from '../src/mcp/mcp-audit.service';
import { McpEnabledGuard } from '../src/mcp/guards/mcp-enabled.guard';
import { McpOriginGuard } from '../src/mcp/guards/mcp-origin.guard';
import { McpBearerGuard } from '../src/mcp/guards/mcp-bearer.guard';
import { McpOAuthUrls } from '../src/mcp-oauth/mcp-oauth.urls';
import { OAuthTokensService } from '../src/mcp-oauth/oauth-tokens.service';
import { MCP_TOOL_PROVIDERS } from '../src/mcp/mcp.types';
import { PersonasTools } from '../src/mcp/tools/personas.tools';
import { SessionsTools } from '../src/mcp/tools/sessions.tools';
import { AgentsTools } from '../src/mcp/tools/agents.tools';
import { ResourceAccessService } from '../src/auth/resource-access.service';

/**
 * /mcp over real HTTP: the Nest controller, its guards, the global JWT guard
 * it must bypass, and the SDK's own Streamable HTTP client. Domain services
 * and the database are faked; the unit specs cover them.
 */
const GOOD = 'stella_pat_' + 'a'.repeat(43);
const READ_ONLY = 'stella_pat_' + 'r'.repeat(43);
const USER = {
  userId: 'u1',
  email: 'u@x.test',
  name: 'U',
  isSystemAdmin: false,
  projectIds: ['p1'],
  projectRoles: { p1: 'OWNER' },
};

describe('/mcp (e2e)', () => {
  let app: INestApplication;
  let url: string;
  let mcpEnabled = true;
  const personas = {
    findAllForUser: jest.fn(async () => [{ id: 'pe1', name: 'Grace' }]),
    create: jest.fn(async (_u: string, dto: object) => ({ id: 'pe2', ...dto })),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const sessions = {
    create: jest.fn(async (projectId: string, dto: any) => ({
      id: 's1',
      projectId,
      name: dto.name,
      status: 'ACTIVE',
      createdAt: new Date('2026-10-26T00:00:00Z'),
    })),
    close: jest.fn(async () => ({ message: 'Session closed successfully' })),
  };
  const agents = {
    create: jest.fn(async (sessionId: string, dto: any) => ({
      id: 'a1',
      sessionId,
      name: dto.name,
      status: 'STARTING',
    })),
    remove: jest.fn(async () => ({ message: 'Agent stopped successfully' })),
  };
  const projectOf: Record<string, string> = { s1: 'p1', s9: 'p9' };
  const access = new ResourceAccessService({
    session: {
      findUnique: async ({ where }: any) =>
        projectOf[where.id] ? { projectId: projectOf[where.id] } : null,
    },
    agentInstance: {
      findUnique: async ({ where }: any) =>
        where.id === 'a1' ? { session: { projectId: 'p1' } } : null,
    },
  } as any);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        McpEnabledGuard,
        McpOriginGuard,
        McpBearerGuard,
        {
          provide: McpOAuthUrls,
          useValue: {
            resourceMetadataUrl:
              'http://localhost/.well-known/oauth-protected-resource/mcp',
          },
        },
        {
          provide: OAuthTokensService,
          useValue: { authenticateAccessToken: async () => null },
        },
        McpServerFactory,
        { provide: McpAuditService, useValue: audit },
        {
          provide: MCP_TOOL_PROVIDERS,
          useValue: [
            new PersonasTools(personas as any),
            new SessionsTools(
              {} as any,
              sessions as any,
              {} as any,
              {} as any,
              access,
            ),
            new AgentsTools(agents as any, {} as any, access),
          ],
        },
        {
          provide: PlatformSettingsService,
          useValue: { isMcpEnabled: async () => mcpEnabled },
        },
        {
          provide: AccessTokensService,
          useValue: {
            authenticate: async (secret: string) =>
              secret === GOOD
                ? {
                    user: USER,
                    tokenId: 't1',
                    scopes: ['mcp:read', 'mcp:write'],
                  }
                : secret === READ_ONLY
                  ? { user: USER, tokenId: 't2', scopes: ['mcp:read'] }
                  : null,
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (k: string) =>
              (
                ({
                  NODE_ENV: 'production',
                  PUBLIC_FRONTEND_URL: 'https://stella.example.org',
                }) as any
              )[k],
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.use(express.json());
    await app.listen(0);
    url = `${await app.getUrl()}/mcp`.replace('[::1]', 'localhost');
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mcpEnabled = true;
  });

  async function connect(secret: string) {
    const client = new Client({ name: 'e2e', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    );
    return client;
  }

  const initialize = (headers: Record<string, string> = {}, target = url) =>
    fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1' },
        },
      }),
    });

  it('lists tools, reads and writes through the SDK client', async () => {
    const client = await connect(GOOD);
    expect(client.getServerVersion()?.name).toBe('stella');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['personas_list', 'personas_create']),
    );

    const list: any = await client.callTool({
      name: 'personas_list',
      arguments: {},
    });
    expect(list.structuredContent).toEqual({
      items: [{ id: 'pe1', name: 'Grace' }],
    });

    const created: any = await client.callTool({
      name: 'personas_create',
      arguments: { name: 'Ada', systemPrompt: 'You are Ada.' },
    });
    expect(created.isError).toBeFalsy();
    expect(personas.create).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ name: 'Ada' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'personas_create', success: true }),
    );
    await client.close();
  });

  it('runs a session over HTTP: create it, start an agent, stop it, close it', async () => {
    const client = await connect(GOOD);
    const call = async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as any;

    const session = await call('sessions_create', {
      projectId: 'p1',
      name: 'Morning',
    });
    expect(session.structuredContent).toMatchObject({
      id: 's1',
      status: 'ACTIVE',
    });
    const agent = await call('agents_deploy', {
      sessionId: 's1',
      name: 'Grace',
      planId: '7b0e7b8e-6c1a-4e4f-9d37-0e6f3c1b2a11',
    });
    expect(agent.structuredContent).toMatchObject({
      id: 'a1',
      status: 'STARTING',
    });
    expect(agents.create).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        planId: '7b0e7b8e-6c1a-4e4f-9d37-0e6f3c1b2a11',
      }),
      'u1',
    );
    expect((await call('agents_stop', { agentId: 'a1' })).isError).toBeFalsy();
    expect(
      (await call('sessions_close', { sessionId: 's1' })).isError,
    ).toBeFalsy();

    // Not a member of p9: refused as not found, and nothing runs.
    const other = await call('sessions_create', { projectId: 'p9' });
    expect(JSON.parse(other.content[0].text).error.status).toBe(404);
    const otherAgent = await call('agents_deploy', {
      sessionId: 's9',
      name: 'X',
    });
    expect(JSON.parse(otherAgent.content[0].text).error.status).toBe(404);
    expect(sessions.create).toHaveBeenCalledTimes(1);
    expect(agents.create).toHaveBeenCalledTimes(1);

    for (const tool of [
      'sessions_create',
      'agents_deploy',
      'agents_stop',
      'sessions_close',
    ])
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ tool, userId: 'u1', tokenId: 't1' }),
      );
    await client.close();
  });

  it('does not let a read-only token start or stop anything', async () => {
    const client = await connect(READ_ONLY);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const tool of [
      'sessions_create',
      'sessions_close',
      'agents_deploy',
      'agents_stop',
    ])
      expect(names).not.toContain(tool);
    const res: any = await client.callTool({
      name: 'agents_deploy',
      arguments: { sessionId: 's1', name: 'Grace' },
    });
    expect(res.isError).toBe(true);
    expect(agents.create).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it('hides write tools from a read-only token', async () => {
    const client = await connect(READ_ONLY);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('personas_list');
    expect(names).not.toContain('personas_create');
    await client.close();
  });

  it('answers 404 while MCP is switched off, even with a good token', async () => {
    mcpEnabled = false;
    const res = await initialize({ Authorization: `Bearer ${GOOD}` });
    expect(res.status).toBe(404);
  });

  it('answers 401 with WWW-Authenticate for a missing or unknown token', async () => {
    const missing = await initialize();
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('Bearer');
    const unknown = await initialize({
      Authorization: 'Bearer stella_pat_unknown',
    });
    expect(unknown.status).toBe(401);
  });

  it('refuses a token in the query string', async () => {
    const res = await initialize({}, `${url}?token=${GOOD}`);
    expect(res.status).toBe(400);
  });

  it('refuses browser requests from other origins', async () => {
    const res = await initialize({
      Authorization: `Bearer ${GOOD}`,
      Origin: 'https://evil.example.com',
    });
    expect(res.status).toBe(403);
    const ours = await initialize({
      Authorization: `Bearer ${GOOD}`,
      Origin: 'https://stella.example.org',
    });
    expect(ours.status).toBe(200);
  });

  it('answers GET and DELETE with 405: the server is stateless', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${GOOD}`,
          Accept: 'text/event-stream',
        },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });
});
