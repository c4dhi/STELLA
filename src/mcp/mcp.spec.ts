import { jest } from '@jest/globals';
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ResourceAccessService } from '../auth/resource-access.service.js';
import { McpServerFactory } from './mcp-server.factory.js';
import { McpAuthContext } from './mcp.types.js';
import { summarizeToolArgs } from './mcp-audit.util.js';
import { McpBearerGuard } from './guards/mcp-bearer.guard.js';
import { McpOriginGuard } from './guards/mcp-origin.guard.js';
import { CatalogTools } from './tools/catalog.tools.js';
import { PersonasTools } from './tools/personas.tools.js';
import { PlanTemplatesTools } from './tools/plan-templates.tools.js';
import { AgentConfigurationsTools } from './tools/agent-configurations.tools.js';
import { SessionsTools } from './tools/sessions.tools.js';
import { AgentsTools } from './tools/agents.tools.js';
import { CreatePersonaDto } from '../personas/dto/create-persona.dto.js';
import { CreateAgentDto } from '../agents/dto/create-agent.dto.js';
import { CreateSessionDto } from '../sessions/dto/create-session.dto.js';

const USER = {
  userId: 'u1',
  email: 'u@x.test',
  name: 'U',
  isSystemAdmin: false,
  projectIds: ['p1'],
  projectRoles: { p1: 'OWNER' as const },
};
const READ: McpAuthContext = {
  user: USER,
  tokenId: 't1',
  scopes: ['mcp:read'],
};
const READ_WRITE: McpAuthContext = {
  user: USER,
  tokenId: 't1',
  scopes: ['mcp:read', 'mcp:write'],
};

function setup() {
  const personas = {
    findAllForUser: jest.fn(async () => [{ id: 'pe1', name: 'Grace' }]),
    findOne: jest.fn(async (id: string) => {
      if (id === 'missing')
        throw new NotFoundException('Persona missing not found');
      if (id === 'boom')
        throw new Error('connection reset by peer at 10.0.0.3');
      return { id, name: 'Grace', createdAt: new Date('2026-10-01T00:00:00Z') };
    }),
    create: jest.fn(async (_userId: string, dto: unknown) => ({
      id: 'pe2',
      ...(dto as object),
    })),
    update: jest.fn(async (id: string, _userId: string, dto: unknown) => ({
      id,
      ...(dto as object),
    })),
  };
  const sessions = {
    findAll: jest.fn(async () => ({ data: [], total: 0, skip: 0, take: 20 })),
    getMessages: jest.fn(async () => ({
      messages: [
        {
          id: 'm1',
          timestamp: new Date('2026-10-01T00:00:00Z'),
          role: 'user',
          messageType: 'user_text',
          content: 'hi',
          metadata: { x: 1 },
        },
      ],
      hasMore: false,
      nextCursor: null,
    })),
    create: jest.fn(async (projectId: string, dto: any) => ({
      id: 's3',
      projectId,
      name: dto.name ?? null,
      status: 'ACTIVE',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      room: { livekitRoomName: 'room-s3' },
    })),
    close: jest.fn(async () => ({ message: 'Session closed' })),
  };
  const agentRow = {
    id: 'a1',
    sessionId: 's1',
    name: 'Grace',
    status: 'STARTING',
    agentConfig: { persona: { system_prompt: 'secret sauce' } },
    podName: 'agent-a1',
    secretName: 'agent-a1-env',
    manualEnvVarsEncrypted: 'ciphertext',
  };
  const agents = {
    create: jest.fn(async () => agentRow),
    findOne: jest.fn(async () => ({ ...agentRow, podStatus: 'Running' })),
    getLogs: jest.fn(async () => 'line 1\nline 2'),
    restart: jest.fn(async () => agentRow),
    remove: jest.fn(async () => ({ message: 'Agent stopped successfully' })),
  };
  const invitations = {
    create: jest.fn(async () => ({
      invitation: { id: 'i1', token: 'tok', status: 'PENDING' },
      joinUrl: 'https://stella.test/join/tok',
    })),
    joinUrl: (token: string) => `https://stella.test/join/${token}`,
    findBySession: jest.fn(async () => [
      { id: 'i1', token: 'tok', status: 'PENDING' },
    ]),
    revoke: jest.fn(async () => ({
      message: 'Invitation revoked successfully',
    })),
  };
  const byId = (rows: Record<string, unknown>) => async (args: any) =>
    rows[args.where.id] ?? null;
  const prisma = {
    session: {
      findUnique: jest.fn(
        byId({ s1: { projectId: 'p1' }, s2: { projectId: 'p2' } }),
      ),
    },
    agentInstance: {
      findUnique: jest.fn(
        byId({
          a1: { session: { projectId: 'p1' } },
          a2: { session: { projectId: 'p2' } },
        }),
      ),
    },
    invitation: {
      findUnique: jest.fn(
        byId({
          i1: { session: { projectId: 'p1' } },
          i2: { session: { projectId: 'p2' } },
        }),
      ),
    },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const access = new ResourceAccessService(prisma as any);
  const providers = [
    new CatalogTools({ getAgentTypesWithInfo: jest.fn(async () => []) } as any),
    new PersonasTools(personas as any),
    new PlanTemplatesTools({} as any),
    new AgentConfigurationsTools({} as any),
    new SessionsTools(
      { findAll: jest.fn(async () => []) } as any,
      sessions as any,
      { getFullState: jest.fn(async () => null) } as any,
      invitations as any,
      access,
    ),
    new AgentsTools(
      agents as any,
      {
        findAllByUser: jest.fn(async () => [
          {
            id: 'e1',
            userId: 'u1',
            name: 'Keys',
            description: null,
            variableKeys: ['OPENAI_API_KEY'],
            agentTypeId: 'at1',
          },
        ]),
      } as any,
      access,
    ),
  ];
  const factory = new McpServerFactory(providers, audit as any);
  const tool = (name: string) =>
    (factory as any).tools.find((t: any) => t.name === name);
  return { factory, personas, sessions, agents, invitations, audit, tool };
}

async function connect(factory: McpServerFactory, auth: McpAuthContext) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await factory.create(auth).connect(serverTransport);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(clientTransport);
  return client;
}

const parse = (result: any) => JSON.parse(result.content[0].text);

describe('MCP server over the SDK client', () => {
  it('lists only read tools to a read-only token, and every tool to a read/write token', async () => {
    const { factory } = setup();
    const readNames = (
      await (await connect(factory, READ)).listTools()
    ).tools.map((t) => t.name);
    const allNames = (
      await (await connect(factory, READ_WRITE)).listTools()
    ).tools.map((t) => t.name);
    expect(readNames).toContain('personas_list');
    expect(readNames).not.toContain('personas_create');
    expect(allNames).toEqual(
      expect.arrayContaining([
        'personas_create',
        'plan_templates_update',
        'agent_configurations_create',
      ]),
    );
    expect(allNames.some((n) => n.includes('delete'))).toBe(false);
  });

  it('marks read tools read-only for the client', async () => {
    const { factory } = setup();
    const tools = (await (await connect(factory, READ_WRITE)).listTools())
      .tools;
    expect(
      tools.find((t) => t.name === 'personas_get')?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      tools.find((t) => t.name === 'personas_update')?.annotations
        ?.readOnlyHint,
    ).toBe(false);
  });

  it('calls the domain service as the token owner and returns JSON', async () => {
    const { factory, personas } = setup();
    const client = await connect(factory, READ);
    const result: any = await client.callTool({
      name: 'personas_get',
      arguments: { id: 'pe1' },
    });
    expect(personas.findOne).toHaveBeenCalledWith('pe1', 'u1');
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      id: 'pe1',
      name: 'Grace',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    expect(parse(result)).toEqual(result.structuredContent);
  });

  it('turns a Nest HttpException into a tool error with its status', async () => {
    const { factory } = setup();
    const result: any = await (
      await connect(factory, READ)
    ).callTool({ name: 'personas_get', arguments: { id: 'missing' } });
    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({
      error: { status: 404, message: 'Persona missing not found' },
    });
  });

  it('hides internal error details from the client', async () => {
    const { factory } = setup();
    const result: any = await (
      await connect(factory, READ)
    ).callTool({ name: 'personas_get', arguments: { id: 'boom' } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('10.0.0.3');
    expect(parse(result).error.status).toBe(500);
  });
});

describe('MCP tool runner', () => {
  it('validates writes with the REST DTO, so MCP and REST reject the same input', async () => {
    const { factory, personas, tool } = setup();
    const noPrompt: any = await factory.run(
      tool('personas_create'),
      { name: 'X' },
      READ_WRITE,
    );
    expect(noPrompt.isError).toBe(true);
    expect(parse(noPrompt).error).toEqual({
      status: 400,
      message: expect.stringContaining('systemPrompt'),
    });

    const extra: any = await factory.run(
      tool('personas_create'),
      { name: 'X', systemPrompt: 'Y', owner: 'someone' },
      READ_WRITE,
    );
    expect(parse(extra).error.message).toContain(
      'property owner should not exist',
    );
    expect(personas.create).not.toHaveBeenCalled();

    const ok: any = await factory.run(
      tool('personas_create'),
      { name: 'X', systemPrompt: 'Y' },
      READ_WRITE,
    );
    expect(ok.isError).toBeFalsy();
    expect(personas.create.mock.calls[0][1]).toBeInstanceOf(CreatePersonaDto);
  });

  it('refuses a write tool called by name with a read-only token', async () => {
    const { factory, personas, audit, tool } = setup();
    const result: any = await factory.run(
      tool('personas_create'),
      { name: 'X', systemPrompt: 'Y' },
      READ,
    );
    expect(parse(result).error.status).toBe(403);
    expect(personas.create).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorCode: 'insufficient_scope',
      }),
    );
  });

  it('records an audit entry for every call', async () => {
    const { factory, audit, tool } = setup();
    await factory.run(tool('personas_get'), { id: 'pe1' }, READ);
    await factory.run(tool('personas_get'), { id: 'missing' }, READ);
    expect(audit.record).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: 'u1',
        tokenId: 't1',
        tool: 'personas_get',
        success: true,
      }),
    );
    expect(audit.record).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ success: false, errorCode: '404' }),
    );
  });

  it('only shows sessions and projects the user is a member of', async () => {
    const { factory, sessions, tool } = setup();
    const otherProject: any = await factory.run(
      tool('sessions_list'),
      { projectId: 'p2' },
      READ,
    );
    expect(parse(otherProject).error.status).toBe(404);
    expect(sessions.findAll).not.toHaveBeenCalled();

    const otherSession: any = await factory.run(
      tool('session_transcript_get'),
      { sessionId: 's2' },
      READ,
    );
    expect(parse(otherSession).error.status).toBe(404);
    const unknown: any = await factory.run(
      tool('session_state_get'),
      { sessionId: 'nope' },
      READ,
    );
    expect(parse(unknown).error.status).toBe(404);
    expect(sessions.getMessages).not.toHaveBeenCalled();
  });

  it('returns a compact transcript, with metadata only when asked for debug', async () => {
    const { factory, tool } = setup();
    const plain: any = await factory.run(
      tool('session_transcript_get'),
      { sessionId: 's1' },
      READ,
    );
    expect(plain.structuredContent.messages[0]).toEqual({
      id: 'm1',
      timestamp: '2026-10-01T00:00:00.000Z',
      role: 'user',
      messageType: 'user_text',
      content: 'hi',
    });
    const debug: any = await factory.run(
      tool('session_transcript_get'),
      { sessionId: 's1', includeDebug: true },
      READ,
    );
    expect(debug.structuredContent.messages[0].metadata).toEqual({ x: 1 });
  });
});

describe('MCP session and agent tools', () => {
  it('shows following tools to a read-only token, and running tools only with write', () => {
    const { factory } = setup();
    const read = factory.toolNamesFor(READ);
    expect(read).toEqual(
      expect.arrayContaining([
        'sessions_get',
        'session_invitations_list',
        'agents_get',
        'agent_logs_get',
        'env_var_templates_list',
      ]),
    );
    for (const write of [
      'sessions_create',
      'sessions_close',
      'session_invitations_create',
      'agents_deploy',
      'agents_restart',
      'agents_stop',
    ]) {
      expect(read).not.toContain(write);
      expect(factory.toolNamesFor(READ_WRITE)).toContain(write);
    }
  });

  it('creates sessions only in projects the user is a member of', async () => {
    const { factory, sessions, tool } = setup();
    const other: any = await factory.run(
      tool('sessions_create'),
      { projectId: 'p2', name: 'X' },
      READ_WRITE,
    );
    expect(parse(other).error.status).toBe(404);
    expect(sessions.create).not.toHaveBeenCalled();

    const ok: any = await factory.run(
      tool('sessions_create'),
      { projectId: 'p1', name: 'Morning' },
      READ_WRITE,
    );
    expect(sessions.create.mock.calls[0][0]).toBe('p1');
    expect(sessions.create.mock.calls[0][1]).toBeInstanceOf(CreateSessionDto);
    expect(ok.structuredContent).toEqual({
      id: 's3',
      projectId: 'p1',
      name: 'Morning',
      status: 'ACTIVE',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('acts on sessions, agents and invitations only inside the user projects', async () => {
    const { factory, sessions, agents, invitations, tool } = setup();
    const calls: Array<[string, Record<string, unknown>]> = [
      ['sessions_close', { sessionId: 's2' }],
      ['session_invitations_create', { sessionId: 's2' }],
      ['session_invitations_revoke', { invitationId: 'i2' }],
      ['agents_deploy', { sessionId: 's2', name: 'A' }],
      ['agents_get', { agentId: 'a2' }],
      ['agent_logs_get', { agentId: 'a2' }],
      ['agents_restart', { agentId: 'a2' }],
      ['agents_stop', { agentId: 'missing' }],
    ];
    for (const [name, args] of calls) {
      const result: any = await factory.run(tool(name), args, READ_WRITE);
      expect(parse(result).error.status).toBe(404);
    }
    expect(sessions.close).not.toHaveBeenCalled();
    expect(invitations.create).not.toHaveBeenCalled();
    expect(invitations.revoke).not.toHaveBeenCalled();
    for (const fn of Object.values(agents)) expect(fn).not.toHaveBeenCalled();
  });

  it('deploys an agent as the token owner, without raw config or env var values', async () => {
    const { factory, agents, tool } = setup();
    const result: any = await factory.run(
      tool('agents_deploy'),
      {
        sessionId: 's1',
        name: 'Grace',
        planId: '7b0e7b8e-6c1a-4e4f-9d37-0e6f3c1b2a11',
        config: { plan: { id: 'smuggled' } },
        envVars: { OPENAI_API_KEY: 'sk-x' },
      },
      READ_WRITE,
    );
    expect(result.isError).toBeFalsy();
    const [sessionId, dto, userId] = agents.create.mock.calls[0] as any[];
    expect(sessionId).toBe('s1');
    expect(userId).toBe('u1');
    expect(dto).toBeInstanceOf(CreateAgentDto);
    expect(dto.planId).toBe('7b0e7b8e-6c1a-4e4f-9d37-0e6f3c1b2a11');
    expect(dto.config).toBeUndefined();
    expect(dto.envVars).toBeUndefined();
  });

  it('rejects an agent the REST DTO would reject', async () => {
    const { factory, agents, tool } = setup();
    const result: any = await factory.run(
      tool('agents_deploy'),
      { sessionId: 's1', name: 'Grace', planId: 'not-a-uuid' },
      READ_WRITE,
    );
    expect(parse(result).error).toEqual({
      status: 400,
      message: expect.stringContaining('planId'),
    });
    expect(agents.create).not.toHaveBeenCalled();
  });

  it('returns agents without their deployment snapshot or secrets', async () => {
    const { factory, tool } = setup();
    const result: any = await factory.run(
      tool('agents_get'),
      { agentId: 'a1' },
      READ,
    );
    expect(result.structuredContent).toMatchObject({
      id: 'a1',
      status: 'STARTING',
      podStatus: 'Running',
    });
    expect(result.content[0].text).not.toContain('secret sauce');
    expect(result.content[0].text).not.toContain('ciphertext');
    expect(result.content[0].text).not.toContain('agent-a1-env');
  });

  it('hands back the join link of an invitation, and never env var values', async () => {
    const { factory, tool } = setup();
    const created: any = await factory.run(
      tool('session_invitations_create'),
      { sessionId: 's1', participantName: 'Anna' },
      READ_WRITE,
    );
    expect(created.structuredContent).toMatchObject({
      id: 'i1',
      status: 'PENDING',
      joinUrl: 'https://stella.test/join/tok',
    });
    const listed: any = await factory.run(
      tool('session_invitations_list'),
      { sessionId: 's1' },
      READ,
    );
    expect(listed.structuredContent.items[0].joinUrl).toBe(
      'https://stella.test/join/tok',
    );
    const templates: any = await factory.run(
      tool('env_var_templates_list'),
      {},
      READ,
    );
    expect(templates.structuredContent.items).toEqual([
      {
        id: 'e1',
        name: 'Keys',
        description: null,
        variableKeys: ['OPENAI_API_KEY'],
        agentTypeId: 'at1',
      },
    ]);
  });
});

describe('summarizeToolArgs', () => {
  it('redacts secret-looking keys and shortens long values', () => {
    const summary = summarizeToolArgs({
      apiKey: 'sk-123',
      nested: { password: 'p' },
      systemPrompt: 'x'.repeat(500),
      list: Array(30).fill(1),
    });
    expect(summary.apiKey).toBe('[redacted]');
    expect((summary.nested as any).password).toBe('[redacted]');
    expect(summary.systemPrompt).toMatch(/… \(500 chars\)$/);
    expect((summary.list as unknown[]).length).toBe(21);
  });

  it('keeps only the keys when the summary would still be too large', () => {
    const big = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`k${i}`, 'v'.repeat(150)]),
    );
    expect(summarizeToolArgs(big)).toEqual({
      truncated: true,
      keys: Object.keys(big),
    });
  });
});

describe('McpBearerGuard', () => {
  const urls = {
    resourceMetadataUrl:
      'https://backend.example.org/.well-known/oauth-protected-resource/mcp',
  } as any;
  function ctx(req: any) {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
    return {
      context: {
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
      } as any,
      headers,
    };
  }
  const guard = (pat: unknown, grant: unknown = null) =>
    new McpBearerGuard(
      { authenticate: jest.fn(async () => pat) } as any,
      { authenticateAccessToken: jest.fn(async () => grant) } as any,
      urls,
    );

  it('never accepts a token in the URL', async () => {
    const { context } = ctx({ query: { token: 'stella_pat_x' }, headers: {} });
    await expect(guard(READ).canActivate(context)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('answers 401 pointing at the sign-in metadata, so Claude and ChatGPT can start sign-in', async () => {
    const missing = ctx({ query: {}, headers: {} });
    await expect(guard(READ).canActivate(missing.context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(missing.headers['WWW-Authenticate']).toBe(
      `Bearer resource_metadata="${urls.resourceMetadataUrl}"`,
    );

    const bad = ctx({
      query: {},
      headers: { authorization: 'Bearer stella_pat_nope' },
    });
    await expect(guard(null).canActivate(bad.context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(bad.headers['WWW-Authenticate']).toContain('error="invalid_token"');
    expect(bad.headers['WWW-Authenticate']).toContain('resource_metadata=');
  });

  it('puts a personal token owner on the request', async () => {
    const req: any = {
      query: {},
      headers: { authorization: 'Bearer stella_pat_ok' },
    };
    await expect(
      guard({ user: USER, tokenId: 't1', scopes: ['mcp:read'] }).canActivate(
        ctx(req).context,
      ),
    ).resolves.toBe(true);
    expect(req.user).toBe(USER);
    expect(req.mcpAuth).toEqual({
      user: USER,
      tokenId: 't1',
      scopes: ['mcp:read'],
    });
  });

  it('puts the user behind a signed-in app on the request, with the app', async () => {
    const req: any = {
      query: {},
      headers: { authorization: 'Bearer stella_oat_ok' },
    };
    const grant = {
      user: USER,
      grantId: 'g1',
      clientName: 'Claude',
      scopes: ['mcp:read', 'mcp:write'],
    };
    await expect(
      guard(null, grant).canActivate(ctx(req).context),
    ).resolves.toBe(true);
    expect(req.mcpAuth).toEqual({
      user: USER,
      oauthGrantId: 'g1',
      clientName: 'Claude',
      scopes: ['mcp:read', 'mcp:write'],
    });
  });
});

describe('McpOriginGuard', () => {
  const guard = (env: Record<string, string>) =>
    new McpOriginGuard({ get: (k: string) => env[k] } as any);
  const ctx = (origin?: string) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers: origin ? { origin } : {} }),
      }),
    }) as any;

  it('lets clients without an Origin through, and the STELLA frontend', () => {
    const g = guard({
      NODE_ENV: 'production',
      PUBLIC_FRONTEND_URL: 'https://stella.example.org/',
    });
    expect(g.canActivate(ctx())).toBe(true);
    expect(g.canActivate(ctx('https://stella.example.org'))).toBe(true);
  });

  it('turns away other web pages, and localhost outside development', () => {
    const g = guard({
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://stella.example.org',
    });
    expect(() => g.canActivate(ctx('https://evil.example.com'))).toThrow();
    expect(() => g.canActivate(ctx('http://localhost:5173'))).toThrow();
    expect(
      guard({ NODE_ENV: 'development' }).canActivate(
        ctx('http://localhost:5173'),
      ),
    ).toBe(true);
  });
});
