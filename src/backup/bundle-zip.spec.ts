import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { ZipWriter, ZipReader, copyZipAdding } from './bundle-zip.js'

/**
 * Streaming zip writer/reader round-trip (#378). Covers buffer entries, a
 * file-on-disk entry, prefix iteration (how a table's chunks are discovered on
 * import), and the host-side copy-with-added-config path.
 */
describe('bundle-zip', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stella-zip-test-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('writes and reads back buffer + file entries', async () => {
    const srcFile = path.join(dir, 'pkg.bin')
    await fs.writeFile(srcFile, Buffer.from([1, 2, 3, 4, 5]))

    const zipPath = path.join(dir, 'a.zip')
    const w = await ZipWriter.create(zipPath)
    w.addBuffer('manifest.json', Buffer.from('{"formatVersion":2}', 'utf8'))
    w.addBuffer('tables/User/000000.json', Buffer.from('[{"id":"u1"}]', 'utf8'))
    w.addBuffer('tables/User/000001.json', Buffer.from('[{"id":"u2"}]', 'utf8'))
    w.addFile('packages/pkg.bin', srcFile)
    await w.finalize()

    const r = await ZipReader.open(zipPath)
    try {
      const manifest = await r.readBuffer('manifest.json')
      expect(manifest?.toString('utf8')).toBe('{"formatVersion":2}')

      const chunks = r.entryNamesUnder('tables/User/')
      expect(chunks).toEqual([
        'tables/User/000000.json',
        'tables/User/000001.json',
      ])

      const dest = path.join(dir, 'out.bin')
      const ok = await r.extractTo('packages/pkg.bin', dest)
      expect(ok).toBe(true)
      expect((await fs.readFile(dest)).equals(Buffer.from([1, 2, 3, 4, 5]))).toBe(
        true,
      )

      expect(await r.readBuffer('does-not-exist')).toBeNull()
    } finally {
      r.close()
    }
  })

  it('copyZipAdding copies all entries and folds in an extra entry', async () => {
    const srcPath = path.join(dir, 'data.zip')
    const w = await ZipWriter.create(srcPath)
    w.addBuffer('manifest.json', Buffer.from('M', 'utf8'))
    w.addBuffer('tables/Room/000000.json', Buffer.from('[]', 'utf8'))
    await w.finalize()

    const outPath = path.join(dir, 'final.zip')
    await copyZipAdding(srcPath, outPath, [
      { name: 'config/deployment.env', data: Buffer.from('KEY=val', 'utf8') },
    ])

    const r = await ZipReader.open(outPath)
    try {
      const names = r.entries().map((e) => e.name).sort()
      expect(names).toEqual([
        'config/deployment.env',
        'manifest.json',
        'tables/Room/000000.json',
      ])
      expect((await r.readBuffer('config/deployment.env'))?.toString('utf8')).toBe(
        'KEY=val',
      )
      expect((await r.readBuffer('manifest.json'))?.toString('utf8')).toBe('M')
    } finally {
      r.close()
    }
  })
})
