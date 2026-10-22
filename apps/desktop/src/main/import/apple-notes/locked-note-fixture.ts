/**
 * Test-only: builds locked-note crypto material the way Apple lays it out
 * (PBKDF2 -> RFC 3394 key wrap -> AES-128-GCM), so tests can lock a body
 * without a real Notes library. Not imported by production code.
 */

import crypto from 'crypto'
import type { LockedNoteCrypto } from './decrypt-note'

/** RFC 3394 §2.2.1 wrap, used only to build fixtures. */
export function aesKeyWrap(kek: Buffer, key: Buffer): Buffer {
  const n = key.length / 8
  let a = Buffer.alloc(8, 0xa6)
  const r = Array.from({ length: n }, (_, i) => Buffer.from(key.subarray(8 * i, 8 * i + 8)))
  for (let j = 0; j <= 5; j++) {
    for (let i = 1; i <= n; i++) {
      const cipher = crypto.createCipheriv(`aes-${kek.length * 8}-ecb`, kek, null)
      cipher.setAutoPadding(false)
      const b = Buffer.concat([cipher.update(Buffer.concat([a, r[i - 1]])), cipher.final()])
      const t = n * j + i
      a = Buffer.from(b.subarray(0, 8))
      a.writeUInt32BE((a.readUInt32BE(0) ^ Math.floor(t / 2 ** 32)) >>> 0, 0)
      a.writeUInt32BE((a.readUInt32BE(4) ^ (t >>> 0)) >>> 0, 4)
      r[i - 1] = Buffer.from(b.subarray(8, 16))
    }
  }
  return Buffer.concat([a, ...r])
}

export function lockNote(password: string, body: Buffer): { note: LockedNoteCrypto; data: Buffer } {
  const salt = crypto.randomBytes(16)
  const iterations = 1000
  const kek = crypto.pbkdf2Sync(password, salt, iterations, 16, 'sha256')
  const noteKey = crypto.randomBytes(16)
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv('aes-128-gcm', noteKey, iv)
  const data = Buffer.concat([cipher.update(body), cipher.final()])
  return {
    note: { salt, iterations, wrappedKey: aesKeyWrap(kek, noteKey), iv, tag: cipher.getAuthTag() },
    data
  }
}
