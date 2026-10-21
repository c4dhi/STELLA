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
import { PatAuthGuard } from '../src/mcp/guards/pat-auth.guard';
import { MCP_TOOL_PROVIDERS } from '../src/mcp/mcp.types';
import { PersonasTools } from '../src/mcp/tools/personas.tools';

/**
 * /mcp over real HTTP: the Nest controller, its guards, the global JWT guard
 * it must bypass, and the SDK's own Streamable HTTP client. Domain services
 * and the database are faked; the unit specs cover them.
 */
const GOOD = 'stella_pat_' + 'a'.repeat(43);
const READ_ONLY = 'stella_pat_' + 'r'.repeat(43);
const USER = { userId: 'u1', email: 'u@x.test', name: 'U', isSystemAdmin: false, projectIds: [], projectRoles: {} };

describe('/mcp (e2e)', () => {
  let app: INestApplication;
  let url: string;
  let mcpEnabled = true;
  const personas = {
    findAllForUser: jest.fn(async () => [{ id: 'pe1', name: 'Grace' }]),
    create: jest.fn(async (_u: string, dto: object) => ({ id: 'pe2', ...dto })),
  };
  const audit = { record: jest.fn(async () => undefined) };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        McpEnabledGuard,
        McpOriginGuard,
        PatAuthGuard,
        McpServerFactory,
        { provide: McpAuditService, useValue: audit },
        { provide: MCP_TOOL_PROVIDERS, useValue: [new PersonasTools(personas as any)] },
        { provide: PlatformSettingsService, useValue: { isMcpEnabled: async () => mcpEnabled } },
        {
          provide: AccessTokensService,
          useValue: {
            authenticate: async (secret: string) =>
              secret === GOOD
                ? { user: USER, tokenId: 't1', scopes: ['mcp:read', 'mcp:write'] }
                : secret === READ_ONLY
                  ? { user: USER, tokenId: 't2', scopes: ['mcp:read'] }
                  : null,
          },
        },
        { provide: ConfigService, useValue: { get: (k: string) => ({ NODE_ENV: 'production', PUBLIC_FRONTEND_URL: 'https://stella.example.org' } as any)[k] } },
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
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${secret}` } } }),
    );
    return client;
  }

  const initialize = (headers: Record<string, string> = {}, target = url) =>
    fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
      }),
    });

  it('lists tools, reads and writes through the SDK client', async () => {
    const client = await connect(GOOD);
    expect(client.getServerVersion()?.name).toBe('stella');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['personas_list', 'personas_create']));

    const list: any = await client.callTool({ name: 'personas_list', arguments: {} });
    expect(list.structuredContent).toEqual({ items: [{ id: 'pe1', name: 'Grace' }] });

    const created: any = await client.callTool({ name: 'personas_create', arguments: { name: 'Ada', systemPrompt: 'You are Ada.' } });
    expect(created.isError).toBeFalsy();
    expect(personas.create).toHaveBeenCalledWith('u1', expect.objectContaining({ name: 'Ada' }));
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ tool: 'personas_create', success: true }));
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
    const unknown = await initialize({ Authorization: 'Bearer stella_pat_unknown' });
    expect(unknown.status).toBe(401);
  });

  it('refuses a token in the query string', async () => {
    const res = await initialize({}, `${url}?token=${GOOD}`);
    expect(res.status).toBe(400);
  });

  it('refuses browser requests from other origins', async () => {
    const res = await initialize({ Authorization: `Bearer ${GOOD}`, Origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
    const ours = await initialize({ Authorization: `Bearer ${GOOD}`, Origin: 'https://stella.example.org' });
    expect(ours.status).toBe(200);
  });

  it('answers GET and DELETE with 405: the server is stateless', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(url, { method, headers: { Authorization: `Bearer ${GOOD}`, Accept: 'text/event-stream' } });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });
});
