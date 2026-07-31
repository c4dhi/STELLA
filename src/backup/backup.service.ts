import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import * as fs from 'fs/promises'
import { createReadStream } from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { PrismaService } from '../prisma/prisma.service'
import { StorageService } from '../storage/storage.service'
import { EncryptionService } from '../env-var-templates/encryption.service'
import {
  buildManifest,
  countTables,
  readMigrationHead,
  tablesForExport,
  tablesForImport,
  validateForImport,
  allTableNames,
  metricsTableNames,
  BackupManifest,
  PackageEntry,
  EXPORT_CHUNK_ROWS,
} from './manifest'
import {
  encryptBundle,
  decryptBundle,
  isEncryptedBundle,
} from './bundle-crypto'
import { ZipReader, ZipWriter } from './bundle-zip'
import { AuditActor, AuditService } from './audit.service'

/**
 * Every table name we will ever trust from an (untrusted) uploaded manifest.
 * Derived from the live schema, so it automatically covers new tables and can
 * never drift out of sync with what export produces.
 */
const knownTables = (): Set<string> => new Set<string>(allTableNames())

/**
 * Both the export snapshot and the destructive import run as single
 * transactions. A whole-deployment clone can take a while, so the interactive
 * timeout is generous — far better than the Prisma 5 s default, which would
 * abort any real-sized restore mid-flight.
 */
const TX_MAX_WAIT_MS = 60_000
const TX_TIMEOUT_MS = 2 * 60 * 60 * 1000 // 2 hours

export interface BackupExportOptions {
  /** Include the high-volume metrics/observability tables (default false). */
  includeMetrics?: boolean
  /** When set, encrypt the whole bundle at rest under this passphrase. */
  passphrase?: string
}

export interface BackupExportResult {
  /** Absolute path of the finished bundle, ready to stream to the client. */
  bundlePath: string
  filename: string
  byteLength: number
  manifest: BackupManifest
  /** Remove the bundle's temp directory. Call once the bundle is fully sent. */
  cleanup: () => Promise<void>
}

export interface BackupImportOptions {
  /** Absolute path of the uploaded bundle on disk. */
  bundlePath: string
  /** Explicit acknowledgement that import OVERWRITES all existing data. */
  confirmOverwrite: boolean
  /** Passphrase to decrypt the bundle (required iff it was exported encrypted). */
  passphrase?: string
  /** Proceed despite an encryption-key fingerprint mismatch. */
  allowKeyMismatch?: boolean
  /**
   * Who is running this import, for the audit trail (#380). Defaults to the CLI
   * actor, since the in-pod command has no authenticated user.
   */
  actor?: AuditActor
}

export interface TableVerification {
  name: string
  expected: number
  actual: number
  match: boolean
}

export interface BackupImportReport {
  warnings: string[]
  tables: TableVerification[]
  packages: {
    expected: number
    restored: number
    missingOnDisk: string[]
  }
  orphanPackagePaths: string[]
  keyStatus: 'match' | 'mismatch-overridden'
}

/**
 * Full-system data export/import (#378).
 *
 * Engine: pure Prisma + Postgres for the data, archiver/yauzl for the container,
 * Node crypto for encryption — no external binaries (no pg_dump / zip / kubectl).
 * The same code runs identically on a developer's Mac, a dev box, and a
 * production Kubernetes pod — nothing has to be installed on any host.
 *
 * Fidelity is delegated to Postgres itself: each table is exported as
 * `json_agg(row)::text` and re-imported via `json_populate_recordset`, which
 * casts the JSON back through the table's own column types. The aggregate is
 * kept as TEXT end-to-end (never parsed in JS), so even int8/BigInt values
 * round-trip with full precision.
 *
 * Scale: every stage is bounded-memory. Tables are paginated (ctid keyset) into
 * fixed-size chunk files rather than one giant JSON string; the zip is streamed
 * entry-by-entry; encryption streams through the cipher. So a bundle the size of
 * the whole deployment moves through constant RAM. Export reads under a single
 * REPEATABLE READ snapshot for a consistent point-in-time image; import applies
 * the DB restore in one transaction so it is all-or-nothing.
 */
@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditService,
  ) {}

  async export(
    options: BackupExportOptions = {},
  ): Promise<BackupExportResult> {
    const includeMetrics = options.includeMetrics ?? false
    const exportedAt = new Date().toISOString()

    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stella-backup-'))
    const stamp = exportedAt.replace(/[:.]/g, '-')
    const appVersion = await this.readAppVersion()
    let filename = `stella-backup-${appVersion}-${stamp}.zip`
    let bundlePath = path.join(outDir, filename)

    const zip = new ZipWriter(bundlePath)

    // 1. Agent-package files — streamed straight from disk into the archive.
    const packages = await this.addPackagesToZip(zip)

    // 2. Table data + manifest, all read from one consistent snapshot. Tables
    //    are chunked so no single JSON string ever holds a whole table.
    const manifest = await this.prisma.$transaction(
      async (tx) => {
        for (const table of tablesForExport(includeMetrics)) {
          await this.dumpTableChunks(tx, table, zip)
        }
        return buildManifest({
          prisma: tx,
          appVersion,
          exportedAt,
          encryptionKeyFingerprint: this.encryption.getKeyFingerprint(),
          includeMetrics,
          packages,
        })
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: TX_MAX_WAIT_MS,
        timeout: TX_TIMEOUT_MS,
      },
    )

    zip.addBuffer(
      'manifest.json',
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
    )
    await zip.finalize()

    // 3. Optionally encrypt the whole bundle at rest (streamed).
    if (options.passphrase) {
      const encPath = `${bundlePath}.enc`
      await encryptBundle(bundlePath, encPath, options.passphrase)
      await fs.rm(bundlePath, { force: true })
      bundlePath = encPath
      filename = `${filename}.enc`
    }

    const { size } = await fs.stat(bundlePath)
    this.logger.log(
      `Export ready: ${filename} (${size} bytes, ${packages.length} packages, ` +
        `metrics=${includeMetrics}, encrypted=${Boolean(options.passphrase)})`,
    )

    return {
      bundlePath,
      filename,
      byteLength: size,
      manifest,
      cleanup: () => this.removeDir(outDir),
    }
  }

  async import(options: BackupImportOptions): Promise<BackupImportReport> {
    // Audit context (#380). Import is the destructive half — it wipes and
    // replaces the whole deployment, and over HTTP it needs only a SystemAdmin
    // token, no cluster access. Every terminal path below records who did it.
    const actor: AuditActor = options.actor ?? { type: 'cli' }
    const bundleFilename = path.basename(options.bundlePath)

    if (!options.confirmOverwrite) {
      throw new BadRequestException(
        'Import not confirmed: this operation overwrites all existing data ' +
          'and must be explicitly acknowledged.',
      )
    }

    let decryptedPath: string | null = null
    let decryptedDir: string | null = null
    let reader: ZipReader | null = null
    // Guards against double-recording: the rejected path below already writes
    // its own event, and would otherwise also be caught as a failure.
    let audited = false
    try {
      // Decrypt first if the bundle was exported with a passphrase.
      let bundlePath = options.bundlePath
      if (await isEncryptedBundle(options.bundlePath)) {
        if (!options.passphrase) {
          throw new BadRequestException(
            'This backup is encrypted. Provide the passphrase to import it.',
          )
        }
        // Decrypting materializes the bundle in the clear. Stage it in an
        // owner-only (0700) directory rather than a bare tmpdir path, so it is
        // not readable by other local users for the duration of the import.
        decryptedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stella-dec-'))
        decryptedPath = path.join(
          decryptedDir,
          `${crypto.randomBytes(8).toString('hex')}.zip`,
        )
        try {
          await decryptBundle(options.bundlePath, decryptedPath, options.passphrase)
        } catch {
          throw new BadRequestException(
            'Could not decrypt the backup — wrong passphrase or corrupted file.',
          )
        }
        bundlePath = decryptedPath
      }

      reader = await this.openBundle(bundlePath)
      const manifest = await this.readManifest(reader)

      // --- Guards: refuse before any write ---------------------------------
      const target = {
        migrationHead: await readMigrationHead(this.prisma),
        encryptionKeyFingerprint: this.encryption.getKeyFingerprint(),
      }
      const guard = validateForImport(manifest, target, {
        allowKeyMismatch: options.allowKeyMismatch,
      })
      if (!guard.ok) {
        // Record the attempt too, not just the successes — a rejected import is
        // exactly the kind of thing you want to find in the log afterwards.
        await this.audit.record('backup.import', 'rejected', actor, {
          bundleFilename,
          blockers: guard.blockers,
          migrationHead: manifest.migrationHead,
          encryptionKeyFingerprint: manifest.encryptionKeyFingerprint,
        })
        audited = true
        throw new BadRequestException({
          message: 'Backup import rejected before any changes were made.',
          blockers: guard.blockers,
        })
      }

      // Only tables that exist in the live schema are ever trusted from the
      // uploaded manifest (also the SQL-injection allowlist for table names).
      // tablesForImport then drops the never-restore set (the audit log), so it
      // is neither truncated, re-inserted, nor counted during verification.
      const known = knownTables()
      const bundleTables = tablesForImport(
        Object.keys(manifest.tables).filter((t) => known.has(t)),
      )
      const order = this.insertionOrder().filter((t) =>
        bundleTables.includes(t),
      )
      const readerRef = reader

      // --- Destructive phase: DB restore is ONE transaction ----------------
      // truncate + all inserts commit together, so any failure mid-restore
      // rolls back to the pre-import state rather than leaving a half-wiped DB.
      this.logger.warn(
        `Importing backup — OVERWRITING ${bundleTables.length} tables and the ` +
          `agent-package store.`,
      )
      await this.prisma.$transaction(
        async (tx) => {
          await this.truncateTables(tx, bundleTables)
          for (const table of order) {
            for (const chunkName of readerRef.entryNamesUnder(
              `tables/${table}/`,
            )) {
              const buf = await readerRef.readBuffer(chunkName)
              if (!buf) continue
              await this.restoreTableJson(tx, table, buf.toString('utf8'))
            }
          }
        },
        { maxWait: TX_MAX_WAIT_MS, timeout: TX_TIMEOUT_MS },
      )

      // Filesystem package restore can't join the DB transaction; do it after
      // the DB is committed. Missing/partial packages surface in the report.
      await this.restorePackages(reader)

      // --- Verify ----------------------------------------------------------
      const report = await this.verifyRestore(manifest, bundleTables)
      report.warnings.push(...guard.warnings)
      report.warnings.push(...this.cascadeWarnings(manifest, bundleTables))
      this.logger.log(
        `Import complete: ${report.tables.length} tables, ` +
          `${report.packages.restored}/${report.packages.expected} packages, ` +
          `key=${report.keyStatus}`,
      )

      // Written AFTER the transaction commits. Inside it, the truncate would
      // have to spare this table by accident of ordering; the never-restore set
      // keeps it out of the wipe, and committing first keeps it out of a
      // rollback that would erase the record of a restore that did happen.
      await this.audit.record('backup.import', 'success', actor, {
        bundleFilename,
        includesMetrics: manifest.includesMetrics,
        tableCount: report.tables.length,
        packageCount: report.packages.restored,
        migrationHead: manifest.migrationHead,
        encryptionKeyFingerprint: manifest.encryptionKeyFingerprint,
        keyStatus: report.keyStatus,
      })
      audited = true
      return report
    } catch (err) {
      // A failure part-way through is the state most worth having a record of:
      // the deployment may have been left mid-restore. Record it, then rethrow
      // untouched so the caller still sees the original error.
      if (!audited) {
        await this.audit.record('backup.import', 'failed', actor, {
          bundleFilename,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
      throw err
    } finally {
      reader?.close()
      // The uploaded bundle (and any decrypted copy) is a credential — delete.
      await fs.rm(options.bundlePath, { force: true }).catch(() => undefined)
      if (decryptedDir) {
        // Removes the staging directory and the decrypted bundle inside it.
        await fs
          .rm(decryptedDir, { recursive: true, force: true })
          .catch(() => undefined)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Table data — Postgres does the type round-trip; JS never parses the rows.
  // ---------------------------------------------------------------------------

  /**
   * Export one table as a sequence of bounded JSON chunk files
   * (`tables/<table>/<seq>.json`). Pages are walked by ctid keyset — a stable
   * cursor that works on any table without assuming a specific primary key —
   * within the caller's REPEATABLE READ snapshot, so ctids don't shift under us.
   * The system `__ctid` column is stripped from each emitted row.
   */
  private async dumpTableChunks(
    tx: Prisma.TransactionClient,
    table: string,
    zip: ZipWriter,
  ): Promise<void> {
    let lastCtid: string | null = null
    let seq = 0
    for (;;) {
      const rows = await tx.$queryRawUnsafe<
        Array<{ data: string; last_ctid: string | null; n: number }>
      >(
        `WITH page AS (
           SELECT t.*, t.ctid AS __ctid
           FROM "${table}" t
           WHERE ($1::tid IS NULL OR t.ctid > $1::tid)
           ORDER BY t.ctid
           LIMIT ${EXPORT_CHUNK_ROWS}
         )
         SELECT coalesce(json_agg(to_jsonb(page) - '__ctid'), '[]')::text AS data,
                max(__ctid)::text AS last_ctid,
                count(*)::int AS n
         FROM page`,
        lastCtid,
      )
      const row = rows[0]
      const n = row?.n ?? 0
      if (n === 0) break
      zip.addBuffer(
        `tables/${table}/${String(seq).padStart(6, '0')}.json`,
        Buffer.from(row.data, 'utf8'),
      )
      seq += 1
      lastCtid = row.last_ctid
      if (n < EXPORT_CHUNK_ROWS) break
    }
  }

  /** Restore one chunk of a table from a JSON array string via
   * json_populate_recordset. Runs on the caller's transaction client. */
  private async restoreTableJson(
    tx: Prisma.TransactionClient,
    table: string,
    json: string,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO "${table}" SELECT * FROM json_populate_recordset(NULL::"${table}", $1::json)`,
      json,
    )
  }

  /** Empty the given tables. CASCADE + RESTART IDENTITY so order/sequences are
   * irrelevant. Names are allowlist-checked already. Runs on the caller's tx. */
  private async truncateTables(
    tx: Prisma.TransactionClient,
    tables: string[],
  ): Promise<void> {
    if (tables.length === 0) return
    const quoted = tables.map((t) => `"${t}"`).join(', ')
    await tx.$executeRawUnsafe(`TRUNCATE ${quoted} RESTART IDENTITY CASCADE`)
  }

  /**
   * Warn when a core-only restore will have emptied metrics/log tables as a
   * side effect: those tables FK to core rows, so `TRUNCATE ... CASCADE` on the
   * core set empties them even though the bundle never restores them. Harmless
   * when cloning onto a fresh target, but silent data loss on a live one.
   */
  private cascadeWarnings(
    manifest: BackupManifest,
    bundleTables: string[],
  ): string[] {
    if (manifest.includesMetrics) return []
    const cascaded = metricsTableNames().filter(
      (t) => !bundleTables.includes(t),
    )
    if (cascaded.length === 0) return []
    return [
      `Metrics/log tables were emptied via TRUNCATE CASCADE and NOT restored ` +
        `(bundle excluded metrics): ${cascaded.join(', ')}. Expected when ` +
        `cloning onto a fresh target; on a live system this drops its existing ` +
        `metrics/logs.`,
    ]
  }

  /**
   * Topological insert order (dependencies first) derived from the live Prisma
   * schema, so it adapts to schema changes instead of being hand-maintained.
   * A model "depends on" any model it holds a foreign key to (relationFromFields).
   * Returns Postgres table names (honouring @@map), matching the bundle's keys.
   */
  private insertionOrder(): string[] {
    const models = Prisma.dmmf.datamodel.models
    const names = new Set(models.map((m) => m.name))
    const tableOf = new Map(models.map((m) => [m.name, m.dbName ?? m.name]))
    const deps = new Map<string, Set<string>>()
    for (const m of models) {
      const set = new Set<string>()
      for (const f of m.fields) {
        if (
          f.kind === 'object' &&
          f.relationFromFields &&
          f.relationFromFields.length > 0 &&
          f.type !== m.name &&
          names.has(f.type)
        ) {
          set.add(f.type)
        }
      }
      deps.set(m.name, set)
    }

    const order: string[] = []
    const visited = new Set<string>()
    const inProgress = new Set<string>()
    const visit = (n: string) => {
      if (visited.has(n) || inProgress.has(n)) return // skip done / break cycles
      inProgress.add(n)
      for (const d of deps.get(n) ?? []) visit(d)
      inProgress.delete(n)
      visited.add(n)
      order.push(tableOf.get(n) ?? n)
    }
    for (const m of models) visit(m.name)
    return order
  }

  // ---------------------------------------------------------------------------
  // Agent-package files
  // ---------------------------------------------------------------------------

  /** Add the whole agent-package tree to the zip under `packages/`, streaming
   * each file from disk. Returns a checksum manifest ([] when none exist yet). */
  private async addPackagesToZip(zip: ZipWriter): Promise<PackageEntry[]> {
    const root = this.storage.getStorageRoot()
    try {
      await fs.access(root)
    } catch {
      return []
    }
    return this.walkPackages(zip, root, root)
  }

  private async walkPackages(
    zip: ZipWriter,
    dir: string,
    base: string,
  ): Promise<PackageEntry[]> {
    const entries: PackageEntry[] = []
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    for (const dirent of dirents) {
      const abs = path.join(dir, dirent.name)
      if (dirent.isDirectory()) {
        entries.push(...(await this.walkPackages(zip, abs, base)))
      } else if (dirent.isFile()) {
        const rel = path.relative(base, abs)
        // Stream the file into the archive; hash it in a separate streamed pass
        // so neither step holds the whole file in memory.
        zip.addFile(`packages/${rel}`, abs)
        entries.push({
          path: rel,
          bytes: (await fs.stat(abs)).size,
          sha256: await this.hashFile(abs),
        })
      }
    }
    return entries
  }

  private async hashFile(absPath: string): Promise<string> {
    const hash = crypto.createHash('sha256')
    await new Promise<void>((resolve, reject) => {
      createReadStream(absPath)
        .on('data', (d) => hash.update(d))
        .on('end', () => resolve())
        .on('error', reject)
    })
    return hash.digest('hex')
  }

  /** Replace the entire agent-package store with the bundle's `packages/` tree,
   * streaming each entry to disk. */
  private async restorePackages(reader: ZipReader): Promise<void> {
    const root = this.storage.getStorageRoot()
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
    const prefix = 'packages/'
    for (const name of reader.entryNamesUnder(prefix)) {
      const rel = name.slice(prefix.length)
      const dest = this.storage.getAbsolutePath(rel)
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await reader.extractTo(name, dest)
    }
  }

  // ---------------------------------------------------------------------------
  // Bundle + manifest helpers
  // ---------------------------------------------------------------------------

  private async openBundle(bundlePath: string): Promise<ZipReader> {
    try {
      return await ZipReader.open(bundlePath)
    } catch {
      throw new BadRequestException('Invalid bundle: not a readable .zip archive.')
    }
  }

  private async readManifest(reader: ZipReader): Promise<BackupManifest> {
    const buf = await reader.readBuffer('manifest.json')
    if (!buf) {
      throw new BadRequestException('Invalid bundle: manifest.json is missing.')
    }
    try {
      return JSON.parse(buf.toString('utf8')) as BackupManifest
    } catch {
      throw new BadRequestException('Invalid bundle: manifest.json is unreadable.')
    }
  }

  private async verifyRestore(
    manifest: BackupManifest,
    tableNames: string[],
  ): Promise<BackupImportReport> {
    const actual = await countTables(this.prisma, tableNames)
    const tables: TableVerification[] = tableNames.map((name) => {
      const expected = manifest.tables[name] ?? 0
      const got = actual[name] ?? 0
      return { name, expected, actual: got, match: expected === got }
    })

    const missingOnDisk: string[] = []
    for (const pkg of manifest.packages) {
      try {
        await fs.access(this.storage.getAbsolutePath(pkg.path))
      } catch {
        missingOnDisk.push(pkg.path)
      }
    }

    // Referential integrity: every AgentType.packagePath must resolve to a file.
    const orphanPackagePaths: string[] = []
    const agentTypes = await this.prisma.agentType.findMany({
      where: { packagePath: { not: null } },
      select: { packagePath: true },
    })
    for (const at of agentTypes) {
      if (!at.packagePath) continue
      try {
        await fs.access(this.storage.getAbsolutePath(at.packagePath))
      } catch {
        orphanPackagePaths.push(at.packagePath)
      }
    }

    return {
      warnings: [],
      tables,
      packages: {
        expected: manifest.packages.length,
        restored: manifest.packages.length - missingOnDisk.length,
        missingOnDisk,
      },
      orphanPackagePaths,
      keyStatus:
        manifest.encryptionKeyFingerprint ===
        this.encryption.getKeyFingerprint()
          ? 'match'
          : 'mismatch-overridden',
    }
  }

  private async readAppVersion(): Promise<string> {
    try {
      const raw = await fs.readFile(
        path.join(process.cwd(), 'package.json'),
        'utf8',
      )
      return (JSON.parse(raw).version as string) ?? 'unknown'
    } catch {
      return 'unknown'
    }
  }

  private async removeDir(dir: string): Promise<void> {
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch (err) {
      this.logger.warn(`Failed to remove temp dir ${dir}: ${String(err)}`)
    }
  }
}
