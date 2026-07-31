import * as crypto from 'crypto'
import * as fs from 'fs'
import * as fsp from 'fs/promises'
import { pipeline } from 'stream/promises'

/**
 * Optional at-rest encryption for a backup bundle (#378).
 *
 * A bundle holds password hashes and (when wizard config is included) secrets,
 * so the operator may choose to encrypt it with a passphrase at export time.
 * Pure Node crypto — no openssl / gpg binary — so it works identically on every
 * platform, matching the dependency-free backup engine.
 *
 * Format (single file), STREAMED end-to-end so a multi-GB bundle never resides
 * in memory:
 *   MAGIC(9) | salt(16) | iv(12) | ciphertext... | authTag(16)
 *
 * AES-256-GCM (authenticated) with a scrypt-derived key. The auth tag is written
 * LAST (it only exists after the final block), which lets encryption stream the
 * plaintext straight through the cipher to disk. Decryption reads the trailing
 * tag first (via a positioned read), sets it, then streams the ciphertext body
 * through the decipher — `final()` fails closed on a wrong passphrase or any
 * tampering.
 *
 * (Format marker bumped from STELLABK1 → STELLABK2 with the move to tag-at-end
 * streaming; the previous in-memory format was never shipped in a release.)
 */
const MAGIC = Buffer.from('STELLABK2') // bundle format marker, 9 bytes
const SALT_LEN = 16
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN
// scrypt cost: ~16 MB, well within Node's default maxmem.
const SCRYPT: crypto.ScryptOptions = { N: 16384, r: 8, p: 1 }

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_LEN, SCRYPT)
}

/** Encrypt `plainPath` → `encPath` under `passphrase`, streaming throughout. */
export async function encryptBundle(
  plainPath: string,
  encPath: string,
  passphrase: string,
): Promise<void> {
  const salt = crypto.randomBytes(SALT_LEN)
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv)

  // Owner-only: even the ciphertext is worth withholding, since it is offline
  // brute-forceable by anyone who can read it.
  const out = fs.createWriteStream(encPath, { mode: 0o600 })
  // Header goes out ahead of the ciphertext body.
  out.write(Buffer.concat([MAGIC, salt, iv]))
  await pipeline(fs.createReadStream(plainPath), cipher, out, { end: false })
  // The tag is only defined once the cipher has flushed its final block.
  await new Promise<void>((resolve, reject) => {
    out.end(cipher.getAuthTag(), () => resolve())
    out.on('error', reject)
  })
}

/** True if `filePath` begins with the encrypted-bundle marker. */
export async function isEncryptedBundle(filePath: string): Promise<boolean> {
  const fd = await fsp.open(filePath, 'r')
  try {
    const head = Buffer.alloc(MAGIC.length)
    const { bytesRead } = await fd.read(head, 0, MAGIC.length, 0)
    return bytesRead === MAGIC.length && head.equals(MAGIC)
  } finally {
    await fd.close()
  }
}

/**
 * Decrypt `encPath` → `plainPath` with `passphrase`, streaming throughout.
 * Throws if the passphrase is wrong or the file was tampered with (GCM auth
 * failure on `final()`).
 */
export async function decryptBundle(
  encPath: string,
  plainPath: string,
  passphrase: string,
): Promise<void> {
  const { size } = await fsp.stat(encPath)
  if (size < HEADER_LEN + TAG_LEN) {
    throw new Error('encrypted bundle is truncated')
  }

  // Read the fixed header (magic+salt+iv) and the trailing auth tag via
  // positioned reads, then release the descriptor before streaming the body.
  const header = Buffer.alloc(HEADER_LEN)
  const tag = Buffer.alloc(TAG_LEN)
  const fd = await fsp.open(encPath, 'r')
  try {
    await fd.read(header, 0, HEADER_LEN, 0)
    await fd.read(tag, 0, TAG_LEN, size - TAG_LEN)
  } finally {
    await fd.close()
  }
  const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN)
  const iv = header.subarray(MAGIC.length + SALT_LEN, HEADER_LEN)

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(passphrase, salt),
    iv,
  )
  decipher.setAuthTag(tag)

  // Ciphertext body occupies [HEADER_LEN, size - TAG_LEN). Handle the empty
  // case directly — a zero-length range is invalid for createReadStream, and
  // final() still verifies the tag against an empty body.
  const bodyLen = size - HEADER_LEN - TAG_LEN
  if (bodyLen === 0) {
    const out = Buffer.concat([decipher.update(Buffer.alloc(0)), decipher.final()])
    await fsp.writeFile(plainPath, out, { mode: 0o600 })
    return
  }

  const body = fs.createReadStream(encPath, {
    start: HEADER_LEN,
    end: size - TAG_LEN - 1, // inclusive end offset
  })
  // The decrypted output is the plaintext bundle — owner-only, same as export.
  await pipeline(body, decipher, fs.createWriteStream(plainPath, { mode: 0o600 }))
}
