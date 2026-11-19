/**
 * Verifier for `pack-container.json` (T072).
 *
 * Reader-only, because a client is never a pack writer. `parsePack` must accept
 * every good case with the expected entries, and reject every bad one with the
 * documented message.
 *
 * `readFooter` is exercised on the TAIL SLICE alone, because that is what a
 * streaming reader passes: it never holds the file.
 */
import sodium, { ready } from 'libsodium-wrappers-sumo'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  decryptCrdtUpdatePacked,
  decryptRecordItem
} from '../../../sync-client/src/pull/record-decrypt.ts'
import { deterministicProvider, hex } from '../../test-vectors/deterministic-provider'
import {
  PACK_FOOTER_SIZE,
  PACK_HEADER_SIZE,
  PACK_MAGIC,
  PACK_MAX_ENTRIES,
  PACK_VERSION,
  PackKindCode,
  extractEntry,
  parsePack,
  readFooter
} from '../pack-format'
import {
  CrdtUpdatePackEntryMetaSchema,
  PackCoverageSchema,
  EncryptedItemPayloadSchema,
  RECORD_SYNC_ITEM_TYPES,
  RecordPackEntryMetaSchema,
  RecordPullItemResponseSchema
} from '../sync-api'
import { fromHex, loadVectorFile } from './vector-loader'

interface EntryContract {
  records?: Array<{
    id: string
    usable: boolean
    // Present when `usable`.
    sortKey?: number
    sourceKey?: string
    pullItem?: unknown
    vaultKeyHex?: string
    signingSeedHex?: string
    plaintextUtf8?: string
  }>
  updates?: Array<{
    noteId: string
    usable: boolean
    sortKey: number
    meta: unknown
    vaultKeyHex: string
    signingSeedHex: string
    plaintextHex: string
  }>
  updatePlans?: Array<{
    scenario: string
    cursor: number
    floor: number | null
    floorReadAfterPack: boolean
    snapshotSequenceNum: number | null
    apply: number[]
    cursorAfter: number
  }>
}

/**
 * Chapter 08 §8.4.3 as a reader would run it over one document's packed
 * updates: nothing without a `floor` read after the pack, nothing when one pair
 * carries two digests, and otherwise each update that is above the floor and
 * the cursor plus one, until the first that is not. `snapshotMeta` is never
 * consulted: a claimed snapshot after a purge can number below the floor
 * (#5248).
 */
function planPackedUpdates(
  entries: Array<{ meta?: unknown; payloadHex: string }>,
  cursor: number,
  floor: number | null,
  floorReadAfterPack: boolean
): { apply: number[]; cursorAfter: number } {
  if (floor === null || !floorReadAfterPack) return { apply: [], cursorAfter: cursor }
  const digestBySeq = new Map<number, string>()
  for (const entry of entries) {
    const { sequenceNum } = CrdtUpdatePackEntryMetaSchema.parse(entry.meta)
    const digest = entry.payloadHex
    const seen = digestBySeq.get(sequenceNum)
    if (seen !== undefined && seen !== digest) return { apply: [], cursorAfter: cursor }
    digestBySeq.set(sequenceNum, digest)
  }
  const apply: number[] = []
  let at = cursor
  while (at + 1 > floor && digestBySeq.has(at + 1)) {
    at += 1
    apply.push(at)
  }
  return { apply, cursorAfter: at }
}

interface CoverageCase {
  scenario: string
  noteBody: boolean
  coverage: unknown[] | null
  packs: Array<{ itemKind: string; coverFrom?: number; coverThrough?: number; usable: boolean }>
  unusableRecordSortKeys: number[]
  tailFrom: number
}

/**
 * Chapter 08 §8.10 as a reader would run it: per kind that bounds the tail,
 * chain the usable packs that carry a coverage range from 0; reaching
 * `packedThrough` earns `coveredThrough`, a gap stops at the chain's end, and a
 * kind with no coverage entry gives 0. Unusable record entries pull the record
 * bound to `sortKey - 1`. The tail starts at the lowest bound.
 */
function tailFrom(c: CoverageCase): number {
  const stated = c.coverage?.map((entry) => PackCoverageSchema.parse(entry)) ?? []
  const kinds = c.noteBody ? ['record', 'crdt_snapshot', 'crdt_update'] : ['record']
  const bounds = kinds.map((kind) => {
    const coverage = stated.find((entry) => entry.itemKind === kind)
    if (!coverage) return 0
    const ranges = c.packs
      .filter((p) => p.itemKind === kind && p.usable)
      .flatMap((p) =>
        p.coverFrom === undefined || p.coverThrough === undefined
          ? []
          : [{ from: p.coverFrom, through: p.coverThrough }]
      )
      .toSorted((a, b) => a.from - b.from)
    let end = 0
    for (const range of ranges) {
      if (range.from > end) break
      end = Math.max(end, range.through)
    }
    const bound = end >= coverage.packedThrough ? Math.max(end, coverage.coveredThrough) : end
    return kind === 'record'
      ? Math.min(bound, ...c.unusableRecordSortKeys.map((sortKey) => sortKey - 1))
      : bound
  })
  return Math.min(...bounds)
}

const vectors = loadVectorFile<{
  meta: {
    caseCount: number
    layout: Record<string, unknown>
    kindCodes: Record<string, number>
  }
  cases: Array<{
    name: string
    pins: string
    packHex: string
    expected: { version: number; entries: unknown[]; integrityVerified: boolean }
    entryContract?: EntryContract
  }>
  errorCases: Array<{
    name: string
    packHex: string
    // Absent when the reference's message is unreachable for a conforming
    // reader; `referenceOnlyMessage` records it for the record instead.
    expectErrorContains?: string
    referenceOnlyMessage?: string
    // The portable half. A second implementation asserts this, never the
    // English message.
    expectErrorCode: string
    pins: string
  }>
  coverageCases: CoverageCase[]
}>('pack-container.json')

describe('pack-container vectors', () => {
  it('carries the recorded case count', () => {
    expect(vectors.cases.length + vectors.errorCases.length).toBe(vectors.meta.caseCount)
  })

  it('the recorded layout matches the production constants', () => {
    expect(vectors.meta.layout).toEqual({
      PACK_MAGIC,
      PACK_VERSION,
      PACK_HEADER_SIZE,
      PACK_FOOTER_SIZE,
      PACK_MAX_ENTRIES
    })
    expect(vectors.meta.kindCodes).toEqual({ ...PackKindCode })
  })

  for (const entry of vectors.cases) {
    // oxlint-disable-next-line vitest/valid-title -- title comes from vector/fixture data typed as string; the rule is not type-aware
    it(entry.name, async () => {
      const bytes = fromHex(entry.packHex)
      const parsed = await parsePack(bytes)
      expect(parsed.version, entry.pins).toBe(entry.expected.version)
      expect(parsed.integrityVerified).toBe(true)
      expect(parsed.entries).toEqual(entry.expected.entries)
    })

    it(`${entry.name}: the footer parses from the tail slice alone`, () => {
      const bytes = fromHex(entry.packHex)
      const tail = bytes.subarray(bytes.length - PACK_FOOTER_SIZE)
      const fromTail = readFooter(tail)
      const fromWhole = readFooter(bytes)
      expect(fromTail).toEqual(fromWhole)
    })
  }

  for (const entry of vectors.errorCases) {
    // oxlint-disable-next-line vitest/valid-title -- title comes from vector/fixture data typed as string; the rule is not type-aware
    it(entry.name, async () => {
      // oxlint-disable-next-line vitest/valid-expect -- promise is awaited below, after fake timers advance; awaiting here would deadlock
      const rejects = expect(parsePack(fromHex(entry.packHex)), entry.pins).rejects
      // `entry-count-too-large` has no asserted message: the reference reaches
      // "pack truncated" only because it does not apply §8.6's cap, and a
      // conforming reader fails earlier. Assert that it still rejects.
      await (entry.expectErrorContains
        ? rejects.toThrow(entry.expectErrorContains)
        : rejects.toThrow())
    })
  }

  it('every error case carries a portable error code', () => {
    // Without this, a second implementation can only assert this reader's
    // English, which pins the phrasing rather than the behaviour.
    for (const entry of vectors.errorCases) {
      expect(entry.expectErrorCode, entry.name).toBeTruthy()
    }
  })

  it('a per-entry digest failure is caught even when the payload digest passes', () => {
    // Named explicitly so a refactor that short-circuits after the whole-payload
    // digest cannot quietly retire the per-entry check.
    const entry = vectors.errorCases.find((c) => c.expectErrorCode === 'entry-checksum-mismatch')
    expect(entry, 'the per-entry digest case is missing').toBeDefined()
  })

  it('an offset is relative to the payload region, not to the file', () => {
    // The off-by-eight a reader gets wrong first: the first entry starts at
    // offset 0, which sits at PACK_HEADER_SIZE in the file.
    const first = vectors.cases[0].expected.entries[0] as { offset: number }
    expect(first.offset).toBe(0)
    expect(PACK_HEADER_SIZE).toBe(8)
  })
})

/**
 * Chapter 08 §8.4.2 and §8.4.3: what one record or update entry means.
 *
 * Rebuilt from the pack bytes and pushed through the production verify and
 * decrypt paths, so a meta that dropped a field the pull item carries fails
 * here on the signature, not on a shape comparison alone.
 */
describe('pack coverage vectors', () => {
  it('covers a gap, a rollup overlap, an unusable record entry and a cache-only pack', () => {
    const scenarios = vectors.coverageCases.map((c) => c.scenario)
    for (const required of [
      'no coverage (every server today)',
      'a pack in the middle of the chain answered 404',
      'a rollup listed both the old packs and the new one',
      'the newest pack left the listing during the walk',
      'an unusable record entry',
      'a snapshot pack without a coverage range is a cache only'
    ]) {
      expect(scenarios).toContain(required)
    }
  })

  for (const c of vectors.coverageCases) {
    // oxlint-disable-next-line vitest/valid-title -- title comes from vector/fixture data typed as string; the rule is not type-aware
    it(c.scenario, () => {
      expect(tailFrom(c)).toBe(c.tailFrom)
    })
  }
})

describe('pack entry contract vectors', () => {
  beforeAll(async () => {
    await ready
  })

  const contractCases = vectors.cases.filter((c) => c.entryContract)

  it('covers record entries, a record entry without meta, and kind 2', () => {
    const records = contractCases.flatMap((c) => c.entryContract?.records ?? [])
    const updates = contractCases.flatMap((c) => c.entryContract?.updates ?? [])
    expect(records.some((r) => r.usable)).toBe(true)
    expect(records.some((r) => !r.usable)).toBe(true)
    expect(updates.length).toBeGreaterThan(1)
  })

  it('covers a purge, a gap and one pair with two digests', () => {
    const plans = contractCases.flatMap((c) => c.entryContract?.updatePlans ?? [])
    const scenarios = plans.map((p) => p.scenario)
    for (const required of [
      'cursor at the floor',
      'claimed snapshot after the purge, no floor',
      'floor read before the purge, then the pack',
      'answer without floor (every server today)',
      'floor above the pack'
    ]) {
      expect(scenarios).toContain(required)
    }
    expect(contractCases.some((c) => c.name.includes('gap'))).toBe(true)
    expect(contractCases.some((c) => c.name.includes('two digests'))).toBe(true)
  })

  for (const entry of contractCases) {
    // oxlint-disable-next-line vitest/valid-title -- title comes from vector/fixture data typed as string; the rule is not type-aware
    it(entry.name, async () => {
      const bytes = fromHex(entry.packHex)
      const parsed = await parsePack(bytes)
      const wantRecords = entry.entryContract?.records ?? []
      const wantUpdates = entry.entryContract?.updates ?? []
      const records = parsed.entries.filter((e) => e.kind === 'record')
      const updates = parsed.entries.filter((e) => e.kind === 'crdt_update')
      expect(records.map((e) => e.id)).toEqual(wantRecords.map((r) => r.id))
      // Plan cases carry entries but no per-entry expectations.
      expect(updates.length).toBe(
        entry.entryContract?.updatePlans ? updates.length : wantUpdates.length
      )

      for (const [i, packed] of records.entries()) {
        const want = wantRecords[i]
        const meta = RecordPackEntryMetaSchema.safeParse(packed.meta)
        // `type:id`, split at the first colon: no record type contains one.
        const split = packed.id.indexOf(':')
        const declared = (RECORD_SYNC_ITEM_TYPES as readonly string[]).includes(
          packed.id.slice(0, split)
        )
        expect(meta.success && declared, `${packed.id}: usable`).toBe(want.usable)
        if (!meta.success || !declared) continue
        expect(packed.sortKey).toBe(want.sortKey)
        expect(packed.sourceKey).toBe(want.sourceKey)
        const blob = EncryptedItemPayloadSchema.parse(
          JSON.parse(new TextDecoder().decode(extractEntry(bytes, packed)))
        )
        const pullItem = RecordPullItemResponseSchema.parse({
          ...meta.data,
          id: packed.id.slice(split + 1),
          type: packed.id.slice(0, split),
          blob
        })
        expect(pullItem).toEqual(want.pullItem)

        const signer = sodium.crypto_sign_seed_keypair(fromHex(want.signingSeedHex ?? ''))
        const plaintext = await decryptRecordItem(
          deterministicProvider(),
          { ...pullItem, ...pullItem.blob, cryptoVersion: pullItem.cryptoVersion ?? 1 },
          fromHex(want.vaultKeyHex ?? ''),
          signer.publicKey
        )
        expect(new TextDecoder().decode(plaintext)).toBe(want.plaintextUtf8)
      }

      // Within one document, server_cursor order is sequenceNum order (chapter 07 §7.17).
      const sortKeys = updates.map((u) => u.sortKey)
      const sequenceNums = updates.map(
        (u) => CrdtUpdatePackEntryMetaSchema.parse(u.meta).sequenceNum
      )
      expect(sortKeys).toEqual(sortKeys.toSorted((a, b) => a - b))
      expect(sequenceNums).toEqual(sequenceNums.toSorted((a, b) => a - b))

      for (const [i, want] of wantUpdates.entries()) {
        const packed = updates[i]
        expect(packed.id).toBe(want.noteId)
        expect(packed.sortKey).toBe(want.sortKey)
        expect(packed.sourceKey).toBe('')
        const meta = CrdtUpdatePackEntryMetaSchema.parse(packed.meta)
        expect(meta).toEqual(want.meta)
        const signer = sodium.crypto_sign_seed_keypair(fromHex(want.signingSeedHex))
        const plaintext = await decryptCrdtUpdatePacked(
          deterministicProvider(),
          extractEntry(bytes, packed),
          fromHex(want.vaultKeyHex),
          packed.id,
          signer.publicKey
        )
        expect(hex(plaintext)).toBe(want.plaintextHex)
      }

      // Equal payloads are equal digests: parsePack already checked each one.
      const packedUpdates = updates.map((u) => ({
        meta: u.meta,
        payloadHex: hex(extractEntry(bytes, u))
      }))
      for (const plan of entry.entryContract?.updatePlans ?? []) {
        expect(
          planPackedUpdates(packedUpdates, plan.cursor, plan.floor, plan.floorReadAfterPack),
          plan.scenario
        ).toEqual({
          apply: plan.apply,
          cursorAfter: plan.cursorAfter
        })
      }
    })
  }
})
