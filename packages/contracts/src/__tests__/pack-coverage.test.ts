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
 * every live record at its current version (or knows its payload is lost),
 * every tombstone that still has a payload, and each live document's current
 * body, exactly as the server does. Each probe failed under
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
  // Live rows only: a tombstone whose payload is lost is a marker (sync.ts:470-479).
  lost?: boolean
  // An index entry above PACK_MAX_INDEX_ENTRY_BYTES: the item routes serve it, packs never do.
  oversize?: boolean
  // `sync_items.version` of a record; 1 when absent.
  version?: number
  // The R2 key the row points at, for the 404 recheck.
  key?: string
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
      r.kind === kind &&
      r.cursor > coverFrom &&
      r.cursor <= coverThrough &&
      !r.marker &&
      !r.lost &&
      !r.oversize
  )
  return { kind, coverFrom, coverThrough, entries }
}

/**
 * §8.10 writer over `(coverFrom, coverThrough]`. A record row it cannot pack is
 * omitted and the range spans it, so record ranges tile. A body row it cannot
 * pack (a lost snapshot) is in no range: the range before it ends below it and
 * the next starts at its cursor, a gap one cursor wide.
 */
function writeRanges(rows: Row[], kind: ProbeKind, coverFrom: number, coverThrough: number) {
  if (kind === 'record') return [buildPack(rows, kind, coverFrom, coverThrough)]
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
 * §8.10 lost body row: a selected row whose object answers 404 is lost only
 * while the row still points at the key it was read with. A row that moved or
 * is gone is not needed at that cursor.
 */
function readForBuild(selected: Row[], objects: Set<string>, current: Row[]): Row[] {
  return selected.flatMap((r) => {
    if (r.key === undefined || objects.has(r.key)) return [r]
    const now = current.find((c) => c.kind === r.kind && c.doc === r.doc)
    return now?.key === r.key ? [{ ...r, lost: true }] : []
  })
}

/** §8.10 Bridging a body gap: adjacent ranges merge once the gap holds no needed row. */
function bridgeGaps(packs: Pack[], current: Row[]): Pack[] {
  const out: Pack[] = []
  for (const p of packs.toSorted((a, b) => a.coverFrom - b.coverFrom)) {
    const prev = out.at(-1)
    const needed = (r: Row) =>
      prev !== undefined &&
      r.kind === p.kind &&
      r.cursor > prev.coverThrough &&
      r.cursor <= p.coverFrom
    if (prev && prev.coverThrough < p.coverFrom && !current.some(needed)) {
      out[out.length - 1] = {
        ...prev,
        coverThrough: p.coverThrough,
        entries: [...prev.entries, ...p.entries]
      }
    } else out.push(p)
  }
  return out
}

const FEED_PAGE_ROWS = 500 // MAX_CHANGES_LIMIT, apps/sync-server/src/services/sync.ts:41

/**
 * §8.10 SHOULD: read the feed across each gap `(a, b]` of a kind, from `a`
 * until `nextCursor` reaches `b`, then treat the gap as usable. Returns the
 * feed pages that costs and the packs with each gap filled.
 */
function readAcrossGaps(packs: Pack[]) {
  let pages = 0
  const filled: Pack[] = []
  for (const kind of ['record', 'crdt_snapshot'] as const) {
    let end = 0
    for (const p of packs
      .filter((q) => q.kind === kind)
      .toSorted((a, b) => a.coverFrom - b.coverFrom)) {
      if (p.coverFrom > end) {
        pages += Math.ceil((p.coverFrom - end) / FEED_PAGE_ROWS)
        filled.push({ kind, coverFrom: end, coverThrough: p.coverFrom, entries: [] })
      }
      end = Math.max(end, p.coverThrough)
    }
  }
  return { pages, packs: [...packs, ...filled] }
}

type ProbeCoverage = Array<{ itemKind: ProbeKind; packedThrough: number; coveredThrough: number }>

/** §8.10 tail start for a reader that declares `note_body`; updates are fully covered here. */
function tailOf(packs: Pack[], coverage: ProbeCoverage): number {
  return tailFrom({
    scenario: '',
    noteBody: true,
    coverage: [...coverage, { itemKind: 'crdt_update', packedThrough: 0, coveredThrough: 1e9 }],
    packs: packs.map((p) => ({
      itemKind: p.kind,
      coverFrom: p.coverFrom,
      coverThrough: p.coverThrough,
      usable: true
    })),
    unusableRecordSortKeys: [],
    tailFrom: 0
  })
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
    live: rows
      .filter((r) => r.kind === 'record' && !r.deleted && !r.lost)
      .map((r) => `${r.doc}@${r.version ?? 1}`)
      .toSorted(),
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
 * §8.10 tail start, then the feed above it, then the version-exact record
 * reconcile against `GET /sync/manifest` (live records with their `version`,
 * `deleted_at IS NULL`) and the body check against `snapshotMeta`, both read
 * after the pack bytes. Every id the reconcile pulls lands in `pulls`.
 */
function bootstrap(input: {
  packs: Pack[]
  coverage: ProbeCoverage
  rowsAtTail: Row[]
  rowsAfterPack: Row[]
  localModified?: string[]
  pulls?: string[]
}) {
  const tail = tailOf(input.packs, input.coverage)
  const records = new Map<string, Row & { fromPack: boolean }>()
  const blobMissing = new Set<string>()
  const bodies = new Map<string, Row>()
  const take = (r: Row, fromPack: boolean) => {
    if (r.lost) {
      // `POST /sync/pull` reports it in `blobMissing`; the held row stays (chapter 05 §5.12.4).
      blobMissing.add(r.doc)
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
  const manifest = input.rowsAfterPack.filter((r) => r.kind === 'record' && !r.deleted)
  for (const [doc, r] of records)
    if (
      r.fromPack &&
      !r.deleted &&
      !manifest.some((m) => m.doc === doc) &&
      !input.localModified?.includes(doc)
    )
      records.delete(doc)
  for (const item of manifest) {
    const held = records.get(item.doc)
    if (held && !held.deleted && (held.version ?? 1) === (item.version ?? 1)) continue
    input.pulls?.push(item.doc)
    if (item.lost) blobMissing.add(item.doc)
    else records.set(item.doc, { ...item, fromPack: false })
  }
  const held = [...records.values()].filter((r) => !r.deleted)
  const live = new Set(held.map((r) => r.doc))
  return {
    live: held
      .filter((r) => !blobMissing.has(r.doc))
      .map((r) => `${r.doc}@${r.version ?? 1}`)
      .toSorted(),
    tombstones: [...records.values()]
      .filter((r) => r.deleted)
      .map((r) => r.doc)
      .toSorted(),
    bodies: Object.fromEntries(
      [...bodies.values()].filter((r) => live.has(r.doc)).map((r) => [r.doc, r.revision ?? ''])
    ),
    blobMissing: [...blobMissing].toSorted()
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
    expect(bootstrap({ ...input, localModified: ['x'] }).live).toEqual(['x@1', 'y@1'])
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

  it('V1: record ranges tile over an omitted X v2, and the version-exact reconcile pulls it', () => {
    const first: Row[] = [{ kind: 'record', doc: 'x', cursor: 10, version: 1 }]
    // X v2 at 50 cannot be packed: its payload is lost, or its index entry is too large.
    for (const unpackable of [{ lost: true }, { oversize: true }]) {
      const rows: Row[] = [
        { kind: 'record', doc: 'x', cursor: 50, version: 2, ...unpackable },
        { kind: 'record', doc: 'y', cursor: 55 }
      ]
      const packs = [buildPack(first, 'record', 0, 20), ...writeRanges(rows, 'record', 20, 60)]
      const coverage: ProbeCoverage = [
        { itemKind: 'record', packedThrough: 60, coveredThrough: 60 },
        { itemKind: 'crdt_snapshot', packedThrough: 0, coveredThrough: 1e9 }
      ]
      expect(tailOf(packs, coverage)).toBe(60)
      const pulls: string[] = []
      const read = bootstrap({ packs, coverage, rowsAtTail: rows, rowsAfterPack: rows, pulls })
      expect(pulls).toEqual(['x'])
      expect(read).toEqual(oracle(rows))
    }
  })

  it('R1: a lost record row keeps the tail at the top, and a body gap costs one feed page', () => {
    const top = 20_000
    const rows: Row[] = [
      { kind: 'record', doc: 'x', cursor: 50, lost: true },
      { kind: 'crdt_snapshot', doc: 'y', cursor: 60, key: 'k-y', lost: true },
      { kind: 'record', doc: 'y', cursor: top }
    ]
    const coverage: ProbeCoverage = [
      { itemKind: 'record', packedThrough: top, coveredThrough: top },
      { itemKind: 'crdt_snapshot', packedThrough: top, coveredThrough: top }
    ]
    const records = writeRanges(rows, 'record', 0, top)
    const snapshots = writeRanges(rows, 'crdt_snapshot', 0, top)
    // Records: the lost row is omitted, not a gap.
    expect(tailOf([...records, ...bridgeGaps(snapshots, [])], coverage)).toBe(top)
    // Bodies: a MUST-only reader starts the tail at the gap, about 40 pages.
    const mustOnly = tailOf([...records, ...snapshots], coverage)
    expect(mustOnly).toBe(59)
    expect(Math.ceil((top - mustOnly) / FEED_PAGE_ROWS)).toBe(40)
    // The SHOULD: read the feed across the one-cursor gap, one page, then tail from the top.
    const across = readAcrossGaps([...records, ...snapshots])
    expect(across.pages).toBe(1)
    expect(tailOf(across.packs, coverage)).toBe(top)
  })

  it('R2: a 404 on a replaced snapshot is no gap, and a gap whose row moved is bridged', () => {
    const range = (p: Pack) => [p.coverFrom, p.coverThrough]
    // The writer selected a@50 under k1; a concurrent write moved it to 70 under k2 and deleted k1.
    const selected: Row[] = [
      { kind: 'crdt_snapshot', doc: 'a', cursor: 50, key: 'k1', revision: 'r1' }
    ]
    const current: Row[] = [
      { kind: 'record', doc: 'a', cursor: 5 },
      { kind: 'crdt_snapshot', doc: 'a', cursor: 70, key: 'k2', revision: 'r2' }
    ]
    const replaced = readForBuild(selected, new Set(['k2']), current)
    expect(writeRanges(replaced, 'crdt_snapshot', 0, 60).map(range)).toEqual([[0, 60]])
    // A real loss at 50 leaves a gap. It stays while the row is there, and the run after
    // the write that moved it bridges it.
    const gapped = writeRanges(readForBuild(selected, new Set(), selected), 'crdt_snapshot', 0, 60)
    expect(gapped.map(range)).toEqual([
      [0, 49],
      [50, 60]
    ])
    expect(bridgeGaps(gapped, selected).map(range)).toEqual(gapped.map(range))
    const bridged = bridgeGaps(gapped, current)
    expect(bridged.map(range)).toEqual([[0, 60]])
    const packs = [
      buildPack(current, 'record', 0, 80),
      ...bridged,
      buildPack(current, 'crdt_snapshot', 60, 80)
    ]
    const coverage: ProbeCoverage = [
      { itemKind: 'record', packedThrough: 80, coveredThrough: 80 },
      { itemKind: 'crdt_snapshot', packedThrough: 80, coveredThrough: 80 }
    ]
    expect(tailOf(packs, coverage)).toBe(80)
    const read = bootstrap({ packs, coverage, rowsAtTail: current, rowsAfterPack: current })
    expect(read).toEqual(oracle(current))
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
