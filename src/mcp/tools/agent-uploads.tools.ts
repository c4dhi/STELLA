import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { AgentValidationStatus } from '@prisma/client';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service.js';
import { StorageService } from '../../storage/storage.service.js';
import { AgentPackageService } from '../../agent-package/agent-package.service.js';
import { AgentBuildService, resolveDockerfilePath } from '../../agent-build/agent-build.service.js';
import { DEFAULT_DOCKERFILE } from '../../agent-package/manifest-defaults.js';
import { manifestToAgentTypeData } from '../../agent-package/manifest-mapper.js';
import { requirementsForListing } from '../../agents/agent-requirements.js';
import { builtSdkProblem } from '../../agent-package/sdk-support.js';
import { canSeeAgentBuilds } from '../../agent-upload/agent-upload.controller.js';
import { UpdateAgentSharesDto } from '../../agent-upload/dto/update-agent-shares.dto.js';
import { CREATES, McpToolProvider, READ_ONLY, UPDATES, defineTool, idArg } from '../mcp.types.js';

// Mirrors MulterModule's own limit on the web upload (agent-upload.module.ts).
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

const agentTypeId = idArg('uploaded agent type', 'agent_uploads_list');

/**
 * Uploaded (custom, non-built-in) agent types: the REST surface at
 * POST/GET /agent-types/* (agent-upload.controller.ts), minus delete (#202) and
 * the build-logs SSE stream, which has no one-shot MCP shape. Reuses that
 * controller's own exported access checks (canSeeAgentBuilds) rather than
 * reinventing them.
 *
 * That controller queries Prisma directly instead of through a dedicated
 * service for most of this - these tools do the same, matching its own
 * existing shape rather than inventing a service layer MCP alone would need.
 */
@Injectable()
export class AgentUploadsTools implements McpToolProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly agentPackage: AgentPackageService,
    private readonly agentBuild: AgentBuildService,
  ) {}

  private async findOwnedOrAdmin(id: string, userId: string, isSystemAdmin?: boolean) {
    const agentType = await this.prisma.agentType.findUnique({ where: { id } });
    if (!agentType) throw new NotFoundException(`Agent type ${id} not found`);
    if (!isSystemAdmin && agentType.userId !== userId) {
      throw new ForbiddenException('You do not own this agent');
    }
    return agentType;
  }

  /** The caller's own upload: sharing is the owner's alone, not an admin's - matches
   *  agent-upload.controller.ts's own ownUpload exactly. */
  private async ownUpload(id: string, userId: string) {
    const agentType = await this.prisma.agentType.findUnique({ where: { id } });
    if (!agentType) throw new NotFoundException(`Agent type ${id} not found`);
    if (agentType.isBuiltIn || agentType.userId !== userId) {
      throw new ForbiddenException('Only its owner can share this agent');
    }
    return agentType;
  }

  private async assertVisibleBuilds(id: string, userId: string, isSystemAdmin?: boolean) {
    const agentType = await this.prisma.agentType.findUnique({ where: { id } });
    if (!agentType) throw new NotFoundException(`Agent type ${id} not found`);
    const [memberships, shares] =
      isSystemAdmin || agentType.userId === userId
        ? [[], []]
        : await Promise.all([
            this.prisma.projectMembership.findMany({ where: { userId }, select: { projectId: true } }),
            this.prisma.agentTypeProjectShare.findMany({ where: { agentTypeId: id }, select: { projectId: true } }),
          ]);
    const allowed = canSeeAgentBuilds(agentType, {
      userId,
      isSystemAdmin,
      memberOf: memberships.map((m) => m.projectId),
      sharedWith: shares.map((s) => s.projectId),
    });
    if (!allowed) throw new ForbiddenException("You cannot see this agent's builds");
  }

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
              z.object({
                path: z.string().min(1).describe('Path inside the package, e.g. "agent.yaml" or "src/main.py".'),
                content: z.string().describe('The file\'s text content.'),
              }),
            )
            .min(1)
            .describe('Must include agent.yaml. Text files only - this tool cannot carry binary assets.'),
        },
        annotations: CREATES,
        handler: async (args, { auth }) => {
          const userId = auth.user.userId;
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

          const validation = await this.agentPackage.validatePackage(buffer);
          if (!validation.valid) {
            throw new BadRequestException({
              message: 'Package validation failed',
              errors: validation.errors,
              warnings: validation.warnings,
            });
          }
          const manifest = validation.manifest!;

          if (manifest.image.imageUrl) {
            throw new BadRequestException(
              'image.imageUrl is not allowed in an uploaded agent; remove it and STELLA builds the image from your Dockerfile',
            );
          }
          resolveDockerfilePath('/package', manifest.image.dockerfile ?? DEFAULT_DOCKERFILE);

          const existing = await this.prisma.agentType.findUnique({
            where: { slug: manifest.metadata.slug },
          });
          if (existing && (existing.isBuiltIn || existing.userId !== userId)) {
            throw new BadRequestException(
              `Another agent already uses the slug "${manifest.metadata.slug}"; pick another metadata.slug`,
            );
          }
          if (existing && existing.version === manifest.metadata.version) {
            throw new BadRequestException(
              `You already uploaded ${existing.name} ${existing.version}; raise metadata.version to replace it`,
            );
          }

          const storageInfo = await this.agentPackage.storePackage(
            buffer,
            `${manifest.metadata.slug}-${manifest.metadata.version}.zip`,
          );
          const expertDefaults = this.agentPackage.readExpertDefaults(buffer, manifest.capabilities);
          const data = {
            ...manifestToAgentTypeData(manifest, expertDefaults),
            isBuiltIn: false,
            userId,
            packagePath: storageInfo.path,
            packageSize: storageInfo.size,
            packageHash: storageInfo.hash,
            imageUrl: null,
            sdkVersion: null,
            validationStatus: AgentValidationStatus.PENDING,
            validationNotes: null,
            validatedAt: null,
            validatedBy: null,
          };
          const agentType = existing
            ? await this.prisma.agentType.update({ where: { id: existing.id }, data })
            : await this.prisma.agentType.create({ data });

          if (existing?.packagePath && existing.packagePath !== storageInfo.path) {
            await this.storage.delete(existing.packagePath);
          }

          try {
            await this.agentBuild.startBuild(agentType.id, userId);
          } catch {
            // The upload itself succeeded regardless; the caller can retry with agent_uploads_build.
          }

          return {
            id: agentType.id,
            slug: agentType.slug,
            name: agentType.name,
            version: agentType.version,
            validationStatus: agentType.validationStatus,
            replacedVersion: existing?.version ?? null,
            warnings: validation.warnings,
          };
        },
      }),
      defineTool({
        name: 'agent_uploads_list',
        title: 'List my uploaded agents',
        description: "The caller's own custom (non-built-in) agent uploads, with their build and sharing state.",
        scope: 'mcp:read',
        input: {},
        annotations: READ_ONLY,
        handler: async (_args, { auth }) => {
          const agents = await this.prisma.agentType.findMany({
            where: { isBuiltIn: false, userId: auth.user.userId },
            orderBy: { createdAt: 'desc' },
            include: {
              buildLogs: { orderBy: { startedAt: 'desc' }, take: 1 },
              projectShares: { select: { projectId: true } },
            },
          });
          return {
            items: agents.map((agent) => ({
              id: agent.id,
              slug: agent.slug,
              name: agent.name,
              description: agent.description,
              icon: agent.icon,
              version: agent.version,
              validationStatus: agent.validationStatus,
              validationNotes: agent.validationNotes,
              validatedAt: agent.validatedAt,
              capabilities: agent.capabilities,
              defaultConfig: agent.defaultConfig,
              configSchema: agent.configSchema,
              pipelineSchema: agent.pipelineSchema,
              requirements: requirementsForListing(agent).requirements,
              createdAt: agent.createdAt,
              built: !!agent.imageUrl,
              sdkVersion: agent.sdkVersion,
              sharedProjectIds: agent.projectShares.map((share) => share.projectId),
              sdkProblem: agent.imageUrl ? builtSdkProblem(agent.sdkVersion) : null,
              lastBuild: agent.buildLogs[0]
                ? {
                    status: agent.buildLogs[0].status,
                    startedAt: agent.buildLogs[0].startedAt,
                    completedAt: agent.buildLogs[0].completedAt,
                  }
                : null,
            })),
          };
        },
      }),
      defineTool({
        name: 'agent_uploads_build',
        title: 'Rebuild an uploaded agent',
        description: "Start a build of the caller's uploaded agent from its stored package.",
        scope: 'mcp:write',
        input: { agentTypeId },
        annotations: CREATES,
        handler: async ({ agentTypeId }, { auth }) => {
          const agentType = await this.findOwnedOrAdmin(agentTypeId, auth.user.userId, auth.user.isSystemAdmin);
          if (agentType.isBuiltIn) throw new BadRequestException('Cannot rebuild built-in agents');
          if (!agentType.packagePath) throw new BadRequestException('Agent has no uploaded package');
          const result = await this.agentBuild.startBuild(agentTypeId, auth.user.userId);
          return { buildLogId: result.buildLogId, message: 'Build started' };
        },
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
        handler: async ({ agentTypeId }, { auth }) => {
          await this.assertVisibleBuilds(agentTypeId, auth.user.userId, auth.user.isSystemAdmin);
          const latestBuild = await this.prisma.agentBuildLog.findFirst({
            where: { agentTypeId },
            orderBy: { startedAt: 'desc' },
          });
          const status = latestBuild ? await this.agentBuild.getBuildStatus(latestBuild.id) : null;
          if (!status) return { build: null };
          const buildOutput = await this.agentBuild.getBuildOutput(latestBuild!.id);
          return { build: { ...status, buildOutput: buildOutput ?? undefined } };
        },
      }),
      defineTool({
        name: 'agent_uploads_build_history',
        title: 'Get build history',
        description: "An uploaded agent's past builds, newest first.",
        scope: 'mcp:read',
        input: { agentTypeId },
        annotations: READ_ONLY,
        handler: async ({ agentTypeId }, { auth }) => {
          await this.assertVisibleBuilds(agentTypeId, auth.user.userId, auth.user.isSystemAdmin);
          return { items: await this.agentBuild.getBuildHistory(agentTypeId) };
        },
      }),
      defineTool({
        name: 'agent_uploads_shares_get',
        title: 'Get an uploaded agent\'s shares',
        description:
          "The projects this custom agent is shared with, and the projects its owner could share it with.",
        scope: 'mcp:read',
        input: { agentTypeId },
        annotations: READ_ONLY,
        handler: async ({ agentTypeId }, { auth }) => {
          const agentType = await this.ownUpload(agentTypeId, auth.user.userId);
          const [shares, memberships] = await Promise.all([
            this.prisma.agentTypeProjectShare.findMany({ where: { agentTypeId }, select: { projectId: true } }),
            this.prisma.projectMembership.findMany({
              where: { userId: agentType.userId! },
              select: { project: { select: { id: true, name: true } } },
              orderBy: { project: { name: 'asc' } },
            }),
          ]);
          return {
            projectIds: shares.map((s) => s.projectId),
            projects: memberships.map((m) => m.project),
          };
        },
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
          projectIds: z.array(z.string()).max(200).describe('Replaces the whole share list.'),
        },
        annotations: UPDATES,
        handler: async ({ agentTypeId, projectIds }, ctx) => {
          const dto = await ctx.validate(UpdateAgentSharesDto, { projectIds });
          const agentType = await this.ownUpload(agentTypeId, ctx.auth.user.userId);
          const ids = [...new Set(dto.projectIds)];
          const memberOf = await this.prisma.projectMembership.findMany({
            where: { userId: agentType.userId!, projectId: { in: ids } },
            select: { projectId: true },
          });
          if (memberOf.length !== ids.length) {
            throw new ForbiddenException('You can only share an agent with projects you are a member of');
          }
          await this.prisma.$transaction([
            this.prisma.agentTypeProjectShare.deleteMany({
              where: { agentTypeId, projectId: { notIn: ids } },
            }),
            ...ids.map((projectId) =>
              this.prisma.agentTypeProjectShare.upsert({
                where: { agentTypeId_projectId: { agentTypeId, projectId } },
                create: { agentTypeId, projectId },
                update: {},
              }),
            ),
          ]);
          return { projectIds: ids };
        },
      }),
    ];
  }
}
