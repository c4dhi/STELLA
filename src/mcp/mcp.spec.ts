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
import { PlatformSettingsTools } from './tools/platform-settings.tools.js';
import { ConnectorsTools } from './tools/connectors.tools.js';
import { AgentUploadsTools } from './tools/agent-uploads.tools.js';
import { AgentReviewsTools } from './tools/agent-reviews.tools.js';
import {
  CreateConnectorDto,
  UpdateConnectorDto,
} from '../connectors/dto/connector.dto.js';
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
  const settingsView = (agentReviewRequired: boolean) => ({
    ttsPlayback: null,
    updatedAt: null,
    updatedBy: null,
    pinnedDeployments: [{ agentId: 'other-project-agent' }],
    mcpEnabled: true,
    agentReviewRequired,
    hardwareFit: {},
  });
  const platformSettings = {
    getView: jest.fn(async () => settingsView(true)),
    setAgentReviewRequired: jest.fn(async (raw: boolean, _userId: string) => settingsView(raw)),
  };
  const reviewed = (validationStatus: string) => ({ id: 'up1', slug: 'my-agent', validationStatus });
  const agentReview = {
    list: jest.fn(async (_state: string) => [reviewed('PENDING')]),
    get: jest.fn(async (_id: string) => ({ ...reviewed('APPROVED'), buildLogs: [] })),
    approve: jest.fn(async (_id: string, _adminId: string, _notes?: string) => reviewed('APPROVED')),
    reject: jest.fn(async (_id: string, _adminId: string, _reason: string) => reviewed('REJECTED')),
  };
  const personas = {
    findAllForUser: jest.fn(async () => [
      {
        id: 'pe1',
        userId: 'u1',
        name: 'Grace',
        description: null,
        icon: '🌿',
        systemPrompt: 'secret sauce',
        voice: null,
        language: 'de',
        variables: { mood: 'calm' },
        isSystemDefault: false,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      },
    ]),
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
  // Writes return a bare row; the tools must answer with what findOne gives.
  const plans = {
    findAllByUser: jest.fn(async () => [
      {
        id: 'pl1',
        userId: 'u1',
        name: 'Walk',
        description: null,
        content: { states: [{ id: 'whole-plan-content' }] },
        defaultPersonaId: null,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      },
    ]),
    findOne: jest.fn(async (id: string) => ({
      id,
      name: 'Walk',
      content: { states: [] },
      from: 'findOne',
    })),
    create: jest.fn(async () => ({ id: 'pl2', from: 'create' })),
    update: jest.fn(async (id: string) => ({ id, from: 'update' })),
  };
  const configurations = {
    findAllByUser: jest.fn(async () => [
      {
        id: 'c1',
        userId: 'u1',
        name: 'Default',
        description: null,
        agentTypeId: 'at1',
        configuration: { nodes: { prompt: 'whole-override' } },
        compatibility: 'CURRENT',
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      },
    ]),
    findOne: jest.fn(async (id: string) => ({
      id,
      name: 'Default',
      configuration: {},
      agentType: {
        id: 'at1',
        slug: 'stella-v2-agent',
        name: 'STELLA V2',
        icon: null,
        pipelineSchema: { huge: 'pipeline-schema' },
      },
      from: 'findOne',
    })),
    create: jest.fn(async () => ({ id: 'c2', from: 'create' })),
    update: jest.fn(async (id: string) => ({ id, from: 'update' })),
  };
  const projects = {
    findAll: jest.fn(async () => [
      {
        id: 'p1',
        name: 'Testing',
        ownerId: 'u1',
        isOwner: true,
        isPublic: true,
        publicToken: 'public-join-secret',
        publicEnabled: true,
        agentInactivityTimeoutMinutes: 5,
        activeSessions: 1,
        activeAgents: 0,
        totalSessions: 2,
        createdAt: new Date('2026-10-01T00:00:00Z'),
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      },
    ]),
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
    findOne: jest.fn(async (id: string) => ({
      id,
      projectId: 'p1',
      name: 'Morning',
      status: 'ACTIVE',
      createdAt: new Date('2026-10-01T00:00:00Z'),
      closedAt: null,
      agentSpawnMode: 'immediate',
      hasHumanParticipant: false,
      maxSessionDurationSeconds: null,
      lastAgentConfig: { manualEnvVarsEncrypted: 'ciphertext' },
      agents: [],
      participants: [],
      _count: { messages: 0 },
    })),
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
    findOne: jest.fn(async (id: string) => ({
      id,
      token: 'tok',
      status: 'REVOKED',
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
  const agentImages = {
    getAgentTypesWithInfo: jest.fn(async () => [
      {
        id: 'at1',
        slug: 'stella-v2-agent',
        name: 'STELLA V2',
        description: 'Pipeline',
        icon: null,
        version: '1.1.0',
        isBuiltIn: true,
        capabilities: ['voice'],
        defaultConfig: {},
        configSchema: { type: 'object' },
      },
    ]),
  };
  const connectorRow = {
    id: 'c1',
    name: 'ELIAS',
    handle: 'elias',
    kind: 'mcp',
    url: 'https://elias.example/mcp',
    authType: 'bearer',
    hasCredential: true,
    status: 'untested',
    sharedWith: [],
  };
  const connectors = {
    list: jest.fn(async () => [connectorRow]),
    listAvailable: jest.fn(async () => [{ ...connectorRow, owned: true }]),
    get: jest.fn(async () => connectorRow),
    create: jest.fn(async () => connectorRow),
    update: jest.fn(async () => connectorRow),
    test: jest.fn(async () => ({ ok: true, connector: connectorRow })),
    setShares: jest.fn(async () => connectorRow),
    remove: jest.fn(),
  };
  const agentTypeRows: Record<string, any> = {
    'at-mine': {
      id: 'at-mine',
      slug: 'my-agent',
      name: 'My Agent',
      userId: 'u1',
      isBuiltIn: false,
      packagePath: 'storage/my-agent-1.0.0.zip',
      version: '1.0.0',
    },
    'at-other': {
      id: 'at-other',
      slug: 'their-agent',
      name: 'Their Agent',
      userId: 'u2',
      isBuiltIn: false,
      packagePath: 'storage/their-agent-1.0.0.zip',
      version: '1.0.0',
    },
    'at-builtin': {
      id: 'at-builtin',
      slug: 'builtin-agent',
      name: 'Built-in',
      userId: null,
      isBuiltIn: true,
      packagePath: null,
      version: '1.0.0',
    },
  };
  const uploadsPrisma = {
    agentType: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return agentTypeRows[where.id] ?? null;
        if (where.slug)
          return Object.values(agentTypeRows).find((a) => a.slug === where.slug) ?? null;
        return null;
      }),
      findMany: jest.fn(async () => [
        {
          id: 'at-mine',
          slug: 'my-agent',
          name: 'My Agent',
          description: null,
          icon: null,
          version: '1.0.0',
          validationStatus: 'PENDING',
          validationNotes: null,
          validatedAt: null,
          capabilities: [],
          defaultConfig: {},
          configSchema: {},
          pipelineSchema: {},
          createdAt: new Date('2026-11-01T00:00:00Z'),
          imageUrl: null,
          sdkVersion: null,
          projectShares: [{ projectId: 'p1' }],
          buildLogs: [],
        },
      ]),
      create: jest.fn(async ({ data }: any) => ({ id: 'at-new', ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    agentBuildLog: {
      findFirst: jest.fn(async () => ({ id: 'build-1' })),
    },
    projectMembership: {
      findMany: jest.fn(async () => [{ projectId: 'p1', project: { id: 'p1', name: 'Playground' } }]),
    },
    agentTypeProjectShare: {
      findMany: jest.fn(async () => [{ projectId: 'p1' }]),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      upsert: jest.fn(async () => ({})),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const agentPackage = {
    validatePackage: jest.fn(async () => ({
      valid: true,
      errors: [],
      warnings: [],
      files: ['agent.yaml'],
      manifest: {
        metadata: { slug: 'new-agent', version: '1.0.0' },
        image: {},
        capabilities: [],
      },
    })),
    storePackage: jest.fn(async () => ({ path: 'storage/new-agent-1.0.0.zip', size: 42, hash: 'h1' })),
    readExpertDefaults: jest.fn(() => null),
  };
  const agentBuildForUploads = {
    startBuild: jest.fn(async () => ({ buildLogId: 'build-new' })),
    getBuildStatus: jest.fn(async () => ({
      id: 'build-1',
      status: 'success' as const,
      startedAt: new Date('2026-11-01T00:00:00Z'),
    })),
    getBuildHistory: jest.fn(async () => [{ id: 'build-1', status: 'success' }]),
    getBuildOutput: jest.fn(async () => 'built ok'),
  };
  const providers = [
    new CatalogTools(agentImages as any),
    new PersonasTools(personas as any),
    new PlanTemplatesTools(plans as any),
    new AgentConfigurationsTools(configurations as any),
    new SessionsTools(
      projects as any,
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
            variableKeys: ['OPENAI_API_KEY', 'TTS_SPEED'],
            agentTypeId: 'at1',
            settings: { TTS_SPEED: '3' },
            invalid: { TTS_SPEED: 'must be between 0.5 and 2' },
            needsCheck: true,
          },
        ]),
      } as any,
      agentImages as any,
      access,
    ),
    new PlatformSettingsTools(platformSettings as any),
    new AgentReviewsTools(agentReview as any),
    new ConnectorsTools(connectors as any),
    new AgentUploadsTools(
      uploadsPrisma as any,
      { delete: jest.fn() } as any,
      agentPackage as any,
      agentBuildForUploads as any,
    ),
  ];
  const factory = new McpServerFactory(providers, audit as any);
  const tool = (name: string) =>
    (factory as any).tools.find((t: any) => t.name === name);
  return {
    factory,
    platformSettings,
    agentReview,
    personas,
    plans,
    configurations,
    sessions,
    agents,
    invitations,
    connectors,
    uploadsPrisma,
    agentPackage,
    agentBuildForUploads,
    audit,
    tool,
  };
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
      arguments: { personaId: 'pe1' },
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
    ).callTool({ name: 'personas_get', arguments: { personaId: 'missing' } });
    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({
      error: { status: 404, message: 'Persona missing not found' },
    });
  });

  it('hides internal error details from the client', async () => {
    const { factory } = setup();
    const result: any = await (
      await connect(factory, READ)
    ).callTool({ name: 'personas_get', arguments: { personaId: 'boom' } });
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
    await factory.run(tool('personas_get'), { personaId: 'pe1' }, READ);
    await factory.run(tool('personas_get'), { personaId: 'missing' }, READ);
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
    expect(plain.structuredContent.items[0]).toEqual({
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
    expect(debug.structuredContent.items[0].metadata).toEqual({ x: 1 });
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
    // The session as sessions_get shows it, without its deploy snapshot.
    expect(ok.structuredContent).toMatchObject({
      id: 's3',
      projectId: 'p1',
      name: 'Morning',
      status: 'ACTIVE',
      agents: [],
      messageCount: 0,
    });
    expect(ok.content[0].text).not.toContain('ciphertext');
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

  it('lists sessions with counts, not their deploy snapshot', async () => {
    const { factory, sessions, tool } = setup();
    sessions.findAll.mockResolvedValueOnce({
      data: [
        {
          id: 's1',
          name: 'Morning',
          status: 'ACTIVE',
          lastAgentConfig: {
            agentConfig: { persona: { system_prompt: 'secret sauce' } },
            manualEnvVarsEncrypted: 'ciphertext',
          },
          room: { livekitRoomName: 'session-1' },
          _count: { agents: 1, participants: 2, messages: 7 },
        },
      ],
      total: 1,
      skip: 0,
      take: 20,
    } as any);
    const result: any = await factory.run(
      tool('sessions_list'),
      { projectId: 'p1' },
      READ,
    );
    expect(result.structuredContent).toMatchObject({
      items: [
        {
          id: 's1',
          name: 'Morning',
          agentCount: 1,
          participantCount: 2,
          messageCount: 7,
        },
      ],
      total: 1,
    });
    expect(result.content[0].text).not.toContain('ciphertext');
    expect(result.content[0].text).not.toContain('secret sauce');
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
        variableKeys: ['OPENAI_API_KEY', 'TTS_SPEED'],
        agentTypeId: 'at1',
        // What does not fit, and why, but never a value — not even a setting's.
        invalid: { TTS_SPEED: 'must be between 0.5 and 2' },
        needsCheck: true,
      },
    ]);
  });
});

describe('MCP agent review tools (system admins only)', () => {
  const ADMIN = { ...USER, userId: 'admin-1', isSystemAdmin: true };
  const ADMIN_READ: McpAuthContext = { user: ADMIN, tokenId: 't2', scopes: ['mcp:read'] };
  const ADMIN_RW: McpAuthContext = { user: ADMIN, tokenId: 't2', scopes: ['mcp:read', 'mcp:write'] };
  const REVIEW_TOOLS = ['agent_reviews_list', 'agent_reviews_get', 'agent_reviews_approve', 'agent_reviews_reject'];

  it('lists them only to a system admin, writes only with mcp:write', () => {
    const { factory } = setup();
    expect(factory.toolNamesFor(READ_WRITE).filter((n) => REVIEW_TOOLS.includes(n))).toEqual([]);
    expect(factory.toolNamesFor(ADMIN_READ).filter((n) => REVIEW_TOOLS.includes(n))).toEqual([
      'agent_reviews_list',
      'agent_reviews_get',
    ]);
    expect(factory.toolNamesFor(ADMIN_RW)).toEqual(expect.arrayContaining(REVIEW_TOOLS));
  });

  it('refuses a user approving their own upload by name, and records it', async () => {
    const { factory, tool, agentReview, audit } = setup();
    const result: any = await factory.run(tool('agent_reviews_approve'), { agentTypeId: 'up1' }, READ_WRITE);
    expect(parse(result).error.status).toBe(403);
    expect(agentReview.approve).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'agent_reviews_approve', success: false, errorCode: 'not_system_admin' }),
    );
  });

  it('lists pending uploads unless another state is asked for', async () => {
    const { factory, tool, agentReview } = setup();
    const result: any = await factory.run(tool('agent_reviews_list'), {}, ADMIN_READ);
    expect(agentReview.list).toHaveBeenCalledWith('pending');
    expect(result.structuredContent).toEqual({ items: [{ id: 'up1', slug: 'my-agent', validationStatus: 'PENDING' }] });
    await factory.run(tool('agent_reviews_list'), { status: 'rejected' }, ADMIN_READ);
    expect(agentReview.list).toHaveBeenLastCalledWith('rejected');
  });

  it('approves and rejects as the admin, returning what _get shows', async () => {
    const { factory, tool, agentReview } = setup();
    const approved: any = await factory.run(
      tool('agent_reviews_approve'),
      { agentTypeId: 'up1', notes: 'fine' },
      ADMIN_RW,
    );
    expect(agentReview.approve).toHaveBeenCalledWith('up1', 'admin-1', 'fine');
    expect(approved.structuredContent).toEqual({ id: 'up1', slug: 'my-agent', validationStatus: 'APPROVED', buildLogs: [] });
    await factory.run(tool('agent_reviews_reject'), { agentTypeId: 'up1', reason: 'opens a shell' }, ADMIN_RW);
    expect(agentReview.reject).toHaveBeenCalledWith('up1', 'admin-1', 'opens a shell');
    expect(agentReview.get).toHaveBeenCalledTimes(2);
  });
});

describe('MCP platform settings tools (system admins only)', () => {
  const ADMIN = { ...USER, userId: 'admin-1', isSystemAdmin: true };
  const ADMIN_READ: McpAuthContext = { user: ADMIN, tokenId: 't2', scopes: ['mcp:read'] };
  const ADMIN_RW: McpAuthContext = { user: ADMIN, tokenId: 't2', scopes: ['mcp:read', 'mcp:write'] };
  const SETTINGS_TOOLS = ['platform_settings_get', 'platform_settings_update'];

  it('lists them only to a system admin, each with its scope', async () => {
    const { factory } = setup();
    expect(factory.toolNamesFor(READ_WRITE)).toEqual(expect.not.arrayContaining(['platform_settings_get']));
    expect(factory.toolNamesFor(READ_WRITE)).toEqual(expect.not.arrayContaining(['platform_settings_update']));
    expect(factory.toolNamesFor(ADMIN_READ)).toContain('platform_settings_get');
    expect(factory.toolNamesFor(ADMIN_READ)).not.toContain('platform_settings_update');
    expect(factory.toolNamesFor(ADMIN_RW)).toEqual(expect.arrayContaining(SETTINGS_TOOLS));
    const listed = (await (await connect(factory, READ_WRITE)).listTools()).tools.map((t) => t.name);
    expect(listed.filter((n) => SETTINGS_TOOLS.includes(n))).toEqual([]);
  });

  it('refuses a non-admin who calls them by name, and records it', async () => {
    const { factory, tool, platformSettings, audit } = setup();
    for (const name of SETTINGS_TOOLS) {
      const result: any = await factory.run(tool(name), { agentReviewRequired: false }, READ_WRITE);
      expect(result.isError).toBe(true);
      expect(parse(result).error.status).toBe(403);
    }
    expect(platformSettings.getView).not.toHaveBeenCalled();
    expect(platformSettings.setAgentReviewRequired).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ tool: 'platform_settings_update', success: false, errorCode: 'not_system_admin' }),
    );
  });

  it('reads the switches without the cross-project deployment list', async () => {
    const { factory, tool } = setup();
    const result: any = await factory.run(tool('platform_settings_get'), {}, ADMIN_READ);
    expect(result.structuredContent).toEqual({ agentReviewRequired: true, mcpEnabled: true, ttsPlayback: null });
  });

  it('turns review off as the admin and returns what _get shows', async () => {
    const { factory, tool, platformSettings } = setup();
    const result: any = await factory.run(
      tool('platform_settings_update'),
      { agentReviewRequired: false },
      ADMIN_RW,
    );
    expect(platformSettings.setAgentReviewRequired).toHaveBeenCalledWith(false, 'admin-1');
    expect(result.structuredContent).toEqual({ agentReviewRequired: false, mcpEnabled: true, ttsPlayback: null });
  });
});

describe('One shape for every tool', () => {
  async function schemas() {
    const { factory } = setup();
    const client = await connect(factory, READ_WRITE);
    return (await client.listTools()).tools;
  }

  it('names every id after what it points to, and says where to get one', async () => {
    const offenders: string[] = [];
    let ids = 0;
    for (const t of await schemas()) {
      const properties = (t.inputSchema.properties ?? {}) as Record<
        string,
        any
      >;
      for (const [key, schema] of Object.entries(properties)) {
        if (key === 'id') offenders.push(`${t.name}: bare id`);
        if (!key.endsWith('Id')) continue;
        ids++;
        if (!/from \w+/.test(schema.description ?? '')) {
          offenders.push(`${t.name}.${key}: no "from <tool>"`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(ids).toBeGreaterThan(20);
  });

  it('takes updates as flat fields next to the id', async () => {
    const updates = (await schemas()).filter((t) => t.name.endsWith('_update'));
    expect(updates.map((t) => t.name).sort()).toEqual([
      'agent_configurations_update',
      'agent_uploads_shares_update',
      'connectors_update',
      'personas_update',
      'plan_templates_update',
      'sessions_update',
    ]);
    for (const t of updates) {
      const keys = Object.keys(t.inputSchema.properties ?? {});
      expect({
        tool: t.name,
        changes: keys.includes('changes'),
        ids: keys.filter((k) => k.endsWith('Id')).length,
      }).toEqual({ tool: t.name, changes: false, ids: 1 });
    }
  });

  it('returns the resulting object from writes that end something', async () => {
    const { factory, tool } = setup();
    const stopped: any = await factory.run(
      tool('agents_stop'),
      { agentId: 'a1' },
      READ_WRITE,
    );
    expect(stopped.structuredContent).toMatchObject({
      id: 'a1',
      sessionId: 's1',
    });
    const closed: any = await factory.run(
      tool('sessions_close'),
      { sessionId: 's1' },
      READ_WRITE,
    );
    expect(closed.structuredContent).toMatchObject({ id: 's1', agents: [] });
    const revoked: any = await factory.run(
      tool('session_invitations_revoke'),
      { invitationId: 'i1' },
      READ_WRITE,
    );
    expect(revoked.structuredContent).toMatchObject({
      id: 'i1',
      status: 'REVOKED',
      joinUrl: 'https://stella.test/join/tok',
    });
  });

  it('lists summaries, never prompts, plan content, overrides or join tokens', async () => {
    const { factory, tool } = setup();
    const list = async (name: string) =>
      ((await factory.run(tool(name), {}, READ)) as any).structuredContent
        .items[0];

    const persona = await list('personas_list');
    expect(persona).toMatchObject({ id: 'pe1', name: 'Grace', language: 'de' });
    for (const field of ['systemPrompt', 'variables', 'userId'])
      expect(persona[field]).toBeUndefined();

    const plan = await list('plan_templates_list');
    expect(plan).toMatchObject({ id: 'pl1', name: 'Walk' });
    for (const field of ['content', 'userId'])
      expect(plan[field]).toBeUndefined();

    const configuration = await list('agent_configurations_list');
    expect(configuration).toMatchObject({ id: 'c1', agentTypeId: 'at1' });
    for (const field of ['configuration', 'userId'])
      expect(configuration[field]).toBeUndefined();

    const project = await list('projects_list');
    expect(project).toMatchObject({
      id: 'p1',
      name: 'Testing',
      totalSessions: 2,
    });
    for (const field of ['publicToken', 'publicEnabled', 'ownerId'])
      expect(project[field]).toBeUndefined();
  });

  it('answers creates and updates with exactly what _get shows', async () => {
    const { factory, tool } = setup();
    const run = async (name: string, args: Record<string, unknown>) =>
      ((await factory.run(tool(name), args, READ_WRITE)) as any)
        .structuredContent;
    const cases = [
      ['personas', 'personaId', { name: 'Ada', systemPrompt: 'You are Ada.' }],
      ['plan_templates', 'planId', { name: 'Walk', content: { states: [] } }],
      [
        'agent_configurations',
        'agentConfigurationId',
        { name: 'D', agentTypeId: 'at1', configuration: {} },
      ],
    ] as const;
    for (const [things, idKey, fields] of cases) {
      const created = await run(`${things}_create`, fields);
      expect(created).toEqual(
        await run(`${things}_get`, { [idKey]: created.id }),
      );
      const updated = await run(`${things}_update`, {
        [idKey]: created.id,
        name: 'New',
      });
      expect(updated).toEqual(
        await run(`${things}_get`, { [idKey]: created.id }),
      );
      expect(updated.from).toBe(things === 'personas' ? undefined : 'findOne');
    }
  });

  it('gives a configuration its agent type by summary, not the pipeline schema', async () => {
    const { factory, tool } = setup();
    const result: any = await factory.run(
      tool('agent_configurations_get'),
      { agentConfigurationId: 'c1' },
      READ,
    );
    expect(result.structuredContent.agentType).toEqual({
      id: 'at1',
      slug: 'stella-v2-agent',
      name: 'STELLA V2',
      icon: null,
    });
    expect(result.content[0].text).not.toContain('pipeline-schema');
  });

  it('lists agent types briefly and gets one in full', async () => {
    const { factory, tool } = setup();
    const listed: any = await factory.run(tool('agent_types_list'), {}, READ);
    expect(listed.structuredContent.items).toEqual([
      expect.objectContaining({ id: 'at1', slug: 'stella-v2-agent' }),
    ]);
    expect(listed.structuredContent.items[0].configSchema).toBeUndefined();
    const one: any = await factory.run(
      tool('agent_types_get'),
      { agentTypeId: 'at1' },
      READ,
    );
    expect(one.structuredContent.configSchema).toEqual({ type: 'object' });
    const missing: any = await factory.run(
      tool('agent_types_get'),
      { agentTypeId: 'nope' },
      READ,
    );
    expect(parse(missing).error.status).toBe(404);
  });

  it('never sends clients to agent_types_list for the pipeline schema (#820)', async () => {
    const offenders: string[] = [];
    for (const t of await schemas()) {
      const texts = [t.description, ...Object.values(t.inputSchema.properties ?? {}).map((s: any) => s.description)];
      for (const text of texts) {
        if (!text) continue;
        if ((/pipeline ?schema|configSchema/i.test(text)) && /agent_types_list/.test(text)) {
          offenders.push(t.name);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('deploys by agent type id', async () => {
    const { factory, agents, tool } = setup();
    await factory.run(
      tool('agents_deploy'),
      { sessionId: 's1', name: 'Grace', agentTypeId: 'at1' },
      READ_WRITE,
    );
    expect((agents.create.mock.calls[0] as any[])[1].agentType).toBe(
      'stella-v2-agent',
    );
    const unknown: any = await factory.run(
      tool('agents_deploy'),
      { sessionId: 's1', name: 'Grace', agentTypeId: 'nope' },
      READ_WRITE,
    );
    expect(parse(unknown).error.status).toBe(404);
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

describe('MCP connector tools', () => {
  it('lists and tests with read/write, and offers no delete', () => {
    const { factory } = setup();
    const read = factory.toolNamesFor(READ);
    expect(read).toEqual(
      expect.arrayContaining(['connectors_list', 'connectors_get']),
    );
    for (const write of [
      'connectors_create',
      'connectors_update',
      'connectors_test',
      'connector_shares_set',
    ]) {
      expect(read).not.toContain(write);
      expect(factory.toolNamesFor(READ_WRITE)).toContain(write);
    }
    expect(
      factory
        .toolNamesFor(READ_WRITE)
        .some((n) => n.startsWith('connector') && n.includes('delete')),
    ).toBe(false);
  });

  it('creates through the REST DTO and keeps the token out of the audit log', async () => {
    const { factory, connectors, audit, tool } = setup();
    const result: any = await factory.run(
      tool('connectors_create'),
      {
        name: 'ELIAS',
        handle: 'elias',
        url: 'https://elias.example/mcp',
        token: 'elias_secret',
      },
      READ_WRITE,
    );
    expect(result.isError).toBeFalsy();
    const [userId, dto] = connectors.create.mock.calls[0] as any[];
    expect(userId).toBe('u1');
    expect(dto).toBeInstanceOf(CreateConnectorDto);
    expect(dto.token).toBe('elias_secret');
    expect(JSON.stringify(result)).not.toContain('elias_secret');
    const entry = (audit.record.mock.calls[0] as any[])[0];
    expect(JSON.stringify(summarizeToolArgs(entry.args))).not.toContain(
      'elias_secret',
    );
  });

  it('rejects input the REST DTO would reject', async () => {
    const { factory, connectors, tool } = setup();
    const bad: any = await factory.run(
      tool('connectors_create'),
      { name: 'X', handle: 'Bad Handle', url: 'https://x.example/mcp' },
      READ_WRITE,
    );
    expect(parse(bad).error.status).toBe(400);
    expect(connectors.create).not.toHaveBeenCalled();
  });

  it('updates only the given fields, shares, tests, and lists per project', async () => {
    const { factory, connectors, tool } = setup();
    await factory.run(
      tool('connectors_update'),
      { connectorId: 'c1', name: 'New' },
      READ_WRITE,
    );
    const [id, userId, dto] = connectors.update.mock.calls[0] as any[];
    expect([id, userId]).toEqual(['c1', 'u1']);
    expect(dto).toBeInstanceOf(UpdateConnectorDto);
    expect(dto.token).toBeUndefined();

    await factory.run(
      tool('connector_shares_set'),
      {
        connectorId: 'c1',
        projectIds: ['7b0e7b8e-6c1a-4e4f-9d37-0e6f3c1b2a11'],
      },
      READ_WRITE,
    );
    expect(connectors.setShares).toHaveBeenCalledWith('c1', 'u1', [
      '7b0e7b8e-6c1a-4e4f-9d37-0e6f3c1b2a11',
    ]);
    const badShare: any = await factory.run(
      tool('connector_shares_set'),
      { connectorId: 'c1', projectIds: ['p1'] },
      READ_WRITE,
    );
    expect(parse(badShare).error.status).toBe(400);

    const tested: any = await factory.run(
      tool('connectors_test'),
      { connectorId: 'c1' },
      READ_WRITE,
    );
    expect(tested.structuredContent.ok).toBe(true);

    const available: any = await factory.run(
      tool('connectors_list'),
      { projectId: 'p1' },
      READ,
    );
    expect(connectors.listAvailable).toHaveBeenCalledWith('u1', 'p1');
    expect(available.structuredContent.items[0].owned).toBe(true);
  });

  it('passes connector bindings to agents_deploy', async () => {
    const { factory, agents, tool } = setup();
    const result: any = await factory.run(
      tool('agents_deploy'),
      {
        sessionId: 's1',
        name: 'ELIAS interviewer',
        connectorBindings: [
          {
            connectorId: '7b0e7b8e-6c1a-4e4f-9d37-0e6f3c1b2a11',
            slot: 'elias',
          },
        ],
      },
      READ_WRITE,
    );
    expect(result.isError).toBeFalsy();
    const dto = (agents.create.mock.calls[0] as any[])[1];
    expect(dto.connectorBindings).toEqual([
      expect.objectContaining({
        connectorId: '7b0e7b8e-6c1a-4e4f-9d37-0e6f3c1b2a11',
        slot: 'elias',
      }),
    ]);
  });
});

describe('MCP agent upload tools', () => {
  it('lists only read tools to a read-only token, and every tool to read/write', () => {
    const { factory } = setup();
    const read = factory.toolNamesFor(READ);
    expect(read).toEqual(
      expect.arrayContaining([
        'agent_uploads_list',
        'agent_uploads_build_status',
        'agent_uploads_build_history',
        'agent_uploads_shares_get',
      ]),
    );
    for (const write of [
      'agent_uploads_create',
      'agent_uploads_build',
      'agent_uploads_shares_update',
    ]) {
      expect(read).not.toContain(write);
      expect(factory.toolNamesFor(READ_WRITE)).toContain(write);
    }
  });

  it('packs files into a zip, validates, stores and starts a build', async () => {
    const { factory, agentPackage, agentBuildForUploads, uploadsPrisma, tool } = setup();
    const result: any = await factory.run(
      tool('agent_uploads_create'),
      {
        files: [
          { path: 'agent.yaml', content: 'metadata:\n  slug: new-agent\n  version: 1.0.0\n' },
          { path: 'main.py', content: 'print("hi")' },
        ],
      },
      READ_WRITE,
    );
    expect(result.isError).toBeFalsy();
    const [buffer] = agentPackage.validatePackage.mock.calls[0] as [Buffer];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(agentPackage.storePackage).toHaveBeenCalledWith(buffer, 'new-agent-1.0.0.zip');
    expect(uploadsPrisma.agentType.create).toHaveBeenCalled();
    expect(agentBuildForUploads.startBuild).toHaveBeenCalledWith('at-new', 'u1');
    expect(result.structuredContent).toMatchObject({
      id: 'at-new',
      slug: 'new-agent',
      replacedVersion: null,
    });
  });

  it('refuses image.imageUrl, and replaces the owner\'s existing slug on a higher version', async () => {
    const { factory, agentPackage, uploadsPrisma, tool } = setup();
    agentPackage.validatePackage.mockResolvedValueOnce({
      valid: true,
      errors: [],
      warnings: [],
      files: ['agent.yaml'],
      manifest: { metadata: { slug: 'x', version: '1.0.0' }, image: { imageUrl: 'docker.io/x' }, capabilities: [] },
    });
    const refused: any = await factory.run(
      tool('agent_uploads_create'),
      { files: [{ path: 'agent.yaml', content: 'x' }] },
      READ_WRITE,
    );
    expect(refused.isError).toBe(true);

    agentPackage.validatePackage.mockResolvedValueOnce({
      valid: true,
      errors: [],
      warnings: [],
      files: ['agent.yaml'],
      manifest: { metadata: { slug: 'my-agent', version: '2.0.0' }, image: {}, capabilities: [] },
    });
    const replaced: any = await factory.run(
      tool('agent_uploads_create'),
      { files: [{ path: 'agent.yaml', content: 'x' }] },
      READ_WRITE,
    );
    expect(replaced.isError).toBeFalsy();
    expect(uploadsPrisma.agentType.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'at-mine' } }),
    );
    expect(replaced.structuredContent).toMatchObject({ replacedVersion: '1.0.0' });
  });

  it('refuses re-uploading the same version, and another user\'s slug', async () => {
    const { factory, agentPackage, tool } = setup();
    agentPackage.validatePackage.mockResolvedValueOnce({
      valid: true,
      errors: [],
      warnings: [],
      files: ['agent.yaml'],
      manifest: { metadata: { slug: 'my-agent', version: '1.0.0' }, image: {}, capabilities: [] },
    });
    const sameVersion: any = await factory.run(
      tool('agent_uploads_create'),
      { files: [{ path: 'agent.yaml', content: 'x' }] },
      READ_WRITE,
    );
    expect(sameVersion.isError).toBe(true);

    agentPackage.validatePackage.mockResolvedValueOnce({
      valid: true,
      errors: [],
      warnings: [],
      files: ['agent.yaml'],
      manifest: { metadata: { slug: 'their-agent', version: '2.0.0' }, image: {}, capabilities: [] },
    });
    const notYours: any = await factory.run(
      tool('agent_uploads_create'),
      { files: [{ path: 'agent.yaml', content: 'x' }] },
      READ_WRITE,
    );
    expect(notYours.isError).toBe(true);
  });

  it('lists only the caller\'s own uploads, mapped like the REST route', async () => {
    const { factory, tool } = setup();
    const result: any = await factory.run(tool('agent_uploads_list'), {}, READ);
    expect(result.structuredContent.items[0]).toMatchObject({
      id: 'at-mine',
      slug: 'my-agent',
      sharedProjectIds: ['p1'],
      built: false,
    });
  });

  it('build: owner may trigger, another user may not, admin may', async () => {
    const { factory, agentBuildForUploads, tool } = setup();
    const ADMIN = { ...USER, userId: 'admin-1', isSystemAdmin: true };
    const ADMIN_RW: McpAuthContext = { user: ADMIN, tokenId: 't2', scopes: ['mcp:read', 'mcp:write'] };

    const owned: any = await factory.run(tool('agent_uploads_build'), { agentTypeId: 'at-mine' }, READ_WRITE);
    expect(owned.isError).toBeFalsy();
    expect(agentBuildForUploads.startBuild).toHaveBeenCalledWith('at-mine', 'u1');

    const notOwned: any = await factory.run(tool('agent_uploads_build'), { agentTypeId: 'at-other' }, READ_WRITE);
    expect(notOwned.isError).toBe(true);

    const asAdmin: any = await factory.run(tool('agent_uploads_build'), { agentTypeId: 'at-other' }, ADMIN_RW);
    expect(asAdmin.isError).toBeFalsy();
  });

  it('build_status answers null when never built, and the latest build otherwise', async () => {
    const { factory, uploadsPrisma, tool } = setup();
    uploadsPrisma.agentBuildLog.findFirst.mockResolvedValueOnce(null);
    const never: any = await factory.run(tool('agent_uploads_build_status'), { agentTypeId: 'at-mine' }, READ);
    expect(never.structuredContent).toEqual({ build: null });

    const built: any = await factory.run(tool('agent_uploads_build_status'), { agentTypeId: 'at-mine' }, READ);
    expect(built.structuredContent.build).toMatchObject({ status: 'success', buildOutput: 'built ok' });
  });

  it('build_history and build_status are refused to someone outside the owner\'s projects', async () => {
    const { factory, uploadsPrisma, tool } = setup();
    uploadsPrisma.projectMembership.findMany.mockResolvedValueOnce([]);
    const result: any = await factory.run(tool('agent_uploads_build_history'), { agentTypeId: 'at-other' }, READ);
    expect(result.isError).toBe(true);
  });

  it('shares: only the owner may see or change them, never an admin override, never on a built-in', async () => {
    const { factory, uploadsPrisma, tool } = setup();
    const ADMIN = { ...USER, userId: 'admin-1', isSystemAdmin: true };
    const ADMIN_RW: McpAuthContext = { user: ADMIN, tokenId: 't2', scopes: ['mcp:read', 'mcp:write'] };

    const owner: any = await factory.run(tool('agent_uploads_shares_get'), { agentTypeId: 'at-mine' }, READ);
    expect(owner.isError).toBeFalsy();
    expect(owner.structuredContent).toMatchObject({ projectIds: ['p1'] });

    const asAdmin: any = await factory.run(tool('agent_uploads_shares_get'), { agentTypeId: 'at-other' }, ADMIN_RW);
    expect(asAdmin.isError).toBe(true);

    const onBuiltin: any = await factory.run(
      tool('agent_uploads_shares_get'),
      { agentTypeId: 'at-builtin' },
      ADMIN_RW,
    );
    expect(onBuiltin.isError).toBe(true);

    const updated: any = await factory.run(
      tool('agent_uploads_shares_update'),
      { agentTypeId: 'at-mine', projectIds: ['7b0e7b8e-6c1a-4e4f-9d37-0e6f3c1b2a11'] },
      READ_WRITE,
    );
    expect(updated.isError).toBeFalsy();
    expect(uploadsPrisma.$transaction).toHaveBeenCalled();
  });
});
