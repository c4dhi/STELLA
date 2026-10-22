import { Module } from '@nestjs/common';
import { AccessTokensModule } from '../access-tokens/access-tokens.module.js';
import { AgentConfigurationsModule } from '../agent-configurations/agent-configurations.module.js';
import { AgentImageModule } from '../agent-image/agent-image.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { McpOAuthModule } from '../mcp-oauth/mcp-oauth.module.js';
import { PersonasModule } from '../personas/personas.module.js';
import { PlanTemplatesModule } from '../plan-templates/plan-templates.module.js';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module.js';
import { ProjectsModule } from '../projects/projects.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { StateMachineModule } from '../state-machine/state-machine.module.js';
import { McpEnabledGuard } from './guards/mcp-enabled.guard.js';
import { McpOriginGuard } from './guards/mcp-origin.guard.js';
import { McpBearerGuard } from './guards/mcp-bearer.guard.js';
import { McpAuditService } from './mcp-audit.service.js';
import { McpServerFactory } from './mcp-server.factory.js';
import { McpController } from './mcp.controller.js';
import { MCP_TOOL_PROVIDERS } from './mcp.types.js';
import { AgentConfigurationsTools } from './tools/agent-configurations.tools.js';
import { CatalogTools } from './tools/catalog.tools.js';
import { PersonasTools } from './tools/personas.tools.js';
import { PlanTemplatesTools } from './tools/plan-templates.tools.js';
import { SessionsTools } from './tools/sessions.tools.js';

// Adding a domain: write a *.tools.ts provider and list it here.
const TOOL_PROVIDERS = [
  CatalogTools,
  PersonasTools,
  PlanTemplatesTools,
  AgentConfigurationsTools,
  SessionsTools,
];

/** Remote MCP server for AI clients (#772). Holds no business logic of its own. */
@Module({
  imports: [
    AuthModule,
    AccessTokensModule,
    McpOAuthModule,
    PlatformSettingsModule,
    AgentImageModule,
    PersonasModule,
    PlanTemplatesModule,
    AgentConfigurationsModule,
    ProjectsModule,
    SessionsModule,
    StateMachineModule,
  ],
  controllers: [McpController],
  providers: [
    McpEnabledGuard,
    McpOriginGuard,
    McpBearerGuard,
    McpAuditService,
    McpServerFactory,
    ...TOOL_PROVIDERS,
    {
      provide: MCP_TOOL_PROVIDERS,
      useFactory: (...providers) => providers,
      inject: TOOL_PROVIDERS,
    },
  ],
})
export class McpModule {}
