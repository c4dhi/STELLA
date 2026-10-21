import { INestApplication, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { createOAuthMetadata, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service.js';
import { OAUTH_SCOPES } from './mcp-oauth.constants.js';
import { McpOAuthUrls } from './mcp-oauth.urls.js';
import { StellaOAuthProvider } from './stella-oauth.provider.js';

const OAUTH_PATHS = ['/authorize', '/token', '/register', '/revoke', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource'];
const isOAuthPath = (path: string) => OAUTH_PATHS.some((p) => path === p || path.startsWith(`${p}/`));

// Production sits behind a layer-4 proxy, so every request has the same IP.
// Limits are keyed by client instead, with one global ceiling on registration.
const clientKey = (req: Request) => String(req.body?.client_id ?? req.query?.client_id ?? 'anonymous');

/**
 * Mount MCP sign-in (OAuth 2.1 authorization server, RFC 8414/9728/7591,
 * PKCE, CIMD) at the backend root, where the MCP spec has clients look.
 * Plain Express, because the SDK's handlers are Express routers; it must run
 * before Nest's routes. Everything answers 404 while MCP is switched off.
 */
export function setupMcpOAuth(app: INestApplication): void {
  const logger = new Logger('McpOAuth');
  const urls = app.get(McpOAuthUrls);
  if (!urls.signInAvailable()) return;
  const provider = app.get(StellaOAuthProvider);
  const platformSettings = app.get(PlatformSettingsService);

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!isOAuthPath(req.path)) return next();
    if (await platformSettings.isMcpEnabled()) return next();
    res.status(404).json({ error: 'not_found', error_description: 'MCP access is switched off' });
  });

  const options = {
    provider,
    issuerUrl: urls.issuer,
    resourceServerUrl: urls.mcpResource,
    scopesSupported: [...OAUTH_SCOPES],
    resourceName: 'STELLA',
  };

  // The SDK's metadata, plus what it does not advertise itself: CIMD support
  // (Claude prefers it when offered) and the RFC 9207 iss parameter.
  const metadata = {
    ...createOAuthMetadata(options),
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
  app.use('/.well-known/oauth-authorization-server', (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') return next();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(metadata);
  });

  app.use(
    mcpAuthRouter({
      ...options,
      authorizationOptions: { rateLimit: { windowMs: 15 * 60_000, max: 60, keyGenerator: clientKey } },
      tokenOptions: { rateLimit: { windowMs: 15 * 60_000, max: 300, keyGenerator: clientKey } },
      revocationOptions: { rateLimit: { windowMs: 15 * 60_000, max: 100, keyGenerator: clientKey } },
      clientRegistrationOptions: {
        // Public clients (none) get no secret; confidential ones keep theirs until the app re-registers.
        clientSecretExpirySeconds: 0,
        rateLimit: { windowMs: 60 * 60_000, max: 100, keyGenerator: () => 'global' },
      },
    }),
  );
  logger.log(`MCP sign-in ready: issuer ${urls.issuer.href}, resource ${urls.mcpResource.href}`);
}
