import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';

/**
 * The public addresses MCP sign-in is built on. Claude and ChatGPT reach STELLA
 * server to server, so these are the public URLs (PUBLIC_API_URL for the
 * backend, PUBLIC_FRONTEND_URL for the consent page), never internal ones.
 */
@Injectable()
export class McpOAuthUrls {
  private readonly logger = new Logger(McpOAuthUrls.name);
  /** OAuth issuer: the backend's public origin. */
  readonly issuer: URL;
  /** The protected resource: the MCP endpoint. Tokens are bound to it. */
  readonly mcpResource: URL;
  readonly resourceMetadataUrl: string;
  private readonly frontend: URL;

  constructor(config: ConfigService) {
    const port = config.get<string>('PORT') || '3000';
    const api = (
      config.get<string>('PUBLIC_API_URL') || `http://localhost:${port}`
    ).replace(/\/+$/, '');
    const frontend = (
      config.get<string>('PUBLIC_FRONTEND_URL') || 'http://localhost:8080'
    ).replace(/\/+$/, '');
    this.issuer = new URL(`${api}/`);
    this.mcpResource = new URL(`${api}/mcp`);
    this.resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
      this.mcpResource,
    );
    this.frontend = new URL(`${frontend}/`);
  }

  consentUrl(requestId: string): string {
    const url = new URL('oauth/consent', this.frontend);
    url.searchParams.set('request', requestId);
    return url.toString();
  }

  /**
   * The MCP authorization spec wants HTTPS; the SDK allows plain HTTP only on
   * localhost. Anywhere else (e.g. a LAN address) sign-in stays off and
   * personal access tokens are the only way in.
   */
  signInAvailable(): boolean {
    const local = ['localhost', '127.0.0.1'].includes(this.issuer.hostname);
    const ok = this.issuer.protocol === 'https:' || local;
    if (!ok)
      this.logger.warn(
        `MCP sign-in disabled: PUBLIC_API_URL ${this.issuer.origin} is not HTTPS`,
      );
    return ok;
  }

  /** True for a resource indicator naming this MCP endpoint (RFC 8707). */
  isOwnResource(resource: string | URL | null | undefined): boolean {
    if (!resource) return true;
    try {
      const url = new URL(resource.toString());
      return (
        url.origin === this.mcpResource.origin &&
        url.pathname.replace(/\/+$/, '') === this.mcpResource.pathname
      );
    } catch {
      return false;
    }
  }
}
