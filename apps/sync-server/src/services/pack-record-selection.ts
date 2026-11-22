import { PACK_MAX_INDEX_ENTRY_BYTES } from '@memry/contracts/pack-format'

import { createLogger } from '../lib/logger'
import { EXPIRED_TOMBSTONE_SQL } from './expired-tombstone'
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
  /** Read for step 06 (#5229), which omits a row whose payload is lost. */
  blob_missing_at: number | null
}

/** A record candidate's meta and content hash, read from one row. */
type VaultScope = { userId: string; vaultId: string }

export interface RecordEntry {
  meta: PackEntryPlanMeta
  contentHash: string
}

/** Rows above the composite watermark, ascending, with every RecordRow column. */
export const recordSelectionQuery = (
  scope: VaultScope,
  watermark: { last_sort_value: number; last_sort_tiebreak: string },
  limit: number
): { sql: string; bind: unknown[] } => ({
  sql: `SELECT server_cursor AS sort_key, item_type || ':' || item_id AS tiebreak, item_type, item_id, blob_key, size_bytes,
          content_hash, crypto_version, operation, signer_device_id, signature, clock, deleted_at,
          blob_missing_at, updated_at AS row_time
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
 * conforming reader. Such a row is omitted and the range still spans it: the
 * reader's cursor-exact GET /sync/manifest reconcile pulls it (protocol 08
 * §8.10).
 */
export const recordEntryOf = (scope: VaultScope, row: RecordRow): RecordEntry | null => {
  const omit = (reason: string): null => {
    logger.warn('record row left out of packs', {
      userId: scope.userId,
      vaultId: scope.vaultId,
      id: row.tiebreak,
      reason
    })
    return null
  }
  if (row.blob_key === '') return omit('purged tombstone')
  if (!isSupportedRecordSyncItemType(row.item_type)) return omit('unknown type')
  if (!row.signer_device_id || !row.signature) return omit('missing signer metadata')
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
    return omit('corrupt clock')
  }
  const indexBytes = packIndexRecordBytes({ id: row.tiebreak, sourceKey: row.blob_key, meta })
  if (indexBytes > PACK_MAX_INDEX_ENTRY_BYTES) return omit('index entry too large')
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
 * True when a selected row whose payload 404'd is one the shed empties in
 * place at its cursor: already a marker (another blob key, `''`), or a
 * tombstone past retention whose blob the shed deleted before its D1 update
 * (cleanup.ts deletes R2 first). The caller abandons the range then. Any
 * other 404 stays a hole: a row a push replaced sits at a higher cursor, and
 * an unexpired tombstone or live row with a lost blob is omitted while the
 * range still spans it. The reader's cursor-exact manifest reconcile pulls
 * the omitted row (protocol 08 §8.10); the range does not end there.
 */
export const recordRowShedInPlace = async (
  db: D1Database,
  scope: VaultScope,
  missing: ReadonlyArray<{ id: string; sourceKey: string; sortKey: number }>
): Promise<boolean> => {
  if (missing.length === 0) return false
  // A record type never contains ':' (protocol 08 §8.4.2), so the first one
  // splits the identity.
  const pairs = missing.map((entry) => {
    const at = entry.id.indexOf(':')
    return [entry.id.slice(0, at), entry.id.slice(at + 1)]
  })
  const rows = await db
    .prepare(
      `SELECT si.item_type || ':' || si.item_id AS id, si.blob_key, si.server_cursor,
              (${EXPIRED_TOMBSTONE_SQL}) AS expired
       FROM sync_items si
       LEFT JOIN sync_entitlements e ON e.user_id = si.user_id
       WHERE si.user_id = ? AND si.vault_id = ?
         AND (si.item_type, si.item_id) IN
           (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`
    )
    .bind(Math.floor(Date.now() / 1000), scope.userId, scope.vaultId, JSON.stringify(pairs))
    .all<{ id: string; blob_key: string; server_cursor: number; expired: number }>()
  return (rows.results ?? []).some((row) => {
    const selected = missing.find((entry) => entry.id === row.id)
    return (
      selected !== undefined &&
      row.server_cursor === selected.sortKey &&
      (row.blob_key !== selected.sourceKey || Boolean(row.expired))
    )
  })
}
