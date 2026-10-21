import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { summarizeToolArgs } from './mcp-audit.util.js';

const RETENTION_DAYS = 90;

export interface McpAuditEntry {
  userId: string;
  tokenId?: string;
  oauthGrantId?: string;
  tool: string;
  args: unknown;
  success: boolean;
  errorCode?: string;
  durationMs: number;
}

/** Records every MCP tool call (#772) and drops records after 90 days. */
@Injectable()
export class McpAuditService {
  private readonly logger = new Logger(McpAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Never fails the tool call it describes: a lost audit row is logged instead. */
  async record(entry: McpAuditEntry): Promise<void> {
    this.logger.log(
      `MCP ${entry.tool} by user ${entry.userId} ${entry.success ? 'ok' : `failed (${entry.errorCode})`} in ${entry.durationMs}ms`,
    );
    try {
      await this.prisma.mcpAuditLog.create({
        data: {
          userId: entry.userId,
          tokenId: entry.tokenId ?? null,
          oauthGrantId: entry.oauthGrantId ?? null,
          tool: entry.tool,
          argsSummary: summarizeToolArgs(entry.args) as object,
          success: entry.success,
          errorCode: entry.errorCode ?? null,
          durationMs: entry.durationMs,
        },
      });
    } catch (error) {
      this.logger.warn(`Could not store audit row for ${entry.tool}: ${error.message}`);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeOld(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const { count } = await this.prisma.mcpAuditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    if (count > 0) this.logger.log(`Deleted ${count} MCP audit rows older than ${RETENTION_DAYS} days`);
  }
}
