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
  32 /* payloadSha256 */ +
  8 /* entryCount */ +
  8 /* indexOffset */ +
  4 /* magic */ +
  1 /* version */

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
      new Uint8Array([
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff
      ])
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
 * Everything an entry's index record needs BEFORE its bytes are fetched:
 * identities, ordering key and freshness meta come from D1 selection rows,
 * and `sizeBytes` is the D1-declared blob size the writer enforces on write.
 */
export interface PackEntryPlan {
  kind: PackKindName
  id: string
  sourceKey: string
  sortKey: number
  /** Declared payload size; writeEntry rejects a mismatch. */
  sizeBytes: number
  meta?: PackEntryMeta
}

export interface OpenPack {
  /**
   * Copy one entry's EXACT bytes into the pack buffer at the next slot,
   * recording its digest. Must be called in plan order. The caller drops its
   * `bytes` reference right after — the pack buffer then holds the only copy,
   * which is what keeps peak memory at buffer + one transient entry.
   */
  writeEntry: (plan: PackEntryPlan, bytes: Uint8Array) => Promise<void>
  /** Advance past a slot whose blob vanished or drifted (hole). */
  skipEntry: (plan: PackEntryPlan) => void
  /** Write index block + footer; returns the trimmed file bytes. */
  finish: () => Promise<BuiltPack>
}

/**
 * Open a pack for STREAMING assembly into ONE pre-allocated buffer (#1839).
 *
 * Memory contract: every plan field except the bytes themselves is known up
 * front (D1 size_bytes + snapshot metadata read before fetch), so the buffer
 * is sized exactly once — header + declared payload + index + footer — and no
 * second full-size allocation ever exists. Holes leave their capacity unused;
 * finish() trims it off with a subarray view rather than copying. Peak memory
 * ≈ PACK_TARGET_BYTES + one transient source blob, never payload + assembled
 * copy simultaneously. Production compaction MUST use this path; buildPack is
 * only for callers that already hold every entry in hand (tests).
 */
export const openPack = (plans: PackEntryPlan[]): OpenPack => {
  if (plans.length === 0) throw new Error('cannot open a pack with no entries')

  // Exact per-entry index record sizes are computable pre-fetch: id/sourceKey/
  // metaJson byte lengths plus fixed-width fields. That makes the single
  // allocation below exact, not estimated.
  interface Slot {
    plan: PackEntryPlan
    metaJson: string
    written: boolean
    skipped: boolean
    offset: number | null
    digest: Uint8Array | null
  }
  const slots: Slot[] = plans.map((plan) => ({
    plan,
    metaJson: plan.meta ? JSON.stringify(plan.meta) : '',
    written: false,
    skipped: false,
    offset: null,
    digest: null
  }))
  const indexRecordSize = (slot: Slot): number =>
    1 /* kind */ +
    2 +
    encoder.encode(slot.plan.id).byteLength +
    2 +
    encoder.encode(slot.plan.sourceKey).byteLength +
    8 /* sortKey i64 */ +
    2 +
    encoder.encode(slot.metaJson).byteLength +
    8 /* offset u64 */ +
    8 /* length u64 */ +
    32 /* sha256 */

  const declaredPayloadBytes = slots.reduce((sum, slot) => sum + slot.plan.sizeBytes, 0)
  const indexBytes = slots.reduce((sum, slot) => sum + indexRecordSize(slot), 0)
  const total = HEADER_SIZE + declaredPayloadBytes + indexBytes + PACK_FOOTER_SIZE

  // THE single payload-sized allocation of a pack build. Written in file
  // order: header now, entries streamed as they are fetched, index block and
  // footer at finish().
  const out = new Uint8Array(total)
  out.set(encoder.encode(PACK_MAGIC), 0)
  out[4] = PACK_VERSION
  out[5] = 0
  out[6] = 0
  out[7] = 0
  let writeAt = HEADER_SIZE // absolute position of the next payload byte
  let nextSlot = 0 // strict plan order for both write and skip

  const claimNextSlot = (plan: PackEntryPlan): Slot => {
    const slot = slots[nextSlot]
    if (!slot || slot.plan !== plan) throw new Error('pack entries must be written in plan order')
    if (slot.written || slot.skipped) throw new Error(`pack entry already consumed: ${plan.id}`)
    nextSlot++
    return slot
  }

  return {
    writeEntry: async (plan, bytes) => {
      if (bytes.length === 0) throw new Error(`empty pack entry: ${plan.id}`)
      if (bytes.length !== plan.sizeBytes) {
        throw new Error(
          `pack entry size mismatch: ${plan.id} declared ${plan.sizeBytes}, got ${bytes.length}`
        )
      }
      const slot = claimNextSlot(plan)
      slot.digest = await sha256(bytes)
      slot.offset = writeAt - HEADER_SIZE
      out.set(bytes, writeAt)
      writeAt += bytes.length
      slot.written = true
    },
    skipEntry: (plan) => {
      claimNextSlot(plan).skipped = true
    },
    finish: async (): Promise<BuiltPack> => {
      const writtenSlots = slots.filter((slot) => slot.written)
      if (writtenSlots.length === 0) throw new Error('pack has no entries')
      const payloadBytes = writeAt - HEADER_SIZE

      // Index block directly after the payload region, plan order, written
      // entries only — holes simply do not appear.
      let cursor = 0
      const packed: PackedEntry[] = []
      for (const slot of writtenSlots) {
        const index = new ByteWriter()
        index.u8(PackKindCode[slot.plan.kind])
        index.lenPrefixed(encoder.encode(slot.plan.id))
        index.lenPrefixed(encoder.encode(slot.plan.sourceKey))
        index.i64(slot.plan.sortKey)
        index.lenPrefixed(encoder.encode(slot.metaJson))
        index.u64(slot.offset!)
        index.u64(slot.plan.sizeBytes)
        index.push(slot.digest!)
        out.set(index.finish(), writeAt + cursor)
        cursor += indexRecordSize(slot)
        const packedEntry: PackedEntry = {
          kind: slot.plan.kind,
          id: slot.plan.id,
          sourceKey: slot.plan.sourceKey,
          sortKey: slot.plan.sortKey,
          offset: slot.offset!,
          length: slot.plan.sizeBytes
        }
        if (slot.plan.meta) packedEntry.meta = slot.plan.meta
        packed.push(packedEntry)
      }
      const indexOffset = writeAt

      const footer = new ByteWriter()
      footer.push(await sha256(out.subarray(HEADER_SIZE, HEADER_SIZE + payloadBytes)))
      footer.u64(writtenSlots.length)
      footer.u64(indexOffset)
      footer.push(encoder.encode(PACK_MAGIC))
      footer.u8(PACK_VERSION)
      out.set(footer.finish(), writeAt + cursor)

      // Trim the unused hole capacity with a view — no copy, so the returned
      // file is exactly what gets PUT.
      return {
        bytes: out.subarray(0, writeAt + cursor + PACK_FOOTER_SIZE),
        entries: packed,
        payloadBytes
      }
    }
  }
}

/**
 * Build one complete pack from fully-materialized entries.
 *
 * Deterministic: the same inputs always produce the same bytes, which is what
 * makes retried compactions of one range land on an identical file instead of
 * diverging copies.
 *
 * MEMORY NOTE: this wrapper holds every entry AND the finished file at once
 * (~2× payload). Fine for tests; the production compaction path streams
 * through openPack() precisely to avoid that doubling inside a 128MB isolate.
 */
export const buildPack = async (entries: PackEntryInput[]): Promise<BuiltPack> => {
  const plans: PackEntryPlan[] = entries.map(({ bytes, ...rest }) => ({
    ...rest,
    sizeBytes: bytes.length
  }))
  const pack = openPack(plans)
  for (const [i, entry] of entries.entries()) await pack.writeEntry(plans[i], entry.bytes)
  return pack.finish()
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
    const actualDigest = await sha256(
      bytes.subarray(HEADER_SIZE + offset, HEADER_SIZE + offset + length)
    )
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
