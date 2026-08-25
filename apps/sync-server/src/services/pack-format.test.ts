import { describe, expect, it } from 'vitest'

import {
  PACK_FOOTER_SIZE,
  PackKindCode,
  buildPack,
  extractEntry,
  openPack,
  parsePack,
  readFooter,
  type PackEntryInput,
  type PackEntryPlan
} from './pack-format'

/**
 * Round-trip proofs for the pack container (#1839): what buildPack writes,
 * parsePack must read back with EXACT offsets, and every corruption vector
 * must be detected rather than silently served.
 */

const entry = (overrides: Partial<PackEntryInput> = {}): PackEntryInput => ({
  kind: 'record',
  id: 'task:11111111-1111-4111-8111-111111111111',
  sourceKey: 'user-1/vaults/default/items-v3/task/it/hash',
  sortKey: 42,
  bytes: crypto.getRandomValues(new Uint8Array(64)),
  ...overrides
})

const snapshotEntry = (noteId: string, seq: number): PackEntryInput =>
  entry({
    kind: 'crdt_snapshot',
    id: noteId,
    sourceKey: `user-1/vaults/default/crdt/${noteId}/snapshot`,
    sortKey: 1700000000,
    meta: { sequenceNum: seq, revision: 'rev-' + noteId },
    bytes: crypto.getRandomValues(new Uint8Array(32))
  })

describe('buildPack / parsePack round trip', () => {
  it('preserves payload bytes byte-for-byte and reports exact offsets', async () => {
    const first = entry({ sortKey: 10 })
    const second = snapshotEntry('note-a', 3)
    const third = entry({ id: 'note:b', sortKey: 11, bytes: new Uint8Array([1, 2, 3, 4, 5]) })
    const built = await buildPack([first, second, third])

    // Header magic + version.
    expect(built.bytes.subarray(0, 4)).toEqual(new TextEncoder().encode('MPAK'))
    expect(built.bytes[4]).toBe(1)

    const parsed = await parsePack(built.bytes)
    expect(parsed.entries.map((e) => e.id)).toEqual([first.id, second.id, third.id])
    expect(parsed.entries[0].offset).toBe(0)
    expect(parsed.entries[0].length).toBe(first.bytes.length)
    // Contiguity: no padding between entries — the payload region is a pure
    // byte-concat, which is the whole point (server never transforms bytes).
    expect(parsed.entries[1].offset).toBe(parsed.entries[0].length)

    for (const [i, source] of [first, second, third].entries()) {
      expect(extractEntry(built.bytes, parsed.entries[i])).toEqual(source.bytes)
    }
    expect(parsed.integrityVerified).toBe(true)
  })

  it('round-trips index-block metadata used for client freshness checks', async () => {
    const built = await buildPack([snapshotEntry('note-x', 7)])
    const parsed = await parsePack(built.bytes)
    expect(parsed.entries[0].kind).toBe('crdt_snapshot')
    expect(parsed.entries[0].meta).toEqual({ sequenceNum: 7, revision: 'rev-note-x' })
    expect(parsed.entries[0].sourceKey).toContain('/crdt/note-x/snapshot')
  })

  it('is deterministic: identical inputs produce identical bytes', async () => {
    const inputs = [entry(), snapshotEntry('n', 1)]
    const a = await buildPack(inputs)
    const b = await buildPack(inputs)
    expect(a.bytes).toEqual(b.bytes)
  })

  it('footer carries version, entry count, index offset and payload digest', async () => {
    const entries = [entry(), entry({ sortKey: 43 })]
    const built = await buildPack(entries)
    const footer = readFooter(built.bytes)
    expect(footer.version).toBe(1)
    expect(footer.entryCount).toBe(2)
    expect(footer.indexOffset).toBe(8 + built.payloadBytes)
    // Footer occupies exactly the documented tail.
    expect(built.bytes.length - footer.indexOffset).toBeGreaterThanOrEqual(PACK_FOOTER_SIZE)
  })
})

describe('openPack streaming assembly', () => {
  const planOf = (entry: PackEntryInput): PackEntryPlan => ({
    kind: entry.kind,
    id: entry.id,
    sourceKey: entry.sourceKey,
    sortKey: entry.sortKey,
    sizeBytes: entry.bytes.length,
    ...(entry.meta ? { meta: entry.meta } : {})
  })

  it('produces byte-identical files to buildPack for the same entries', async () => {
    const entries = [entry(), snapshotEntry('note-a', 3), entry({ sortKey: 11 })]
    const plans = entries.map(planOf)
    const buffered = await buildPack(entries)

    const pack = openPack(plans)
    for (const [i, e] of entries.entries()) await pack.writeEntry(plans[i], e.bytes)
    const streamed = await pack.finish()

    expect(streamed.bytes).toEqual(buffered.bytes)
    expect(streamed.payloadBytes).toBe(buffered.payloadBytes)
    expect(await parsePack(streamed.bytes).then((p) => p.integrityVerified)).toBe(true)
  })

  it('leaves skipped slots out of the file and keeps remaining entries intact', async () => {
    const first = entry({ sortKey: 1 })
    const hole = snapshotEntry('gone', 2)
    const third = entry({ id: 'task:22222222-2222-4222-8222-222222222222', sortKey: 3 })
    const plans = [first, hole, third].map(planOf)

    const pack = openPack(plans)
    await pack.writeEntry(plans[0], first.bytes)
    pack.skipEntry(plans[1])
    await pack.writeEntry(plans[2], third.bytes)
    const built = await pack.finish()

    // Exact file length: the hole's reserved payload AND index record are
    // absent — no zero-filled slack survives into the PUT.
    const textEncoder = new TextEncoder()
    const recordSize = (e: PackEntryInput, metaJson: string): number =>
      1 +
      2 +
      textEncoder.encode(e.id).byteLength +
      2 +
      textEncoder.encode(e.sourceKey).byteLength +
      8 +
      2 +
      textEncoder.encode(metaJson).byteLength +
      8 +
      8 +
      32
    const expectedLength =
      8 +
      first.bytes.length +
      third.bytes.length +
      recordSize(first, '') +
      recordSize(third, '') +
      PACK_FOOTER_SIZE
    expect(built.bytes.length).toBe(expectedLength)
    expect(built.entries.map((e) => e.id)).toEqual([first.id, third.id])

    const parsed = await parsePack(built.bytes)
    expect(parsed.entries[0].offset).toBe(0)
    // Contiguity survives the skip: the survivor lands where the hole was.
    expect(parsed.entries[1].offset).toBe(first.bytes.length)
    expect(extractEntry(built.bytes, parsed.entries[1])).toEqual(third.bytes)
  })

  it('rejects a write whose bytes contradict the declared plan size', async () => {
    const plan = planOf(entry())
    const pack = openPack([plan])
    await expect(pack.writeEntry(plan, new Uint8Array(plan.sizeBytes + 1))).rejects.toThrow(
      /size mismatch/
    )
  })

  it('enforces strict plan order so offsets can never desync', async () => {
    const plans = [planOf(entry({ sortKey: 1 })), planOf(entry({ sortKey: 2 }))]
    const pack = openPack(plans)
    expect(() => pack.skipEntry(plans[1])).toThrow(/plan order/)
    await expect(pack.finish()).rejects.toThrow(/no entries/)
  })
})

/**
 * Byte positions of the FIRST index record's `offset` and `sha256` fields.
 *
 * The index block sits OUTSIDE the payload region the footer digest covers, so
 * editing it leaves that digest valid: the per-entry sha256 is the only guard
 * against a desynced index record (writer offset bug, R2 bit flip in the index).
 */
const indexRecordFields = (bytes: Uint8Array, first: PackEntryInput) => {
  const utf8 = new TextEncoder()
  const metaJson = first.meta ? JSON.stringify(first.meta) : ''
  const offsetAt =
    readFooter(bytes).indexOffset +
    1 /* kind */ +
    2 +
    utf8.encode(first.id).byteLength +
    2 +
    utf8.encode(first.sourceKey).byteLength +
    8 /* sortKey */ +
    2 +
    utf8.encode(metaJson).byteLength
  return { offsetAt, digestAt: offsetAt + 8 /* offset */ + 8 /* length */ }
}

const writeU64 = (bytes: Uint8Array, at: number, value: number): void => {
  new DataView(bytes.buffer, bytes.byteOffset).setBigUint64(at, BigInt(value))
}

describe('corruption detection', () => {
  it('rejects a tampered payload via the footer checksum', async () => {
    const built = await buildPack([entry()])
    const corrupt = new Uint8Array(built.bytes)
    const headerEnd = 8
    corrupt[headerEnd] = corrupt[headerEnd] ^ 0xff // flip one ciphertext bit
    await expect(parsePack(corrupt)).rejects.toThrow(/payload checksum mismatch/)
  })

  it('rejects an index record whose offset field points at another entry', async () => {
    const first = entry({ id: 'task:a', bytes: new Uint8Array(8).fill(0xaa) })
    const second = entry({ id: 'task:b', sortKey: 2, bytes: new Uint8Array(8).fill(0xbb) })
    const built = await buildPack([first, second])
    expect((await parsePack(built.bytes)).entries[0].offset).toBe(0)

    // Repoint entry 0 at entry 1's payload region. The payload bytes are
    // untouched, so the footer's whole-payload digest still matches — without
    // the per-entry digest this parses clean and serves task:b's ciphertext
    // under task:a's identity.
    const corrupt = new Uint8Array(built.bytes)
    writeU64(corrupt, indexRecordFields(corrupt, first).offsetAt, first.bytes.length)

    await expect(parsePack(corrupt)).rejects.toThrow(/pack entry checksum mismatch: task:a/)
  })

  it('rejects an index record whose recorded entry digest is corrupt', async () => {
    const first = entry({ id: 'task:a' })
    const built = await buildPack([first, entry({ id: 'task:b', sortKey: 2 })])

    const corrupt = new Uint8Array(built.bytes)
    const { digestAt } = indexRecordFields(corrupt, first)
    corrupt[digestAt] = corrupt[digestAt] ^ 0xff

    await expect(parsePack(corrupt)).rejects.toThrow(/pack entry checksum mismatch: task:a/)
  })

  it('rejects wrong magic and unknown versions', async () => {
    const built = await buildPack([entry()])
    const badMagic = new Uint8Array(built.bytes)
    badMagic[0] = 0x58
    await expect(parsePack(badMagic)).rejects.toThrow(/header magic/)

    const badVersion = new Uint8Array(built.bytes)
    badVersion[4] = 99
    await expect(parsePack(badVersion)).rejects.toThrow(/unsupported pack version/)

    const badFooterVersion = new Uint8Array(built.bytes)
    badFooterVersion[badFooterVersion.length - 1] = 99
    await expect(parsePack(badFooterVersion)).rejects.toThrow(/unsupported pack version/)
  })

  it('rejects truncated files and empty entries', async () => {
    const built = await buildPack([entry()])
    await expect(parsePack(built.bytes.subarray(0, built.bytes.length - 10))).rejects.toThrow()

    await expect(buildPack([entry({ bytes: new Uint8Array(0) })])).rejects.toThrow(
      /empty pack entry/
    )
    expect(PackKindCode.record).toBe(0)
  })
})
