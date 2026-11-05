import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { assertPublicHost } from './connector-url.util.js';

/** What a connection needs. The credential is plaintext here and nowhere past this service. */
export interface McpTarget {
  connectorId: string;
  url: string;
  bearerToken?: string | null;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServerInfo {
  name?: string;
  version?: string;
  protocolVersion?: string;
}

export interface McpCallResult {
  isError: boolean;
  structuredContent?: unknown;
  content: unknown[];
}

export type ConnectorErrorCode =
  | 'unreachable'
  | 'unauthorized'
  | 'timeout'
  | 'protocol'
  | 'redirect'
  | 'blocked_host'
  | 'tool_not_found'
  | 'invalid_arguments';

const RETRYABLE: ReadonlySet<ConnectorErrorCode> = new Set(['unreachable', 'timeout']);

/** A failure talking to the outside server, with whether trying again can help. */
export class ConnectorCallError extends Error {
  readonly retryable: boolean;
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
  ) {
    super(message);
    this.retryable = RETRYABLE.has(code);
  }
}

interface CachedConnection {
  key: string;
  client: Client;
  transport: StreamableHTTPClientTransport;
  serverInfo: McpServerInfo;
  lastUsed: number;
}

const IDLE_MS = 10 * 60 * 1000;

/**
 * STELLA as an MCP CLIENT of outside servers (Connectors). Not to be confused
 * with src/mcp, where STELLA is the server for Claude/ChatGPT.
 *
 * One cached connection per connector, keyed by URL + credential so editing a
 * connector replaces its connection. Idle connections close after 10 minutes.
 * Every request has a timeout. Redirects are refused rather than followed,
 * since a followed redirect drops the Authorization header (see
 * normalizeConnectorUrl).
 */
@Injectable()
export class McpClientService implements OnModuleDestroy {
  private readonly logger = new Logger(McpClientService.name);
  private readonly connections = new Map<string, CachedConnection>();
  private readonly pending = new Map<string, Promise<CachedConnection>>();
  private readonly sweeper: NodeJS.Timeout;

  readonly connectTimeoutMs: number;
  readonly listTimeoutMs: number;
  readonly callTimeoutMs: number;
  private readonly allowPrivateHosts: boolean;

  constructor(config: ConfigService) {
    const num = (key: string, fallback: number) => {
      const value = Number(config.get<string>(key));
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    this.connectTimeoutMs = num('CONNECTORS_CONNECT_TIMEOUT_MS', 10_000);
    this.listTimeoutMs = num('CONNECTORS_LIST_TIMEOUT_MS', 15_000);
    this.callTimeoutMs = num('CONNECTORS_CALL_TIMEOUT_MS', 60_000);
    this.allowPrivateHosts =
      config.get<string>('CONNECTORS_ALLOW_PRIVATE_HOSTS') === 'true';
    this.sweeper = setInterval(() => this.closeIdle(), 60_000);
    this.sweeper.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.connections.keys()].map((id) => this.evict(id)));
  }

  /** initialize + tools/list on a fresh connection; used by "Test connection". */
  async probe(target: McpTarget): Promise<{ serverInfo: McpServerInfo; tools: McpToolInfo[] }> {
    await this.evict(target.connectorId);
    const conn = await this.connection(target);
    const tools = await this.listTools(target);
    return { serverInfo: conn.serverInfo, tools };
  }

  async listTools(target: McpTarget): Promise<McpToolInfo[]> {
    return this.withConnection(target, async (conn) => {
      const tools: McpToolInfo[] = [];
      let cursor: string | undefined;
      // A server may page tools/list; ten pages is far beyond any real server.
      for (let page = 0; page < 10; page++) {
        const res = await conn.client.listTools(cursor ? { cursor } : undefined, {
          timeout: this.listTimeoutMs,
        });
        for (const t of res.tools) {
          tools.push({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as Record<string, unknown>,
          });
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      return tools;
    });
  }

  async callTool(
    target: McpTarget,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    return this.withConnection(target, async (conn) => {
      const res = await conn.client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: this.callTimeoutMs,
      });
      return {
        isError: res.isError === true,
        structuredContent: res.structuredContent,
        content: Array.isArray(res.content) ? res.content : [],
      };
    });
  }

  /** Drop a connector's cached connection (after it is edited or deleted). */
  async evict(connectorId: string): Promise<void> {
    const conn = this.connections.get(connectorId);
    this.connections.delete(connectorId);
    if (conn) await this.close(conn);
  }

  private async withConnection<T>(
    target: McpTarget,
    run: (conn: CachedConnection) => Promise<T>,
  ): Promise<T> {
    const conn = await this.connection(target);
    try {
      const result = await run(conn);
      conn.lastUsed = Date.now();
      return result;
    } catch (error) {
      const mapped = this.classify(error);
      // A broken transport is not reused; the next call reconnects. The call
      // itself is NOT retried here: tools/call may have side effects.
      if (mapped.code !== 'tool_not_found' && mapped.code !== 'invalid_arguments') {
        await this.evict(target.connectorId);
      }
      throw mapped;
    }
  }

  private connectionKey(target: McpTarget): string {
    return createHash('sha256')
      .update(`${target.url}\n${target.bearerToken ?? ''}`)
      .digest('hex');
  }

  private async connection(target: McpTarget): Promise<CachedConnection> {
    const key = this.connectionKey(target);
    const cached = this.connections.get(target.connectorId);
    if (cached && cached.key === key) return cached;
    if (cached) await this.evict(target.connectorId);

    const pendingKey = `${target.connectorId}:${key}`;
    const inFlight = this.pending.get(pendingKey);
    if (inFlight) return inFlight;

    const opening = this.open(target, key).finally(() => this.pending.delete(pendingKey));
    this.pending.set(pendingKey, opening);
    return opening;
  }

  private async open(target: McpTarget, key: string): Promise<CachedConnection> {
    try {
      await assertPublicHost(target.url, this.allowPrivateHosts);
    } catch (error) {
      throw new ConnectorCallError('blocked_host', (error as Error).message);
    }

    const headers: Record<string, string> = {};
    if (target.bearerToken) headers.Authorization = `Bearer ${target.bearerToken}`;
    const transport = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: { headers, redirect: 'error' },
      // Agents' calls are request/response; no resumable GET stream needed.
      reconnectionOptions: {
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 500,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    });
    const client = new Client({ name: 'stella-connectors', version: '1.0.0' });
    try {
      await client.connect(transport, { timeout: this.connectTimeoutMs });
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw this.classify(error);
    }
    const version = client.getServerVersion();
    const conn: CachedConnection = {
      key,
      client,
      transport,
      serverInfo: {
        name: version?.name,
        version: version?.version,
        protocolVersion: transport.protocolVersion,
      },
      lastUsed: Date.now(),
    };
    this.connections.set(target.connectorId, conn);
    return conn;
  }

  private async close(conn: CachedConnection): Promise<void> {
    try {
      await conn.client.close();
    } catch (error) {
      this.logger.debug(`Closing MCP connection failed: ${(error as Error).message}`);
    }
  }

  private closeIdle(): void {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, conn] of this.connections) {
      if (conn.lastUsed < cutoff) void this.evict(id);
    }
  }

  /** Map SDK, HTTP and network errors onto the codes agents can act on. */
  classify(error: unknown): ConnectorCallError {
    if (error instanceof ConnectorCallError) return error;
    const message = (error as Error)?.message ?? String(error);

    if (error instanceof McpError) {
      if (error.code === ErrorCode.RequestTimeout)
        return new ConnectorCallError('timeout', 'The connector did not answer in time');
      if (error.code === ErrorCode.ConnectionClosed)
        return new ConnectorCallError('unreachable', 'The connection to the connector closed');
      if (error.code === ErrorCode.InvalidParams) {
        return /unknown tool|not found/i.test(message)
          ? new ConnectorCallError('tool_not_found', message)
          : new ConnectorCallError('invalid_arguments', message);
      }
      if (error.code === ErrorCode.MethodNotFound)
        return new ConnectorCallError('protocol', message);
      return new ConnectorCallError('protocol', message);
    }

    if (error instanceof StreamableHTTPError) {
      const status = error.code ?? 0;
      if (status === 401 || status === 403)
        return new ConnectorCallError(
          'unauthorized',
          `The server refused the credential (HTTP ${status})`,
        );
      if (status === 404)
        return new ConnectorCallError('protocol', 'No MCP endpoint at this URL (HTTP 404)');
      if (status >= 500 || status === 429)
        return new ConnectorCallError('unreachable', `The server is having trouble (HTTP ${status})`);
      return new ConnectorCallError('protocol', message);
    }

    if (/redirect/i.test(message) || /unexpected redirect/i.test(String((error as any)?.cause)))
      return new ConnectorCallError(
        'redirect',
        'The server answered with a redirect. Check the URL (no trailing slash, https).',
      );
    if (/HTTP 40[13]|unauthori[sz]ed|forbidden/i.test(message))
      return new ConnectorCallError('unauthorized', 'The server refused the credential');
    if (/timed? ?out|ETIMEDOUT|AbortError/i.test(message))
      return new ConnectorCallError('timeout', 'The connector did not answer in time');
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket|network/i.test(message))
      return new ConnectorCallError('unreachable', `Could not reach the server: ${message}`);
    return new ConnectorCallError('protocol', message);
  }
}
