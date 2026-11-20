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
 * The last `note_id` of the snapshot rows written in `second`: the watermark
 * tiebreak that leaves a whole tie group behind (pack-compaction.ts).
 */
export const snapshotTieEnd = async (
  db: D1Database,
  scope: VaultScope,
  second: number
): Promise<string | null> =>
  (
    await db
      .prepare(
        'SELECT MAX(note_id) AS t FROM crdt_snapshots WHERE user_id = ? AND vault_id = ? AND created_at = ?'
      )
      .bind(scope.userId, scope.vaultId, second)
      .first<{ t: string | null }>()
  )?.t ?? null

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
