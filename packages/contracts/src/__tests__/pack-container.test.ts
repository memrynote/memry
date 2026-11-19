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
  PACK_PURGE_DEADLINE_SECONDS,
  PACK_REPLACED_GRACE_SECONDS,
  PackCoverageSchema,
  PackListResponseSchema,
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

/**
 * REVIEW-5254 and REVIEW-5253 probes: chapter 08 §8.10 to §8.13 run as a
 * writer, a server and a fresh reader over one small vault, with the
 * zero-loss oracle as the assertion: after the bootstrap the reader holds
 * every live record, every tombstone that still has a payload, and each live
 * document's current body, exactly as the server does. Each probe failed under
 * the text it replaces (PR #5254 body, Proof). A dead document's body rows
 * are needed rows: a re-create revives them (chapter 07 §7.15).
 */
type ProbeKind = 'record' | 'crdt_snapshot'

interface Row {
  kind: ProbeKind
  doc: string
  cursor: number
  deleted?: boolean
  // A purged-tombstone marker (chapter 05 §5.12.3): no payload, never in a fresh reader's feed.
  marker?: boolean
  revision?: string
}

interface Pack {
  kind: ProbeKind
  coverFrom: number
  coverThrough: number
  entries: Row[]
}

/** §8.10 writer: every needed row of the kind in the range. A marker has no payload. */
function buildPack(rows: Row[], kind: ProbeKind, coverFrom: number, coverThrough: number): Pack {
  const entries = rows.filter(
    (r) => r.kind === kind && r.cursor > coverFrom && r.cursor <= coverThrough && !r.marker
  )
  return { kind, coverFrom, coverThrough, entries }
}

/** §8.13 scoped rewrite: the document's body entries and older record entries go. */
function rewriteForPurge(pack: Pack, doc: string, rows: Row[]): Pack {
  const current = (e: Row) =>
    rows.some((r) => r.kind === e.kind && r.doc === doc && r.cursor === e.cursor)
  const entries = pack.entries.filter((e) => e.doc !== doc || (e.kind === 'record' && current(e)))
  return { ...pack, entries }
}

const liveDocs = (rows: Row[]) =>
  rows.filter((r) => r.kind === 'record' && !r.deleted).map((r) => r.doc)

function oracle(rows: Row[]) {
  const live = liveDocs(rows)
  const bodies: Record<string, string> = {}
  for (const r of rows)
    if (r.kind === 'crdt_snapshot' && live.includes(r.doc)) bodies[r.doc] = r.revision ?? ''
  return {
    live: live.toSorted(),
    tombstones: rows
      .filter((r) => r.kind === 'record' && r.deleted && !r.marker)
      .map((r) => r.doc)
      .toSorted(),
    bodies
  }
}

/**
 * A fresh reader that declares `note_body` but not `purged_tombstones`:
 * §8.10 tail start, then the feed above it, then the record reconcile against
 * `GET /sync/manifest` (live records only, `deleted_at IS NULL`) and the body
 * check against `snapshotMeta`, both read after the pack bytes.
 */
function bootstrap(input: {
  packs: Pack[]
  coverage: Array<{ itemKind: ProbeKind; packedThrough: number; coveredThrough: number }>
  rowsAtTail: Row[]
  rowsAfterPack: Row[]
  localModified?: string[]
}) {
  const tail = tailFrom({
    scenario: '',
    noteBody: true,
    coverage: [
      ...input.coverage,
      { itemKind: 'crdt_update', packedThrough: 0, coveredThrough: 1e9 }
    ],
    packs: input.packs.map((p) => ({
      itemKind: p.kind,
      coverFrom: p.coverFrom,
      coverThrough: p.coverThrough,
      usable: true
    })),
    unusableRecordSortKeys: [],
    tailFrom: 0
  })
  const records = new Map<string, Row & { fromPack: boolean }>()
  const bodies = new Map<string, Row>()
  const take = (r: Row, fromPack: boolean) => {
    if (r.kind === 'record') {
      const held = records.get(r.doc)
      if (!held || r.cursor > held.cursor) records.set(r.doc, { ...r, fromPack })
    } else if (!bodies.has(r.doc) || r.cursor > (bodies.get(r.doc)?.cursor ?? 0)) {
      bodies.set(r.doc, r)
    }
  }
  const snapshotMeta = (doc: string) =>
    input.rowsAfterPack.find((r) => r.kind === 'crdt_snapshot' && r.doc === doc)?.revision
  for (const pack of input.packs)
    for (const e of pack.entries)
      if (e.kind === 'record' || e.revision === snapshotMeta(e.doc)) take(e, true)
  for (const r of input.rowsAtTail) if (r.cursor > tail && !r.marker) take(r, false)
  const manifest = liveDocs(input.rowsAfterPack)
  for (const [doc, r] of records)
    if (r.fromPack && !r.deleted && !manifest.includes(doc) && !input.localModified?.includes(doc))
      records.delete(doc)
  for (const doc of manifest) {
    if (records.get(doc)?.deleted === false) continue
    const row = input.rowsAfterPack.find((r) => r.kind === 'record' && r.doc === doc)
    if (row) records.set(doc, { ...row, fromPack: false })
  }
  const live = [...records.values()].filter((r) => !r.deleted).map((r) => r.doc)
  return {
    live: live.toSorted(),
    tombstones: [...records.values()]
      .filter((r) => r.deleted)
      .map((r) => r.doc)
      .toSorted(),
    bodies: Object.fromEntries(
      [...bodies.values()].filter((r) => live.includes(r.doc)).map((r) => [r.doc, r.revision ?? ''])
    )
  }
}

const PRESIGN_TTL_SECONDS = 300 // apps/sync-server/src/services/r2-presign.ts:27
const PACK_DELETE_SWEEP_SECONDS = 300 // §8.13: the sweep runs at most every 5 minutes

/**
 * §8.13 object deletion after a purge removed a pack's listing row at `removedAt`:
 * the queue message fires at the end of the grace period, and the sweep
 * retries a failed or deferred delete. A delete waits for the pack's rewrite
 * only while the next sweep is still inside the deadline; when the deadline
 * forces it first, the range is rebuilt from source rows.
 */
function deleteReplacedObject(input: {
  removedAt: number
  rewriteCommittedAt: number
  failingDeletes: number
}): { goneAt: number; relisted: 'rewrite' | 'rebuild' } {
  let failures = input.failingDeletes
  const deadline = input.removedAt + PACK_PURGE_DEADLINE_SECONDS
  for (
    let t = input.removedAt + PACK_REPLACED_GRACE_SECONDS;
    t < input.removedAt + 86_400;
    t += PACK_DELETE_SWEEP_SECONDS
  ) {
    const forced = t + PACK_DELETE_SWEEP_SECONDS > deadline
    if (input.rewriteCommittedAt > t && !forced) continue
    if (failures > 0) {
      failures -= 1
      continue
    }
    return { goneAt: t, relisted: input.rewriteCommittedAt <= t ? 'rewrite' : 'rebuild' }
  }
  return { goneAt: Infinity, relisted: 'rebuild' }
}

describe('pack coverage probes (REVIEW-5254, REVIEW-5253)', () => {
  it('P1: a dead document body revived by a re-create below the coverage reaches the reader', () => {
    const before: Row[] = [
      { kind: 'record', doc: 'x', cursor: 60, deleted: true },
      { kind: 'crdt_snapshot', doc: 'x', cursor: 50, revision: 'r1' }
    ]
    const packs = [buildPack(before, 'record', 0, 100), buildPack(before, 'crdt_snapshot', 0, 100)]
    // The purge has not run (or failed); the re-create at 120 keeps the body row at 50.
    const after: Row[] = [{ kind: 'record', doc: 'x', cursor: 120 }, before[1]]
    const read = bootstrap({
      packs,
      coverage: [
        { itemKind: 'record', packedThrough: 100, coveredThrough: 100 },
        { itemKind: 'crdt_snapshot', packedThrough: 100, coveredThrough: 100 }
      ],
      rowsAtTail: after,
      rowsAfterPack: after
    })
    expect(read).toEqual(oracle(after))
    expect(read.bodies).toEqual({ x: 'r1' })
  })

  it('P2: the scoped rewrite keeps the record tombstone, so a fresh reader learns its clock', () => {
    const before: Row[] = [
      { kind: 'record', doc: 'x', cursor: 20, deleted: true },
      { kind: 'crdt_snapshot', doc: 'x', cursor: 11, revision: 'rx' },
      { kind: 'record', doc: 'y', cursor: 25 },
      { kind: 'crdt_snapshot', doc: 'y', cursor: 26, revision: 'ry' }
    ]
    const after = before.filter((r) => !(r.kind === 'crdt_snapshot' && r.doc === 'x'))
    const packs = [
      buildPack(before, 'record', 0, 30),
      buildPack(before, 'crdt_snapshot', 0, 30)
    ].map((p) => rewriteForPurge(p, 'x', after))
    const read = bootstrap({
      packs,
      coverage: [
        { itemKind: 'record', packedThrough: 30, coveredThrough: 30 },
        { itemKind: 'crdt_snapshot', packedThrough: 30, coveredThrough: 30 }
      ],
      rowsAtTail: after,
      rowsAfterPack: after
    })
    expect(read).toEqual(oracle(after))
    expect(read.tombstones).toEqual(['x'])
  })

  it('P3: a packed live record whose tombstone was shed is not applied (manifest reconcile)', () => {
    const listed: Row[] = [
      { kind: 'record', doc: 'x', cursor: 10 },
      { kind: 'record', doc: 'y', cursor: 12 }
    ]
    const pack = buildPack(listed, 'record', 0, 15)
    // REVIEW-5253 probe a and REVIEW-5254 P3: the tombstone at 20 is shed to a marker
    // before any pack carries it, and the reader still downloads the old pack.
    const shed: Row[] = [
      { kind: 'record', doc: 'x', cursor: 20, deleted: true, marker: true },
      listed[1]
    ]
    const input = {
      packs: [pack],
      coverage: [
        { itemKind: 'record' as const, packedThrough: 15, coveredThrough: 15 },
        { itemKind: 'crdt_snapshot' as const, packedThrough: 0, coveredThrough: 1e9 }
      ],
      rowsAtTail: shed,
      rowsAfterPack: shed
    }
    expect(bootstrap(input)).toEqual(oracle(shed))
    // A pack-sourced record the device modified locally stays, for its push to decide.
    expect(bootstrap({ ...input, localModified: ['x'] }).live).toEqual(['x', 'y'])
  })

  it('P3: the shed waits out every URL signed while the record pack was listed', () => {
    const removedAt = 1_000
    const shedAt = removedAt + PACK_REPLACED_GRACE_SECONDS
    for (const signedAt of [0, removedAt - 1, removedAt]) {
      expect(signedAt + PRESIGN_TTL_SECONDS).toBeLessThan(shedAt)
    }
  })

  it('P4: the old object outlives its in-flight rewrite, and the deadline forces a rebuild', () => {
    const late = deleteReplacedObject({ removedAt: 0, rewriteCommittedAt: 700, failingDeletes: 0 })
    expect(late.relisted).toBe('rewrite')
    expect(late.goneAt).toBeGreaterThanOrEqual(700)
    expect(late.goneAt).toBeLessThanOrEqual(PACK_PURGE_DEADLINE_SECONDS)
    const never = deleteReplacedObject({
      removedAt: 0,
      rewriteCommittedAt: Infinity,
      failingDeletes: 0
    })
    expect(never).toEqual({ goneAt: PACK_PURGE_DEADLINE_SECONDS, relisted: 'rebuild' })
  })

  it('P5: a failed object delete is retried by the sweep inside the 900 s bound', () => {
    const run = deleteReplacedObject({ removedAt: 0, rewriteCommittedAt: 100, failingDeletes: 1 })
    expect(run.goneAt).toBeLessThanOrEqual(PACK_PURGE_DEADLINE_SECONDS)
  })

  it('P6: a pack whose pack_index insert would do nothing advances neither watermark nor coverage', () => {
    // Two snapshots in one second: their packs share min_cursor (created_at), the
    // UNIQUE key of pack_index (0007_pack_index.sql:32), and the second insert does nothing.
    const rows: Row[] = [
      { kind: 'record', doc: 'a', cursor: 4 },
      { kind: 'crdt_snapshot', doc: 'a', cursor: 5, revision: 'ra' },
      { kind: 'record', doc: 'b', cursor: 6 },
      { kind: 'crdt_snapshot', doc: 'b', cursor: 7, revision: 'rb' },
      { kind: 'record', doc: 'c', cursor: 8 },
      { kind: 'crdt_snapshot', doc: 'c', cursor: 9, revision: 'rc' }
    ]
    const createdAt = new Map([
      [5, 1_000],
      [7, 1_000],
      [9, 1_001]
    ])
    const index = new Map<number, Pack>()
    let watermark = 0
    for (const through of [5, 7, 10]) {
      const pack = buildPack(rows, 'crdt_snapshot', watermark, through)
      const key = createdAt.get(pack.entries[0]?.cursor ?? 0) ?? 0
      const held = index.get(key)
      // §8.10: instead of an insert that would do nothing, the colliding pack and the
      // new rows roll up into one (§8.12, old row deleted first).
      index.set(
        key,
        held
          ? { ...pack, coverFrom: held.coverFrom, entries: [...held.entries, ...pack.entries] }
          : pack
      )
      watermark = through
    }
    const read = bootstrap({
      packs: [buildPack(rows, 'record', 0, 10), ...index.values()],
      coverage: [
        { itemKind: 'record', packedThrough: 10, coveredThrough: 10 },
        { itemKind: 'crdt_snapshot', packedThrough: watermark, coveredThrough: watermark }
      ],
      rowsAtTail: rows,
      rowsAfterPack: rows
    })
    expect(read).toEqual(oracle(rows))
  })

  it('P7: a coverage entry of an unknown kind is skipped, not a failed listing', () => {
    const parsed = PackListResponseSchema.safeParse({
      packs: [],
      serverTime: 1,
      coverage: [
        { itemKind: 'record', packedThrough: 5, coveredThrough: 5 },
        { itemKind: 'attachment_chunk', packedThrough: 9, coveredThrough: 9 }
      ]
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.coverage).toEqual([
      { itemKind: 'record', packedThrough: 5, coveredThrough: 5 }
    ])
  })
})
