import { PACK_LIST_MAX_PACKS_PER_VAULT } from '@memry/contracts/sync-api'

import type { PackEntryMeta } from './pack-format'

/**
 * The `crdt_snapshot` half of pack selection (#1839, protocol 08 §8.4): which
 * `crdt_snapshots` rows become entries, their freshness meta, and the
 * commit-time recheck against a racing purge (protocol 07 §7.15).
 */

type VaultScope = { userId: string; vaultId: string }

/**
 * Every snapshot row packs, a deleted document's included, while the row
 * exists (protocol 08 §8.10): the purge removes the row and drops the packs
 * that may hold it (protocol 07 §7.15).
 */
export const snapshotSelectionQuery = (
  scope: VaultScope,
  watermark: { last_sort_value: number; last_sort_tiebreak: string },
  limit: number
): { sql: string; bind: unknown[] } => ({
  sql: `SELECT created_at AS sort_key, note_id AS tiebreak, note_id, blob_key, size_bytes,
          created_at AS row_time
        FROM crdt_snapshots s
        WHERE user_id = ? AND vault_id = ?
          AND (created_at > ? OR (created_at = ? AND note_id > ?))
        ORDER BY created_at ASC, note_id ASC
        LIMIT ?`,
  bind: [
    scope.userId,
    scope.vaultId,
    watermark.last_sort_value,
    watermark.last_sort_value,
    watermark.last_sort_tiebreak,
    limit
  ]
})

/**
 * Where a snapshot pack whose first row was written in `second` can list
 * (D-TIE-REMAINDER, #5310). `min_cursor` is unique per kind, so a second that
 * already starts a listed pack (a tie group larger than one pack, or a
 * remainder left below the watermark) takes the highest free `min_cursor`
 * below it. A snapshot pack is a cache and readers never read `minCursor`, so
 * it only has to bound the entries. Such a pack holds that one second, so it
 * starts inside no other pack's range but the ones at seconds it skipped;
 * a pack at its own second holds rows up to the next listed pack's second.
 * Of the 1,000 values at or below `second`, at most 999 start a pack (§8.14).
 */
export const snapshotSlot = async (
  db: D1Database,
  scope: VaultScope,
  second: number
): Promise<{ minCursor: number; lastSecond: number }> => {
  const rows = await db
    .prepare(
      `SELECT min_cursor FROM pack_index
       WHERE user_id = ? AND vault_id = ? AND item_kind = 'crdt_snapshot' AND min_cursor >= ?
       ORDER BY min_cursor ASC`
    )
    .bind(scope.userId, scope.vaultId, second - PACK_LIST_MAX_PACKS_PER_VAULT)
    .all<{ min_cursor: number }>()
  const mins = (rows.results ?? []).map((row) => row.min_cursor)
  const taken = new Set(mins)
  let minCursor = second
  while (taken.has(minCursor)) minCursor--
  if (minCursor < 0) throw new Error(`no free snapshot min_cursor at or below ${second}`)
  const next = mins.find((min) => min > second)
  return {
    minCursor,
    lastSecond: minCursor < second ? second : (next ?? Number.MAX_SAFE_INTEGER)
  }
}

/** The document ids a vault's listed snapshot packs hold; binds user_id, vault_id. */
export const packedSnapshotIds = `SELECT d.value FROM pack_index p, json_each(p.documents) d
  WHERE p.user_id = ? AND p.vault_id = ? AND p.item_kind = 'crdt_snapshot'`

/**
 * The packed entries whose snapshot row still exists with the packed blob: a
 * `FROM` clause for `allLive` and the rollup. A deleted document's row counts
 * while it exists (protocol 08 §8.12).
 * Entries ride as one JSON bind, clear of D1's 100-bind limit. CROSS JOIN
 * keeps `json_each` the outer loop, one index probe per entry: SQLite otherwise
 * scans the vault's rows and every entry inside, about 13 s at 10k rows (#5230).
 */
export const snapshotsLive = (
  scope: VaultScope,
  entries: ReadonlyArray<{ id: string; sourceKey: string }>
): { sql: string; bind: unknown[] } => ({
  sql: `FROM json_each(?) e CROSS JOIN crdt_snapshots s
          ON s.user_id = ? AND s.vault_id = ?
            AND s.note_id = json_extract(e.value, '$[0]') AND s.blob_key = json_extract(e.value, '$[1]')`,
  bind: [
    JSON.stringify(entries.map((entry) => [entry.id, entry.sourceKey])),
    scope.userId,
    scope.vaultId
  ]
})

export const loadSnapshotMeta = async (
  db: D1Database,
  scope: VaultScope,
  sourceKeys: string[]
): Promise<Map<string, PackEntryMeta>> => {
  const meta = new Map<string, PackEntryMeta>()
  // 95-bind split mirrors sync.ts/crdt.ts: user_id + vault_id ride along, and
  // blob keys are long — keep chunks comfortably under the D1 100-bind ceiling.
  const CHUNK = 40
  for (let i = 0; i < sourceKeys.length; i += CHUNK) {
    const chunk = sourceKeys.slice(i, i + CHUNK)
    const rows = await db
      .prepare(
        `SELECT blob_key, sequence_num, revision FROM crdt_snapshots
         WHERE user_id = ? AND vault_id = ? AND blob_key IN (${chunk.map(() => '?').join(', ')})`
      )
      .bind(scope.userId, scope.vaultId, ...chunk)
      .all<{ blob_key: string; sequence_num: number; revision: string }>()
    for (const row of rows.results ?? []) {
      meta.set(row.blob_key, { sequenceNum: row.sequence_num, revision: row.revision })
    }
  }
  return meta
}

/**
 * Up to `limit` snapshot rows at or below the watermark that no listed pack
 * holds, by `pack_index.documents` (migration 0024), oldest first: a tie
 * remainder an older build passed (#5310), or a same-second write that sorted
 * below the watermark. Oversized rows are left out as a build leaves them out.
 * Nothing is selected while a snapshot pack predates 0024, whose membership
 * D1 does not know.
 */
export const snapshotRemainderQuery = (
  scope: VaultScope,
  watermark: { last_sort_value: number; last_sort_tiebreak: string },
  maxItemBytes: number,
  limit: number
): { sql: string; bind: unknown[] } => ({
  sql: `SELECT created_at AS sort_key, note_id AS tiebreak, blob_key, size_bytes
        FROM crdt_snapshots s
        WHERE user_id = ? AND vault_id = ?
          AND (created_at < ? OR (created_at = ? AND note_id <= ?))
          AND size_bytes <= ?
          AND note_id NOT IN (${packedSnapshotIds})
          AND NOT EXISTS (SELECT 1 FROM pack_index WHERE user_id = ? AND vault_id = ?
            AND item_kind = 'crdt_snapshot' AND documents IS NULL)
        ORDER BY created_at ASC, note_id ASC
        LIMIT ?`,
  bind: [
    scope.userId,
    scope.vaultId,
    watermark.last_sort_value,
    watermark.last_sort_value,
    watermark.last_sort_tiebreak,
    maxItemBytes,
    scope.userId,
    scope.vaultId,
    scope.userId,
    scope.vaultId,
    limit
  ]
})
