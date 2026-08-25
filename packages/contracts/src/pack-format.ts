/**
 * Pack file format — THE one place the layout is defined (#1839, #1840).
 *
 * A pack is an immutable byte container of E2E-ENCRYPTED blobs. The server
 * concatenates ciphertext blindly: payload bytes are copied verbatim from
 * their source R2 objects (record payloads are the exact JSON-text bytes a
 * push stored; snapshots are the exact encrypted bodies) — never decoded,
 * never re-encoded. Only a client holding the vault key can read anything.
 *
 * It lives in `@memry/contracts` because it is a WIRE CONTRACT: the server
 * writes these bytes and the desktop client reads them, and `@memry/contracts`
 * is the only package both depend on (the architecture check forbids the
 * desktop app importing from `apps/sync-server`). The writer stays server-side;
 * everything a reader needs is here, so the two halves can never drift.
 *
 * Exact layout (all integers big-endian):
 *
 *   offset  size                field
 *   ------------------------------------------------------------------
 *   0       4                   magic  'M','P','A','K'
 *   4       1                   format version (uint8), PACK_VERSION
 *   5       1                   reserved (0)
 *   6       2                   flags (uint16), currently 0
 *   --- payload region: entry bytes concatenated in index order ---
 *   ...     sum(entry lengths)  opaque ciphertext, no padding/separators —
 *                               byte-for-byte what the source object held
 *   --- index block: `entryCount` entries back to back ---
 *   each entry:
 *     kind        uint8    PackKindCode
 *     idLen       uint16   identity length in bytes
 *     idBytes              UTF-8 identity (`type:id` for records, noteId
 *                          for crdt kinds) — what a client matches against
 *     keyLen      uint16   source blob key length
 *     keyBytes             source R2 key (provenance + per-item fallback)
 *     sortKey     int64    server_cursor for records; created_at epoch
 *                          seconds for crdt kinds
 *     metaLen     uint16   JSON metadata length ({sequenceNum, revision}
 *                          for snapshots — the freshness token a client
 *                          compares against snapshotMeta before trusting
 *                          these bytes)
 *     metaBytes            UTF-8 JSON or empty
 *     offset      uint64   entry start within the payload region
 *     length      uint64   entry byte length
 *     sha256      32       digest of this entry's payload bytes
 *   --- footer, PACK_FOOTER_SIZE = 53 bytes at end of file ---
 *   payloadSha256 32       digest of the WHOLE payload region
 *   entryCount  uint64
 *   indexOffset uint64     absolute file offset of the first index entry
 *   magic       4          'MPAK'
 *   version     uint8      PACK_VERSION (footer echo)
 *
 * Immutability: a pack is never modified after its single PUT. New data goes
 * into NEW packs; stale entries stay as dead bytes forever (derived cache).
 * A reader must discard anything failing checksum and fall back to the
 * item-granular endpoints.
 */

export const PACK_MAGIC = 'MPAK'
/** Bump on incompatible layout change; readers reject other versions. */
export const PACK_VERSION = 1

export const PACK_FOOTER_SIZE =
  32 /* payloadSha256 */ +
  8 /* entryCount */ +
  8 /* indexOffset */ +
  4 /* magic */ +
  1 /* version */

/** magic(4) + version(1) + reserved(1) + flags(2). Payload region starts here. */
export const PACK_HEADER_SIZE = 8

export const PackKindCode = {
  record: 0,
  crdt_snapshot: 1,
  crdt_update: 2
} as const

export type PackKindName = keyof typeof PackKindCode

export const KIND_BY_CODE = {
  [PackKindCode.record]: 'record',
  [PackKindCode.crdt_snapshot]: 'crdt_snapshot',
  [PackKindCode.crdt_update]: 'crdt_update'
} as const satisfies Record<number, PackKindName>

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Freshness metadata contract for snapshot entries (parsed from index block). */
export interface PackEntryMeta {
  sequenceNum?: number
  revision?: string
  [key: string]: string | number | undefined
}

export interface PackedEntry {
  kind: PackKindName
  id: string
  sourceKey: string
  sortKey: number
  meta?: Record<string, unknown>
  offset: number
  length: number
}

/**
 * A decoded index record WITH its per-entry digest.
 *
 * `parsePack` verifies and discards the digest because it holds the whole file
 * anyway. A streaming reader cannot: it verifies each entry against this
 * digest as it reads that entry's slice off disk, so the digest has to survive
 * the decode.
 */
export interface PackIndexEntry extends PackedEntry {
  sha256: Uint8Array
}

/**
 * Whatever `crypto.subtle.digest` accepts here. Spelled through the WebCrypto
 * signature rather than `BufferSource` so this module compiles under a
 * DOM-free lib set (the contracts package) as well as in the Worker and in
 * Electron main.
 */
type DigestSource = Parameters<typeof crypto.subtle.digest>[1]

export const packSha256 = async (bytes: Uint8Array): Promise<Uint8Array> => {
  // SAFETY: a Uint8Array is a valid digest source by construction.
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as DigestSource))
}

export const packBytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export class ByteReader {
  at = 0

  constructor(private readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.at
  }

  take(n: number): Uint8Array {
    if (n < 0 || this.at + n > this.bytes.length) throw new Error('pack truncated')
    const slice = this.bytes.subarray(this.at, this.at + n)
    this.at += n
    return slice
  }

  u8(): number {
    return this.take(1)[0]
  }

  u16(): number {
    const b = this.take(2)
    return (b[0] << 8) | b[1]
  }

  u32(): number {
    const b = this.take(4)
    return b[0] * 2 ** 24 + (b[1] << 16) + (b[2] << 8) + b[3]
  }

  u64(): number {
    return this.u32() * 2 ** 32 + this.u32()
  }

  i64(): number {
    const v = this.u64()
    return v >= 2 ** 63 ? v - 2 ** 64 : v
  }
}

export interface FooterInfo {
  version: number
  entryCount: number
  indexOffset: number
  payloadSha256: Uint8Array
}

/**
 * Parse the trailing footer from the LAST `PACK_FOOTER_SIZE` bytes of a pack.
 *
 * `bytes` may be the whole file or just that tail slice — a streaming reader
 * passes the tail so it never has to hold the file. Cheap structural probe
 * before any hashing.
 */
export const readFooter = (bytes: Uint8Array): FooterInfo => {
  if (bytes.length < PACK_FOOTER_SIZE) throw new Error('pack too small')
  const footerAt = bytes.length - PACK_FOOTER_SIZE
  const view = new ByteReader(bytes.subarray(footerAt))
  const payloadSha256 = view.take(32)
  const entryCount = view.u64()
  const indexOffset = view.u64()
  const magic = decoder.decode(view.take(4))
  const version = view.u8()
  if (magic !== PACK_MAGIC) throw new Error('pack footer magic mismatch')
  if (version !== PACK_VERSION) throw new Error(`unsupported pack version ${version}`)
  return { version, entryCount, indexOffset, payloadSha256 }
}

/** Reject anything whose first 5 bytes are not this format at this version. */
export const readPackHeader = (headerBytes: Uint8Array): void => {
  if (headerBytes.length < PACK_HEADER_SIZE) throw new Error('pack too small')
  const headerMagic = decoder.decode(headerBytes.subarray(0, 4))
  if (headerMagic !== PACK_MAGIC) throw new Error('pack header magic mismatch')
  if (headerBytes[4] !== PACK_VERSION) throw new Error(`unsupported pack version ${headerBytes[4]}`)
}

/**
 * Decode `entryCount` index records from the index block bytes.
 *
 * Structural only — no payload bytes are touched, so a streaming reader can
 * call this holding nothing but the index block (kilobytes) and then verify
 * each entry's digest against slices it reads one at a time.
 */
export const decodePackIndex = (indexBytes: Uint8Array, entryCount: number): PackIndexEntry[] => {
  const view = new ByteReader(indexBytes)
  const entries: PackIndexEntry[] = []
  for (let i = 0; i < entryCount; i++) {
    // SAFETY: u8() reads exactly one verified byte; unknown codes are rejected
    // by the guard below rather than trusted.
    const kind = (KIND_BY_CODE as Record<number, PackKindName | undefined>)[view.u8()]
    if (!kind) throw new Error('unknown pack entry kind')
    const id = decoder.decode(view.take(view.u16()))
    const sourceKey = decoder.decode(view.take(view.u16()))
    const sortKey = view.i64()
    const metaJson = decoder.decode(view.take(view.u16()))
    const offset = view.u64()
    const length = view.u64()
    // Copied out of the view: `take` returns a subarray onto the caller's
    // buffer, which a streaming reader is free to recycle after this call.
    const sha256 = new Uint8Array(view.take(32))
    const entry: PackIndexEntry = { kind, id, sourceKey, sortKey, offset, length, sha256 }
    if (metaJson !== '') {
      // SAFETY: metaJson was written by the pack writer via JSON.stringify.
      // A malformed value throws here and the caller discards the pack.
      entry.meta = JSON.parse(metaJson) as PackEntryMeta
    }
    entries.push(entry)
  }
  return entries
}

export interface VerifiedPack {
  version: number
  entries: PackedEntry[]
  /** Recomputed digests matched every entry and the whole payload region. */
  integrityVerified: true
}

const footerAt = (bytes: Uint8Array): number => bytes.length - PACK_FOOTER_SIZE

/**
 * Full parse + integrity verification of a pack held entirely in memory.
 * Walks the index block, checks the whole-payload digest, then re-hashes each
 * entry against the digest recorded in the index. Any mismatch throws —
 * callers treat a bad pack as absent and use item-granular reads (derived
 * cache may vanish; source blobs never do).
 *
 * MEMORY NOTE: this needs the whole file in one buffer. The desktop client
 * reads packs off disk instead (`openPackFile`) precisely to avoid that.
 */
export const parsePack = async (bytes: Uint8Array): Promise<VerifiedPack> => {
  if (bytes.length < PACK_HEADER_SIZE + PACK_FOOTER_SIZE) throw new Error('pack too small')
  readPackHeader(bytes)

  const footer = readFooter(bytes)

  // The payload region runs from the header end to the absolute indexOffset
  // recorded in the footer.
  const actualPayloadDigest = await packSha256(bytes.subarray(PACK_HEADER_SIZE, footer.indexOffset))
  if (!packBytesEqual(actualPayloadDigest, footer.payloadSha256)) {
    throw new Error('pack payload checksum mismatch')
  }

  const decoded = decodePackIndex(
    bytes.subarray(footer.indexOffset, footerAt(bytes)),
    footer.entryCount
  )
  const entries: PackedEntry[] = []
  for (const entry of decoded) {
    const actualDigest = await packSha256(
      bytes.subarray(
        PACK_HEADER_SIZE + entry.offset,
        PACK_HEADER_SIZE + entry.offset + entry.length
      )
    )
    if (!packBytesEqual(actualDigest, entry.sha256)) {
      throw new Error(`pack entry checksum mismatch: ${entry.id}`)
    }
    const parsedEntry: PackedEntry = {
      kind: entry.kind,
      id: entry.id,
      sourceKey: entry.sourceKey,
      sortKey: entry.sortKey,
      offset: entry.offset,
      length: entry.length
    }
    if (entry.meta) parsedEntry.meta = entry.meta
    entries.push(parsedEntry)
  }

  return { version: footer.version, entries, integrityVerified: true }
}

/** Extract one entry's payload bytes after parsing (bounds-checked slice). */
export const extractEntry = (bytes: Uint8Array, entry: PackedEntry): Uint8Array => {
  const start = PACK_HEADER_SIZE + entry.offset
  if (start + entry.length > footerAt(bytes)) throw new Error(`entry out of bounds: ${entry.id}`)
  const out = new Uint8Array(entry.length)
  out.set(bytes.subarray(start, start + entry.length))
  return out
}

/** Kept for the writer, whose index-record arithmetic sizes its one buffer. */
export const packEncodeUtf8 = (value: string): Uint8Array => encoder.encode(value)
