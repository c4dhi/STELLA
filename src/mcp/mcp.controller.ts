import { Controller, Delete, Get, HttpException, HttpStatus, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Public } from '../common/decorators/public.decorator.js';
import { McpEnabledGuard } from './guards/mcp-enabled.guard.js';
import { McpOriginGuard } from './guards/mcp-origin.guard.js';
import { PatAuthGuard } from './guards/pat-auth.guard.js';
import { McpServerFactory } from './mcp-server.factory.js';
import { McpAuthContext } from './mcp.types.js';

/**
 * The remote MCP endpoint (#772): Streamable HTTP, stateless, so any backend
 * replica can answer any request. Public to the global JWT guard; the guards
 * below run in order: switched on, allowed origin, valid access token.
 */
@Public()
@Controller('mcp')
@UseGuards(McpEnabledGuard, McpOriginGuard, PatAuthGuard)
export class McpController {
  private readonly logger = new Logger(McpController.name);

  constructor(private readonly serverFactory: McpServerFactory) {}

  @Post()
  async handle(@Req() req: Request & { mcpAuth: McpAuthContext }, @Res() res: Response): Promise<void> {
    const server = this.serverFactory.create(req.mcpAuth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      // main.ts has already parsed the JSON body.
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      this.logger.error(`MCP request failed: ${error?.message}`, error?.stack);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  }

  /** Stateless: no server-to-client stream to open. */
  @Get()
  openStream(@Res({ passthrough: true }) res: Response): never {
    return methodNotAllowed(res);
  }

  /** Stateless: no session to end. */
  @Delete()
  endSession(@Res({ passthrough: true }) res: Response): never {
    return methodNotAllowed(res);
  }
}

function methodNotAllowed(res: Response): never {
  res.setHeader('Allow', 'POST');
  throw new HttpException('Method not allowed: this MCP server is stateless, use POST', HttpStatus.METHOD_NOT_ALLOWED);
}
