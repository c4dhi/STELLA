import { jest } from '@jest/globals';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { BadRequestException } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { assertPublicHost, normalizeConnectorUrl } from './connector-url.util.js';
import {
  ConnectorSlot,
  readBindings,
  resolveConnectorBindings,
} from './connector-bindings.util.js';
import {
  agentConnectorTokenMatches,
  issueAgentConnectorToken,
} from './agent-connector-token.util.js';
import { ConnectorCallError, McpClientService } from './mcp-client.service.js';
import { ConnectorsService } from './connectors.service.js';
import { ConnectorGatewayService, GatewayError } from './connector-gateway.service.js';
import { ConnectorsGrpcController } from './connectors-grpc.controller.js';
import { parseAgentManifestYaml } from '../agent-package/schemas/agent-manifest.schema.js';

describe('normalizeConnectorUrl', () => {
  it.each([
    ['https://elias.apps.c4dhi.org/mcp', 'https://elias.apps.c4dhi.org/mcp'],
    ['https://elias.apps.c4dhi.org/mcp/', 'https://elias.apps.c4dhi.org/mcp'],
    ['https://elias.apps.c4dhi.org//mcp', 'https://elias.apps.c4dhi.org/mcp'],
    ['  https://host.example//a//mcp//  ', 'https://host.example/a/mcp'],
    ['https://host.example/', 'https://host.example'],
    ['https://host.example', 'https://host.example'],
    ['https://host.example/mcp/?k=1#frag', 'https://host.example/mcp?k=1'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeConnectorUrl(input)).toBe(expected);
  });

  it.each(['ftp://host/mcp', 'not a url', 'https://user:pw@host/mcp'])('rejects %s', (input) => {
    expect(() => normalizeConnectorUrl(input)).toThrow();
  });
});

describe('assertPublicHost', () => {
  it.each([
    'http://localhost:3000/mcp',
    'http://127.0.0.1/mcp',
    'http://10.0.0.5/mcp',
    'http://192.168.1.1/mcp',
    'http://172.20.0.1/mcp',
    'http://169.254.169.254/latest',
    'http://[::1]/mcp',
    'http://session-management-server.ai-agents.svc.cluster.local:3000/mcp',
  ])('refuses %s', async (url) => {
    await expect(assertPublicHost(url, false)).rejects.toThrow(/private/);
  });

  it('allows public addresses, and anything when private hosts are allowed', async () => {
    await expect(assertPublicHost('https://8.8.8.8/mcp', false)).resolves.toBeUndefined();
    await expect(assertPublicHost('http://localhost/mcp', true)).resolves.toBeUndefined();
  });
});

describe('resolveConnectorBindings', () => {
  const owned = [
    { id: 'c1', handle: 'elias', name: 'ELIAS', toolsSnapshot: [{ name: 'start_interview' }, { name: 'end_interview' }] },
    { id: 'c2', handle: 'notes', name: 'Notes', toolsSnapshot: null },
  ];
  const slots: ConnectorSlot[] = [
    { slot: 'interview', kind: 'mcp', required: true, label: 'Interview server', requiredTools: ['start_interview'] },
    { slot: 'extra-slot', kind: 'mcp', required: false, label: 'Optional' },
  ];

  it('binds a slot under its slot name and an extra connector under its own handle', () => {
    expect(
      resolveConnectorBindings(
        [{ connectorId: 'c1', slot: 'interview' }, { connectorId: 'c2' }],
        slots,
        owned,
      ),
    ).toEqual([
      { handle: 'interview', connectorId: 'c1', slot: 'interview' },
      { handle: 'notes', connectorId: 'c2' },
    ]);
  });

  it('allows extra connectors on an agent that declares none', () => {
    expect(resolveConnectorBindings([{ connectorId: 'c2', handle: 'my-notes' }], null, owned)).toEqual([
      { handle: 'my-notes', connectorId: 'c2' },
    ]);
  });

  it('refuses a connector the user does not own', () => {
    expect(() => resolveConnectorBindings([{ connectorId: 'someone-elses' }], null, owned)).toThrow(/not found/);
  });

  it('refuses a missing required slot', () => {
    expect(() => resolveConnectorBindings([], slots, owned)).toThrow(/Interview server/);
  });

  it('refuses an undeclared slot, a slot bound twice, and a duplicate handle', () => {
    expect(() => resolveConnectorBindings([{ connectorId: 'c1', slot: 'nope' }], slots, owned)).toThrow(/no connector slot/);
    expect(() =>
      resolveConnectorBindings(
        [
          { connectorId: 'c1', slot: 'interview' },
          { connectorId: 'c2', slot: 'interview' },
        ],
        slots,
        owned,
      ),
    ).toThrow(/bound twice/);
    expect(() =>
      resolveConnectorBindings(
        [
          { connectorId: 'c1', slot: 'interview' },
          { connectorId: 'c2', handle: 'interview' },
        ],
        slots,
        owned,
      ),
    ).toThrow(/used twice/);
  });

  it('checks requiredTools against the tool snapshot when there is one', () => {
    const lacking = [{ ...owned[0], toolsSnapshot: [{ name: 'end_interview' }] }];
    expect(() => resolveConnectorBindings([{ connectorId: 'c1', slot: 'interview' }], slots, lacking)).toThrow(
      /start_interview/,
    );
    // Untested connector: no snapshot, nothing to check yet.
    const untested = [{ ...owned[0], toolsSnapshot: null }];
    expect(resolveConnectorBindings([{ connectorId: 'c1', slot: 'interview' }], slots, untested)).toHaveLength(1);
  });

  it('reads stored bindings defensively', () => {
    expect(readBindings(null)).toEqual([]);
    expect(readBindings([{ handle: 'a', connectorId: 'c' }, { handle: 1 }, 'x'])).toEqual([
      { handle: 'a', connectorId: 'c' },
    ]);
  });
});

describe('agent connector token', () => {
  it('matches only its own hash', () => {
    const { token, hash } = issueAgentConnectorToken();
    expect(agentConnectorTokenMatches(token, hash)).toBe(true);
    expect(agentConnectorTokenMatches(token + 'x', hash)).toBe(false);
    expect(agentConnectorTokenMatches(token, null)).toBe(false);
    expect(agentConnectorTokenMatches('', hash)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// McpClientService against a real Streamable HTTP MCP server on localhost.
// ---------------------------------------------------------------------------

const SECRET = 'test-bearer-secret';

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'fake-elias', version: '9.9.9' });
  server.registerTool(
    'start_interview',
    {
      description: 'Start an interview',
      inputSchema: { project: z.string() },
      outputSchema: { interviewId: z.string() },
    },
    async ({ project }) => ({
      content: [{ type: 'text', text: JSON.stringify({ interviewId: `iv-${project}` }) }],
      structuredContent: { interviewId: `iv-${project}` },
    }),
  );
  server.registerTool('fails', { description: 'Always fails' }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'project closed' }],
  }));
  return server;
}

async function startFakeServer(): Promise<{ url: string; server: Server; calls: { auth?: string }[] }> {
  const calls: { auth?: string }[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    calls.push({ auth: req.headers.authorization });
    if (req.url?.startsWith('/redirect')) {
      res.writeHead(307, { Location: 'http://example.invalid/mcp' }).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    // Stateless, plain JSON replies, no Mcp-Session-Id: the way ELIAS answers.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcp = buildMcpServer();
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server, calls };
}

function clientService(): McpClientService {
  const config = {
    get: (key: string) =>
      ({ CONNECTORS_ALLOW_PRIVATE_HOSTS: 'true', CONNECTORS_CALL_TIMEOUT_MS: '5000' })[key],
  };
  return new McpClientService(config as any);
}

describe('McpClientService', () => {
  let fake: Awaited<ReturnType<typeof startFakeServer>>;
  let mcp: McpClientService;

  beforeAll(async () => {
    fake = await startFakeServer();
  });
  afterAll(async () => {
    await new Promise((resolve) => fake.server.close(resolve));
  });
  beforeEach(() => {
    mcp = clientService();
  });
  afterEach(async () => {
    await mcp.onModuleDestroy();
  });

  it('initializes, lists tools and sends the bearer token', async () => {
    const { serverInfo, tools } = await mcp.probe({
      connectorId: 'c1',
      url: `${fake.url}/mcp`,
      bearerToken: SECRET,
    });
    expect(serverInfo.name).toBe('fake-elias');
    expect(tools.map((t) => t.name).sort()).toEqual(['fails', 'start_interview']);
    expect(tools.find((t) => t.name === 'start_interview')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { project: { type: 'string' } },
    });
    expect(fake.calls.every((c) => c.auth === `Bearer ${SECRET}`)).toBe(true);
  });

  it('calls a tool and returns structured content', async () => {
    const target = { connectorId: 'c1', url: `${fake.url}/mcp`, bearerToken: SECRET };
    const result = await mcp.callTool(target, 'start_interview', { project: 'p1' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ interviewId: 'iv-p1' });
    const failed = await mcp.callTool(target, 'fails', {});
    expect(failed.isError).toBe(true);
  });

  it('reports a refused credential as unauthorized, not retryable', async () => {
    const err = await mcp
      .probe({ connectorId: 'c2', url: `${fake.url}/mcp`, bearerToken: 'wrong' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorCallError);
    expect(err.code).toBe('unauthorized');
    expect(err.retryable).toBe(false);
  });

  it('refuses to follow a redirect (it would drop the Authorization header)', async () => {
    const err = await mcp
      .probe({ connectorId: 'c3', url: `${fake.url}/redirect`, bearerToken: SECRET })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorCallError);
    expect(err.code).toBe('redirect');
  });

  it('reports a server that is not there as unreachable and retryable', async () => {
    const err = await mcp
      .probe({ connectorId: 'c4', url: 'http://127.0.0.1:1/mcp', bearerToken: SECRET })
      .catch((e) => e);
    expect(err.code).toBe('unreachable');
    expect(err.retryable).toBe(true);
  });

  it('refuses private hosts unless allowed', async () => {
    const strict = new McpClientService({ get: () => undefined } as any);
    const err = await strict
      .probe({ connectorId: 'c5', url: `${fake.url}/mcp`, bearerToken: SECRET })
      .catch((e) => e);
    expect(err.code).toBe('blocked_host');
    await strict.onModuleDestroy();
  });
});

// ---------------------------------------------------------------------------
// ConnectorsService: the credential is write-only.
// ---------------------------------------------------------------------------

function fakeEncryption() {
  return {
    encrypt: (data: Record<string, string>) => `enc:${Buffer.from(JSON.stringify(data)).toString('base64')}`,
    decrypt: (s: string) => JSON.parse(Buffer.from(s.slice(4), 'base64').toString('utf8')),
  };
}

function connectorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    userId: 'u1',
    name: 'ELIAS',
    handle: 'elias',
    kind: 'MCP',
    url: 'https://elias.apps.c4dhi.org/mcp',
    authType: 'BEARER',
    credentialEncrypted: fakeEncryption().encrypt({ token: 'tok-123' }),
    status: 'UNTESTED',
    lastError: null,
    lastCheckedAt: null,
    toolsSnapshot: null,
    serverInfo: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ConnectorsService', () => {
  function make(row = connectorRow()) {
    const prisma = {
      connector: {
        create: jest.fn(async (args: any) => connectorRow({ ...args.data })),
        findFirst: jest.fn(async ({ where }: any) => (where.userId === row.userId && where.id === row.id ? row : null)),
        findMany: jest.fn(async () => [row]),
        update: jest.fn(async (args: any) => connectorRow({ ...row, ...args.data })),
        delete: jest.fn(async () => row),
      },
    };
    const mcp = {
      probe: jest.fn(async () => ({
        serverInfo: { name: 'elias' },
        tools: [{ name: 'start_interview', description: 'x', inputSchema: {} }],
      })),
      evict: jest.fn(async () => undefined),
      classify: (e: unknown) => e,
    };
    const audit = { record: jest.fn(async () => undefined) };
    const service = new ConnectorsService(prisma as any, fakeEncryption() as any, mcp as any, audit as any);
    return { service, prisma, mcp, audit };
  }

  it('encrypts the token, normalises the URL and never returns the credential', async () => {
    const { service, prisma } = make();
    const created = await service.create('u1', {
      name: 'ELIAS',
      handle: 'elias',
      url: 'https://elias.apps.c4dhi.org//mcp/',
      token: 'tok-123',
    });
    const data = (prisma.connector.create.mock.calls[0][0] as any).data;
    expect(data.url).toBe('https://elias.apps.c4dhi.org/mcp');
    expect(data.credentialEncrypted).not.toContain('tok-123');
    expect(JSON.stringify(created)).not.toContain('tok-123');
    expect(JSON.stringify(created)).not.toContain(data.credentialEncrypted);
    expect(created).not.toHaveProperty('credentialEncrypted');
    expect(created.hasCredential).toBe(true);
  });

  it('needs a token for bearer auth', async () => {
    const { service } = make();
    await expect(service.create('u1', { name: 'x', handle: 'x', url: 'https://h/mcp' })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('test stores the tool snapshot and passes the decrypted token to the client', async () => {
    const { service, prisma, mcp, audit } = make();
    const res = await service.test('c1', 'u1');
    expect(res.ok).toBe(true);
    expect((mcp.probe.mock.calls[0] as any)[0]).toMatchObject({ bearerToken: 'tok-123' });
    const update = (prisma.connector.update.mock.calls[0][0] as any).data;
    expect(update.status).toBe('OK');
    expect(update.toolsSnapshot).toEqual([{ name: 'start_interview', description: 'x', inputSchema: {} }]);
    expect(res.connector.tools?.[0].name).toBe('start_interview');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ operation: 'initialize', success: true }));
  });

  it('test records a failure without throwing', async () => {
    const { service, mcp } = make();
    mcp.probe.mockRejectedValueOnce(new ConnectorCallError('unauthorized', 'refused') as never);
    const res = await service.test('c1', 'u1');
    expect(res).toMatchObject({ ok: false, errorCode: 'unauthorized' });
    expect(res.connector.status).toBe('error');
  });

  it("does not show or test another user's connector", async () => {
    const { service } = make();
    await expect(service.get('c1', 'someone-else')).rejects.toThrow(/not found/);
    await expect(service.test('c1', 'someone-else')).rejects.toThrow(/not found/);
  });

  it('changing the token resets the status and drops the cached connection', async () => {
    const { service, prisma, mcp } = make(connectorRow({ status: 'OK' }));
    await service.update('c1', 'u1', { token: 'new' });
    const data = (prisma.connector.update.mock.calls[0][0] as any).data;
    expect(data.status).toBe('UNTESTED');
    expect(mcp.evict).toHaveBeenCalledWith('c1');
  });
});

// ---------------------------------------------------------------------------
// Gateway + gRPC controller: agents only reach their own bound connectors.
// ---------------------------------------------------------------------------

describe('ConnectorGatewayService via ConnectorsGrpcController', () => {
  const { token, hash } = issueAgentConnectorToken();

  function make() {
    const connector = connectorRow({
      status: 'OK',
      toolsSnapshot: [{ name: 'start_interview', description: 'Start', inputSchema: { type: 'object' } }],
    });
    const prisma = {
      agentInstance: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 'agent-1'
            ? {
                id: 'agent-1',
                sessionId: 's1',
                connectorTokenHash: hash,
                connectorBindings: [{ handle: 'interview', connectorId: 'c1', slot: 'interview' }],
              }
            : null,
        ),
      },
      connector: {
        findMany: jest.fn(async () => [connector]),
        findUnique: jest.fn(async ({ where }: any) => (where.id === 'c1' ? connector : null)),
      },
    };
    const connectors = new ConnectorsService(prisma as any, fakeEncryption() as any, {} as any, {} as any);
    const mcp = {
      callTool: jest.fn(async () => ({
        isError: false,
        structuredContent: { interviewId: 'iv-1' },
        content: [{ type: 'text', text: '{"interviewId":"iv-1"}' }],
      })),
      listTools: jest.fn(async () => [{ name: 'start_interview' }]),
      classify: (e: unknown) => e,
    };
    const audit = { record: jest.fn(async () => undefined) };
    const gateway = new ConnectorGatewayService(prisma as any, connectors, mcp as any, audit as any);
    return { controller: new ConnectorsGrpcController(gateway), mcp, audit };
  }

  const meta = (value?: string) => ({ get: (key: string) => (key === 'x-stella-connector-token' && value ? [value] : []) });

  it('lists the bound connectors with their tool snapshot', async () => {
    const { controller } = make();
    const res: any = await controller.listConnectors({ agentId: 'agent-1' }, meta(token) as any);
    expect(res.success).toBe(true);
    expect(res.connectors).toEqual([
      {
        handle: 'interview',
        slot: 'interview',
        name: 'ELIAS',
        status: 'ok',
        tools: [{ name: 'start_interview', description: 'Start', inputSchemaJson: '{"type":"object"}' }],
      },
    ]);
  });

  it('calls the tool with the decrypted credential, which never reaches the response', async () => {
    const { controller, mcp, audit } = make();
    const res: any = await controller.callTool(
      { agentId: 'agent-1', handle: 'interview', tool: 'start_interview', argumentsJson: '{"project":"p"}' },
      meta(token) as any,
    );
    expect(res).toMatchObject({ success: true, isError: false, structuredContentJson: '{"interviewId":"iv-1"}' });
    expect((mcp.callTool.mock.calls[0] as any)[0]).toMatchObject({ bearerToken: 'tok-123' });
    expect(JSON.stringify(res)).not.toContain('tok-123');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'tools/call', tool: 'start_interview', agentInstanceId: 'agent-1', success: true }),
    );
  });

  it('refuses a wrong or missing token', async () => {
    const { controller, mcp } = make();
    for (const m of [meta('wrong'), meta(undefined)]) {
      const res: any = await controller.callTool(
        { agentId: 'agent-1', handle: 'interview', tool: 'start_interview', argumentsJson: '' },
        m as any,
      );
      expect(res).toMatchObject({ success: false, error: { code: 'unauthenticated', retryable: false } });
    }
    // Another agent's id with this agent's token gets nothing either.
    const other: any = await controller.listConnectors({ agentId: 'agent-2' }, meta(token) as any);
    expect(other.error.code).toBe('unauthenticated');
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it('refuses a handle not bound to this agent, and bad arguments', async () => {
    const { controller } = make();
    const unbound: any = await controller.callTool(
      { agentId: 'agent-1', handle: 'elias', tool: 'start_interview', argumentsJson: '{}' },
      meta(token) as any,
    );
    expect(unbound.error.code).toBe('not_bound');
    const bad: any = await controller.callTool(
      { agentId: 'agent-1', handle: 'interview', tool: 'start_interview', argumentsJson: '[1]' },
      meta(token) as any,
    );
    expect(bad.error.code).toBe('invalid_arguments');
  });

  it('passes a tool error through as is_error with the tool message', async () => {
    const { controller, mcp } = make();
    mcp.callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'project closed' }] } as never);
    const res: any = await controller.callTool(
      { agentId: 'agent-1', handle: 'interview', tool: 'start_interview', argumentsJson: '{}' },
      meta(token) as any,
    );
    expect(res).toMatchObject({ success: false, isError: true, error: { code: 'tool_error', message: 'project closed' } });
  });

  it('marks timeouts retryable', async () => {
    const { controller, mcp } = make();
    mcp.callTool.mockRejectedValueOnce(new ConnectorCallError('timeout', 'slow') as never);
    const res: any = await controller.callTool(
      { agentId: 'agent-1', handle: 'interview', tool: 'start_interview', argumentsJson: '{}' },
      meta(token) as any,
    );
    expect(res.error).toEqual({ code: 'timeout', message: 'slow', retryable: true });
    expect(new GatewayError('timeout', 'x', true).retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Manifest: x-stella-connectors
// ---------------------------------------------------------------------------

describe('x-stella-connectors in agent.yaml', () => {
  const base = `
version: "1.0"
metadata:
  name: ELIAS Interviewer
  slug: elias-interviewer
  version: 0.1.0
  description: Runs ELIAS interviews
image:
  dockerfile: Dockerfile
`;

  it('accepts declared slots and fills in defaults', () => {
    const result = parseAgentManifestYaml(`${base}
x-stella-connectors:
  - slot: interview
    kind: mcp
    required: true
    label: ELIAS server
    description: Where interview questions come from
    requiredTools: [get_interview_guide, start_interview]
  - slot: notes
    kind: mcp
    label: Optional notes
`);
    expect(result.errors).toEqual([]);
    expect(result.manifest?.['x-stella-connectors']).toEqual([
      {
        slot: 'interview',
        kind: 'mcp',
        required: true,
        label: 'ELIAS server',
        description: 'Where interview questions come from',
        requiredTools: ['get_interview_guide', 'start_interview'],
      },
      { slot: 'notes', kind: 'mcp', required: false, label: 'Optional notes', requiredTools: [] },
    ]);
  });

  it.each([
    ['an unknown kind', '  - { slot: a, kind: rest, label: A }'],
    ['a bad slot name', '  - { slot: Bad_Name, kind: mcp, label: A }'],
    ['a missing label', '  - { slot: a, kind: mcp }'],
    ['an unknown key', '  - { slot: a, kind: mcp, label: A, token: secret }'],
    ['a duplicate slot', '  - { slot: a, kind: mcp, label: A }\n  - { slot: a, kind: mcp, label: B }'],
  ])('rejects %s', (_name, entries) => {
    const result = parseAgentManifestYaml(`${base}\nx-stella-connectors:\n${entries}\n`);
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/x-stella-connectors/);
  });

  it('is optional', () => {
    const result = parseAgentManifestYaml(base);
    expect(result.valid).toBe(true);
    expect(result.manifest?.['x-stella-connectors']).toBeUndefined();
  });
});
