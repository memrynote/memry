import { PACK_MAX_ENTRIES } from '@memry/contracts/pack-format'
import type { CrdtUpdatePackEntryMeta } from '@memry/contracts/sync-api'

import type { PackKindName } from './pack-format'
import type { Coverage, VaultScope } from './pack-index-write'
import {
  recordEntryOf,
  recordSelectionQuery,
  type RecordEntry,
  type RecordRow
} from './pack-record-selection'
import { PACK_TARGET_BYTES, packFillReady } from './pack-sizing'
import { snapshotSelectionQuery } from './pack-snapshot-selection'
import { updateMetaOf, updateSelectionQuery, type UpdateRow } from './pack-update-selection'

/**
 * Pack selection (#1839): the rows above a kind's watermark that the next
 * build packs (pack-compaction.ts), and where the watermark moves after them.
 */
// Max items per pack build.
//
// SUBREQUEST ARITHMETIC (paid plan: 1000 subrequests per invocation):
//   N R2 GETs (one per item blob, N ≤ 256)
// + 1 R2 PUT  (the pack itself)
// + 5 D1 round trips (listing-cap check, watermark read, candidate select,
//   collision check, the listing batch). A range that collides with a listed
//   pack adds one R2 GET and one D1 read (its live entries), and a snapshot
//   tie it cannot roll in adds one D1 read (its free slot, snapshotSlot)
// + up to ⌈256/40⌉ = 7 D1 chunk reads loading snapshot freshness metadata
// => ~269 subrequests per full 256-item pack (~27% of the ceiling). A record
// pack reads its entry meta in the selection query itself, so it costs
// ~262. An update pack makes no R2 GET: its bytes come from D1 in ⌈24MB/4MB⌉
// reads, ~11. compactVault builds one pack per kind per queue message
// (max_batch_size 1), ~542 together with ~350 of rollups (compactVault), and a large vault drains across
// invocations: each push nudges one more pack per kind, and the cron backfill
// continues from the watermark.
// A full retry doubles safely. The free plan's 50-subrequest ceiling cannot fit ANY pack;
// compaction has always been a paid-plan background job by construction.
export const PACK_MAX_ITEMS = 256

// Items larger than this never enter packs (they stay item-granular tail):
// the largest legal record payload is ~7MB of JSON text (5MB decoded
// encryptedData inflated by base64 + envelope), and snapshots cap at 5MB.
// Excluding anything near that bound keeps one item from dominating a pack
// and keeps memory during the bounded-concurrency fetch predictable.
export const MAX_PACKED_ITEM_BYTES = 8 * 1024 * 1024

export interface WatermarkRow {
  last_sort_value: number
  last_sort_tiebreak: string
  /** cover_through of the kind's newest pack: the next pack's cover_from. NULL: cache only. */
  covered_through: number | null
}

export interface PackSelection {
  candidates: Array<{
    sortKey: number
    tiebreak: string
    id: string
    sourceKey: string
    sizeBytes: number
    /** Record entries: the pull-item meta and the content hash of the same D1 row. */
    record?: RecordEntry
    update?: CrdtUpdatePackEntryMeta
  }>
  /** Progress marker AFTER the last candidate (composite, exclusive). */
  nextSortValue: number
  nextTiebreak: string
  /** False while the window is below its minimum fill (pack-sizing.ts): build nothing, move nothing. */
  ready: boolean
  /** The next pack's coverage when it lists, or null for a cache-only pack. */
  coverage: Coverage
  /** The watermark this selection read: every write it commits is guarded on it (watermarkUnchanged). */
  watermark: WatermarkRow
}

/**
 * Read the composite progress marker for a scope+kind. Everything strictly
 * BELOW it (row-value comparison on (sort_value, tiebreak)) is already packed
 * or deliberately skipped; everything above is eligible.
 */
export const readWatermark = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName
): Promise<WatermarkRow> => {
  const row = await db
    .prepare(
      'SELECT last_sort_value, last_sort_tiebreak, covered_through FROM pack_watermarks WHERE user_id = ? AND vault_id = ? AND item_kind = ?'
    )
    .bind(scope.userId, scope.vaultId, kind)
    .first<WatermarkRow>()
  // A kind with no watermark has packed nothing, so its first range starts at 0.
  return (
    row ?? {
      last_sort_value: 0,
      last_sort_tiebreak: '',
      covered_through: kind === 'record' ? 0 : null
    }
  )
}

/**
 * Select up to PACK_MAX_ITEMS un-packed rows ordered ascending, capped so the
 * projected payload stays within PACK_TARGET_BYTES (itself far below
 * PACK_HARD_MAX_BYTES).
 *
 * Ordering keys: records use server_cursor (strictly monotonic per user, so
 * no ties), as do updates; snapshots use created_at epoch seconds, which TIE
 * heavily — the tiebreak column (note_id / type:id) makes progress exact via a
 * row-value comparison instead of skipping or looping on tie groups.
 */
export const selectCandidates = async (
  db: D1Database,
  scope: VaultScope,
  kind: PackKindName
): Promise<PackSelection> => {
  const watermark = await readWatermark(db, scope, kind)

  const query =
    kind === 'record'
      ? recordSelectionQuery(scope, watermark, PACK_MAX_ITEMS)
      : kind === 'crdt_update'
        ? updateSelectionQuery(scope, watermark, PACK_MAX_ENTRIES)
        : snapshotSelectionQuery(scope, watermark, PACK_MAX_ITEMS)

  const rows = await db
    .prepare(query.sql)
    .bind(...query.bind)
    .all<
      {
        sort_key: number
        tiebreak: string
        blob_key: string
        size_bytes: number
        row_time: number | null
      } & Partial<RecordRow> &
        Partial<UpdateRow>
    >()

  const candidates: PackSelection['candidates'] = []
  let bytes = 0
  let bytesFull = false
  for (const row of rowList(rows)) {
    if (row.size_bytes > MAX_PACKED_ITEM_BYTES) continue // oversized: permanent item-granular tail
    const record =
      kind === 'record'
        ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the record query selects every RecordRow column
          recordEntryOf(scope, row as typeof row & RecordRow)
        : undefined
    if (record === null) continue
    const update =
      kind === 'crdt_update'
        ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the update query selects every UpdateRow column
          updateMetaOf(row as typeof row & UpdateRow)
        : undefined
    if (bytes + row.size_bytes > PACK_TARGET_BYTES) {
      bytesFull = true
      break
    }
    bytes += row.size_bytes
    candidates.push({
      sortKey: row.sort_key,
      tiebreak: row.tiebreak,
      id: row.tiebreak,
      sourceKey: row.blob_key,
      sizeBytes: row.size_bytes,
      ...(record ? { record } : {}),
      ...(update ? { update } : {})
    })
  }

  const ready = packFillReady(rowList(rows), bytesFull, Math.floor(Date.now() / 1000))
  const last = candidates[candidates.length - 1]
  // A record range chains from the previous pack's cover_through, so rows a
  // window omitted fall inside the next range and record ranges tile (protocol
  // 08 §8.10). Body packs stay cache-only until step 07: snapshots still select
  // on created_at, not server_cursor.
  const coverage: Coverage =
    last && kind === 'record' && watermark.covered_through !== null
      ? { from: watermark.covered_through, through: last.sortKey }
      : null
  if (!last) {
    // Nothing selectable above the watermark. Only advance when the scan
    // actually saw rows (an all-oversized window must progress past itself);
    // an empty scan means "nothing to do" and the watermark must stay put —
    // writing 0 here would reset progress and force pointless re-scans.
    const scanned = rowList(rows)
    return {
      ready,
      coverage,
      watermark,
      candidates,
      nextSortValue: scanned.length > 0 ? maxScannedSortKey(scanned) : watermark.last_sort_value,
      nextTiebreak:
        scanned.length > 0
          ? maxScannedTiebreakAt(scanned, maxScannedSortKey(scanned))
          : watermark.last_sort_tiebreak
    }
  }
  return {
    ready,
    coverage,
    watermark,
    candidates,
    nextSortValue: last.sortKey,
    nextTiebreak: last.tiebreak
  }
}

const rowList = <T>(result: { results?: T[] }): T[] => result.results ?? []

const maxScannedSortKey = (rows: Array<{ sort_key: number }>): number =>
  rows.reduce((max, row) => Math.max(max, row.sort_key), 0)

const maxScannedTiebreakAt = (
  rows: Array<{ sort_key: number; tiebreak: string }>,
  sortKey: number
): string =>
  rows
    .filter((row) => row.sort_key === sortKey)
    .reduce((max, row) => (row.tiebreak > max ? row.tiebreak : max), '')
