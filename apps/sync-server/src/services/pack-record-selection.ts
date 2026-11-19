import { PACK_MAX_INDEX_ENTRY_BYTES } from '@memry/contracts/pack-format'

import { createLogger } from '../lib/logger'
import { packIndexRecordBytes, packSha256, type PackEntryPlanMeta } from './pack-format'
import { isSupportedRecordSyncItemType, recordMetaFromColumns } from './sync'

const logger = createLogger('PackRecordSelection')

/**
 * The `record` half of pack selection (#5227, protocol 08 §8.4.2): which
 * `sync_items` rows become entries, their meta, and the checks that keep an
 * entry's meta and payload on one version.
 */

export interface RecordRow {
  tiebreak: string
  item_type: string
  item_id: string
  blob_key: string
  content_hash: string
  crypto_version: number
  operation: string
  signer_device_id: string | null
  signature: string | null
  clock: string | null
  deleted_at: number | null
}

/** A record candidate's meta and content hash, read from one row. */
export interface RecordEntry {
  meta: PackEntryPlanMeta
  contentHash: string
}

/** Rows above the composite watermark, ascending, with every RecordRow column. */
export const recordSelectionQuery = (
  scope: { userId: string; vaultId: string },
  watermark: { last_sort_value: number; last_sort_tiebreak: string },
  limit: number
): { sql: string; bind: unknown[] } => ({
  sql: `SELECT server_cursor AS sort_key, item_type || ':' || item_id AS tiebreak, item_type, item_id, blob_key, size_bytes,
          content_hash, crypto_version, operation, signer_device_id, signature, clock, deleted_at
        FROM sync_items
        WHERE user_id = ? AND vault_id = ?
          AND (server_cursor > ? OR (server_cursor = ? AND (item_type || ':' || item_id) > ?))
        ORDER BY server_cursor ASC, tiebreak ASC
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
 * The entry for one row, or null when the row cannot be an entry: `POST
 * /sync/pull` would not serve it as an item either (protocol 08 §8.4.2). A
 * purged tombstone has no payload (`blob_key` ''), an unknown type is never
 * pulled, a row without signer metadata or with a corrupt clock fails the
 * pull, and an index entry above PACK_MAX_INDEX_ENTRY_BYTES fails every
 * conforming reader. Such a row is invisible to a reader that tails from a
 * pack's maxCursor; the reader reconciles against GET /sync/manifest (#5254).
 */
export const recordEntryOf = (row: RecordRow): RecordEntry | null => {
  if (row.blob_key === '' || !isSupportedRecordSyncItemType(row.item_type)) return null
  if (!row.signer_device_id || !row.signature) return null
  let meta: PackEntryPlanMeta
  try {
    meta = recordMetaFromColumns({
      id: row.item_id,
      type: row.item_type,
      operation: row.operation,
      cryptoVersion: row.crypto_version,
      signature: row.signature,
      signerDeviceId: row.signer_device_id,
      deletedAt: row.deleted_at,
      clock: row.clock
    })
  } catch {
    logger.warn('record row has a corrupt clock; left out of packs', { itemType: row.item_type })
    return null
  }
  const indexBytes = packIndexRecordBytes({ id: row.tiebreak, sourceKey: row.blob_key, meta })
  if (indexBytes > PACK_MAX_INDEX_ENTRY_BYTES) return null
  return { meta, contentHash: row.content_hash }
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * True when `bytes` are the payload of the row the entry's meta came from:
 * the push stores exactly the bytes it hashed into content_hash.
 */
export const isSelectedRecordVersion = async (
  bytes: Uint8Array,
  entry: RecordEntry
): Promise<boolean> => toHex(await packSha256(bytes)) === entry.contentHash

/**
 * True when a selected row whose payload 404'd still sits at its selected
 * cursor under another blob key: the tombstone shed (cleanup.ts) emptied it
 * in place. Leaving a hole there would move the watermark past a row whose
 * cursor never moves, so the caller abandons the range instead. A row that
 * moved to a higher cursor was replaced by a push, and the tail serves it.
 */
export const recordRowChangedInPlace = async (
  db: D1Database,
  scope: { userId: string; vaultId: string },
  missing: ReadonlyArray<{ id: string; sourceKey: string; sortKey: number }>
): Promise<boolean> => {
  if (missing.length === 0) return false
  const rows = await db
    .prepare(
      `SELECT item_type || ':' || item_id AS id, blob_key, server_cursor FROM sync_items
       WHERE user_id = ? AND vault_id = ?
         AND item_type || ':' || item_id IN (SELECT value FROM json_each(?))`
    )
    .bind(scope.userId, scope.vaultId, JSON.stringify(missing.map((entry) => entry.id)))
    .all<{ id: string; blob_key: string; server_cursor: number }>()
  return (rows.results ?? []).some((row) => {
    const selected = missing.find((entry) => entry.id === row.id)
    return (
      selected !== undefined &&
      row.server_cursor === selected.sortKey &&
      row.blob_key !== selected.sourceKey
    )
  })
}
