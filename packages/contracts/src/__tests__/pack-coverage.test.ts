/**
 * Chapter 08 §8.10 coverage: the `coverageCases` of `pack-container.json`
 * (where a reader's tail starts), the lenient `coverage` parse, and rule
 * models of §8.10 to §8.13 for the review probes.
 */
import { describe, expect, it } from 'vitest'

import {
  PACK_PURGE_DEADLINE_SECONDS,
  PACK_REPLACED_GRACE_SECONDS,
  PackCoverageSchema,
  PackListResponseSchema
} from '../sync-api'
import { loadVectorFile } from './vector-loader'

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

const vectors = loadVectorFile<{ coverageCases: CoverageCase[] }>('pack-container.json')

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

/**
 * Rule models for REVIEW-5254, REVIEW-5253 and VERIFY-5254. These are not
 * the chapter: each function below restates one chapter 08 §8.10 to §8.13 rule
 * as a writer, a server or a fresh reader over one small vault, and the probes
 * check that the rules together keep the zero-loss oracle: after the bootstrap the reader holds
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
  // A live row whose payload is lost (`blob_missing_at`, chapter 05 §5.12.4): a writer cannot pack it.
  lost?: boolean
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
    (r) =>
      r.kind === kind && r.cursor > coverFrom && r.cursor <= coverThrough && !r.marker && !r.lost
  )
  return { kind, coverFrom, coverThrough, entries }
}

/**
 * §8.10 writer over `(coverFrom, coverThrough]`: a needed row it cannot pack
 * (here, a lost payload) is in no range. The range before it ends below it, and
 * the next starts at its cursor, so a reader's chain stops there.
 */
function writeRanges(rows: Row[], kind: ProbeKind, coverFrom: number, coverThrough: number) {
  const packs: Pack[] = []
  let from = coverFrom
  for (const r of rows.filter((row) => row.kind === kind && row.lost)) {
    if (r.cursor <= from || r.cursor > coverThrough) continue
    packs.push(buildPack(rows, kind, from, r.cursor - 1))
    from = r.cursor
  }
  packs.push(buildPack(rows, kind, from, coverThrough))
  return packs
}

/**
 * §8.12 rollup commit: it inserts only if every input pack is still listed,
 * and keeps only entries whose row still exists at that cursor and is no marker.
 */
function commitRollup(index: Map<string, Pack>, inputs: string[], read: Pack[], rows: Row[]) {
  if (!inputs.every((id) => index.has(id))) return
  const entries = read
    .flatMap((p) => p.entries)
    .filter((e) =>
      rows.some((r) => r.kind === e.kind && r.doc === e.doc && r.cursor === e.cursor && !r.marker)
    )
  for (const id of inputs) index.delete(id)
  index.set(inputs.join('+'), {
    kind: read[0].kind,
    coverFrom: read[0].coverFrom,
    coverThrough: read[read.length - 1].coverThrough,
    entries
  })
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
    bodies,
    blobMissing: rows
      .filter((r) => r.kind === 'record' && r.lost)
      .map((r) => r.doc)
      .toSorted()
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
  const blobMissing: string[] = []
  const bodies = new Map<string, Row>()
  const take = (r: Row, fromPack: boolean) => {
    if (r.lost) {
      // `POST /sync/pull` reports it in `blobMissing`; the held row stays (chapter 05 §5.12.4).
      blobMissing.push(r.doc)
    } else if (r.kind === 'record') {
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
    ),
    blobMissing: blobMissing.toSorted()
  }
}

const PRESIGN_TTL_SECONDS = 300 // apps/sync-server/src/services/r2-presign.ts:27
const PACK_DELETE_SWEEP_SECONDS = 300 // §8.13: the sweep runs at most every 5 minutes

/**
 * §8.13 object deletion after a purge removed a pack's listing row at `removedAt`.
 * The queue message fires at the end of the grace period when it was sent. A
 * sweep every `PACK_DELETE_SWEEP_SECONDS`, at any phase, covers every recorded
 * deletion past its grace. A delete waits for the pack's rewrite only while the
 * next sweep is still inside the deadline; when the deadline forces it first,
 * the range is rebuilt from source rows. Past the deadline the server alerts.
 */
function deleteReplacedObject(input: {
  removedAt: number
  rewriteCommittedAt: number
  failingDeletes: number
  queueSent?: boolean
  sweepPhase?: number
}): { goneAt: number; relisted: 'rewrite' | 'rebuild'; alert: boolean } {
  let failures = input.failingDeletes
  const grace = input.removedAt + PACK_REPLACED_GRACE_SECONDS
  const deadline = input.removedAt + PACK_PURGE_DEADLINE_SECONDS
  const phase = input.sweepPhase ?? 0
  const firstSweep =
    grace +
    ((((phase - grace) % PACK_DELETE_SWEEP_SECONDS) + PACK_DELETE_SWEEP_SECONDS) %
      PACK_DELETE_SWEEP_SECONDS)
  const attempts = input.queueSent === false ? [] : [grace]
  for (let t = firstSweep; t < input.removedAt + 86_400; t += PACK_DELETE_SWEEP_SECONDS)
    attempts.push(t)
  for (const t of [...new Set(attempts)].toSorted((x, y) => x - y)) {
    const forced = t + PACK_DELETE_SWEEP_SECONDS > deadline
    if (input.rewriteCommittedAt > t && !forced) continue
    if (failures > 0) {
      failures -= 1
      continue
    }
    const relisted = input.rewriteCommittedAt <= t ? 'rewrite' : 'rebuild'
    return { goneAt: t, relisted, alert: t > deadline }
  }
  return { goneAt: Infinity, relisted: 'rebuild', alert: true }
}

describe('chapter 08 §8.10-§8.13 rule models (REVIEW-5254, REVIEW-5253, VERIFY-5254)', () => {
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
    expect(never).toEqual({
      goneAt: PACK_PURGE_DEADLINE_SECONDS,
      relisted: 'rebuild',
      alert: false
    })
  })

  it('P5: the sweep keeps the 900 s bound unless two delete attempts fail, then alerts', () => {
    const oneFailure = deleteReplacedObject({
      removedAt: 0,
      rewriteCommittedAt: 100,
      failingDeletes: 1
    })
    expect(oneFailure.goneAt).toBeLessThanOrEqual(PACK_PURGE_DEADLINE_SECONDS)
    for (const sweepPhase of [0, 137, 299]) {
      const lostMessage = deleteReplacedObject({
        removedAt: 0,
        rewriteCommittedAt: 100,
        failingDeletes: 0,
        queueSent: false,
        sweepPhase
      })
      expect(lostMessage.goneAt).toBeLessThanOrEqual(PACK_PURGE_DEADLINE_SECONDS)
    }
    const twoFailures = deleteReplacedObject({
      removedAt: 0,
      rewriteCommittedAt: 100,
      failingDeletes: 2
    })
    expect(twoFailures.goneAt).toBeGreaterThan(PACK_PURGE_DEADLINE_SECONDS)
    expect(twoFailures.alert).toBe(true)
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

  it('V1: a newer version whose payload is lost ends the range, so the reader learns of it', () => {
    const first: Row[] = [{ kind: 'record', doc: 'x', cursor: 10 }]
    const rows: Row[] = [
      { kind: 'record', doc: 'x', cursor: 50, lost: true },
      { kind: 'record', doc: 'y', cursor: 55 }
    ]
    const read = bootstrap({
      packs: [buildPack(first, 'record', 0, 20), ...writeRanges(rows, 'record', 20, 60)],
      coverage: [
        { itemKind: 'record', packedThrough: 60, coveredThrough: 60 },
        { itemKind: 'crdt_snapshot', packedThrough: 0, coveredThrough: 1e9 }
      ],
      rowsAtTail: rows,
      rowsAfterPack: rows
    })
    expect(read).toEqual(oracle(rows))
    expect(read.blobMissing).toEqual(['x'])
  })

  it('V2: a rollup that straddles a shed does not list the shed item again', () => {
    const before: Row[] = [
      { kind: 'record', doc: 'x', cursor: 5 },
      { kind: 'record', doc: 'y', cursor: 15 }
    ]
    const index = new Map([
      ['a', buildPack(before, 'record', 0, 10)],
      ['b', buildPack(before, 'record', 10, 20)]
    ])
    const inputs = ['a', 'b']
    const read = inputs.flatMap((id) => index.get(id) ?? [])
    // §8.13: x is deleted at 25, its record pack leaves the listing, and the shed follows.
    index.delete('a')
    const after: Row[] = [
      { kind: 'record', doc: 'x', cursor: 25, deleted: true, marker: true },
      before[1]
    ]
    commitRollup(index, inputs, read, after)
    const listed = [...index.values()].flatMap((p) => p.entries)
    expect(listed.filter((e) => e.doc === 'x')).toEqual([])
  })
})

describe('PackListResponseSchema coverage', () => {
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
