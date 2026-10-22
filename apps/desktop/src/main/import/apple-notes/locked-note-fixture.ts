/**
 * Test-only: builds locked-note crypto material the way Apple lays it out
 * (PBKDF2 -> RFC 3394 key wrap -> AES-GCM), so tests can lock a body
 * without a real Notes library. Not imported by production code.
 */

import crypto from 'crypto'
import type { LockedNoteCrypto } from './decrypt-note'
import { Uid, type PlistValue } from './bplist'

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

/** Serialize a value as a `bplist00` (2-byte refs and offsets; enough for fixtures). */
export function buildBinaryPlist(root: PlistValue): Buffer {
  const objects: PlistValue[] = []
  const collect = (value: PlistValue): number => {
    const index = objects.length
    objects.push(value)
    if (Array.isArray(value)) value.forEach(collect)
    else if (
      value &&
      typeof value === 'object' &&
      !Buffer.isBuffer(value) &&
      !(value instanceof Uid)
    ) {
      for (const [key, child] of Object.entries(value)) {
        collect(key)
        collect(child)
      }
    }
    return index
  }
  collect(root)

  // Children were collected right after their parent, so walk again to resolve refs.
  const refs = new Map<PlistValue, number[]>()
  const walk = (value: PlistValue, at: { index: number }): number => {
    const mine = at.index++
    if (Array.isArray(value))
      refs.set(
        value,
        value.map((child) => walk(child, at))
      )
    else if (
      value &&
      typeof value === 'object' &&
      !Buffer.isBuffer(value) &&
      !(value instanceof Uid)
    ) {
      const keys: number[] = []
      const values: number[] = []
      for (const [key, child] of Object.entries(value)) {
        keys.push(walk(key, at))
        values.push(walk(child, at))
      }
      refs.set(value, [...keys, ...values])
    }
    return mine
  }
  walk(root, { index: 0 })

  const lengthBytes = (marker: number, length: number): Buffer =>
    length < 15
      ? Buffer.from([marker | length])
      : Buffer.concat([
          Buffer.from([marker | 0x0f, 0x11]),
          Buffer.from([length >> 8, length & 0xff])
        ])
  const ref2 = (n: number): Buffer => Buffer.from([n >> 8, n & 0xff])

  const encode = (value: PlistValue): Buffer => {
    if (typeof value === 'number') {
      if (value < 256) return Buffer.from([0x10, value])
      if (value < 65536) return Buffer.from([0x11, value >> 8, value & 0xff])
      const wide = Buffer.alloc(5, 0x12)
      wide.writeUInt32BE(value, 1)
      return wide
    }
    if (typeof value === 'string')
      return Buffer.concat([lengthBytes(0x50, value.length), Buffer.from(value, 'latin1')])
    if (Buffer.isBuffer(value)) return Buffer.concat([lengthBytes(0x40, value.length), value])
    if (value instanceof Uid) return Buffer.from([0x80, value.index])
    if (Array.isArray(value)) {
      return Buffer.concat([lengthBytes(0xa0, value.length), ...(refs.get(value) ?? []).map(ref2)])
    }
    if (value && typeof value === 'object') {
      const all = refs.get(value) ?? []
      return Buffer.concat([lengthBytes(0xd0, all.length / 2), ...all.map(ref2)])
    }
    throw new Error('fixture plist: unsupported value')
  }

  const header = Buffer.from('bplist00', 'latin1')
  const encoded = objects.map(encode)
  const offsets: number[] = []
  let cursor = header.length
  for (const chunk of encoded) {
    offsets.push(cursor)
    cursor += chunk.length
  }
  const table = Buffer.concat(offsets.map(ref2))
  const trailer = Buffer.alloc(32)
  trailer[6] = 2
  trailer[7] = 2
  trailer.writeBigUInt64BE(BigInt(objects.length), 8)
  trailer.writeBigUInt64BE(0n, 16)
  trailer.writeBigUInt64BE(BigInt(cursor), 24)
  return Buffer.concat([header, ...encoded, table, trailer])
}

/** Lock `body` the way current macOS does: an archived cipher-version-2 envelope for ZDATA. */
export function lockNoteEnvelope(
  password: string,
  body: Buffer,
  options: { tamperCiphertext?: boolean } = {}
): Buffer {
  const salt = crypto.randomBytes(32)
  const iterations = 1000
  const kek = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256')
  const contentKey = crypto.randomBytes(32)
  const iv = crypto.randomBytes(32)
  const metadata = buildBinaryPlist({ cipherVersion: 2, objectIdentifier: 'FIXTURE-ID' })
  const cipher = crypto.createCipheriv('aes-256-gcm', contentKey, iv)
  cipher.setAAD(metadata)
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()])
  if (options.tamperCiphertext) ciphertext[0] ^= 0xff
  const encryptedData = Buffer.concat([ciphertext, iv, cipher.getAuthTag()])
  return buildBinaryPlist({
    $archiver: 'NSKeyedArchiver',
    $version: 100000,
    $top: { root: new Uid(1) },
    $objects: [
      '$null',
      {
        metadata: new Uid(2),
        unauthenticatedMetadata: new Uid(3),
        wrappedEncryptionKey: new Uid(4),
        encryptedData: new Uid(5)
      },
      metadata,
      buildBinaryPlist({ passphraseSalt: salt, passphraseIterationCount: iterations }),
      aesKeyWrap(kek, contentKey),
      encryptedData
    ]
  })
}
