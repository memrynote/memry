import { AppError, ErrorCodes } from '../lib/errors'
import { assertPaidSyncAccess } from './entitlements'

export async function checkQuota(
  db: D1Database,
  userId: string,
  additionalBytes: number
): Promise<void> {
  const entitlement = await assertPaidSyncAccess(db, userId)

  if (entitlement.storage_used + additionalBytes > entitlement.storage_limit) {
    throw new AppError(ErrorCodes.STORAGE_QUOTA_EXCEEDED, 'Storage quota exceeded', 413)
  }
}

export async function reserveStorage(
  db: D1Database,
  userId: string,
  additionalBytes: number
): Promise<void> {
  if (additionalBytes <= 0) return

  const now = Math.floor(Date.now() / 1000)
  const result = await db
    .prepare(
      `UPDATE users
       SET storage_used = storage_used + ?, updated_at = ?
       WHERE id = ?
         AND storage_used + ? <= (
           SELECT COALESCE(e.storage_limit, 0)
           FROM sync_entitlements e
           WHERE e.user_id = users.id
             AND e.plan != 'free'
             AND e.status = 'active'
             AND (e.expires_at IS NULL OR e.expires_at > ?)
         )`
    )
    .bind(additionalBytes, now, userId, additionalBytes, now)
    .run()

  if ((result.meta.changes ?? 0) > 0) return

  await checkQuota(db, userId, additionalBytes)
  throw new AppError(ErrorCodes.STORAGE_QUOTA_EXCEEDED, 'Storage quota exceeded', 413)
}

export async function adjustStorageUsed(
  db: D1Database,
  userId: string,
  deltaBytes: number
): Promise<void> {
  if (deltaBytes > 0) {
    await reserveStorage(db, userId, deltaBytes)
    return
  }

  if (deltaBytes === 0) return

  await db
    .prepare(
      `UPDATE users SET storage_used = MAX(0, storage_used + ?), updated_at = ? WHERE id = ?`
    )
    .bind(deltaBytes, Math.floor(Date.now() / 1000), userId)
    .run()
}
