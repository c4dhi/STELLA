import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import {
  encryptBundle,
  decryptBundle,
  isEncryptedBundle,
} from './bundle-crypto.js'

/**
 * Streaming AES-256-GCM envelope round-trip (#378). Exercises the real file I/O
 * path (tag-at-end, positioned reads) rather than mocking it.
 */
describe('bundle-crypto', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stella-crypto-test-'))
  })
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  async function write(name: string, data: Buffer): Promise<string> {
    const p = path.join(dir, name)
    await fs.writeFile(p, data)
    return p
  }

  it('round-trips content of varied sizes', async () => {
    for (const size of [0, 1, 100, 64 * 1024, 1_000_003]) {
      const plain = await write(`p-${size}`, crypto.randomBytes(size))
      const enc = `${plain}.enc`
      const back = `${plain}.back`
      await encryptBundle(plain, enc, 'correct horse battery staple')
      await decryptBundle(enc, back, 'correct horse battery staple')
      const original = await fs.readFile(plain)
      const restored = await fs.readFile(back)
      expect(restored.equals(original)).toBe(true)
    }
  })

  it('tags the encrypted file with the magic marker; plaintext is not flagged', async () => {
    const plain = await write('marker', Buffer.from('hello'))
    const enc = `${plain}.enc`
    await encryptBundle(plain, enc, 'pw')
    expect(await isEncryptedBundle(enc)).toBe(true)
    expect(await isEncryptedBundle(plain)).toBe(false)
  })

  it('fails to decrypt with the wrong passphrase (auth failure, fails closed)', async () => {
    const plain = await write('secret', crypto.randomBytes(2048))
    const enc = `${plain}.enc`
    await encryptBundle(plain, enc, 'right')
    await expect(
      decryptBundle(enc, `${plain}.back`, 'wrong'),
    ).rejects.toThrow()
  })

  it('fails to decrypt a tampered ciphertext', async () => {
    const plain = await write('tamper', crypto.randomBytes(4096))
    const enc = `${plain}.enc`
    await encryptBundle(plain, enc, 'pw')
    const bytes = await fs.readFile(enc)
    bytes[bytes.length - 20] ^= 0xff // flip a byte in the ciphertext body
    await fs.writeFile(enc, bytes)
    await expect(decryptBundle(enc, `${plain}.back`, 'pw')).rejects.toThrow()
  })
})
