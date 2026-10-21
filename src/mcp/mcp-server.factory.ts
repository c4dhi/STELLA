import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpAuditService } from './mcp-audit.service.js';
import {
  MCP_TOOL_PROVIDERS,
  McpAuthContext,
  McpToolContext,
  McpToolDefinition,
  McpToolProvider,
} from './mcp.types.js';

// The version of the tool surface, not of the backend.
const SERVER_INFO = { name: 'stella', version: '1.0.0' };

const INSTRUCTIONS = [
  'STELLA hosts conversational voice agents. An agent is deployed from three parts the user owns:',
  'an agent configuration (pipeline settings for one agent type), a persona (who the agent is: system prompt, voice, language)',
  'and a plan template (what happens in the conversation: states, tasks, deliverables).',
  'Sessions belong to projects and hold the transcript and plan state of past conversations.',
  'Read before you write: fetch an existing item to see its exact structure before creating or updating one.',
].join(' ');

// The same settings as the global pipe in main.ts.
const validationPipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

function errorResult(status: number, message: string): CallToolResult {
  return {
    isError: true,
    content: [
      { type: 'text', text: JSON.stringify({ error: { status, message } }) },
    ],
  };
}

function messageOf(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join('; ');
  return typeof message === 'string' ? message : error.message;
}

/**
 * Builds one McpServer per request (stateless Streamable HTTP), exposing only
 * the tools the caller's token scopes allow. Every call goes through run():
 * scope check, handler, error mapping, audit row.
 */
@Injectable()
export class McpServerFactory {
  private readonly logger = new Logger(McpServerFactory.name);
  private readonly tools: McpToolDefinition[];

  constructor(
    @Inject(MCP_TOOL_PROVIDERS) providers: McpToolProvider[],
    private readonly audit: McpAuditService,
  ) {
    this.tools = providers.flatMap((p) => p.tools());
    const names = new Set<string>();
    for (const tool of this.tools) {
      if (names.has(tool.name))
        throw new Error(`Duplicate MCP tool name: ${tool.name}`);
      names.add(tool.name);
    }
  }

  /** Tool names a token with these scopes can see, for tests and logs. */
  toolNamesFor(auth: Pick<McpAuthContext, 'scopes'>): string[] {
    return this.tools
      .filter((t) => auth.scopes.includes(t.scope))
      .map((t) => t.name);
  }

  create(auth: McpAuthContext): McpServer {
    const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
    for (const tool of this.tools) {
      if (!auth.scopes.includes(tool.scope)) continue;
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.input,
          annotations: tool.annotations,
        },
        (args: unknown) => this.run(tool, args, auth),
      );
    }
    return server;
  }

  async run(
    tool: McpToolDefinition,
    args: unknown,
    auth: McpAuthContext,
  ): Promise<CallToolResult> {
    const started = Date.now();
    let success = false;
    let errorCode: string | undefined;
    const ctx: McpToolContext = {
      auth,
      validate: (dto, value) =>
        validationPipe.transform(value ?? {}, { type: 'body', metatype: dto }),
    };
    try {
      // Tools a token cannot use are not listed, but a client may still call one by name.
      if (!auth.scopes.includes(tool.scope)) {
        errorCode = 'insufficient_scope';
        return errorResult(
          403,
          `This access token does not have the ${tool.scope} scope`,
        );
      }
      const result = await tool.handler((args ?? {}) as never, ctx);
      // Round-trip to plain JSON (Dates become strings) so structuredContent matches the text.
      const json = JSON.parse(JSON.stringify(result)) as Record<
        string,
        unknown
      >;
      success = true;
      return {
        content: [{ type: 'text', text: JSON.stringify(json, null, 2) }],
        structuredContent: json,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        errorCode = String(error.getStatus());
        return errorResult(error.getStatus(), messageOf(error));
      }
      errorCode = 'internal';
      this.logger.error(
        `MCP tool ${tool.name} failed: ${error?.message}`,
        error?.stack,
      );
      return errorResult(500, 'The tool failed with an internal error');
    } finally {
      await this.audit.record({
        userId: auth.user.userId,
        tokenId: auth.tokenId,
        oauthGrantId: auth.oauthGrantId,
        tool: tool.name,
        args,
        success,
        errorCode,
        durationMs: Date.now() - started,
      });
    }
  }
}
