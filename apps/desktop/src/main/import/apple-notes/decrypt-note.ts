/**
 * Decryption of password-protected ("locked") Apple Notes bodies.
 *
 * Apple derives a key-encrypting key from the Notes password (PBKDF2-HMAC-SHA256,
 * 16 bytes), unwraps the per-note key with RFC 3394 AES key wrap, then decrypts
 * the note body (ZICNOTEDATA.ZDATA) with AES-128-GCM. The plaintext is the same
 * gzipped protobuf an unlocked note stores. Layout follows the reverse-engineered
 * format documented by apple_cloud_notes_parser (AppleDecrypter).
 *
 * The password lives only in the closure returned by `createNoteDecryptor`; it
 * is never written to disk, logged or put in an error.
 */

import crypto from 'crypto'

const KEK_BYTES = 16
const KEY_WRAP_IV = Buffer.alloc(8, 0xa6)

/** Per-note crypto material read from the NoteStore snapshot. */
export interface LockedNoteCrypto {
  salt: Buffer
  iterations: number
  wrappedKey: Buffer
  iv: Buffer
  tag: Buffer
}

export type DecryptResult =
  | { ok: true; data: Buffer }
  /** `wrong-password`: the key did not unwrap. `unreadable`: it did, but the body failed to authenticate or the material is malformed. */
  | { ok: false; reason: 'wrong-password' | 'unreadable' }

export interface NoteDecryptor {
  /** Cheap check (key unwrap only, no body read) that this password unlocks the note. */
  canUnlock(note: Pick<LockedNoteCrypto, 'salt' | 'iterations' | 'wrappedKey'>): boolean
  decrypt(note: LockedNoteCrypto, data: Buffer): DecryptResult
}

/** RFC 3394 §2.2.2 unwrap. Returns null when the integrity check fails (wrong KEK). */
export function aesKeyUnwrap(kek: Buffer, wrapped: Buffer): Buffer | null {
  if (wrapped.length < 24 || wrapped.length % 8 !== 0) return null
  const n = wrapped.length / 8 - 1
  const a = Buffer.from(wrapped.subarray(0, 8))
  const r: Buffer[] = []
  for (let i = 0; i < n; i++) r.push(Buffer.from(wrapped.subarray(8 * (i + 1), 8 * (i + 2))))

  for (let j = 5; j >= 0; j--) {
    for (let i = n; i >= 1; i--) {
      const t = n * j + i
      const xored = Buffer.from(a)
      xored.writeUInt32BE((xored.readUInt32BE(0) ^ Math.floor(t / 2 ** 32)) >>> 0, 0)
      xored.writeUInt32BE((xored.readUInt32BE(4) ^ (t >>> 0)) >>> 0, 4)
      const cipher = crypto.createDecipheriv(`aes-${kek.length * 8}-ecb`, kek, null)
      cipher.setAutoPadding(false)
      const block = Buffer.concat([cipher.update(Buffer.concat([xored, r[i - 1]])), cipher.final()])
      block.copy(a, 0, 0, 8)
      r[i - 1] = block.subarray(8, 16)
    }
  }
  return a.equals(KEY_WRAP_IV) ? Buffer.concat(r) : null
}

export function createNoteDecryptor(password: string): NoteDecryptor {
  // Notes in one account usually share a salt, so the (slow) PBKDF2 runs once.
  const kekCache = new Map<string, Buffer>()
  const kekFor = (salt: Buffer, iterations: number): Buffer => {
    const cacheKey = `${iterations}:${salt.toString('hex')}`
    let kek = kekCache.get(cacheKey)
    if (!kek) {
      kek = crypto.pbkdf2Sync(password, salt, iterations, KEK_BYTES, 'sha256')
      kekCache.set(cacheKey, kek)
    }
    return kek
  }
  const unwrap = (note: Pick<LockedNoteCrypto, 'salt' | 'iterations' | 'wrappedKey'>) =>
    Number.isInteger(note.iterations) && note.iterations > 0
      ? aesKeyUnwrap(kekFor(note.salt, note.iterations), note.wrappedKey)
      : null

  return {
    canUnlock: (note) => unwrap(note) !== null,
    decrypt(note, data) {
      const key = unwrap(note)
      if (!key) return { ok: false, reason: 'wrong-password' }
      try {
        const decipher = crypto.createDecipheriv('aes-128-gcm', key, note.iv)
        decipher.setAuthTag(note.tag)
        return { ok: true, data: Buffer.concat([decipher.update(data), decipher.final()]) }
      } catch {
        return { ok: false, reason: 'unreadable' }
      }
    }
  }
}
