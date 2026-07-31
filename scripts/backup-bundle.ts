#!/usr/bin/env ts-node
/**
 * Host-side bundle finalizer/preparer for the wizard backup scripts (#378).
 *
 * The in-pod CLI (src/backup/backup.cli.ts) produces a DATA bundle (DB +
 * packages). This helper, run on the deploy host, owns the deploy-layer
 * concerns — folding in the deployment config and optional at-rest encryption —
 * so all config/secret handling lives in the wizard layer, not the backend.
 *
 *   finalize  <dataBundle> <envFile> <out>
 *       Embed the deployment .env into the bundle and encrypt the whole thing
 *       under BACKUP_PASSPHRASE → <out>. Without a passphrase this REFUSES to
 *       run (the embedded config is a plaintext credential), unless
 *       STELLA_ALLOW_PLAINTEXT_CONFIG=1 explicitly overrides it.
 *
 *   prepare-restore <bundle> <outDataBundle> <outEnvFile>
 *       Decrypt if needed (BACKUP_PASSPHRASE), extract the embedded .env →
 *       <outEnvFile>, and write the plain data bundle → <outDataBundle>.
 *
 * Reuses the backend's bundle-crypto + bundle-zip helpers so on-disk formats
 * match exactly. Every step is streamed (bounded memory), matching the engine.
 */
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import {
  encryptBundle,
  decryptBundle,
  isEncryptedBundle,
} from '../src/backup/bundle-crypto'
import { ZipReader, copyZipAdding } from '../src/backup/bundle-zip'

// Where the deployment .env is parked inside the bundle.
const CONFIG_ENTRY = 'config/deployment.env'

/**
 * Escape hatch for writing a bundle whose embedded config is NOT encrypted.
 * Set to '1' by backup-export.sh only when the operator passed BOTH
 * --no-encrypt and --allow-plaintext-config.
 */
const ALLOW_PLAINTEXT_ENV = 'STELLA_ALLOW_PLAINTEXT_CONFIG'

/**
 * A scratch path for a PLAINTEXT bundle, inside a private (0700) directory.
 *
 * These intermediates hold the deployment config in the clear for the duration
 * of an export/restore. A bare os.tmpdir() path leaves them readable by every
 * local user on a shared /tmp — so the containing directory is owner-only, and
 * the files themselves are written 0600 (see bundle-zip / bundle-crypto).
 *
 * Returns both the file path and its directory, so callers can remove the whole
 * directory rather than just unlinking the file.
 */
async function privateTmp(
  prefix: string,
): Promise<{ file: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`))
  return {
    dir,
    file: path.join(dir, `${crypto.randomBytes(6).toString('hex')}.zip`),
  }
}

async function finalize(
  dataBundle: string,
  envFile: string,
  out: string,
): Promise<void> {
  const passphrase = process.env.BACKUP_PASSPHRASE

  // Embedding the deployment .env puts EVERY secret — ENV_VAR_ENCRYPTION_KEY,
  // JWT_SECRET, the database password, every API key — into this file. Without a
  // passphrase that file is a plaintext credential sitting on disk. Refuse by
  // default, and enforce it HERE rather than only in the calling script: this is
  // the function that actually writes the bytes, so the guarantee cannot be lost
  // to a shell-layer mistake. The check happens before the .env is even read.
  if (!passphrase && process.env[ALLOW_PLAINTEXT_ENV] !== '1') {
    throw new Error(
      'refusing to write an unencrypted bundle: it would contain the deployment ' +
        'config (ENV_VAR_ENCRYPTION_KEY, JWT_SECRET, database password, API keys) ' +
        'in plaintext. Set BACKUP_PASSPHRASE, or re-run the export with both ' +
        '--no-encrypt and --allow-plaintext-config if that is genuinely intended.',
    )
  }

  const config = await fs.readFile(envFile)

  if (passphrase) {
    // Stream-copy the data bundle + config into a plain temp zip, then
    // stream-encrypt it to the output — neither archive is held in memory.
    // The intermediate is a plaintext credential, so it lives in an owner-only
    // directory and the whole directory is removed afterwards.
    const plain = await privateTmp('stella-fin')
    try {
      await copyZipAdding(dataBundle, plain.file, [
        { name: CONFIG_ENTRY, data: config },
      ])
      await encryptBundle(plain.file, out, passphrase)
    } finally {
      await fs.rm(plain.dir, { recursive: true, force: true })
    }
  } else {
    await copyZipAdding(dataBundle, out, [{ name: CONFIG_ENTRY, data: config }])
  }
}

async function prepareRestore(
  bundle: string,
  outDataBundle: string,
  outEnvFile: string,
): Promise<void> {
  let zipPath = bundle
  let decrypted: { file: string; dir: string } | null = null

  try {
    if (await isEncryptedBundle(bundle)) {
      const passphrase = process.env.BACKUP_PASSPHRASE
      if (!passphrase) {
        throw new Error('bundle is encrypted; set BACKUP_PASSPHRASE to decrypt it')
      }
      // Decrypting materializes the full plaintext bundle — same exposure as the
      // export side, so the same owner-only staging applies.
      decrypted = await privateTmp('stella-dec')
      await decryptBundle(bundle, decrypted.file, passphrase)
      zipPath = decrypted.file
    }

    // The decrypted/plain zip IS the data bundle the pod importer reads; the
    // embedded config entry is harmless (the importer only reads manifest.json,
    // tables/*, packages/*). So we just pull the config out and hand the plain
    // zip through unchanged, both streamed.
    const reader = await ZipReader.open(zipPath)
    try {
      const cfg = await reader.readBuffer(CONFIG_ENTRY)
      if (!cfg) {
        throw new Error(
          'bundle has no embedded deployment config (config/deployment.env)',
        )
      }
      // The extracted .env is the deployment's secrets in the clear — owner-only.
      await fs.writeFile(outEnvFile, cfg, { mode: 0o600 })
    } finally {
      reader.close()
    }
    await fs.copyFile(zipPath, outDataBundle)
    await fs.chmod(outDataBundle, 0o600).catch(() => undefined)
  } finally {
    if (decrypted) await fs.rm(decrypted.dir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'check') {
    // Self-check preflight: reaching here means ts-node compiled this file and
    // every import it needs (archiver, yauzl, crypto, …) resolved. The wizard
    // scripts run this before the slow export so a broken host toolchain fails
    // fast with a clear message instead of deep inside finalize.
    process.stdout.write('ok\n')
    return
  }
  if (command === 'finalize') {
    const [dataBundle, envFile, out] = rest
    if (!dataBundle || !envFile || !out) {
      throw new Error('usage: backup-bundle finalize <dataBundle> <envFile> <out>')
    }
    await finalize(dataBundle, envFile, out)
  } else if (command === 'prepare-restore') {
    const [bundle, outDataBundle, outEnvFile] = rest
    if (!bundle || !outDataBundle || !outEnvFile) {
      throw new Error(
        'usage: backup-bundle prepare-restore <bundle> <outDataBundle> <outEnvFile>',
      )
    }
    await prepareRestore(bundle, outDataBundle, outEnvFile)
  } else {
    throw new Error('usage: backup-bundle <finalize|prepare-restore> ...')
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n`)
  process.exit(1)
})
