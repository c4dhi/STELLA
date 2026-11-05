import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { summarizeToolArgs } from '../mcp/mcp-audit.util.js';

const RETENTION_DAYS = 90;

export interface ConnectorAuditEntry {
  connectorId: string;
  userId: string;
  agentInstanceId?: string;
  sessionId?: string;
  operation: 'initialize' | 'tools/list' | 'tools/call';
  tool?: string;
  args?: unknown;
  success: boolean;
  errorCode?: string;
  durationMs: number;
}

/**
 * Records every outbound connector call, the client-side twin of McpAuditService
 * (same argument redaction, same 90-day retention).
 */
@Injectable()
export class ConnectorAuditService {
  private readonly logger = new Logger(ConnectorAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Never fails the call it describes: a lost audit row is logged instead. */
  async record(entry: ConnectorAuditEntry): Promise<void> {
    const who = entry.agentInstanceId ? `agent ${entry.agentInstanceId}` : `user ${entry.userId}`;
    this.logger.log(
      `Connector ${entry.connectorId} ${entry.operation}${entry.tool ? ` ${entry.tool}` : ''} by ${who} ${entry.success ? 'ok' : `failed (${entry.errorCode})`} in ${entry.durationMs}ms`,
    );
    try {
      await this.prisma.connectorAuditLog.create({
        data: {
          connectorId: entry.connectorId,
          userId: entry.userId,
          agentInstanceId: entry.agentInstanceId ?? null,
          sessionId: entry.sessionId ?? null,
          operation: entry.operation,
          tool: entry.tool ?? null,
          argsSummary:
            entry.args === undefined ? undefined : (summarizeToolArgs(entry.args) as object),
          success: entry.success,
          errorCode: entry.errorCode ?? null,
          durationMs: entry.durationMs,
        },
      });
    } catch (error) {
      this.logger.warn(`Could not store connector audit row: ${(error as Error).message}`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeOld(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.connectorAuditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    if (count > 0)
      this.logger.log(`Deleted ${count} connector audit rows older than ${RETENTION_DAYS} days`);
  }
}
