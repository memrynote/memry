import { deleteByPrefix } from './blob'

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

async function sumVaultBytes(db: D1Database, userId: string, vaultId: string): Promise<number> {
  const queries = [
    'SELECT COALESCE(SUM(size_bytes), 0) as total FROM sync_items WHERE user_id = ? AND vault_id = ?',
    'SELECT COALESCE(SUM(size_bytes), 0) as total FROM crdt_snapshots WHERE user_id = ? AND vault_id = ?',
    'SELECT COALESCE(SUM(LENGTH(update_data)), 0) as total FROM crdt_updates WHERE user_id = ? AND vault_id = ?',
    'SELECT COALESCE(SUM(size_bytes), 0) as total FROM blob_chunks WHERE user_id = ? AND vault_id = ?'
  ]

  let total = 0
  for (const sql of queries) {
    const row = await db.prepare(sql).bind(userId, vaultId).first<{ total: number }>()
    total += row?.total ?? 0
  }
  return total
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
    scoped('DELETE FROM device_sync_state WHERE user_id = ? AND vault_id = ?'),
    scoped('DELETE FROM sync_items WHERE user_id = ? AND vault_id = ?'),
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
