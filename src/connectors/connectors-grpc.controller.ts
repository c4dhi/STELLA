import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { CONNECTOR_TOKEN_METADATA } from './agent-connector-token.util.js';
import {
  ConnectorGatewayService,
  GatewayError,
} from './connector-gateway.service.js';
import type { McpToolInfo } from './mcp-client.service.js';

interface WireError {
  code: string;
  message: string;
  retryable: boolean;
}

function wireTool(t: McpToolInfo) {
  return {
    name: t.name,
    description: t.description ?? '',
    inputSchemaJson: JSON.stringify(t.inputSchema ?? {}),
  };
}

/**
 * gRPC ConnectorService (proto/connectors.proto). Agents reach their bound
 * connectors here; failures come back as { success: false, error } so the SDK
 * can raise a typed ConnectorError, as the state-machine service does.
 */
@Controller()
export class ConnectorsGrpcController {
  private readonly logger = new Logger(ConnectorsGrpcController.name);

  constructor(private readonly gateway: ConnectorGatewayService) {}

  @GrpcMethod('ConnectorService', 'ListConnectors')
  async listConnectors(request: { agentId: string }, metadata: Metadata) {
    return this.handle(async () => {
      const ctx = await this.gateway.authenticate(request.agentId, this.token(metadata));
      const connectors = await this.gateway.listConnectors(ctx);
      return {
        success: true,
        connectors: connectors.map((c) => ({
          handle: c.handle,
          slot: c.slot ?? '',
          name: c.name,
          status: c.status,
          tools: c.tools.map(wireTool),
        })),
      };
    });
  }

  @GrpcMethod('ConnectorService', 'ListTools')
  async listTools(request: { agentId: string; handle: string }, metadata: Metadata) {
    return this.handle(async () => {
      const ctx = await this.gateway.authenticate(request.agentId, this.token(metadata));
      const tools = await this.gateway.listTools(ctx, request.handle);
      return { success: true, tools: tools.map(wireTool) };
    });
  }

  @GrpcMethod('ConnectorService', 'CallTool')
  async callTool(
    request: { agentId: string; handle: string; tool: string; argumentsJson: string },
    metadata: Metadata,
  ) {
    return this.handle(async () => {
      const ctx = await this.gateway.authenticate(request.agentId, this.token(metadata));
      const result = await this.gateway.callTool(ctx, request.handle, request.tool, request.argumentsJson);
      const contentJson = JSON.stringify(result.content ?? []);
      const structuredContentJson =
        result.structuredContent === undefined ? 'null' : JSON.stringify(result.structuredContent);
      if (result.isError) {
        return {
          success: false,
          isError: true,
          error: { code: 'tool_error', message: this.textOf(result.content), retryable: false },
          structuredContentJson,
          contentJson,
        };
      }
      return { success: true, isError: false, structuredContentJson, contentJson };
    });
  }

  private token(metadata: Metadata | undefined): string {
    const value = metadata?.get?.(CONNECTOR_TOKEN_METADATA)?.[0];
    return typeof value === 'string' ? value : value ? value.toString() : '';
  }

  private textOf(content: unknown[]): string {
    const text = content
      .map((c) => (c && typeof c === 'object' && (c as any).type === 'text' ? String((c as any).text) : ''))
      .filter(Boolean)
      .join('\n');
    return text.slice(0, 2000) || 'The tool reported an error';
  }

  private async handle<T extends object>(run: () => Promise<T>): Promise<T | { success: false; error: WireError }> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GatewayError) {
        return { success: false, error: { code: error.code, message: error.message, retryable: error.retryable } };
      }
      this.logger.error(`ConnectorService failed: ${(error as Error).message}`);
      return { success: false, error: { code: 'internal', message: 'Connector call failed inside STELLA', retryable: true } };
    }
  }
}
