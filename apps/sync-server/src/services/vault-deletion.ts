import { deleteByPrefix } from './blob'
import { getUploadedByteTotal, readUploadedChunks } from './upload-size'
import { createLogger } from '../lib/logger'

const logger = createLogger('VaultDeletion')

/**
 * True if this user owns this vault. Callers 404 on false — a cross-user
 * delete must be indistinguishable from a missing vault so ownership never
 * leaks.
 */
export async function vaultExistsForUser(
  db: D1Database,
  userId: string,
  vaultId: string
): Promise<boolean> {
  const row = await db
    .prepare('SELECT vault_id FROM sync_vaults WHERE user_id = ? AND vault_id = ?')
    .bind(userId, vaultId)
    .first<{ vault_id: string }>()
  return row !== null
}

interface OpenUploadSessionRow {
  total_size: number
  uploaded_chunks: string
}

/**
 * Open upload sessions reserved their full `total_size` upfront at initiate
 * (blob.ts), before any chunk landed. Landed chunks are already persisted as
 * `blob_chunks` rows and thus already counted by the blob_chunks sum above,
 * so only the *unlanded* remainder of an open session is still an
 * outstanding charge: `total_size - landed`.
 *
 * If `uploaded_chunks` won't parse, the reservation is still real regardless
 * of whether we can read the chunk list — fall back to releasing the full
 * `total_size` (matching abort/expiry-sweep behavior in blob.ts /
 * cleanup.ts), not zero, so we never under-release.
 *
 * A corrupt column must never abort the deletion: that would strand the
 * reservation and leave the user unable to delete their vault at all. It is
 * logged rather than swallowed, because we are about to delete the row that
 * carries the evidence.
 */
async function sumOpenUploadSessionBytes(
  db: D1Database,
  userId: string,
  vaultId: string
): Promise<number> {
  const result = await db
    .prepare(
      'SELECT total_size, uploaded_chunks FROM upload_sessions WHERE user_id = ? AND vault_id = ?'
    )
    .bind(userId, vaultId)
    .all<OpenUploadSessionRow>()

  let total = 0
  for (const session of result.results ?? []) {
    const read = readUploadedChunks(session.uploaded_chunks)
    if (!read.ok) {
      logger.error('upload session uploaded_chunks is corrupt; releasing full reservation', {
        userId,
        vaultId,
        reason: read.reason,
        totalSize: session.total_size
      })
    }
    const landed = getUploadedByteTotal(read.entries)
    total += landed === null ? session.total_size : session.total_size - landed
  }
  return total
}

async function sumVaultBytes(db: D1Database, userId: string, vaultId: string): Promise<number> {
  const sumQueries = [
    'SELECT COALESCE(SUM(size_bytes), 0) as total FROM sync_items WHERE user_id = ? AND vault_id = ?',
    'SELECT COALESCE(SUM(size_bytes), 0) as total FROM crdt_snapshots WHERE user_id = ? AND vault_id = ?',
    'SELECT COALESCE(SUM(LENGTH(update_data)), 0) as total FROM crdt_updates WHERE user_id = ? AND vault_id = ?',
    'SELECT COALESCE(SUM(size_bytes), 0) as total FROM blob_chunks WHERE user_id = ? AND vault_id = ?'
  ]

  const [sums, sessionBytes] = await Promise.all([
    Promise.all(
      sumQueries.map((sql) => db.prepare(sql).bind(userId, vaultId).first<{ total: number }>())
    ),
    sumOpenUploadSessionBytes(db, userId, vaultId)
  ])

  return sums.reduce((total, row) => total + (row?.total ?? 0), 0) + sessionBytes
}

/**
 * Irreversibly purge one vault's server data: R2 payloads, every vault-scoped
 * D1 row, and the storage the vault was charged for.
 *
 * `sync_vaults` has no children by foreign key — every vault-scoped table
 * carries a loose `vault_id TEXT` and FKs only to `users(id)`. Nothing
 * cascades; each table is deleted explicitly.
 *
 * `server_cursor_sequence` is deliberately absent: it is per-user and shared
 * across vaults, so deleting it would corrupt other vaults' cursors.
 *
 * R2 is purged before the D1 batch so a mid-flight failure leaves retryable
 * rows pointing at missing blobs rather than orphaned, unreachable objects.
 *
 * Known residue: attachment manifests are charged via `reserveStorage` at
 * upload-complete (blob.ts) but live only in R2 as opaque JSON — there is no
 * D1 size column for them, so no SQL sum here can see their bytes. They are
 * NOT reclaimed on vault delete. Accepted limitation; manifests are KB-scale.
 */
export async function deleteVaultData(
  db: D1Database,
  bucket: R2Bucket,
  userId: string,
  vaultId: string
): Promise<void> {
  const bytes = await sumVaultBytes(db, userId, vaultId)

  await deleteByPrefix(bucket, `${userId}/vaults/${vaultId}/`, userId)

  const now = Math.floor(Date.now() / 1000)
  const scoped = (sql: string) => db.prepare(sql).bind(userId, vaultId)

  await db.batch([
    scoped('DELETE FROM crdt_updates WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM crdt_snapshots WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM upload_sessions WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM blob_chunks WHERE user_id = ? AND vault_id = ?'),
    // Bootstrap sessions are vault-scoped claims on elevated throughput
    // (#1837); the vault going away revokes them. The signed tokens also die
    // on their own TTL — this is hygiene, plus the immediate cap release.
    scoped('DELETE FROM bootstrap_sessions WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM device_sync_state WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM sync_items WHERE user_id = ? AND vault_id = ?'),
    // Pack bookkeeping (#1839). The pack OBJECTS die with the R2 prefix purge
    // above (pack keys live under the vault prefix); these rows are the D1
    // shadow. Packs are derived cache and never quota-counted, so no storage
    // adjustment accompanies this.
    scoped('DELETE FROM pack_index WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM pack_watermarks WHERE user_id = ? AND vault_id = ?'),
    scoped('UPDATE devices SET vault_id = NULL WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM sync_vaults WHERE user_id = ? AND vault_id = ?'),
    // Inlined rather than calling adjustStorageUsed(): that helper runs its own
    // statement, which would land outside this batch's atomicity.
    db
      .prepare(
        'UPDATE users SET storage_used = MAX(0, storage_used + ?), updated_at = ? WHERE id = ?'
      )
      .bind(-bytes, now, userId)
  ])
}
