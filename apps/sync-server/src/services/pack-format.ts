/**
 * Pack file WRITER (#1839).
 *
 * The layout itself — magic, version, footer, index-record encoding and every
 * reader primitive — lives in `@memry/contracts/pack-format`, because the pack
 * is a wire contract between this Worker and the desktop client and that
 * package is the only one both sides may import (#1840). This module owns the
 * write half and re-exports the shared half unchanged, so every existing
 * server import keeps resolving from here.
 */

import {
  PACK_FOOTER_SIZE,
  PACK_HEADER_SIZE,
  PACK_MAGIC,
  PACK_VERSION,
  PackKindCode,
  packEncodeUtf8,
  packSha256,
  type PackEntryMeta,
  type PackKindName,
  type PackedEntry
} from '@memry/contracts/pack-format'

export {
  ByteReader,
  KIND_BY_CODE,
  PACK_FOOTER_SIZE,
  PACK_HEADER_SIZE,
  PACK_MAGIC,
  PACK_VERSION,
  PackKindCode,
  decodePackIndex,
  extractEntry,
  packBytesEqual,
  packSha256,
  parsePack,
  readFooter,
  readPackHeader
} from '@memry/contracts/pack-format'
export type {
  FooterInfo,
  PackEntryMeta,
  PackIndexEntry,
  PackKindName,
  PackedEntry,
  VerifiedPack
} from '@memry/contracts/pack-format'

const HEADER_SIZE = PACK_HEADER_SIZE

const sha256 = packSha256
const encode = packEncodeUtf8

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

export interface BuiltPack {
  /** Complete pack file bytes, ready for a single R2 PUT. */
  bytes: Uint8Array
  /** Entry offsets/lengths as written into the index block. */
  entries: PackedEntry[]
  /** Payload-region byte total (excludes header/index/footer). */
  payloadBytes: number
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
    encode(slot.plan.id).byteLength +
    2 +
    encode(slot.plan.sourceKey).byteLength +
    8 /* sortKey i64 */ +
    2 +
    encode(slot.metaJson).byteLength +
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
  out.set(encode(PACK_MAGIC), 0)
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
        index.lenPrefixed(encode(slot.plan.id))
        index.lenPrefixed(encode(slot.plan.sourceKey))
        index.i64(slot.plan.sortKey)
        index.lenPrefixed(encode(slot.metaJson))
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
      footer.push(encode(PACK_MAGIC))
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
