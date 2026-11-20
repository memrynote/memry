import type { PackEntryMeta } from './pack-format'
import { BODY_ROW_DEAD } from './pack-update-selection'

/**
 * The `crdt_snapshot` half of pack selection (#1839, protocol 08 §8.4): which
 * `crdt_snapshots` rows become entries, their freshness meta, and the
 * commit-time recheck against a racing purge (protocol 07 §7.15).
 */

type VaultScope = { userId: string; vaultId: string }

/**
 * A deleted note keeps its snapshot row, and a packed body lands on a fresh
 * device before the tombstone that deletes it. A note id with any live note or
 * journal row still packs, as does one whose record has not arrived yet. Dead
 * rows stay in the scan so the watermark moves past a tail of them, as it does
 * past oversized rows.
 */
export const snapshotSelectionQuery = (
  scope: VaultScope,
  watermark: { last_sort_value: number; last_sort_tiebreak: string },
  limit: number
): { sql: string; bind: unknown[] } => ({
  sql: `SELECT created_at AS sort_key, note_id AS tiebreak, note_id, blob_key, size_bytes,
          ${BODY_ROW_DEAD} AS dead
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
 * True while every packed entry's snapshot row still exists with the packed
 * blob and its note is not dead. Entries ride as one JSON bind, clear of D1's
 * 100-bind limit.
 */
export const snapshotsCurrent = (
  scope: VaultScope,
  entries: ReadonlyArray<{ id: string; sourceKey: string }>
): { sql: string; bind: unknown[] } => ({
  sql: `(SELECT COUNT(*) FROM json_each(?) e JOIN crdt_snapshots s
          ON s.user_id = ? AND s.vault_id = ?
            AND s.note_id = json_extract(e.value, '$[0]') AND s.blob_key = json_extract(e.value, '$[1]')
          WHERE NOT ${BODY_ROW_DEAD}) = ?`,
  bind: [
    JSON.stringify(entries.map((entry) => [entry.id, entry.sourceKey])),
    scope.userId,
    scope.vaultId,
    entries.length
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
