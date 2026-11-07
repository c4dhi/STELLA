import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  PlatformSettingsService,
  PlatformSettingsView,
} from '../../platform-settings/platform-settings.service.js';
import { McpToolProvider, READ_ONLY, UPDATES, defineTool } from '../mcp.types.js';

/**
 * The admin switches an assistant may read and change. Only "Review uploaded
 * agents" can be changed over MCP: the MCP switch itself stays in the UI (an
 * assistant shouldn't turn off its own access), and so does TTS playback.
 */
function summarize(view: PlatformSettingsView) {
  return {
    agentReviewRequired: view.agentReviewRequired,
    mcpEnabled: view.mcpEnabled,
    ttsPlayback: view.ttsPlayback,
  };
}

/** Platform defaults (Settings → Platform Defaults), for system admins only. */
@Injectable()
export class PlatformSettingsTools implements McpToolProvider {
  constructor(private readonly platformSettings: PlatformSettingsService) {}

  tools() {
    return [
      defineTool({
        name: 'platform_settings_get',
        title: 'Get platform settings',
        description:
          'The platform-wide admin switches: whether uploaded agents need a system admin\'s approval before they ' +
          'deploy (agentReviewRequired), whether MCP is on, and the default TTS playback mode. System admins only.',
        scope: 'mcp:read',
        systemAdminOnly: true,
        input: {},
        annotations: READ_ONLY,
        handler: async () => summarize(await this.platformSettings.getView()),
      }),
      defineTool({
        name: 'platform_settings_update',
        title: 'Update platform settings',
        description:
          'Change a platform-wide admin switch. agentReviewRequired: true means no uploaded agent deploys until a ' +
          'system admin approves it, and unreviewed agents stop coming back on restart or wake; false lets users ' +
          'deploy their own uploads as soon as they are built. It is on by default because agent pods still get the ' +
          'platform LiveKit key. System admins only.',
        scope: 'mcp:write',
        systemAdminOnly: true,
        input: {
          agentReviewRequired: z
            .boolean()
            .describe('Whether uploaded agents need a system admin\'s approval before they deploy'),
        },
        annotations: UPDATES,
        handler: async ({ agentReviewRequired }, { auth }) =>
          summarize(
            await this.platformSettings.setAgentReviewRequired(agentReviewRequired, auth.user.userId),
          ),
      }),
    ];
  }
}
