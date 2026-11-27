import { BadRequestException, Injectable } from '@nestjs/common';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { AgentUploadService } from '../../agent-upload/agent-upload.service.js';
import { UpdateAgentSharesDto } from '../../agent-upload/dto/update-agent-shares.dto.js';
import {
  CREATES,
  DELETES,
  McpToolProvider,
  READ_ONLY,
  UPDATES,
  defineTool,
  idArg,
} from '../mcp.types.js';

// Mirrors MulterModule's own limit on the web upload (agent-upload.module.ts).
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

const agentTypeId = idArg('uploaded agent type', 'agent_uploads_list');

/**
 * Uploaded (custom, non-built-in) agent types: the REST surface at
 * POST/GET /agent-types/* (agent-upload.controller.ts), minus the build-logs
 * SSE stream, which has no one-shot MCP shape. Calls the same
 * AgentUploadService the controller calls, so neither surface duplicates the
 * upload/build/sharing/delete logic. agent_uploads_delete is system-admin
 * only (#202); AgentUploadService.deleteAgent already lets an admin delete
 * anyone's upload, same as the REST endpoint always has.
 */
@Injectable()
export class AgentUploadsTools implements McpToolProvider {
  constructor(private readonly agentUploads: AgentUploadService) {}

  tools() {
    return [
      defineTool({
        name: 'agent_uploads_create',
        title: 'Upload a custom agent',
        description:
          'Upload a custom agent package, packed here from its files instead of a .zip - same contents, ' +
          'same validation, and the same size limit (50MB total) as the web upload. Starts a build and sets it ' +
          'pending review, same as the web upload. Uploading an existing slug of your own with a higher ' +
          'metadata.version replaces it in place.',
        scope: 'mcp:write',
        input: {
          files: z
            .array(
              z
                .object({
                  path: z
                    .string()
                    .min(1)
                    .describe(
                      'Path inside the package, e.g. "agent.yaml" or "src/main.py".',
                    ),
                  content: z.string().describe("The file's text content."),
                })
                .strict(),
            )
            .min(1)
            .describe(
              'Must include agent.yaml. Text files only - this tool cannot carry binary assets.',
            ),
        },
        annotations: CREATES,
        handler: async (args, { auth }) => {
          const zip = new AdmZip();
          for (const file of args.files) {
            zip.addFile(file.path, Buffer.from(file.content, 'utf-8'));
          }
          const buffer = zip.toBuffer();
          if (buffer.length > MAX_PACKAGE_BYTES) {
            throw new BadRequestException(
              `Package is ${buffer.length} bytes, over the ${MAX_PACKAGE_BYTES} byte limit`,
            );
          }
          return this.agentUploads.createFromPackage(buffer, auth.user.userId);
        },
      }),
      defineTool({
        name: 'agent_uploads_list',
        title: 'List my uploaded agents',
        description:
          "The caller's own custom (non-built-in) agent uploads, with their build and sharing state.",
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async (_args, { auth }) => ({
          items: await this.agentUploads.getMyAgents(auth.user.userId),
        }),
      }),
      defineTool({
        name: 'agent_uploads_build',
        title: 'Rebuild an uploaded agent',
        description:
          "Start a build of the caller's uploaded agent from its stored package.",
        scope: 'mcp:write',
        input: { agentTypeId },
        annotations: CREATES,
        handler: async ({ agentTypeId }, { auth }) =>
          this.agentUploads.triggerBuild(
            agentTypeId,
            auth.user.userId,
            auth.user.isSystemAdmin,
          ),
      }),
      defineTool({
        name: 'agent_uploads_build_status',
        title: 'Get the latest build status',
        description:
          "An uploaded agent's latest build: status, image name, error if any, and the build's stored output. " +
          'build is null when it has never been built.',
        scope: 'mcp:read',
        input: { agentTypeId },
        annotations: READ_ONLY,
        handler: async ({ agentTypeId }, { auth }) => ({
          build: await this.agentUploads.getBuildStatus(
            agentTypeId,
            auth.user.userId,
            auth.user.isSystemAdmin,
          ),
        }),
      }),
      defineTool({
        name: 'agent_uploads_build_history',
        title: 'Get build history',
        description: "An uploaded agent's past builds, newest first.",
        scope: 'mcp:read',
        input: { agentTypeId },
        annotations: READ_ONLY,
        handler: async ({ agentTypeId }, { auth }) => ({
          items: await this.agentUploads.getBuildHistory(
            agentTypeId,
            auth.user.userId,
            auth.user.isSystemAdmin,
          ),
        }),
      }),
      defineTool({
        name: 'agent_uploads_shares_get',
        title: "Get an uploaded agent's shares",
        description:
          'The projects this custom agent is shared with, and the projects its owner could share it with.',
        scope: 'mcp:read',
        input: { agentTypeId },
        annotations: READ_ONLY,
        handler: async ({ agentTypeId }, { auth }) =>
          this.agentUploads.getShares(agentTypeId, auth.user.userId),
      }),
      defineTool({
        name: 'agent_uploads_shares_update',
        title: 'Share an uploaded agent',
        description:
          'Share this custom agent with exactly these projects, replacing the current set. Their members see ' +
          'it and may deploy it there; they cannot change it. Only the owner shares, and only with projects ' +
          'they are a member of.',
        scope: 'mcp:write',
        input: {
          agentTypeId,
          projectIds: z
            .array(z.string())
            .max(200)
            .describe('Replaces the whole share list.'),
        },
        annotations: UPDATES,
        handler: async ({ agentTypeId, projectIds }, ctx) => {
          const dto = await ctx.validate(UpdateAgentSharesDto, { projectIds });
          return this.agentUploads.updateShares(
            agentTypeId,
            ctx.auth.user.userId,
            dto.projectIds,
          );
        },
      }),
      defineTool({
        name: 'agent_uploads_delete',
        title: 'Delete an uploaded agent',
        description:
          'Delete any uploaded agent type, as a system admin. Stops its running agents first, and removes ' +
          'its env var templates and agent configurations with it. Refused while a public project uses it or ' +
          "another user's agent of it still runs.",
        scope: 'mcp:write',
        systemAdminOnly: true,
        input: { agentTypeId },
        annotations: DELETES,
        handler: async ({ agentTypeId }, { auth }) =>
          this.agentUploads.deleteAgent(
            agentTypeId,
            auth.user.userId,
            auth.user.isSystemAdmin,
          ),
      }),
    ];
  }
}
