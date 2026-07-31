/**
 * Streaming zip helpers for the backup engine (#378).
 *
 * The backup bundle can be the size of a whole deployment (the DB plus every
 * agent package), so it must never be materialized in memory as a single
 * archive. These helpers wrap `archiver` (write) and `yauzl` (read) so both
 * export and import move through the archive one entry at a time, with only the
 * current chunk/file resident in RAM.
 *
 * Shared by the in-pod backend engine (backup.service.ts) and the host-side
 * wizard helper (scripts/backup-bundle.ts) so both ends speak the exact same
 * on-disk format.
 */
import archiver from 'archiver'
import * as yauzl from 'yauzl'
import * as fs from 'fs'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

/** Deflate level 1: bundles are huge and often already-compressed (package
 * zips), so favour speed over ratio. */
const ZIP_LEVEL = 1

/**
 * Incrementally builds a zip to `outPath`. Entries are appended in call order
 * and flushed to disk as they arrive, so memory stays bounded regardless of the
 * total archive size. Always `await finalize()` exactly once.
 */
export class ZipWriter {
  private readonly archive = archiver('zip', { zlib: { level: ZIP_LEVEL } })
  private readonly done: Promise<void>

  constructor(outPath: string) {
    // A bundle carries password hashes and (once the deploy layer folds in the
    // .env) every deployment secret. Create it owner-only rather than inheriting
    // the process umask, which on a typical host yields a world-readable 0644.
    const out = fs.createWriteStream(outPath, { mode: 0o600 })
    this.done = new Promise<void>((resolve, reject) => {
      out.on('close', resolve)
      out.on('error', reject)
      this.archive.on('error', reject)
      this.archive.on('warning', (w) => {
        // ENOENT etc. on a single entry shouldn't be swallowed silently.
        if ((w as NodeJS.ErrnoException).code !== 'ENOENT') reject(w)
      })
    })
    this.archive.pipe(out)
  }

  /** Add a small in-memory entry (manifest, a table chunk). */
  addBuffer(name: string, data: Buffer): void {
    this.archive.append(data, { name })
  }

  /** Add a file from disk by streaming it (agent package) — never read whole. */
  addFile(name: string, filePath: string): void {
    this.archive.file(filePath, { name })
  }

  /** Append an entry from a readable stream and resolve once that single entry
   * has been fully consumed — so callers can copy a large archive one entry at a
   * time without opening every source stream at once. */
  addStreamAwait(name: string, stream: Readable): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onEntry = (): void => {
        this.archive.removeListener('error', onError)
        resolve()
      }
      const onError = (err: Error): void => {
        this.archive.removeListener('entry', onEntry)
        reject(err)
      }
      this.archive.once('entry', onEntry)
      this.archive.once('error', onError)
      this.archive.append(stream, { name })
    })
  }

  /** Flush the central directory and wait until every byte is on disk. */
  async finalize(): Promise<void> {
    await this.archive.finalize()
    await this.done
  }
}

export interface ZipEntryInfo {
  name: string
  isDirectory: boolean
}

/**
 * Random-access reader over a zip on disk. The archive is opened once and its
 * central directory indexed; individual entries are then streamed on demand, so
 * only the entry currently being read is in memory.
 */
export class ZipReader {
  private constructor(
    private readonly zip: yauzl.ZipFile,
    private readonly index: Map<string, yauzl.Entry>,
  ) {}

  static open(path: string): Promise<ZipReader> {
    return new Promise((resolve, reject) => {
      // autoClose:false — yauzl would otherwise close the file once all entries
      // are enumerated, but we index first and stream entries on demand after.
      yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
        if (err || !zip) {
          reject(err ?? new Error('could not open zip'))
          return
        }
        const index = new Map<string, yauzl.Entry>()
        zip.on('entry', (entry: yauzl.Entry) => {
          index.set(entry.fileName, entry)
          zip.readEntry()
        })
        zip.on('end', () => resolve(new ZipReader(zip, index)))
        zip.on('error', reject)
        zip.readEntry()
      })
    })
  }

  /** All entries, in central-directory order. */
  entries(): ZipEntryInfo[] {
    return [...this.index.keys()].map((name) => ({
      name,
      isDirectory: name.endsWith('/'),
    }))
  }

  /** Entry names under a `prefix/`, sorted — used to iterate a table's chunks. */
  entryNamesUnder(prefix: string): string[] {
    return [...this.index.keys()]
      .filter((n) => n.startsWith(prefix) && !n.endsWith('/'))
      .sort()
  }

  /** Open a raw read stream for one entry (caller consumes it). */
  openStream(name: string): Promise<Readable | null> {
    const entry = this.index.get(name)
    if (!entry) return Promise.resolve(null)
    return new Promise((resolve, reject) => {
      this.zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) reject(err ?? new Error('could not read entry'))
        else resolve(stream)
      })
    })
  }

  /** Fully read one entry into a Buffer. For bounded entries only (manifest,
   * a single table chunk) — never for whole-archive-sized data. */
  async readBuffer(name: string): Promise<Buffer | null> {
    const stream = await this.openStream(name)
    if (!stream) return null
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(c as Buffer)
    return Buffer.concat(chunks)
  }

  /** Stream one entry straight to a file on disk (agent package restore). */
  async extractTo(name: string, destPath: string): Promise<boolean> {
    const stream = await this.openStream(name)
    if (!stream) return false
    await pipeline(stream, fs.createWriteStream(destPath))
    return true
  }

  close(): void {
    this.zip.close()
  }
}

/**
 * Copy every entry of `srcPath` into a fresh zip at `outPath`, plus any extra
 * in-memory entries — all streamed one entry at a time. Used host-side to fold
 * the deployment config into the pod's data bundle without loading either
 * archive into memory.
 */
export async function copyZipAdding(
  srcPath: string,
  outPath: string,
  extra: Array<{ name: string; data: Buffer }>,
): Promise<void> {
  const reader = await ZipReader.open(srcPath)
  const writer = new ZipWriter(outPath)
  try {
    for (const { name, isDirectory } of reader.entries()) {
      if (isDirectory) continue
      const stream = await reader.openStream(name)
      if (!stream) continue
      await writer.addStreamAwait(name, stream)
    }
    for (const e of extra) writer.addBuffer(e.name, e.data)
    await writer.finalize()
  } finally {
    reader.close()
  }
}
