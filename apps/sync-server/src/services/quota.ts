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
