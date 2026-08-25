/**
 * Pack file format — THE one place the layout is defined (#1839).
 *
 * A pack is an immutable byte container of E2E-ENCRYPTED blobs. The server
 * concatenates ciphertext blindly: payload bytes are copied verbatim from
 * their source R2 objects (record payloads are the exact JSON-text bytes a
 * push stored; snapshots are the exact encrypted bodies) — never decoded,
 * never re-encoded. Only a client holding the vault key can read anything.
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
  32 /* payloadSha256 */ + 8 /* entryCount */ + 8 /* indexOffset */ + 4 /* magic */ + 1 /* version */

export const PackKindCode = {
  record: 0,
  crdt_snapshot: 1,
  crdt_update: 2
} as const

export type PackKindName = keyof typeof PackKindCode

const KIND_BY_CODE = {
  [PackKindCode.record]: 'record',
  [PackKindCode.crdt_snapshot]: 'crdt_snapshot',
  [PackKindCode.crdt_update]: 'crdt_update'
} as const satisfies Record<number, PackKindName>

const HEADER_SIZE = 8 // magic(4) + version(1) + reserved(1) + flags(2)

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Freshness metadata contract for snapshot entries (parsed from index block). */
export interface PackEntryMeta {
  sequenceNum?: number
  revision?: string
  [key: string]: string | number | undefined
}

export interface PackEntryInput {
  kind: PackKindName
  /** Client-facing identity: `${item_type}:${item_id}` or noteId. */
  id: string
  /** Source R2 blob key (provenance + per-item fallback target). */
  sourceKey: string
  /** Ordering key packed into the entry: cursor or epoch seconds. */
  sortKey: number
  /** Freshness metadata (snapshot sequenceNum/revision); omitted for records. */
  meta?: PackEntryMeta
  /** EXACT source bytes. Copied verbatim — callers must not transform them. */
  bytes: Uint8Array
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

export interface BuiltPack {
  /** Complete pack file bytes, ready for a single R2 PUT. */
  bytes: Uint8Array
  /** Entry offsets/lengths as written into the index block. */
  entries: PackedEntry[]
  /** Payload-region byte total (excludes header/index/footer). */
  payloadBytes: number
}

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> => {
  // SAFETY: Uint8Array is a valid BufferSource by construction.
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
}

class ByteWriter {
  private chunks: Uint8Array[] = []
  length = 0

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes)
    this.length += bytes.length
  }

  u8(value: number): void {
    this.push(new Uint8Array([value & 0xff]))
  }

  u16(value: number): void {
    this.push(new Uint8Array([(value >>> 8) & 0xff, value & 0xff]))
  }

  u32(value: number): void {
    this.push(
      new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
    )
  }

  // Number is safe up to 2^53; cursors and offsets never approach it, so two
  // u32 halves carry the full uint64 without BigInt plumbing.
  u64(value: number): void {
    this.u32(Math.floor(value / 2 ** 32))
    this.u32(value >>> 0)
  }

  i64(value: number): void {
    this.u64(value < 0 ? value + 2 ** 64 : value)
  }

  lenPrefixed(bytes: Uint8Array): void {
    if (bytes.length > 0xffff) throw new Error(`pack field too long: ${bytes.length}`)
    this.u16(bytes.length)
    this.push(bytes)
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length)
    let at = 0
    for (const chunk of this.chunks) {
      out.set(chunk, at)
      at += chunk.length
    }
    return out
  }
}

class ByteReader {
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

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Build one complete pack file. Deterministic: the same inputs always produce
 * the same bytes, which is what makes retried compactions of one range land
 * on an identical file instead of diverging copies.
 */
export const buildPack = async (entries: PackEntryInput[]): Promise<BuiltPack> => {
  // Pass 1: lay out the payload region and per-entry digests.
  const payloadChunks: Array<{ entry: PackEntryInput; digest: Uint8Array }> = []
  let payloadBytes = 0
  for (const entry of entries) {
    if (entry.bytes.length === 0) throw new Error(`empty pack entry: ${entry.id}`)
    payloadChunks.push({ entry, digest: await sha256(entry.bytes) })
    payloadBytes += entry.bytes.length
  }

  // Pass 2: serialize the index block so its exact size is known.
  const index = new ByteWriter()
  const packed: PackedEntry[] = []
  let cursor = 0
  for (const { entry, digest } of payloadChunks) {
    const metaJson = entry.meta ? JSON.stringify(entry.meta) : ''
    index.u8(PackKindCode[entry.kind])
    index.lenPrefixed(encoder.encode(entry.id))
    index.lenPrefixed(encoder.encode(entry.sourceKey))
    index.i64(entry.sortKey)
    index.lenPrefixed(encoder.encode(metaJson))
    index.u64(cursor)
    index.u64(entry.bytes.length)
    index.push(digest)
    const packedEntry: PackedEntry = {
      kind: entry.kind,
      id: entry.id,
      sourceKey: entry.sourceKey,
      sortKey: entry.sortKey,
      offset: cursor,
      length: entry.bytes.length
    }
    if (entry.meta) packedEntry.meta = entry.meta
    packed.push(packedEntry)
    cursor += entry.bytes.length
  }
  const indexBlock = index.finish()

  // Pass 3: assemble header + payload + index + footer in ONE buffer.
  const total = HEADER_SIZE + payloadBytes + indexBlock.length + PACK_FOOTER_SIZE
  const out = new Uint8Array(total)
  out.set(encoder.encode(PACK_MAGIC), 0)
  out[4] = PACK_VERSION
  out[5] = 0
  out[6] = 0
  out[7] = 0
  let at = HEADER_SIZE
  for (const { entry } of payloadChunks) {
    out.set(entry.bytes, at)
    at += entry.bytes.length
  }
  out.set(indexBlock, at)
  const indexOffset = at
  at += indexBlock.length

  const footer = new ByteWriter()
  footer.push(await sha256(out.subarray(HEADER_SIZE, HEADER_SIZE + payloadBytes)))
  footer.u64(payloadChunks.length)
  footer.u64(indexOffset)
  footer.push(encoder.encode(PACK_MAGIC))
  footer.u8(PACK_VERSION)
  out.set(footer.finish(), at)

  return { bytes: out, entries: packed, payloadBytes }
}

export interface FooterInfo {
  version: number
  entryCount: number
  indexOffset: number
  payloadSha256: Uint8Array
}

/** Parse just the trailing footer. Cheap structural probe before any hashing. */
export const readFooter = (bytes: Uint8Array): FooterInfo => {
  if (bytes.length < HEADER_SIZE + PACK_FOOTER_SIZE) throw new Error('pack too small')
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

export interface VerifiedPack {
  version: number
  entries: PackedEntry[]
  /** Recomputed digests matched every entry and the whole payload region. */
  integrityVerified: true
}

const footerAt = (bytes: Uint8Array): number => bytes.length - PACK_FOOTER_SIZE

/**
 * Full parse + integrity verification. Walks the index block, checks the
 * whole-payload digest, then re-hashes each entry against the digest recorded
 * in the index. Any mismatch throws — callers treat a bad pack as absent and
 * use item-granular reads (derived cache may vanish; source blobs never do).
 */
export const parsePack = async (bytes: Uint8Array): Promise<VerifiedPack> => {
  const headerMagic = decoder.decode(bytes.subarray(0, 4))
  if (headerMagic !== PACK_MAGIC) throw new Error('pack header magic mismatch')
  if (bytes[4] !== PACK_VERSION) throw new Error(`unsupported pack version ${bytes[4]}`)

  const footer = readFooter(bytes)

  // The payload region runs from the header end to the absolute indexOffset
  // recorded in the footer.
  const actualPayloadDigest = await sha256(bytes.subarray(HEADER_SIZE, footer.indexOffset))
  if (!equalBytes(actualPayloadDigest, footer.payloadSha256)) {
    throw new Error('pack payload checksum mismatch')
  }

  const indexView = new ByteReader(bytes.subarray(footer.indexOffset, footerAt(bytes)))
  const entries: PackedEntry[] = []
  for (let i = 0; i < footer.entryCount; i++) {
    // SAFETY: u8() reads exactly one verified byte; unknown codes are rejected
    // by the guard below rather than trusted.
    const kind = (KIND_BY_CODE as Record<number, PackKindName | undefined>)[indexView.u8()]
    if (!kind) throw new Error('unknown pack entry kind')
    const id = decoder.decode(indexView.take(indexView.u16()))
    const sourceKey = decoder.decode(indexView.take(indexView.u16()))
    const sortKey = indexView.i64()
    const metaJson = decoder.decode(indexView.take(indexView.u16()))
    const offset = indexView.u64()
    const length = indexView.u64()
    const expectedDigest = indexView.take(32)
    const actualDigest = await sha256(bytes.subarray(HEADER_SIZE + offset, HEADER_SIZE + offset + length))
    if (!equalBytes(actualDigest, expectedDigest)) {
      throw new Error(`pack entry checksum mismatch: ${id}`)
    }
    const parsedEntry: PackedEntry = { kind, id, sourceKey, sortKey, offset, length }
    if (metaJson !== '') {
      // SAFETY: metaJson was written by buildPack via JSON.stringify and these
      // bytes passed checksum verification above.
      parsedEntry.meta = JSON.parse(metaJson) as PackEntryMeta
    }
    entries.push(parsedEntry)
  }

  return { version: footer.version, entries, integrityVerified: true }
}

/** Extract one entry's payload bytes after parsing (bounds-checked slice). */
export const extractEntry = (bytes: Uint8Array, entry: PackedEntry): Uint8Array => {
  const start = HEADER_SIZE + entry.offset
  if (start + entry.length > footerAt(bytes)) throw new Error(`entry out of bounds: ${entry.id}`)
  const out = new Uint8Array(entry.length)
  out.set(bytes.subarray(start, start + entry.length))
  return out
}
