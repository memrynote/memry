/**
 * Minimal reader for Apple binary property lists (`bplist00`) and the
 * NSKeyedArchiver graphs built on them.
 *
 * Locked notes on current macOS keep their crypto envelope as an archived
 * `ICCryptoEncryptionObject` in ZICNOTEDATA.ZDATA, so the importer must read
 * it. Only what that needs is supported: null/bool/int/real/data/string/array/
 * dict/UID (dates and sets decode to a plain value). Anything malformed returns
 * null from `parseKeyedArchiveRoot` instead of throwing.
 */

const MAGIC = 'bplist00'
const TRAILER_BYTES = 32

export class Uid {
  constructor(readonly index: number) {}
}

export type PlistValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Buffer
  | Uid
  | PlistValue[]
  | { [key: string]: PlistValue }

export function isBinaryPlist(data: Buffer): boolean {
  return data.length > TRAILER_BYTES && data.toString('latin1', 0, MAGIC.length) === MAGIC
}

function readUInt(data: Buffer, offset: number, size: number): number {
  if (size > 6) {
    const value = data.readBigUInt64BE(offset + size - 8)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('integer too large')
    return Number(value)
  }
  return data.readUIntBE(offset, size)
}

/** Throws RangeError on malformed input; callers use the safe wrappers below. */
export function parseBinaryPlist(data: Buffer): PlistValue {
  if (!isBinaryPlist(data)) throw new RangeError('not a binary plist')
  const trailer = data.length - TRAILER_BYTES
  const offsetSize = data[trailer + 6]
  const refSize = data[trailer + 7]
  const objectCount = readUInt(data, trailer + 8, 8)
  const topObject = readUInt(data, trailer + 16, 8)
  const tableOffset = readUInt(data, trailer + 24, 8)
  if (!offsetSize || !refSize || tableOffset + objectCount * offsetSize > trailer) {
    throw new RangeError('bad trailer')
  }

  const depthLimit = 64
  const read = (index: number, depth: number): PlistValue => {
    if (depth > depthLimit || index >= objectCount) throw new RangeError('bad object ref')
    const start = readUInt(data, tableOffset + index * offsetSize, offsetSize)
    const marker = data[start]
    const kind = marker >> 4
    const low = marker & 0x0f
    let body = start + 1

    const readLength = (): number => {
      if (low !== 0x0f) return low
      const sizeByte = data[body]
      const bytes = 1 << (sizeByte & 0x0f)
      const value = readUInt(data, body + 1, bytes)
      body += 1 + bytes
      return value
    }

    switch (kind) {
      case 0x0:
        return low === 0x8 ? false : low === 0x9 ? true : null
      case 0x1: {
        const bytes = 1 << low
        if (bytes < 8) return readUInt(data, body, bytes)
        const wide = data.readBigInt64BE(body)
        return wide >= BigInt(Number.MIN_SAFE_INTEGER) && wide <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(wide)
          : wide
      }
      case 0x2:
        return low === 2 ? data.readFloatBE(body) : data.readDoubleBE(body)
      case 0x3:
        return data.readDoubleBE(body)
      case 0x4: {
        const length = readLength()
        return Buffer.from(data.subarray(body, body + length))
      }
      case 0x5: {
        const length = readLength()
        return data.toString('latin1', body, body + length)
      }
      case 0x6: {
        const length = readLength()
        return Buffer.from(data.subarray(body, body + length * 2))
          .swap16()
          .toString('utf16le')
      }
      case 0x8:
        return new Uid(readUInt(data, body, low + 1))
      case 0xa:
      case 0xc: {
        const length = readLength()
        const items: PlistValue[] = []
        for (let i = 0; i < length; i++) {
          items.push(read(readUInt(data, body + i * refSize, refSize), depth + 1))
        }
        return items
      }
      case 0xd: {
        const length = readLength()
        const dict: { [key: string]: PlistValue } = {}
        for (let i = 0; i < length; i++) {
          const key = read(readUInt(data, body + i * refSize, refSize), depth + 1)
          const value = read(readUInt(data, body + (length + i) * refSize, refSize), depth + 1)
          if (typeof key === 'string') dict[key] = value
        }
        return dict
      }
      default:
        throw new RangeError('unsupported plist object')
    }
  }
  return read(topObject, 0)
}

/** Parse and swallow malformed-input errors: untrusted bytes come from a user's database. */
export function tryParseBinaryPlist(data: Buffer): PlistValue | undefined {
  try {
    return parseBinaryPlist(data)
  } catch {
    return undefined
  }
}

/**
 * Resolve the root object of an NSKeyedArchive into plain values, following UID
 * references. Returns null when `data` is not a keyed archive.
 */
export function parseKeyedArchiveRoot(data: Buffer): { [key: string]: PlistValue } | null {
  const archive = tryParseBinaryPlist(data)
  if (
    !archive ||
    typeof archive !== 'object' ||
    Array.isArray(archive) ||
    Buffer.isBuffer(archive)
  ) {
    return null
  }
  const plain = archive as { [key: string]: PlistValue }
  const objects = plain.$objects
  const top = plain.$top
  if (!Array.isArray(objects) || !top || typeof top !== 'object' || Array.isArray(top)) return null
  const rootRef =
    (top as { [key: string]: PlistValue }).root ?? (top as { [key: string]: PlistValue }).data
  if (!(rootRef instanceof Uid)) return null
  const root = objects[rootRef.index]
  if (
    !root ||
    typeof root !== 'object' ||
    Array.isArray(root) ||
    Buffer.isBuffer(root) ||
    root instanceof Uid
  ) {
    return null
  }
  const resolved: { [key: string]: PlistValue } = {}
  for (const [key, value] of Object.entries(root as { [key: string]: PlistValue })) {
    if (key === '$class') continue
    resolved[key] = value instanceof Uid ? (objects[value.index] ?? null) : value
  }
  return resolved
}
