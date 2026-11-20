import type { CrdtUpdatePackEntryMeta } from '@memry/contracts/sync-api'

import type { PackEntryPlan } from './pack-format'

/**
 * The `crdt_update` half of pack selection (#5228, protocol 08 §8.4.3): which
 * `crdt_updates` rows become entries, their meta, how their bytes are read
 * from D1, and the commit-time recheck against a racing purge.
 *
 * An update has no R2 object: its packed envelope is `update_data`, so a build
 * reads D1 and costs no R2 GET per entry. Rows pruned behind a snapshot (#2299)
 * or purged with their document (protocol 07 §7.15) no longer exist, so the
 * scan never selects them. A NULL `server_cursor` (a row written before
 * migration 0011) never matches `server_cursor > ?` and stays on the routes.
 */

type VaultScope = { userId: string; vaultId: string }

const NOTE_RECORD_ROWS = `SELECT 1 FROM sync_items r
  WHERE r.user_id = s.user_id AND r.vault_id = s.vault_id
    AND r.item_type IN ('note', 'journal') AND r.item_id = s.note_id`

/**
 * True for a body row (aliased `s`) whose document has a deleted note or
 * journal record and no live one. Shared by both body kinds.
 */
export const BODY_ROW_DEAD = `(EXISTS (${NOTE_RECORD_ROWS} AND r.deleted_at IS NOT NULL)
  AND NOT EXISTS (${NOTE_RECORD_ROWS} AND r.deleted_at IS NULL))`

/**
 * Update rows above the watermark, ascending `server_cursor`. Within one
 * document that is ascending `sequence_num` (protocol 07 §7.17). The cursor is
 * unique per user, so the scan is a bare `server_cursor > ?` that rides the
 * partial (user_id, vault_id, server_cursor) index from 0011 with no sort;
 * `note_id` comes back as the tiebreak only to name the entry.
 */
export const updateSelectionQuery = (
  scope: VaultScope,
  watermark: { last_sort_value: number; last_sort_tiebreak: string },
  limit: number
): { sql: string; bind: unknown[] } => ({
  sql: `SELECT server_cursor AS sort_key, note_id AS tiebreak, '' AS blob_key,
          length(update_data) AS size_bytes, sequence_num, signer_device_id, created_at,
          ${BODY_ROW_DEAD} AS dead
        FROM crdt_updates s
        WHERE user_id = ? AND vault_id = ? AND server_cursor > ?
        ORDER BY server_cursor ASC
        LIMIT ?`,
  bind: [scope.userId, scope.vaultId, watermark.last_sort_value, limit]
})

/**
 * Minimum fill (#5228, protocol 08 §8.14): an update pack is built only once
 * the vault holds UPDATE_PACK_MIN_ROWS unpacked update rows, or its oldest
 * unpacked row is UPDATE_PACK_MAX_WAIT_SECONDS old. Without it every push
 * would list one tiny pack, and the vault would pass the listing cap.
 */
export const UPDATE_PACK_MIN_ROWS = 256
export const UPDATE_PACK_MAX_WAIT_SECONDS = 24 * 60 * 60

export const updateFillReady = (
  scanned: ReadonlyArray<{ created_at?: number }>,
  nowSeconds: number
): boolean =>
  scanned.length >= UPDATE_PACK_MIN_ROWS ||
  scanned.some(
    (row) =>
      row.created_at !== undefined && row.created_at <= nowSeconds - UPDATE_PACK_MAX_WAIT_SECONDS
  )

export interface UpdateRow {
  sequence_num: number
  signer_device_id: string
  created_at: number
}

/** The entry meta of one update row: the route's update entry minus `data`. */
export const updateMetaOf = (row: UpdateRow): CrdtUpdatePackEntryMeta => ({
  sequenceNum: row.sequence_num,
  signerDeviceId: row.signer_device_id,
  createdAt: row.created_at
})

/**
 * How compaction reads entry bytes: plans grouped into windows, and one read
 * per window that answers, per plan, a thunk for its bytes or null for a hole.
 */
export interface EntrySource {
  windows: PackEntryPlan[][]
  read: (window: PackEntryPlan[]) => Promise<Array<(() => Promise<Uint8Array>) | null>>
}

// Update bytes one D1 read returns. Keeps each response a few MB while the
// pack buffer (at most PACK_TARGET_BYTES) is the one large allocation.
export const UPDATE_READ_BYTES = 4 * 1024 * 1024

/**
 * Reads update bytes by `server_cursor`, windows bounded by UPDATE_READ_BYTES.
 * A row gone since selection (pruned or purged) is a hole.
 */
export const updateEntrySource = (
  db: D1Database,
  scope: VaultScope,
  plans: PackEntryPlan[]
): EntrySource => {
  const windows: PackEntryPlan[][] = []
  let bytes = 0
  for (const plan of plans) {
    const current = windows[windows.length - 1]
    if (!current || bytes + plan.sizeBytes > UPDATE_READ_BYTES) {
      windows.push([plan])
      bytes = plan.sizeBytes
    } else {
      current.push(plan)
      bytes += plan.sizeBytes
    }
  }
  return {
    windows,
    read: async (window) => {
      const rows = await db
        .prepare(
          `SELECT server_cursor, update_data FROM crdt_updates
           WHERE user_id = ? AND vault_id = ? AND server_cursor IN (SELECT value FROM json_each(?))`
        )
        .bind(scope.userId, scope.vaultId, JSON.stringify(window.map((plan) => plan.sortKey)))
        .all<{ server_cursor: number; update_data: ArrayBuffer }>()
      const byCursor = new Map(
        (rows.results ?? []).map((row) => [row.server_cursor, new Uint8Array(row.update_data)])
      )
      return window.map((plan) => {
        const data = byCursor.get(plan.sortKey)
        return data ? async () => data : null
      })
    }
  }
}

/**
 * Commit-time recheck (protocol 07 §7.15): true while every packed update row
 * still exists and its document is not dead. A purge that committed after
 * selection deleted the rows, so the pack is discarded rather than listed with
 * a deleted body. A prune (#2299) fails it too; the next run reselects without
 * the pruned rows. Cursors ride as one JSON bind, clear of D1's bind limit.
 */
export const updatesCurrent = (
  scope: VaultScope,
  entries: ReadonlyArray<{ sortKey: number }>
): { sql: string; bind: unknown[] } => ({
  sql: `(SELECT COUNT(*) FROM json_each(?) e JOIN crdt_updates s
          ON s.user_id = ? AND s.vault_id = ? AND s.server_cursor = e.value
          WHERE NOT ${BODY_ROW_DEAD}) = ?`,
  bind: [
    JSON.stringify(entries.map((entry) => entry.sortKey)),
    scope.userId,
    scope.vaultId,
    entries.length
  ]
})
