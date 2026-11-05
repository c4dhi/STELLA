import { jest } from '@jest/globals';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { BadRequestException } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  assertPublicHost,
  isPrivateAddress,
  normalizeConnectorUrl,
} from './connector-url.util.js';
import {
  BlockedHostError,
  createGuardedAgent,
  createGuardedFetch,
  makeGuardedLookup,
} from './connector-fetch.util.js';
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
import {
  ConnectorGatewayService,
  GatewayError,
} from './connector-gateway.service.js';
import { ConnectorsGrpcController } from './connectors-grpc.controller.js';
import { connectorSlotsOf } from './connector-bindings.util.js';
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

  it.each(['ftp://host/mcp', 'not a url', 'https://user:pw@host/mcp'])(
    'rejects %s',
    (input) => {
      expect(() => normalizeConnectorUrl(input)).toThrow();
    },
  );
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
    // IPv4-mapped IPv6: Node rewrites these to ::ffff:7f00:1 and so on.
    'http://[::ffff:127.0.0.1]/mcp',
    'http://[::ffff:10.0.0.5]/mcp',
    'http://[::ffff:169.254.169.254]/',
    'http://[0:0:0:0:0:ffff:7f00:1]/mcp',
    'http://[64:ff9b::a9fe:a9fe]/', // NAT64 of 169.254.169.254
    'http://[2002:7f00:1::]/', // 6to4 of 127.0.0.1
    'http://[::127.0.0.1]/', // IPv4-compatible
    'http://[fd00::1]/mcp',
    'http://[fe80::1]/mcp',
    'http://0.0.0.0/mcp',
    'http://metadata.google.internal/',
  ])('refuses %s', async (url) => {
    await expect(
      assertPublicHost(normalizeConnectorUrl(url), false),
    ).rejects.toThrow(/private/);
  });

  it('allows public addresses, and anything when private hosts are allowed', async () => {
    await expect(
      assertPublicHost('https://8.8.8.8/mcp', false),
    ).resolves.toBeUndefined();
    await expect(
      assertPublicHost('http://localhost/mcp', true),
    ).resolves.toBeUndefined();
  });
});

describe('isPrivateAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['::ffff:7f00:1', true],
    ['::ffff:127.0.0.1', true],
    ['::ffff:a00:5', true],
    ['::ffff:a9fe:a9fe', true],
    ['64:ff9b::7f00:1', true],
    ['2002:a00:1::1', true],
    ['::', true],
    ['::1', true],
    ['ff02::1', true],
    ['224.0.0.1', true],
    ['not-an-ip', true],
    ['8.8.8.8', false],
    ['::ffff:8.8.8.8', false],
    ['::ffff:808:808', false],
    ['64:ff9b::808:808', false],
    ['2606:4700:4700::1111', false],
  ])('%s → private=%s', (ip, expected) => {
    expect(isPrivateAddress(ip)).toBe(expected);
  });
});

describe('guarded fetch (the check that runs at connect time)', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('refuses a host that resolves privately at connect time (DNS rebinding)', async () => {
    // The earlier check saw a public address; the socket's own lookup now
    // answers 127.0.0.1. The guard runs in that lookup, so the request fails.
    const agent = createGuardedAgent((_host, _opts, cb) =>
      cb(null, [{ address: '127.0.0.1', family: 4 }]),
    );
    const fetchGuarded = createGuardedFetch(agent);
    const err = await fetchGuarded(`http://rebind.example:${port}/`).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const mcp = new McpClientService({ get: () => undefined } as any);
    expect(mcp.classify(err).code).toBe('blocked_host');
    await mcp.onModuleDestroy();
    await agent.close();
  });

  it('refuses a mapped IPv6 literal before connecting', async () => {
    const agent = createGuardedAgent();
    const err = await createGuardedFetch(agent)(
      `http://[::ffff:127.0.0.1]:${port}/`,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BlockedHostError);
    await agent.close();
  });

  it('passes a public answer through, in both callback shapes', async () => {
    const lookup = makeGuardedLookup((_host, _opts, cb) =>
      cb(null, [{ address: '8.8.8.8', family: 4 }]),
    );
    const single = await new Promise<unknown[]>((resolve) =>
      lookup('public.example', {}, (...args) => resolve(args)),
    );
    expect(single).toEqual([null, '8.8.8.8', 4]);
    const all = await new Promise<unknown[]>((resolve) =>
      lookup('public.example', { all: true }, (...args) => resolve(args)),
    );
    expect(all).toEqual([null, [{ address: '8.8.8.8', family: 4 }]]);
    const mixed = await new Promise<unknown[]>((resolve) =>
      makeGuardedLookup((_h, _o, cb) =>
        cb(null, [
          { address: '8.8.8.8', family: 4 },
          { address: '::ffff:7f00:1', family: 6 },
        ]),
      )('mixed.example', {}, (...args) => resolve(args)),
    );
    expect(mixed[0]).toBeInstanceOf(BlockedHostError);
  });
});

describe('resolveConnectorBindings', () => {
  const owned = [
    {
      id: 'c1',
      handle: 'elias',
      name: 'ELIAS',
      toolsSnapshot: [{ name: 'start_interview' }, { name: 'end_interview' }],
    },
    { id: 'c2', handle: 'notes', name: 'Notes', toolsSnapshot: null },
  ];
  const slots: ConnectorSlot[] = [
    {
      slot: 'interview',
      kind: 'mcp',
      required: true,
      label: 'Interview server',
      requiredTools: ['start_interview'],
    },
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
    expect(
      resolveConnectorBindings(
        [{ connectorId: 'c2', handle: 'my-notes' }],
        null,
        owned,
      ),
    ).toEqual([{ handle: 'my-notes', connectorId: 'c2' }]);
  });

  it('refuses a connector the user does not own', () => {
    expect(() =>
      resolveConnectorBindings([{ connectorId: 'someone-elses' }], null, owned),
    ).toThrow(/neither yours nor shared/);
  });

  it('refuses a missing required slot', () => {
    expect(() => resolveConnectorBindings([], slots, owned)).toThrow(
      /Interview server/,
    );
  });

  it('refuses an undeclared slot, a slot bound twice, and a duplicate handle', () => {
    expect(() =>
      resolveConnectorBindings(
        [{ connectorId: 'c1', slot: 'nope' }],
        slots,
        owned,
      ),
    ).toThrow(/no connector slot/);
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
    const lacking = [
      { ...owned[0], toolsSnapshot: [{ name: 'end_interview' }] },
    ];
    expect(() =>
      resolveConnectorBindings(
        [{ connectorId: 'c1', slot: 'interview' }],
        slots,
        lacking,
      ),
    ).toThrow(/start_interview/);
    // Untested connector: no snapshot, nothing to check yet.
    const untested = [{ ...owned[0], toolsSnapshot: null }];
    expect(
      resolveConnectorBindings(
        [{ connectorId: 'c1', slot: 'interview' }],
        slots,
        untested,
      ),
    ).toHaveLength(1);
  });

  it('reads stored bindings defensively', () => {
    expect(readBindings(null)).toEqual([]);
    expect(
      readBindings([{ handle: 'a', connectorId: 'c' }, { handle: 1 }, 'x']),
    ).toEqual([{ handle: 'a', connectorId: 'c' }]);
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
      content: [
        {
          type: 'text',
          text: JSON.stringify({ interviewId: `iv-${project}` }),
        },
      ],
      structuredContent: { interviewId: `iv-${project}` },
    }),
  );
  server.registerTool('fails', { description: 'Always fails' }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'project closed' }],
  }));
  return server;
}

async function startFakeServer(): Promise<{
  url: string;
  server: Server;
  calls: { auth?: string }[];
}> {
  const calls: { auth?: string }[] = [];
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      calls.push({ auth: req.headers.authorization });
      if (req.url?.startsWith('/redirect')) {
        res.writeHead(307, { Location: 'http://example.invalid/mcp' }).end();
        return;
      }
      if (req.headers.authorization !== `Bearer ${SECRET}`) {
        res
          .writeHead(401, { 'Content-Type': 'application/json' })
          .end('{"error":"unauthorized"}');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : undefined;
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
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server, calls };
}

function clientService(): McpClientService {
  const config = {
    get: (key: string) =>
      ({
        CONNECTORS_ALLOW_PRIVATE_HOSTS: 'true',
        CONNECTORS_CALL_TIMEOUT_MS: '5000',
      })[key],
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
    expect(tools.map((t) => t.name).sort()).toEqual([
      'fails',
      'start_interview',
    ]);
    expect(
      tools.find((t) => t.name === 'start_interview')?.inputSchema,
    ).toMatchObject({
      type: 'object',
      properties: { project: { type: 'string' } },
    });
    expect(fake.calls.every((c) => c.auth === `Bearer ${SECRET}`)).toBe(true);
  });

  it('calls a tool and returns structured content', async () => {
    const target = {
      connectorId: 'c1',
      url: `${fake.url}/mcp`,
      bearerToken: SECRET,
    };
    const result = await mcp.callTool(target, 'start_interview', {
      project: 'p1',
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ interviewId: 'iv-p1' });
    const failed = await mcp.callTool(target, 'fails', {});
    expect(failed.isError).toBe(true);
  });

  it('reports a refused credential as unauthorized, not retryable', async () => {
    const err = await mcp
      .probe({
        connectorId: 'c2',
        url: `${fake.url}/mcp`,
        bearerToken: 'wrong',
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorCallError);
    expect(err.code).toBe('unauthorized');
    expect(err.retryable).toBe(false);
  });

  it('refuses to follow a redirect (it would drop the Authorization header)', async () => {
    const err = await mcp
      .probe({
        connectorId: 'c3',
        url: `${fake.url}/redirect`,
        bearerToken: SECRET,
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorCallError);
    expect(err.code).toBe('redirect');
  });

  it('reports a server that is not there as unreachable and retryable', async () => {
    const err = await mcp
      .probe({
        connectorId: 'c4',
        url: 'http://127.0.0.1:1/mcp',
        bearerToken: SECRET,
      })
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
    const before = fake.calls.length;
    const port = new URL(fake.url).port;
    const mapped = await strict
      .probe({
        connectorId: 'c6',
        url: `http://[::ffff:127.0.0.1]:${port}/mcp`,
        bearerToken: SECRET,
      })
      .catch((e) => e);
    expect(mapped.code).toBe('blocked_host');
    expect(fake.calls.length).toBe(before);
    await strict.onModuleDestroy();
  });
});

// ---------------------------------------------------------------------------
// ConnectorsService: the credential is write-only.
// ---------------------------------------------------------------------------

function fakeEncryption() {
  return {
    encrypt: (data: Record<string, string>) =>
      `enc:${Buffer.from(JSON.stringify(data)).toString('base64')}`,
    decrypt: (s: string) =>
      JSON.parse(Buffer.from(s.slice(4), 'base64').toString('utf8')),
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
  function make(row = connectorRow(), memberOf: string[] = ['p1', 'p2']) {
    let shares: string[] = [];
    const prisma = {
      connector: {
        create: jest.fn(async (args: any) => connectorRow({ ...args.data })),
        findFirst: jest.fn(async ({ where }: any) =>
          where.userId === row.userId && where.id === row.id ? row : null,
        ),
        findMany: jest.fn(async () => [row]),
        update: jest.fn(async (args: any) =>
          connectorRow({ ...row, ...args.data }),
        ),
        delete: jest.fn(async () => row),
        findUniqueOrThrow: jest.fn(async () => ({
          ...row,
          shares: shares.map((projectId) => ({
            projectId,
            project: { name: `Project ${projectId}` },
          })),
        })),
      },
      projectMembership: {
        findMany: jest.fn(async ({ where }: any) =>
          memberOf
            .filter((p) => where.projectId.in.includes(p))
            .map((projectId) => ({ projectId })),
        ),
        findUnique: jest.fn(async ({ where }: any) =>
          memberOf.includes(where.userId_projectId.projectId)
            ? { id: 'm' }
            : null,
        ),
      },
      connectorProjectShare: {
        deleteMany: jest.fn(async ({ where }: any) => {
          shares = shares.filter((p) => where.projectId.notIn.includes(p));
          return { count: 0 };
        }),
        createMany: jest.fn(async ({ data }: any) => {
          for (const d of data)
            if (!shares.includes(d.projectId)) shares.push(d.projectId);
          return { count: data.length };
        }),
      },
      $transaction: jest.fn(async (ops: Promise<unknown>[]) =>
        Promise.all(ops),
      ),
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
    const service = new ConnectorsService(
      prisma as any,
      fakeEncryption() as any,
      mcp as any,
      audit as any,
    );
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
    await expect(
      service.create('u1', { name: 'x', handle: 'x', url: 'https://h/mcp' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('test stores the tool snapshot and passes the decrypted token to the client', async () => {
    const { service, prisma, mcp, audit } = make();
    const res = await service.test('c1', 'u1');
    expect(res.ok).toBe(true);
    expect((mcp.probe.mock.calls[0] as any)[0]).toMatchObject({
      bearerToken: 'tok-123',
    });
    const update = (prisma.connector.update.mock.calls[0][0] as any).data;
    expect(update.status).toBe('OK');
    expect(update.toolsSnapshot).toEqual([
      { name: 'start_interview', description: 'x', inputSchema: {} },
    ]);
    expect(res.connector.tools?.[0].name).toBe('start_interview');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'initialize', success: true }),
    );
  });

  it('test records a failure without throwing', async () => {
    const { service, mcp } = make();
    mcp.probe.mockRejectedValueOnce(
      new ConnectorCallError('unauthorized', 'refused') as never,
    );
    const res = await service.test('c1', 'u1');
    expect(res).toMatchObject({ ok: false, errorCode: 'unauthorized' });
    expect(res.connector.status).toBe('error');
  });

  it("does not show or test another user's connector", async () => {
    const { service } = make();
    await expect(service.get('c1', 'someone-else')).rejects.toThrow(
      /not found/,
    );
    await expect(service.test('c1', 'someone-else')).rejects.toThrow(
      /not found/,
    );
  });

  it('shares with projects the owner belongs to, and replaces the set', async () => {
    const { service, prisma } = make();
    let res = await service.setShares('c1', 'u1', ['p1', 'p2', 'p1']);
    expect(res.sharedWith.map((s) => s.projectId)).toEqual(['p1', 'p2']);
    res = await service.setShares('c1', 'u1', ['p2']);
    expect(res.sharedWith.map((s) => s.projectId)).toEqual(['p2']);
    res = await service.setShares('c1', 'u1', []);
    expect(res.sharedWith).toEqual([]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(res)).not.toContain('tok-123');
  });

  it('refuses to share with a project the owner is not in, and lets only the owner share', async () => {
    const { service } = make();
    await expect(
      service.setShares('c1', 'u1', ['p1', 'not-mine']),
    ).rejects.toThrow(/projects you belong to/);
    await expect(
      service.setShares('c1', 'someone-else', ['p1']),
    ).rejects.toThrow(/not found/);
  });

  it('deploy validation looks at own connectors plus those shared with the project', async () => {
    const { service, prisma } = make();
    (prisma.connector.findMany as any).mockResolvedValueOnce([
      { id: 'c1', handle: 'elias', name: 'ELIAS', toolsSnapshot: null },
    ]);
    const bindings = await service.resolveBindingsForDeploy(
      'member-2',
      'p1',
      [{ connectorId: 'c1', slot: 'elias' }],
      [{ slot: 'elias', kind: 'mcp', required: true, label: 'ELIAS' }],
    );
    expect(bindings).toEqual([
      { handle: 'elias', connectorId: 'c1', slot: 'elias' },
    ]);
    const where = (prisma.connector.findMany.mock.calls[0][0] as any).where;
    expect(where.OR).toEqual([
      { userId: 'member-2' },
      { shares: { some: { projectId: 'p1' } } },
    ]);
    (prisma.connector.findMany as any).mockResolvedValueOnce([]);
    await expect(
      service.resolveBindingsForDeploy(
        'member-2',
        'p1',
        [{ connectorId: 'c9' }],
        [],
      ),
    ).rejects.toThrow(/neither yours nor shared/);
  });

  it('lists available connectors only for project members, without credentials', async () => {
    const { service, prisma } = make();
    (prisma.connector.findMany as any).mockResolvedValueOnce([
      { ...connectorRow(), user: { name: 'Owner', email: 'o@x.test' } },
    ]);
    const list = await service.listAvailable('member-2', 'p1');
    expect(list).toEqual([
      expect.objectContaining({
        id: 'c1',
        owned: false,
        ownerName: 'Owner',
        handle: 'elias',
      }),
    ]);
    expect(JSON.stringify(list)).not.toMatch(/tok-123|enc:/);
    await expect(service.listAvailable('member-2', 'not-mine')).rejects.toThrow(
      /Project not found/,
    );
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

  function make(
    opts: {
      deployedBy?: string;
      sharedWithP1?: boolean;
      status?: string;
      sessionStatus?: string;
    } = {},
  ) {
    const connector = connectorRow({
      status: 'OK',
      toolsSnapshot: [
        {
          name: 'start_interview',
          description: 'Start',
          inputSchema: { type: 'object' },
        },
      ],
    });
    const shares = () => (opts.sharedWithP1 ? [{ id: 's' }] : []);
    const prisma = {
      agentInstance: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 'agent-1'
            ? {
                id: 'agent-1',
                sessionId: 's1',
                status: opts.status ?? 'RUNNING',
                session: {
                  projectId: 'p1',
                  status: opts.sessionStatus ?? 'ACTIVE',
                },
                deployedByUserId: opts.deployedBy ?? 'u1',
                connectorTokenHash: hash,
                connectorBindings: [
                  { handle: 'interview', connectorId: 'c1', slot: 'interview' },
                ],
              }
            : null,
        ),
      },
      connector: {
        // Applies the gateway's access filter the way Postgres would.
        findMany: jest.fn(async ({ where }: any) => {
          const ok = (where.OR ?? [where]).some((w: any) =>
            w.userId
              ? w.userId === connector.userId
              : opts.sharedWithP1 === true,
          );
          return ok ? [connector] : [];
        }),
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 'c1' ? { ...connector, shares: shares() } : null,
        ),
      },
    };
    const connectors = new ConnectorsService(
      prisma as any,
      fakeEncryption() as any,
      {} as any,
      {} as any,
    );
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
    const gateway = new ConnectorGatewayService(
      prisma as any,
      connectors,
      mcp as any,
      audit as any,
    );
    return { controller: new ConnectorsGrpcController(gateway), mcp, audit };
  }

  const meta = (value?: string) => ({
    get: (key: string) =>
      key === 'x-stella-connector-token' && value ? [value] : [],
  });

  it('lists the bound connectors with their tool snapshot', async () => {
    const { controller } = make();
    const res: any = await controller.listConnectors(
      { agentId: 'agent-1' },
      meta(token) as any,
    );
    expect(res.success).toBe(true);
    expect(res.connectors).toEqual([
      {
        handle: 'interview',
        slot: 'interview',
        name: 'ELIAS',
        status: 'ok',
        tools: [
          {
            name: 'start_interview',
            description: 'Start',
            inputSchemaJson: '{"type":"object"}',
          },
        ],
      },
    ]);
  });

  it('calls the tool with the decrypted credential, which never reaches the response', async () => {
    const { controller, mcp, audit } = make();
    const res: any = await controller.callTool(
      {
        agentId: 'agent-1',
        handle: 'interview',
        tool: 'start_interview',
        argumentsJson: '{"project":"p"}',
      },
      meta(token) as any,
    );
    expect(res).toMatchObject({
      success: true,
      isError: false,
      structuredContentJson: '{"interviewId":"iv-1"}',
    });
    expect((mcp.callTool.mock.calls[0] as any)[0]).toMatchObject({
      bearerToken: 'tok-123',
    });
    expect(JSON.stringify(res)).not.toContain('tok-123');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'tools/call',
        tool: 'start_interview',
        agentInstanceId: 'agent-1',
        success: true,
      }),
    );
  });

  it('refuses a wrong or missing token', async () => {
    const { controller, mcp } = make();
    for (const m of [meta('wrong'), meta(undefined)]) {
      const res: any = await controller.callTool(
        {
          agentId: 'agent-1',
          handle: 'interview',
          tool: 'start_interview',
          argumentsJson: '',
        },
        m as any,
      );
      expect(res).toMatchObject({
        success: false,
        error: { code: 'unauthenticated', retryable: false },
      });
    }
    // Another agent's id with this agent's token gets nothing either.
    const other: any = await controller.listConnectors(
      { agentId: 'agent-2' },
      meta(token) as any,
    );
    expect(other.error.code).toBe('unauthenticated');
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it('refuses the token once the agent has stopped or its session closed', async () => {
    for (const opts of [
      { status: 'STOPPED' },
      { status: 'FAILED' },
      { status: 'STOPPING' },
      { sessionStatus: 'CLOSED' },
    ]) {
      const { controller, mcp } = make(opts);
      const res: any = await controller.callTool(
        {
          agentId: 'agent-1',
          handle: 'interview',
          tool: 'start_interview',
          argumentsJson: '',
        },
        meta(token) as any,
      );
      expect(res.error).toMatchObject({
        code: 'unauthenticated',
        message: 'This agent is no longer running',
      });
      expect(mcp.callTool).not.toHaveBeenCalled();
    }
    const { controller } = make({ status: 'STARTING' });
    const res: any = await controller.listConnectors(
      { agentId: 'agent-1' },
      meta(token) as any,
    );
    expect(res.success).toBe(true);
  });

  it('still serves an agent while its session is CLOSING, so it can finish its work', async () => {
    // A plan that reaches its end marks the session CLOSING; the agent then says
    // its closing line and closes the interview in ELIAS through the connector.
    const { controller, mcp } = make({ sessionStatus: 'CLOSING' });
    const res: any = await controller.callTool(
      { agentId: 'agent-1', handle: 'interview', tool: 'start_interview', argumentsJson: '' },
      meta(token) as any,
    );
    expect(res.error).toBeUndefined();
    expect(mcp.callTool).toHaveBeenCalled();
  });

  it('refuses a handle not bound to this agent, and bad arguments', async () => {
    const { controller } = make();
    const unbound: any = await controller.callTool(
      {
        agentId: 'agent-1',
        handle: 'elias',
        tool: 'start_interview',
        argumentsJson: '{}',
      },
      meta(token) as any,
    );
    expect(unbound.error.code).toBe('not_bound');
    const bad: any = await controller.callTool(
      {
        agentId: 'agent-1',
        handle: 'interview',
        tool: 'start_interview',
        argumentsJson: '[1]',
      },
      meta(token) as any,
    );
    expect(bad.error.code).toBe('invalid_arguments');
  });

  it('passes a tool error through as is_error with the tool message', async () => {
    const { controller, mcp } = make();
    mcp.callTool.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'project closed' }],
    } as never);
    const res: any = await controller.callTool(
      {
        agentId: 'agent-1',
        handle: 'interview',
        tool: 'start_interview',
        argumentsJson: '{}',
      },
      meta(token) as any,
    );
    expect(res).toMatchObject({
      success: false,
      isError: true,
      error: { code: 'tool_error', message: 'project closed' },
    });
  });

  it("lets a member's agent use a connector shared with the project, and stops at once when unshared", async () => {
    const shared = make({ deployedBy: 'member-2', sharedWithP1: true });
    const ok: any = await shared.controller.callTool(
      {
        agentId: 'agent-1',
        handle: 'interview',
        tool: 'start_interview',
        argumentsJson: '{}',
      },
      meta(token) as any,
    );
    expect(ok.success).toBe(true);
    // The audit row names the owner, whose credential was used.
    expect(shared.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', agentInstanceId: 'agent-1' }),
    );

    const unshared = make({ deployedBy: 'member-2', sharedWithP1: false });
    const res: any = await unshared.controller.callTool(
      {
        agentId: 'agent-1',
        handle: 'interview',
        tool: 'start_interview',
        argumentsJson: '{}',
      },
      meta(token) as any,
    );
    expect(res.error).toMatchObject({ code: 'not_bound', retryable: false });
    expect(res.error.message).toMatch(/no longer shared with this project/);
    expect(unshared.mcp.callTool).not.toHaveBeenCalled();
    const listed: any = await unshared.controller.listConnectors(
      { agentId: 'agent-1' },
      meta(token) as any,
    );
    expect(listed.connectors).toEqual([]);
  });

  it('marks timeouts retryable', async () => {
    const { controller, mcp } = make();
    mcp.callTool.mockRejectedValueOnce(
      new ConnectorCallError('timeout', 'slow') as never,
    );
    const res: any = await controller.callTool(
      {
        agentId: 'agent-1',
        handle: 'interview',
        tool: 'start_interview',
        argumentsJson: '{}',
      },
      meta(token) as any,
    );
    expect(res.error).toEqual({
      code: 'timeout',
      message: 'slow',
      retryable: true,
    });
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

  it('accepts declared slots in configSchema and fills in defaults', () => {
    const result = parseAgentManifestYaml(`${base}
configSchema:
  type: object
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
    // Manifest 1.0's configSchema flag becomes the 2.0 `connectors` block.
    const slots = result.manifest?.connectors;
    expect(slots).toEqual([
      {
        slot: 'interview',
        kind: 'mcp',
        required: true,
        label: 'ELIAS server',
        description: 'Where interview questions come from',
        requiredTools: ['get_interview_guide', 'start_interview'],
      },
      {
        slot: 'notes',
        kind: 'mcp',
        required: false,
        label: 'Optional notes',
        requiredTools: [],
      },
    ]);
  });

  it.each([
    ['an unknown kind', '  - { slot: a, kind: rest, label: A }'],
    ['a bad slot name', '  - { slot: Bad_Name, kind: mcp, label: A }'],
    ['a missing label', '  - { slot: a, kind: mcp }'],
    ['an unknown key', '  - { slot: a, kind: mcp, label: A, token: secret }'],
    [
      'a duplicate slot',
      '  - { slot: a, kind: mcp, label: A }\n  - { slot: a, kind: mcp, label: B }',
    ],
  ])('rejects %s', (_name, entries) => {
    const indented = entries.replace(/^/gm, '  ');
    const result = parseAgentManifestYaml(
      `${base}\nconfigSchema:\n  x-stella-connectors:\n${indented}\n`,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toMatch(/^connectors\./m);
  });

  it('is optional', () => {
    const result = parseAgentManifestYaml(base);
    expect(result.valid).toBe(true);
    expect(result.manifest?.connectors ?? []).toEqual([]);
  });

  it('is not read at the top level of agent.yaml', () => {
    const result = parseAgentManifestYaml(
      `${base}\nx-stella-connectors:\n  - { slot: a, kind: mcp, label: A }\n`,
    );
    expect((result.manifest as any)?.['x-stella-connectors']).toBeUndefined();
  });
});
