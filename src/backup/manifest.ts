import { Prisma } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'

/**
 * The subset of the Prisma client these helpers need. Declared structurally so
 * they work with both the injected {@link PrismaService} and an interactive
 * transaction client (`prisma.$transaction(tx => ...)`), letting export read all
 * counts inside the same snapshot as the row dumps.
 */
export type RawSqlClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

/**
 * Full-system backup manifest (#378).
 *
 * The manifest is the small JSON file that travels inside every backup bundle
 * and makes a bundle SAFE to move between machines. It records what the bundle
 * was made from so that {@link validateForImport} can refuse a restore that
 * would silently corrupt the target:
 *   - the migration head, so a bundle whose schema predates/postdates the
 *     target's migrations is rejected before any data is written, and
 *   - a non-reversible fingerprint of ENV_VAR_ENCRYPTION_KEY, so a bundle
 *     exported under a different key is caught instead of restoring secrets
 *     that can never be decrypted (the single biggest correctness risk).
 *
 * The key itself is NEVER written to the bundle — only its SHA-256 fingerprint.
 */

/** Bump when the bundle layout or manifest shape changes incompatibly.
 *  v2: per-table data is chunked into `tables/<Table>/<seq>.json` (was a single
 *  `tables/<Table>.json`) so no table is ever materialized as one JSON string. */
export const BACKUP_FORMAT_VERSION = 2

/**
 * Max rows per exported table chunk. Keeps each JSON chunk (and the string built
 * to insert it) comfortably under Postgres' 1 GB field cap and V8's ~512 MB
 * single-string cap, no matter how large a table grows.
 */
export const EXPORT_CHUNK_ROWS = 1000

/**
 * The set of tables a backup covers is DERIVED FROM THE PRISMA SCHEMA, not a
 * hand-maintained list — so extending the schema automatically extends the
 * backup, and no table can be silently left out. Model names map to Postgres
 * table names via `@@map` (`dbName`) when present, else the model name itself.
 *
 * The ONLY hand-maintained bit is {@link METRICS_MODELS}: an opt-out list of
 * high-volume, low-migration-value observability tables that are excluded by
 * default (and included with the metrics flag). Forgetting to add a new
 * high-volume table here is safe — it just gets exported as core data, i.e. the
 * bundle stays complete, only larger.
 */
export const METRICS_MODELS = [
  'UsageMetricsSnapshot',
  'ServerMetricsSnapshot',
  'SessionActivityLog',
  'RoomEvent',
  'AgentBuildLog',
] as const

/**
 * Models that are EXPORTED (so a bundle carries the evidence) but never
 * truncated or overwritten by an import.
 *
 * An import wipes every other table and replaces it with the bundle's contents.
 * If the audit log were restored like normal data, importing a bundle would
 * erase the target's record of every prior privileged operation — including the
 * record of the import doing the erasing. An audit trail an attacker can clear
 * by uploading a file is not an audit trail, so the target's own history always
 * wins here.
 */
export const NEVER_RESTORE_MODELS = ['AuditEvent'] as const

/** Postgres table name for a Prisma model (honours @@map). */
function tableNameOf(model: { name: string; dbName?: string | null }): string {
  return model.dbName ?? model.name
}

/** Every table defined by the live schema — the single source of truth. */
export function allTableNames(): string[] {
  return Prisma.dmmf.datamodel.models.map(tableNameOf)
}

/** Table names for the metrics opt-out models that actually exist in the schema. */
export function metricsTableNames(): string[] {
  const opt = new Set<string>(METRICS_MODELS)
  return Prisma.dmmf.datamodel.models
    .filter((m) => opt.has(m.name))
    .map(tableNameOf)
}

/** Durable application data: everything that isn't a metrics/observability table. */
export function coreTableNames(): string[] {
  const metrics = new Set(metricsTableNames())
  return allTableNames().filter((t) => !metrics.has(t))
}

/** Table names for {@link NEVER_RESTORE_MODELS} that exist in the live schema. */
export function neverRestoreTableNames(): string[] {
  const never = new Set<string>(NEVER_RESTORE_MODELS)
  return Prisma.dmmf.datamodel.models
    .filter((m) => never.has(m.name))
    .map(tableNameOf)
}

/**
 * Narrow a bundle's tables to those an import may actually write. Applying this
 * in ONE place means truncate, restore, and post-restore verification all agree
 * — a table dropped here is never emptied, never re-inserted, and never
 * reported as a count mismatch.
 */
export function tablesForImport(bundleTables: string[]): string[] {
  const never = new Set(neverRestoreTableNames())
  return bundleTables.filter((t) => !never.has(t))
}

/** Resolve the set of tables to count/restore for the chosen metrics policy. */
export function tablesForExport(includeMetrics: boolean): string[] {
  return includeMetrics ? allTableNames() : coreTableNames()
}

/** One bundled agent-package file (from AGENT_STORAGE_PATH). */
export interface PackageEntry {
  /** Path relative to the storage root — matches AgentType.packagePath. */
  path: string
  bytes: number
  sha256: string
}

export interface BackupManifest {
  formatVersion: number
  /** STELLA app version at export time (package.json). */
  appVersion: string
  /** ISO-8601 export timestamp. */
  exportedAt: string
  /** Latest applied Prisma migration on the source DB (null if none). */
  migrationHead: string | null
  /** SHA-256 of ENV_VAR_ENCRYPTION_KEY (null when encryption was disabled). */
  encryptionKeyFingerprint: string | null
  /** Whether the high-volume metrics tables were included. */
  includesMetrics: boolean
  /** Per-table row counts, for post-restore verification. */
  tables: Record<string, number>
  packages: PackageEntry[]
  packageCount: number
}

/**
 * The latest applied (non-rolled-back) Prisma migration on a database — the
 * "migration head". Two deployments are schema-compatible iff their heads match.
 */
export async function readMigrationHead(
  prisma: RawSqlClient,
): Promise<string | null> {
  // Order by finished_at (most-recently-applied) with migration_name as a
  // deterministic tiebreaker. Prisma names are timestamp-prefixed, so for the
  // normal in-order apply path this equals the logically-latest migration; the
  // tiebreaker only matters under out-of-order repair/resolve.
  const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
    `SELECT migration_name FROM _prisma_migrations
       WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
       ORDER BY finished_at DESC, migration_name DESC
       LIMIT 1`,
  )
  return rows.length > 0 ? rows[0].migration_name : null
}

/**
 * Count rows for each given table. Names come exclusively from the live Prisma
 * schema (via {@link allTableNames}) or an allowlist filtered against it — never
 * raw user input — so interpolating them into the query is safe.
 */
export async function countTables(
  prisma: RawSqlClient,
  tables: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const table of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "${table}"`,
    )
    counts[table] = Number(rows[0]?.count ?? 0)
  }
  return counts
}

/** Inputs gathered by the export service before writing the manifest. */
export interface BuildManifestInput {
  prisma: RawSqlClient
  appVersion: string
  exportedAt: string
  encryptionKeyFingerprint: string | null
  includeMetrics: boolean
  packages: PackageEntry[]
}

export async function buildManifest(
  input: BuildManifestInput,
): Promise<BackupManifest> {
  const tables = await countTables(
    input.prisma,
    tablesForExport(input.includeMetrics),
  )
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: input.appVersion,
    exportedAt: input.exportedAt,
    migrationHead: await readMigrationHead(input.prisma),
    encryptionKeyFingerprint: input.encryptionKeyFingerprint,
    includesMetrics: input.includeMetrics,
    tables,
    packages: input.packages,
    packageCount: input.packages.length,
  }
}

/** The live state of the deployment a bundle is about to be imported into. */
export interface ImportTarget {
  migrationHead: string | null
  encryptionKeyFingerprint: string | null
}

export interface ImportGuardOptions {
  /** Proceed despite an encryption-key fingerprint mismatch (downgrades the
   * hard block to a loud warning — secrets will NOT decrypt). */
  allowKeyMismatch?: boolean
}

export interface ImportGuardResult {
  ok: boolean
  /** Reasons the import must not proceed. Non-empty ⇒ abort. */
  blockers: string[]
  /** Non-fatal concerns to surface to the operator. */
  warnings: string[]
}

/**
 * Decide whether a bundle may be restored onto a target. Pure and synchronous
 * so every branch is unit-testable without a database. Guards, in order:
 *
 *  1. Format version — an unknown bundle layout can't be trusted; hard block.
 *  2. Migration head — a schema mismatch would restore data into the wrong
 *     shape; hard block, no override (the operator must align migrations first).
 *  3. Encryption-key fingerprint — a mismatch means restored secrets can't be
 *     decrypted; hard block UNLESS allowKeyMismatch, which downgrades it to a
 *     warning so a deliberate "data only, I'll re-enter secrets" restore is
 *     possible.
 */
export function validateForImport(
  manifest: BackupManifest,
  target: ImportTarget,
  options: ImportGuardOptions = {},
): ImportGuardResult {
  const blockers: string[] = []
  const warnings: string[] = []

  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    blockers.push(
      `Unsupported bundle format version ${manifest.formatVersion} ` +
        `(this server supports ${BACKUP_FORMAT_VERSION}).`,
    )
  }

  if (manifest.migrationHead !== target.migrationHead) {
    blockers.push(
      `Migration head mismatch: bundle was exported at ` +
        `"${manifest.migrationHead ?? '(none)'}" but this server is at ` +
        `"${target.migrationHead ?? '(none)'}". Align migrations before importing.`,
    )
  }

  if (
    manifest.encryptionKeyFingerprint !== target.encryptionKeyFingerprint
  ) {
    const detail =
      `Encryption-key mismatch: the bundle was exported under a different ` +
      `ENV_VAR_ENCRYPTION_KEY than this server. Encrypted env-var templates ` +
      `and agent secrets will NOT decrypt after restore.`
    if (options.allowKeyMismatch) {
      warnings.push(`${detail} Proceeding because key-mismatch override is set.`)
    } else {
      blockers.push(
        `${detail} Restore the original key, or pass the key-mismatch ` +
          `override to import anyway (secrets must then be re-entered).`,
      )
    }
  }

  return { ok: blockers.length === 0, blockers, warnings }
}
