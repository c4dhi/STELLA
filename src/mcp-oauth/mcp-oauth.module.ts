import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EnvVarTemplatesModule } from '../env-var-templates/env-var-templates.module.js';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module.js';
import { McpOAuthUrls } from './mcp-oauth.urls.js';
import { OAuthAuthorizationService } from './oauth-authorization.service.js';
import { OAuthClientsStore } from './oauth-clients.store.js';
import { OAuthConsentController } from './oauth-consent.controller.js';
import { OAuthTokensService } from './oauth-tokens.service.js';
import { StellaOAuthProvider } from './stella-oauth.provider.js';

/**
 * MCP sign-in: STELLA as OAuth authorization server for its /mcp endpoint, so
 * Claude, ChatGPT and other MCP clients connect with the user's login.
 * The OAuth endpoints themselves are mounted in main.ts (setupMcpOAuth).
 */
@Module({
  imports: [AuthModule, EnvVarTemplatesModule, PlatformSettingsModule],
  controllers: [OAuthConsentController],
  providers: [McpOAuthUrls, OAuthClientsStore, OAuthTokensService, OAuthAuthorizationService, StellaOAuthProvider],
  exports: [McpOAuthUrls, OAuthTokensService, StellaOAuthProvider],
})
export class McpOAuthModule {}
