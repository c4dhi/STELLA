import {
  BadRequestException,
  ConflictException,
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
export interface ConnectorResponse {
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
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorTestResponse {
  ok: boolean;
  errorCode?: string;
  error?: string;
  connector: ConnectorResponse;
}

const AUTH_TO_DB: Record<ConnectorAuthTypeInput, ConnectorAuthType> = {
  bearer: ConnectorAuthType.BEARER,
  none: ConnectorAuthType.NONE,
};

export function toConnectorResponse(c: Connector): ConnectorResponse {
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
    });
    return rows.map(toConnectorResponse);
  }

  async get(id: string, userId: string): Promise<ConnectorResponse> {
    return toConnectorResponse(await this.owned(id, userId));
  }

  async create(userId: string, dto: CreateConnectorDto): Promise<ConnectorResponse> {
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
      dto.authType ?? (existing.authType === ConnectorAuthType.NONE ? 'none' : 'bearer');
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
      const row = await this.prisma.connector.update({ where: { id }, data });
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
      const { serverInfo, tools } = await this.mcp.probe(this.target(connector));
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
    requests: BindingRequest[] | undefined,
    slots: ConnectorSlot[] | null | undefined,
  ): Promise<ConnectorBinding[]> {
    const ids = [...new Set((requests ?? []).map((r) => r.connectorId))];
    const owned = ids.length
      ? await this.prisma.connector.findMany({
          where: { userId, id: { in: ids } },
          select: { id: true, handle: true, name: true, toolsSnapshot: true },
        })
      : [];
    try {
      return resolveConnectorBindings(requests, slots, owned);
    } catch (error) {
      if (error instanceof BindingValidationError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /** Connection details with the decrypted credential. Never leaves the backend. */
  target(connector: Pick<Connector, 'id' | 'url' | 'authType' | 'credentialEncrypted'>): McpTarget {
    let bearerToken: string | null = null;
    if (connector.authType === ConnectorAuthType.BEARER && connector.credentialEncrypted) {
      bearerToken = this.encryption.decrypt(connector.credentialEncrypted).token ?? null;
    }
    return { connectorId: connector.id, url: connector.url, bearerToken };
  }

  private async owned(id: string, userId: string): Promise<Connector> {
    const row = await this.prisma.connector.findFirst({ where: { id, userId } });
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
      return new ConflictException(`You already have a connector with handle "${handle}"`);
    }
    return error;
  }
}
