import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { EncryptionService } from '../env-var-templates/encryption.service'
import { decryptBundle, encryptBundle } from './bundle-crypto'
import { BACKUP_FORMAT_VERSION, BackupManifest, validateForImport } from './manifest'

/**
 * Secret-leak regression guard (#380).
 *
 * A backup bundle is a full credential: the master ENV_VAR_ENCRYPTION_KEY, every
 * API key, every password hash. The one rule the backup path must never break is
 * that none of those VALUES ends up somewhere durable and lower-trust than the
 * bundle itself — a pod log, an error string bubbled to an operator's terminal,
 * or an API response.
 *
 * The code is clean today; this test exists so it stays that way. It plants
 * sentinel values, exercises the paths that handle them (including the failure
 * paths, which is where leaks usually appear), and asserts no sentinel escapes
 * into captured log output or thrown-error text.
 *
 * Scope is deliberately in-process: no database, no containers. Full export /
 * import fidelity is covered by scripts/backup-roundtrip-test.sh.
 */

// Distinctive enough that a substring match cannot fire by accident.
const SENTINEL_KEY = 'aa11bb22cc33dd44ee55ff6607788990a1b2c3d4e5f60718293a4b5c6d7e8f90'
const SENTINEL_SECRET = 'SENTINEL-OPENAI-KEY-b9c4e1f7'
const SENTINEL_PASSPHRASE = 'SENTINEL-PASSPHRASE-4d8a2c'

/** Capture everything written through Nest's Logger for the duration of `run`. */
async function captureLogs(run: () => Promise<void> | void): Promise<string> {
  const captured: string[] = []
  const methods = ['log', 'warn', 'error', 'debug', 'verbose'] as const
  const spies = methods.map((m) =>
    jest
      .spyOn(Logger.prototype, m)
      .mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(' '))
      }),
  )
  try {
    await run()
  } finally {
    spies.forEach((s) => s.mockRestore())
  }
  return captured.join('\n')
}

function encryptionServiceWithKey(keyHex: string | undefined): EncryptionService {
  const config = {
    get: (name: string) => (name === 'ENV_VAR_ENCRYPTION_KEY' ? keyHex : undefined),
  } as unknown as ConfigService
  const service = new EncryptionService(config)
  service.onModuleInit()
  return service
}

describe('backup secret-leak guard', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stella-leak-test-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('never logs the encryption key or the values it protects', async () => {
    const logs = await captureLogs(() => {
      const service = encryptionServiceWithKey(SENTINEL_KEY)
      const blob = service.encrypt({ OPENAI_API_KEY: SENTINEL_SECRET })
      service.decrypt(blob)
      service.getKeys(blob)
      service.getKeyFingerprint()
    })

    expect(logs).not.toContain(SENTINEL_KEY)
    expect(logs).not.toContain(SENTINEL_SECRET)
  })

  it('never logs secret values on the no-key (development) path', async () => {
    // The keyless path warns loudly — verify it warns without quoting the data.
    const logs = await captureLogs(() => {
      const service = encryptionServiceWithKey(undefined)
      const blob = service.encrypt({ OPENAI_API_KEY: SENTINEL_SECRET })
      service.decrypt(blob)
    })

    expect(logs).toMatch(/not securely stored|without encryption/i)
    expect(logs).not.toContain(SENTINEL_SECRET)
  })

  it('exposes only a non-reversible fingerprint of the key', () => {
    const fingerprint = encryptionServiceWithKey(SENTINEL_KEY).getKeyFingerprint()

    expect(fingerprint).not.toBeNull()
    expect(fingerprint).not.toContain(SENTINEL_KEY)
    // A SHA-256 hex digest — same length as the key, so length alone proves
    // nothing; assert it is genuinely different content.
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(fingerprint).not.toBe(SENTINEL_KEY)
  })

  it('reports a key mismatch without disclosing either key', () => {
    const source = encryptionServiceWithKey(SENTINEL_KEY).getKeyFingerprint()
    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      appVersion: '0.0.0-test',
      exportedAt: new Date(0).toISOString(),
      migrationHead: 'head',
      encryptionKeyFingerprint: source,
      includesMetrics: false,
      tables: {},
      packages: [],
      packageCount: 0,
    }

    const result = validateForImport(manifest, {
      migrationHead: 'head',
      encryptionKeyFingerprint: 'a-different-fingerprint',
    })

    // The guard must fire — a mismatch that silently passes is the bug this
    // whole feature exists to prevent.
    expect(result.ok).toBe(false)
    const text = [...result.blockers, ...result.warnings].join('\n')
    expect(text).toMatch(/encryption-key mismatch/i)
    expect(text).not.toContain(SENTINEL_KEY)
  })

  it('does not put the passphrase into the failure message when decryption fails', async () => {
    const plain = path.join(dir, 'bundle.zip')
    const enc = path.join(dir, 'bundle.zip.enc')
    await fs.writeFile(plain, Buffer.from(`config=${SENTINEL_SECRET}`))
    await encryptBundle(plain, enc, SENTINEL_PASSPHRASE)

    const error = await decryptBundle(enc, path.join(dir, 'out.zip'), 'wrong-passphrase')
      .then(() => null)
      .catch((e: unknown) => e)

    expect(error).not.toBeNull()
    const text = `${(error as Error).message}\n${(error as Error).stack ?? ''}`
    expect(text).not.toContain(SENTINEL_PASSPHRASE)
    expect(text).not.toContain(SENTINEL_SECRET)
  })

  it('writes no plaintext secret into the encrypted bundle on disk', async () => {
    const plain = path.join(dir, 'onDisk.zip')
    const enc = path.join(dir, 'onDisk.zip.enc')
    await fs.writeFile(
      plain,
      Buffer.from(`ENV_VAR_ENCRYPTION_KEY=${SENTINEL_KEY}\nOPENAI_API_KEY=${SENTINEL_SECRET}\n`),
    )
    await encryptBundle(plain, enc, SENTINEL_PASSPHRASE)

    const bytes = await fs.readFile(enc)
    expect(bytes.includes(SENTINEL_KEY)).toBe(false)
    expect(bytes.includes(SENTINEL_SECRET)).toBe(false)
  })
})
