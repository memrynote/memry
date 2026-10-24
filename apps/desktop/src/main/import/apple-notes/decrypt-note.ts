/**
 * Decryption of password-protected ("locked") Apple Notes bodies.
 *
 * Two on-disk layouts exist; both derive the key from the Notes password with
 * PBKDF2-HMAC-SHA256, unwrap a content key with RFC 3394 AES key wrap and
 * decrypt with AES-GCM. The plaintext is the same gzipped protobuf an unlocked
 * note stores in ZICNOTEDATA.ZDATA.
 *
 * - Envelope (current macOS/iOS): ZDATA is an NSKeyedArchive of an
 *   `ICCryptoEncryptionObject` (cipherVersion 2) holding the salt, iteration
 *   count, 40-byte wrapped key and `ciphertext || IV[32] || tag[16]`. The
 *   archive's raw `metadata` bytes are the GCM additional authenticated data,
 *   and the key is 32 bytes (AES-256). Verified against a real macOS library;
 *   also documented by timietti/apple-notes-decryptor.
 * - Legacy: ZDATA is the raw ciphertext and the salt, iteration count, wrapped
 *   key, IV and tag sit in ZCRYPTO* columns (AES-128), as documented by
 *   apple_cloud_notes_parser.
 *
 * The password lives only in the closure returned by `createNoteDecryptor`; it
 * is never written to disk, logged or put in an error.
 */

import crypto from 'crypto'
import { isBinaryPlist, parseKeyedArchiveRoot, tryParseBinaryPlist } from './bplist'

const KEY_WRAP_IV = Buffer.alloc(8, 0xa6)
const ENVELOPE_CIPHER_VERSION = 2
const ENVELOPE_IV_BYTES = 32
const ENVELOPE_TAG_BYTES = 16
const ENVELOPE_KEY_BYTES = 32
const LEGACY_KEY_BYTES = 16

/** Legacy per-note crypto material read from the ZCRYPTO* columns. */
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
  /** Cheap check (key unwrap only, no body decryption) that this password unlocks the note. */
  canUnlock(zdata: Buffer, legacy: LockedNoteCrypto | null): boolean
  decrypt(zdata: Buffer, legacy: LockedNoteCrypto | null): DecryptResult
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

interface Envelope {
  salt: Buffer
  iterations: number
  wrappedKey: Buffer
  ciphertext: Buffer
  iv: Buffer
  tag: Buffer
  /** Raw serialized metadata plist, authenticated as GCM AAD. */
  aad: Buffer
}

/** Null when `zdata` is not a supported cipher-version-2 envelope. */
function parseEnvelope(zdata: Buffer): Envelope | null {
  const root = parseKeyedArchiveRoot(zdata)
  if (!root) return null
  const { metadata, unauthenticatedMetadata, wrappedEncryptionKey, encryptedData } = root
  if (
    !Buffer.isBuffer(metadata) ||
    !Buffer.isBuffer(unauthenticatedMetadata) ||
    !Buffer.isBuffer(wrappedEncryptionKey) ||
    !Buffer.isBuffer(encryptedData)
  ) {
    return null
  }
  const meta = plainDict(metadata)
  const passphrase = plainDict(unauthenticatedMetadata)
  if (!meta || !passphrase || meta.cipherVersion !== ENVELOPE_CIPHER_VERSION) return null
  const { passphraseSalt, passphraseIterationCount } = passphrase
  const trailer = ENVELOPE_IV_BYTES + ENVELOPE_TAG_BYTES
  if (
    !Buffer.isBuffer(passphraseSalt) ||
    typeof passphraseIterationCount !== 'number' ||
    passphraseIterationCount <= 0 ||
    encryptedData.length < trailer
  ) {
    return null
  }
  return {
    salt: passphraseSalt,
    iterations: passphraseIterationCount,
    wrappedKey: wrappedEncryptionKey,
    ciphertext: encryptedData.subarray(0, -trailer),
    iv: encryptedData.subarray(-trailer, -ENVELOPE_TAG_BYTES),
    tag: encryptedData.subarray(-ENVELOPE_TAG_BYTES),
    aad: metadata
  }
}

function plainDict(data: Buffer): Record<string, unknown> | null {
  const value = tryParseBinaryPlist(data)
  return value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)
    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- typeof object and non-array were checked on the previous lines
      (value as Record<string, unknown>)
    : null
}

export function createNoteDecryptor(password: string): NoteDecryptor {
  // Notes in one account usually share a salt, so the (slow) PBKDF2 runs once.
  const kekCache = new Map<string, Buffer>()
  const kekFor = (salt: Buffer, iterations: number, length: number): Buffer => {
    const cacheKey = `${length}:${iterations}:${salt.toString('hex')}`
    let kek = kekCache.get(cacheKey)
    if (!kek) {
      kek = crypto.pbkdf2Sync(password, salt, iterations, length, 'sha256')
      kekCache.set(cacheKey, kek)
    }
    return kek
  }

  type Opened =
    | { ok: false; reason: 'wrong-password' | 'unreadable' }
    | { ok: true; key: Buffer; open: (key: Buffer) => DecryptResult }

  const open = (zdata: Buffer, legacy: LockedNoteCrypto | null): Opened => {
    if (isBinaryPlist(zdata)) {
      const envelope = parseEnvelope(zdata)
      if (!envelope) return { ok: false, reason: 'unreadable' }
      const key = aesKeyUnwrap(
        kekFor(envelope.salt, envelope.iterations, ENVELOPE_KEY_BYTES),
        envelope.wrappedKey
      )
      if (!key) return { ok: false, reason: 'wrong-password' }
      return {
        ok: true,
        key,
        open: (k) => gcmDecrypt(k, envelope.iv, envelope.tag, envelope.ciphertext, envelope.aad)
      }
    }
    if (!legacy || !Number.isInteger(legacy.iterations) || legacy.iterations <= 0) {
      return { ok: false, reason: 'unreadable' }
    }
    const key = aesKeyUnwrap(
      kekFor(legacy.salt, legacy.iterations, LEGACY_KEY_BYTES),
      legacy.wrappedKey
    )
    if (!key) return { ok: false, reason: 'wrong-password' }
    return { ok: true, key, open: (k) => gcmDecrypt(k, legacy.iv, legacy.tag, zdata) }
  }

  return {
    canUnlock: (zdata, legacy) => open(zdata, legacy).ok,
    decrypt(zdata, legacy) {
      const opened = open(zdata, legacy)
      return opened.ok ? opened.open(opened.key) : opened
    }
  }
}

function gcmDecrypt(
  key: Buffer,
  iv: Buffer,
  tag: Buffer,
  ciphertext: Buffer,
  aad?: Buffer
): DecryptResult {
  try {
    const algorithm = key.length === ENVELOPE_KEY_BYTES ? 'aes-256-gcm' : 'aes-128-gcm'
    const decipher = crypto.createDecipheriv(algorithm, key, iv)
    decipher.setAuthTag(tag)
    if (aad) decipher.setAAD(aad)
    return { ok: true, data: Buffer.concat([decipher.update(ciphertext), decipher.final()]) }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}
