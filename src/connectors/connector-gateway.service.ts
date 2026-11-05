import { Injectable, Logger } from '@nestjs/common';
import { Connector } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConnectorAuditService } from './connector-audit.service.js';
import { ConnectorBinding, readBindings } from './connector-bindings.util.js';
import { agentConnectorTokenMatches } from './agent-connector-token.util.js';
import { ConnectorsService } from './connectors.service.js';
import {
  ConnectorCallError,
  McpCallResult,
  McpClientService,
  McpToolInfo,
} from './mcp-client.service.js';

export type GatewayErrorCode =
  | ConnectorCallError['code']
  | 'not_bound'
  | 'unauthenticated'
  | 'tool_error'
  | 'internal';

/** An error an agent can act on; `retryable` says whether trying again can help. */
export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

interface AgentContext {
  agentId: string;
  sessionId: string;
  projectId: string;
  deployedByUserId: string | null;
  bindings: ConnectorBinding[];
}

export interface BoundConnectorInfo {
  handle: string;
  slot?: string;
  name: string;
  status: string;
  tools: McpToolInfo[];
}

/**
 * The agent side of Connectors: resolves agent → its bindings → connector →
 * decrypted credential, all server-side, and calls the MCP server for it.
 * An agent proves who it is with the per-pod token, and can only reach the
 * connectors bound to its own instance.
 */
@Injectable()
export class ConnectorGatewayService {
  private readonly logger = new Logger(ConnectorGatewayService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly mcp: McpClientService,
    private readonly audit: ConnectorAuditService,
  ) {}

  async authenticate(agentId: string, token: string): Promise<AgentContext> {
    if (!agentId || !token) {
      throw new GatewayError('unauthenticated', 'Missing agent id or connector token');
    }
    const instance = await this.prisma.agentInstance.findUnique({
      where: { id: agentId },
      select: {
        id: true,
        sessionId: true,
        deployedByUserId: true,
        connectorBindings: true,
        connectorTokenHash: true,
        session: { select: { projectId: true } },
      },
    });
    if (!instance || !agentConnectorTokenMatches(token, instance.connectorTokenHash)) {
      throw new GatewayError('unauthenticated', 'This agent is not allowed to use connectors');
    }
    return {
      agentId: instance.id,
      sessionId: instance.sessionId,
      projectId: instance.session.projectId,
      deployedByUserId: instance.deployedByUserId,
      bindings: readBindings(instance.connectorBindings),
    };
  }

  async listConnectors(ctx: AgentContext): Promise<BoundConnectorInfo[]> {
    if (ctx.bindings.length === 0) return [];
    const rows = await this.prisma.connector.findMany({
      where: { id: { in: ctx.bindings.map((b) => b.connectorId) }, ...this.accessFilter(ctx) },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ctx.bindings.flatMap((b) => {
      const c = byId.get(b.connectorId);
      if (!c) return []; // deleted, or unshared from this project, since the deploy
      return [
        {
          handle: b.handle,
          slot: b.slot,
          name: c.name,
          status: c.status.toLowerCase(),
          tools: (c.toolsSnapshot as unknown as McpToolInfo[] | null) ?? [],
        },
      ];
    });
  }

  async listTools(ctx: AgentContext, handle: string): Promise<McpToolInfo[]> {
    const connector = await this.bound(ctx, handle);
    return this.audited(ctx, connector, 'tools/list', undefined, undefined, () =>
      this.mcp.listTools(this.connectors.target(connector)),
    );
  }

  async callTool(
    ctx: AgentContext,
    handle: string,
    tool: string,
    argumentsJson: string,
  ): Promise<McpCallResult> {
    if (!tool) throw new GatewayError('invalid_arguments', 'No tool name given');
    let args: Record<string, unknown> = {};
    if (argumentsJson && argumentsJson.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(argumentsJson);
      } catch {
        throw new GatewayError('invalid_arguments', 'arguments_json is not valid JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new GatewayError('invalid_arguments', 'arguments_json must be a JSON object');
      }
      args = parsed as Record<string, unknown>;
    }
    const connector = await this.bound(ctx, handle);
    return this.audited(ctx, connector, 'tools/call', tool, args, () =>
      this.mcp.callTool(this.connectors.target(connector), tool, args),
    );
  }

  private async bound(ctx: AgentContext, handle: string): Promise<Connector> {
    const binding = ctx.bindings.find((b) => b.handle === handle);
    if (!binding) {
      const known = ctx.bindings.map((b) => b.handle).join(', ') || 'none';
      throw new GatewayError('not_bound', `No connector "${handle}" is bound to this agent (bound: ${known})`);
    }
    const connector = await this.prisma.connector.findUnique({
      where: { id: binding.connectorId },
      include: { shares: { where: { projectId: ctx.projectId }, select: { id: true } } },
    });
    if (!connector) {
      throw new GatewayError('not_bound', `The connector bound as "${handle}" was deleted by its owner`);
    }
    // Re-checked on every call: a connector stops working the moment its owner
    // unshares it from this project, not at the next deploy.
    const own = ctx.deployedByUserId !== null && connector.userId === ctx.deployedByUserId;
    if (!own && connector.shares.length === 0) {
      throw new GatewayError(
        'not_bound',
        `The connector bound as "${handle}" is no longer shared with this project`,
      );
    }
    return connector;
  }

  /** Prisma filter for connectors this instance may still use. */
  private accessFilter(ctx: AgentContext) {
    const shared = { shares: { some: { projectId: ctx.projectId } } };
    return ctx.deployedByUserId
      ? { OR: [{ userId: ctx.deployedByUserId }, shared] }
      : shared;
  }

  private async audited<T extends McpToolInfo[] | McpCallResult>(
    ctx: AgentContext,
    connector: Connector,
    operation: 'tools/list' | 'tools/call',
    tool: string | undefined,
    args: Record<string, unknown> | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now();
    const base = {
      connectorId: connector.id,
      userId: connector.userId,
      agentInstanceId: ctx.agentId,
      sessionId: ctx.sessionId,
      operation,
      tool,
      args,
    };
    try {
      const result = await run();
      const isError = operation === 'tools/call' && (result as McpCallResult).isError;
      await this.audit.record({
        ...base,
        success: !isError,
        errorCode: isError ? 'tool_error' : undefined,
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      const failure =
        error instanceof ConnectorCallError ? error : this.mcp.classify(error);
      await this.audit.record({
        ...base,
        success: false,
        errorCode: failure.code,
        durationMs: Date.now() - started,
      });
      throw new GatewayError(failure.code, failure.message, failure.retryable);
    }
  }
}
