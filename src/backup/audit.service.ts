import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'

/**
 * Audit trail for privileged, destructive operations (#380).
 *
 * Scope is deliberately narrow — backup IMPORT. That endpoint is reachable over
 * HTTP by any SystemAdmin with no cluster access, it truncates and replaces the
 * entire deployment, and until now it left no record of who ran it (the existing
 * controller log line captures only a byte count). Export is not audited: it
 * requires cluster access, and anyone holding that can read the secrets directly
 * via `kubectl get secret`, so recording only the polite route buys nothing.
 *
 * Two rules this service exists to enforce:
 *
 *  1. **Never record a secret value.** Callers pass fingerprints, counts, and
 *     filenames. {@link AuditDetail} is typed to make that the easy path.
 *  2. **Never break the operation it is recording.** An audit write that throws
 *     must not turn a successful restore into a failure, so every write is
 *     best-effort and logs on failure instead of propagating.
 */

/** Who performed the action. */
export interface AuditActor {
  /** 'system-admin' for the HTTP path, 'cli' for the in-pod command. */
  type: 'system-admin' | 'cli'
  /** User id — null for the CLI, which has no authenticated user. */
  id?: string | null
  /** Email for a user, or "user@host" for the CLI. */
  label?: string | null
}

/**
 * Non-sensitive context for the event. Every field here is safe to persist:
 * counts, flags, filenames, and the key FINGERPRINT (a SHA-256, never the key).
 */
export interface AuditDetail {
  bundleFilename?: string
  byteLength?: number
  encrypted?: boolean
  includesMetrics?: boolean
  packageCount?: number
  tableCount?: number
  migrationHead?: string | null
  encryptionKeyFingerprint?: string | null
  keyStatus?: string
  /** Guard blockers for a rejected import — these quote fingerprints, not keys. */
  blockers?: string[]
  /** Failure reason for outcome 'failed'. */
  reason?: string
}

export type AuditOutcome = 'success' | 'rejected' | 'failed'

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record one audited action. Best-effort by design: a failure to write the
   * audit row is logged loudly but never thrown, because losing the record of a
   * restore is strictly better than failing a restore that already succeeded.
   *
   * Call AFTER the import transaction commits — the import truncates every
   * restorable table, so a row written inside it would survive only by accident
   * of ordering.
   */
  async record(
    action: string,
    outcome: AuditOutcome,
    actor: AuditActor,
    detail: AuditDetail = {},
  ): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          action,
          outcome,
          actorType: actor.type,
          actorId: actor.id ?? null,
          actorLabel: actor.label ?? null,
          detail: detail as object,
        },
      })
      this.logger.log(
        `audit: ${action} ${outcome} by ${actor.label ?? actor.type}`,
      )
    } catch (err) {
      this.logger.error(
        `Failed to write audit event for ${action}/${outcome}: ${String(err)}`,
      )
    }
  }
}
