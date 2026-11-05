import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Connector,
  ConnectorAuthType,
  ConnectorStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../env-var-templates/encryption.service.js';
import { normalizeConnectorUrl } from './connector-url.util.js';
import { ConnectorAuditService } from './connector-audit.service.js';
import {
  BindingRequest,
  BindingValidationError,
  ConnectorBinding,
  ConnectorSlot,
  resolveConnectorBindings,
} from './connector-bindings.util.js';
import {
  ConnectorCallError,
  McpClientService,
  McpServerInfo,
  McpTarget,
  McpToolInfo,
} from './mcp-client.service.js';
import {
  ConnectorAuthTypeInput,
  CreateConnectorDto,
  UpdateConnectorDto,
} from './dto/connector.dto.js';

/** A connector as the API returns it: everything except the credential. */
// A type alias, not an interface, so it can be returned as an MCP tool result.
export type ConnectorResponse = {
  id: string;
  name: string;
  handle: string;
  kind: 'mcp';
  url: string;
  authType: ConnectorAuthTypeInput;
  hasCredential: boolean;
  status: 'untested' | 'ok' | 'error';
  lastError: string | null;
  lastCheckedAt: Date | null;
  tools: McpToolInfo[] | null;
  serverInfo: McpServerInfo | null;
  /** Projects whose members may bind this connector (owner view only). */
  sharedWith: { projectId: string; projectName: string }[];
  createdAt: Date;
  updatedAt: Date;
};

/**
 * A connector the user may bind in one project: their own, or one its owner
 * shared with that project. No credential, and nothing to edit for non-owners.
 */
// A type alias, not an interface, so it can be returned as an MCP tool result.
export type AvailableConnectorResponse = {
  id: string;
  name: string;
  handle: string;
  kind: 'mcp';
  url: string;
  status: 'untested' | 'ok' | 'error';
  tools: McpToolInfo[] | null;
  /** True for the user's own connector; false when shared with the project. */
  owned: boolean;
  ownerName: string | null;
};

type ConnectorWithShares = Connector & {
  shares?: { projectId: string; project: { name: string } }[];
};

const WITH_SHARES = {
  shares: {
    select: { projectId: true, project: { select: { name: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
};

// A type alias, not an interface, so it can be returned as an MCP tool result.
export type ConnectorTestResponse = {
  ok: boolean;
  errorCode?: string;
  error?: string;
  connector: ConnectorResponse;
};

const AUTH_TO_DB: Record<ConnectorAuthTypeInput, ConnectorAuthType> = {
  bearer: ConnectorAuthType.BEARER,
  none: ConnectorAuthType.NONE,
};

export function toConnectorResponse(c: ConnectorWithShares): ConnectorResponse {
  return {
    id: c.id,
    name: c.name,
    handle: c.handle,
    kind: 'mcp',
    url: c.url,
    authType: c.authType === ConnectorAuthType.NONE ? 'none' : 'bearer',
    hasCredential: !!c.credentialEncrypted,
    status: c.status.toLowerCase() as ConnectorResponse['status'],
    lastError: c.lastError,
    lastCheckedAt: c.lastCheckedAt,
    tools: (c.toolsSnapshot as unknown as McpToolInfo[] | null) ?? null,
    serverInfo: (c.serverInfo as McpServerInfo | null) ?? null,
    sharedWith: (c.shares ?? []).map((s) => ({
      projectId: s.projectId,
      projectName: s.project.name,
    })),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** Settings → Connectors: the signed-in user's own outside MCP servers. */
@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly mcp: McpClientService,
    private readonly audit: ConnectorAuditService,
  ) {}

  async list(userId: string): Promise<ConnectorResponse[]> {
    const rows = await this.prisma.connector.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      include: WITH_SHARES,
    });
    return rows.map(toConnectorResponse);
  }

  /**
   * What the user may bind when deploying in `projectId`: their own connectors
   * plus those shared with the project. For the deploy wizard.
   */
  async listAvailable(
    userId: string,
    projectId: string,
  ): Promise<AvailableConnectorResponse[]> {
    await this.assertMember(userId, projectId);
    const rows = await this.prisma.connector.findMany({
      where: { OR: [{ userId }, { shares: { some: { projectId } } }] },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { name: true, email: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      handle: c.handle,
      kind: 'mcp' as const,
      url: c.url,
      status: c.status.toLowerCase() as AvailableConnectorResponse['status'],
      tools: (c.toolsSnapshot as unknown as McpToolInfo[] | null) ?? null,
      owned: c.userId === userId,
      ownerName: c.user?.name ?? c.user?.email ?? null,
    }));
  }

  /**
   * Replace the set of projects a connector is shared with. Owner only, and
   * only projects the owner belongs to. Unsharing takes effect on the next
   * call of any agent that bound it (the gateway re-checks every call).
   */
  async setShares(
    id: string,
    userId: string,
    projectIds: string[],
  ): Promise<ConnectorResponse> {
    await this.owned(id, userId);
    const wanted = [...new Set(projectIds)];
    if (wanted.length > 0) {
      const memberships = await this.prisma.projectMembership.findMany({
        where: { userId, projectId: { in: wanted } },
        select: { projectId: true },
      });
      const member = new Set(memberships.map((m) => m.projectId));
      const notMember = wanted.filter((p) => !member.has(p));
      if (notMember.length > 0) {
        throw new ForbiddenException(
          'You can only share a connector with projects you belong to',
        );
      }
    }
    await this.prisma.$transaction([
      this.prisma.connectorProjectShare.deleteMany({
        where: { connectorId: id, projectId: { notIn: wanted } },
      }),
      this.prisma.connectorProjectShare.createMany({
        data: wanted.map((projectId) => ({ connectorId: id, projectId })),
        skipDuplicates: true,
      }),
    ]);
    const row = await this.prisma.connector.findUniqueOrThrow({
      where: { id },
      include: WITH_SHARES,
    });
    return toConnectorResponse(row);
  }

  async get(id: string, userId: string): Promise<ConnectorResponse> {
    await this.owned(id, userId);
    return toConnectorResponse(
      await this.prisma.connector.findUniqueOrThrow({
        where: { id },
        include: WITH_SHARES,
      }),
    );
  }

  async create(
    userId: string,
    dto: CreateConnectorDto,
  ): Promise<ConnectorResponse> {
    const url = this.cleanUrl(dto.url);
    const authType = dto.authType ?? 'bearer';
    if (authType === 'bearer' && !dto.token?.trim()) {
      throw new BadRequestException('A bearer connector needs a token');
    }
    try {
      const row = await this.prisma.connector.create({
        data: {
          userId,
          name: dto.name.trim(),
          handle: dto.handle,
          url,
          authType: AUTH_TO_DB[authType],
          credentialEncrypted:
            authType === 'bearer' ? this.encryptToken(dto.token!.trim()) : null,
        },
      });
      return toConnectorResponse(row);
    } catch (error) {
      throw this.mapUniqueError(error, dto.handle);
    }
  }

  async update(
    id: string,
    userId: string,
    dto: UpdateConnectorDto,
  ): Promise<ConnectorResponse> {
    const existing = await this.owned(id, userId);
    const data: Prisma.ConnectorUpdateInput = {};
    let reachChanged = false;

    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.handle !== undefined) data.handle = dto.handle;
    if (dto.url !== undefined) {
      const url = this.cleanUrl(dto.url);
      if (url !== existing.url) {
        data.url = url;
        reachChanged = true;
      }
    }
    const authType =
      dto.authType ??
      (existing.authType === ConnectorAuthType.NONE ? 'none' : 'bearer');
    if (dto.authType !== undefined) {
      data.authType = AUTH_TO_DB[dto.authType];
      reachChanged = true;
    }
    if (authType === 'none') {
      data.credentialEncrypted = null;
    } else if (dto.token !== undefined) {
      data.credentialEncrypted = this.encryptToken(dto.token.trim());
      reachChanged = true;
    } else if (!existing.credentialEncrypted) {
      throw new BadRequestException('A bearer connector needs a token');
    }
    if (reachChanged) {
      data.status = ConnectorStatus.UNTESTED;
      data.lastError = null;
    }

    try {
      const row = await this.prisma.connector.update({
        where: { id },
        data,
        include: WITH_SHARES,
      });
      if (reachChanged) await this.mcp.evict(id);
      return toConnectorResponse(row);
    } catch (error) {
      throw this.mapUniqueError(error, dto.handle ?? existing.handle);
    }
  }

  async remove(id: string, userId: string): Promise<{ deleted: true }> {
    await this.owned(id, userId);
    await this.prisma.connector.delete({ where: { id } });
    await this.mcp.evict(id);
    return { deleted: true };
  }

  /** MCP initialize + tools/list; stores the result as the tool snapshot. */
  async test(id: string, userId: string): Promise<ConnectorTestResponse> {
    const connector = await this.owned(id, userId);
    const started = Date.now();
    try {
      const { serverInfo, tools } = await this.mcp.probe(
        this.target(connector),
      );
      await this.audit.record({
        connectorId: id,
        userId,
        operation: 'initialize',
        success: true,
        durationMs: Date.now() - started,
      });
      const row = await this.prisma.connector.update({
        where: { id },
        data: {
          status: ConnectorStatus.OK,
          lastError: null,
          lastCheckedAt: new Date(),
          toolsSnapshot: tools as unknown as Prisma.InputJsonValue,
          serverInfo: serverInfo as Prisma.InputJsonValue,
        },
        include: WITH_SHARES,
      });
      return { ok: true, connector: toConnectorResponse(row) };
    } catch (error) {
      const failure =
        error instanceof ConnectorCallError ? error : this.mcp.classify(error);
      await this.audit.record({
        connectorId: id,
        userId,
        operation: 'initialize',
        success: false,
        errorCode: failure.code,
        durationMs: Date.now() - started,
      });
      const row = await this.prisma.connector.update({
        where: { id },
        data: {
          status: ConnectorStatus.ERROR,
          lastError: failure.message.slice(0, 500),
          lastCheckedAt: new Date(),
        },
        include: WITH_SHARES,
      });
      return {
        ok: false,
        errorCode: failure.code,
        error: failure.message,
        connector: toConnectorResponse(row),
      };
    }
  }

  /**
   * Validate the connectors a deploy request binds and return what to store on
   * AgentInstance.connectorBindings. Throws 400 on anything not allowed.
   */
  async resolveBindingsForDeploy(
    userId: string,
    projectId: string,
    requests: BindingRequest[] | undefined,
    slots: ConnectorSlot[] | null | undefined,
  ): Promise<ConnectorBinding[]> {
    const ids = [...new Set((requests ?? []).map((r) => r.connectorId))];
    // The deployer's own connectors, plus those shared with this project.
    const available = ids.length
      ? await this.prisma.connector.findMany({
          where: {
            id: { in: ids },
            OR: [{ userId }, { shares: { some: { projectId } } }],
          },
          select: { id: true, handle: true, name: true, toolsSnapshot: true },
        })
      : [];
    try {
      return resolveConnectorBindings(requests, slots, available);
    } catch (error) {
      if (error instanceof BindingValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /** Connection details with the decrypted credential. Never leaves the backend. */
  target(
    connector: Pick<
      Connector,
      'id' | 'url' | 'authType' | 'credentialEncrypted'
    >,
  ): McpTarget {
    let bearerToken: string | null = null;
    if (
      connector.authType === ConnectorAuthType.BEARER &&
      connector.credentialEncrypted
    ) {
      bearerToken =
        this.encryption.decrypt(connector.credentialEncrypted).token ?? null;
    }
    return { connectorId: connector.id, url: connector.url, bearerToken };
  }

  private async assertMember(userId: string, projectId: string): Promise<void> {
    const membership = await this.prisma.projectMembership.findUnique({
      where: { userId_projectId: { userId, projectId } },
      select: { id: true },
    });
    if (!membership) throw new NotFoundException('Project not found');
  }

  /** Only the owner sees, edits, tests, shares or deletes a connector here. */
  private async owned(id: string, userId: string): Promise<Connector> {
    const row = await this.prisma.connector.findFirst({
      where: { id, userId },
    });
    if (!row) throw new NotFoundException('Connector not found');
    return row;
  }

  private cleanUrl(url: string): string {
    try {
      return normalizeConnectorUrl(url);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  private encryptToken(token: string): string {
    return this.encryption.encrypt({ token });
  }

  private mapUniqueError(error: unknown, handle: string): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        `You already have a connector with handle "${handle}"`,
      );
    }
    return error;
  }
}
