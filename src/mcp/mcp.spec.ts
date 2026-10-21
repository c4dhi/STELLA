import { jest } from '@jest/globals';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceAccessService } from '../auth/resource-access.service.js';
import { McpServerFactory } from './mcp-server.factory.js';
import { McpAuthContext } from './mcp.types.js';
import { summarizeToolArgs } from './mcp-audit.util.js';
import { PatAuthGuard } from './guards/pat-auth.guard.js';
import { McpOriginGuard } from './guards/mcp-origin.guard.js';
import { CatalogTools } from './tools/catalog.tools.js';
import { PersonasTools } from './tools/personas.tools.js';
import { PlanTemplatesTools } from './tools/plan-templates.tools.js';
import { AgentConfigurationsTools } from './tools/agent-configurations.tools.js';
import { SessionsTools } from './tools/sessions.tools.js';
import { CreatePersonaDto } from '../personas/dto/create-persona.dto.js';

const USER = { userId: 'u1', email: 'u@x.test', name: 'U', isSystemAdmin: false, projectIds: ['p1'], projectRoles: { p1: 'OWNER' as const } };
const READ: McpAuthContext = { user: USER, tokenId: 't1', scopes: ['mcp:read'] };
const READ_WRITE: McpAuthContext = { user: USER, tokenId: 't1', scopes: ['mcp:read', 'mcp:write'] };

function setup() {
  const personas = {
    findAllForUser: jest.fn(async () => [{ id: 'pe1', name: 'Grace' }]),
    findOne: jest.fn(async (id: string) => {
      if (id === 'missing') throw new NotFoundException('Persona missing not found');
      if (id === 'boom') throw new Error('connection reset by peer at 10.0.0.3');
      return { id, name: 'Grace', createdAt: new Date('2026-10-01T00:00:00Z') };
    }),
    create: jest.fn(async (_userId: string, dto: unknown) => ({ id: 'pe2', ...(dto as object) })),
    update: jest.fn(async (id: string, _userId: string, dto: unknown) => ({ id, ...(dto as object) })),
  };
  const sessions = {
    findAll: jest.fn(async () => ({ data: [], total: 0, skip: 0, take: 20 })),
    getMessages: jest.fn(async () => ({
      messages: [{ id: 'm1', timestamp: new Date('2026-10-01T00:00:00Z'), role: 'user', messageType: 'user_text', content: 'hi', metadata: { x: 1 } }],
      hasMore: false,
      nextCursor: null,
    })),
  };
  const prisma = {
    session: { findUnique: jest.fn(async (args: any) => ({ s1: { projectId: 'p1' }, s2: { projectId: 'p2' } } as any)[args.where.id] ?? null) },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const access = new ResourceAccessService(prisma as any);
  const providers = [
    new CatalogTools({ getAgentTypesWithInfo: jest.fn(async () => []) } as any),
    new PersonasTools(personas as any),
    new PlanTemplatesTools({} as any),
    new AgentConfigurationsTools({} as any),
    new SessionsTools({ findAll: jest.fn(async () => []) } as any, sessions as any, { getFullState: jest.fn(async () => null) } as any, access),
  ];
  const factory = new McpServerFactory(providers, audit as any);
  const tool = (name: string) => (factory as any).tools.find((t: any) => t.name === name);
  return { factory, personas, sessions, audit, tool };
}

async function connect(factory: McpServerFactory, auth: McpAuthContext) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await factory.create(auth).connect(serverTransport);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientTransport);
  return client;
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe('MCP server over the SDK client', () => {
  it('lists only read tools to a read-only token, and every tool to a read/write token', async () => {
    const { factory } = setup();
    const readNames = (await (await connect(factory, READ)).listTools()).tools.map((t) => t.name);
    const allNames = (await (await connect(factory, READ_WRITE)).listTools()).tools.map((t) => t.name);
    expect(readNames).toContain('personas_list');
    expect(readNames).not.toContain('personas_create');
    expect(allNames).toEqual(expect.arrayContaining(['personas_create', 'plan_templates_update', 'agent_configurations_create']));
    expect(allNames.some((n) => n.includes('delete'))).toBe(false);
  });

  it('marks read tools read-only for the client', async () => {
    const { factory } = setup();
    const tools = (await (await connect(factory, READ_WRITE)).listTools()).tools;
    expect(tools.find((t) => t.name === 'personas_get')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'personas_update')?.annotations?.readOnlyHint).toBe(false);
  });

  it('calls the domain service as the token owner and returns JSON', async () => {
    const { factory, personas } = setup();
    const client = await connect(factory, READ);
    const result: any = await client.callTool({ name: 'personas_get', arguments: { id: 'pe1' } });
    expect(personas.findOne).toHaveBeenCalledWith('pe1', 'u1');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ id: 'pe1', name: 'Grace', createdAt: '2026-10-01T00:00:00.000Z' });
    expect(parse(result)).toEqual(result.structuredContent);
  });

  it('turns a Nest HttpException into a tool error with its status', async () => {
    const { factory } = setup();
    const result: any = await (await connect(factory, READ)).callTool({ name: 'personas_get', arguments: { id: 'missing' } });
    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({ error: { status: 404, message: 'Persona missing not found' } });
  });

  it('hides internal error details from the client', async () => {
    const { factory } = setup();
    const result: any = await (await connect(factory, READ)).callTool({ name: 'personas_get', arguments: { id: 'boom' } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('10.0.0.3');
    expect(parse(result).error.status).toBe(500);
  });
});

describe('MCP tool runner', () => {
  it('validates writes with the REST DTO, so MCP and REST reject the same input', async () => {
    const { factory, personas, tool } = setup();
    const noPrompt: any = await factory.run(tool('personas_create'), { name: 'X' }, READ_WRITE);
    expect(noPrompt.isError).toBe(true);
    expect(parse(noPrompt).error).toEqual({ status: 400, message: expect.stringContaining('systemPrompt') });

    const extra: any = await factory.run(tool('personas_create'), { name: 'X', systemPrompt: 'Y', owner: 'someone' }, READ_WRITE);
    expect(parse(extra).error.message).toContain('property owner should not exist');
    expect(personas.create).not.toHaveBeenCalled();

    const ok: any = await factory.run(tool('personas_create'), { name: 'X', systemPrompt: 'Y' }, READ_WRITE);
    expect(ok.isError).toBeFalsy();
    expect(personas.create.mock.calls[0][1]).toBeInstanceOf(CreatePersonaDto);
  });

  it('refuses a write tool called by name with a read-only token', async () => {
    const { factory, personas, audit, tool } = setup();
    const result: any = await factory.run(tool('personas_create'), { name: 'X', systemPrompt: 'Y' }, READ);
    expect(parse(result).error.status).toBe(403);
    expect(personas.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ success: false, errorCode: 'insufficient_scope' }));
  });

  it('records an audit entry for every call', async () => {
    const { factory, audit, tool } = setup();
    await factory.run(tool('personas_get'), { id: 'pe1' }, READ);
    await factory.run(tool('personas_get'), { id: 'missing' }, READ);
    expect(audit.record).toHaveBeenNthCalledWith(1, expect.objectContaining({ userId: 'u1', tokenId: 't1', tool: 'personas_get', success: true }));
    expect(audit.record).toHaveBeenNthCalledWith(2, expect.objectContaining({ success: false, errorCode: '404' }));
  });

  it('only shows sessions and projects the user is a member of', async () => {
    const { factory, sessions, tool } = setup();
    const otherProject: any = await factory.run(tool('sessions_list'), { projectId: 'p2' }, READ);
    expect(parse(otherProject).error.status).toBe(404);
    expect(sessions.findAll).not.toHaveBeenCalled();

    const otherSession: any = await factory.run(tool('session_transcript_get'), { sessionId: 's2' }, READ);
    expect(parse(otherSession).error.status).toBe(404);
    const unknown: any = await factory.run(tool('session_state_get'), { sessionId: 'nope' }, READ);
    expect(parse(unknown).error.status).toBe(404);
    expect(sessions.getMessages).not.toHaveBeenCalled();
  });

  it('returns a compact transcript, with metadata only when asked for debug', async () => {
    const { factory, tool } = setup();
    const plain: any = await factory.run(tool('session_transcript_get'), { sessionId: 's1' }, READ);
    expect(plain.structuredContent.messages[0]).toEqual({
      id: 'm1', timestamp: '2026-10-01T00:00:00.000Z', role: 'user', messageType: 'user_text', content: 'hi',
    });
    const debug: any = await factory.run(tool('session_transcript_get'), { sessionId: 's1', includeDebug: true }, READ);
    expect(debug.structuredContent.messages[0].metadata).toEqual({ x: 1 });
  });
});

describe('summarizeToolArgs', () => {
  it('redacts secret-looking keys and shortens long values', () => {
    const summary = summarizeToolArgs({ apiKey: 'sk-123', nested: { password: 'p' }, systemPrompt: 'x'.repeat(500), list: Array(30).fill(1) });
    expect(summary.apiKey).toBe('[redacted]');
    expect((summary.nested as any).password).toBe('[redacted]');
    expect(summary.systemPrompt).toMatch(/… \(500 chars\)$/);
    expect((summary.list as unknown[]).length).toBe(21);
  });

  it('keeps only the keys when the summary would still be too large', () => {
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v'.repeat(150)]));
    expect(summarizeToolArgs(big)).toEqual({ truncated: true, keys: Object.keys(big) });
  });
});

describe('PatAuthGuard', () => {
  function ctx(req: any) {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
    return { context: { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as any, headers };
  }
  const guard = (auth: unknown) => new PatAuthGuard({ authenticate: jest.fn(async () => auth) } as any);

  it('never accepts a token in the URL', async () => {
    const { context } = ctx({ query: { token: 'stella_pat_x' }, headers: {} });
    await expect(guard(READ).canActivate(context)).rejects.toThrow(BadRequestException);
  });

  it('answers 401 with WWW-Authenticate when the header is missing or the token is bad', async () => {
    const missing = ctx({ query: {}, headers: {} });
    await expect(guard(READ).canActivate(missing.context)).rejects.toThrow(UnauthorizedException);
    expect(missing.headers['WWW-Authenticate']).toContain('Bearer');

    const bad = ctx({ query: {}, headers: { authorization: 'Bearer stella_pat_nope' } });
    await expect(guard(null).canActivate(bad.context)).rejects.toThrow(UnauthorizedException);
    expect(bad.headers['WWW-Authenticate']).toContain('invalid_token');
  });

  it('puts the token owner on the request', async () => {
    const req: any = { query: {}, headers: { authorization: 'Bearer stella_pat_ok' } };
    await expect(guard({ user: USER, tokenId: 't1', scopes: ['mcp:read'] }).canActivate(ctx(req).context)).resolves.toBe(true);
    expect(req.user).toBe(USER);
    expect(req.mcpAuth).toEqual({ user: USER, tokenId: 't1', scopes: ['mcp:read'] });
  });
});

describe('McpOriginGuard', () => {
  const guard = (env: Record<string, string>) => new McpOriginGuard({ get: (k: string) => env[k] } as any);
  const ctx = (origin?: string) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: origin ? { origin } : {} }) }) }) as any;

  it('lets clients without an Origin through, and the STELLA frontend', () => {
    const g = guard({ NODE_ENV: 'production', PUBLIC_FRONTEND_URL: 'https://stella.example.org/' });
    expect(g.canActivate(ctx())).toBe(true);
    expect(g.canActivate(ctx('https://stella.example.org'))).toBe(true);
  });

  it('turns away other web pages, and localhost outside development', () => {
    const g = guard({ NODE_ENV: 'production', CORS_ORIGIN: 'https://stella.example.org' });
    expect(() => g.canActivate(ctx('https://evil.example.com'))).toThrow();
    expect(() => g.canActivate(ctx('http://localhost:5173'))).toThrow();
    expect(guard({ NODE_ENV: 'development' }).canActivate(ctx('http://localhost:5173'))).toBe(true);
  });
});
