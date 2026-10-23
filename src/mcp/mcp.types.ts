import type { z } from 'zod';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { AuthUser } from '../auth/auth-user.loader.js';
import type { PatScope } from '../access-tokens/access-token.util.js';

/** Who is calling /mcp: set on the request by McpBearerGuard. */
export interface McpAuthContext {
  user: AuthUser;
  scopes: PatScope[];
  // Exactly one of these: a personal access token, or an app connected by sign-in.
  tokenId?: string;
  oauthGrantId?: string;
  clientName?: string;
}

export interface McpToolContext {
  auth: McpAuthContext;
  /**
   * Validate tool input with a REST DTO through the same ValidationPipe
   * settings as main.ts, so MCP and REST accept and reject the same input.
   */
  validate<T extends object>(dto: new () => T, value: unknown): Promise<T>;
}

/**
 * One MCP tool. `input` only advertises the argument shape to the client;
 * the handler validates writes with the REST DTO and calls the domain service,
 * which keeps ownership and business rules where they already live.
 */
export interface McpToolDefinition<
  Shape extends z.ZodRawShape = z.ZodRawShape,
> {
  name: string;
  title: string;
  description: string;
  scope: PatScope;
  input: Shape;
  annotations: ToolAnnotations;
  // A JSON object: MCP structuredContent must be an object, so lists are wrapped.
  handler(
    args: z.infer<z.ZodObject<Shape>>,
    ctx: McpToolContext,
  ): Promise<Record<string, unknown>>;
}

/** Typed helper so each tool's handler sees its own argument types. */
export function defineTool<Shape extends z.ZodRawShape>(
  def: McpToolDefinition<Shape>,
): McpToolDefinition {
  return def as unknown as McpToolDefinition;
}

/** A domain's tools. Each implementation depends only on that domain's services. */
export interface McpToolProvider {
  tools(): McpToolDefinition[];
}

export const MCP_TOOL_PROVIDERS = Symbol('MCP_TOOL_PROVIDERS');

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  openWorldHint: false,
};
export const CREATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
export const UPDATES: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};
