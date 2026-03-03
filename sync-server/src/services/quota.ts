import { AppError, ErrorCodes } from '../lib/errors'

export async function checkQuota(
  db: D1Database,
  userId: string,
  additionalBytes: number
): Promise<void> {
  const user = await db
    .prepare('SELECT storage_used, storage_limit FROM users WHERE id = ?')
    .bind(userId)
    .first<{ storage_used: number; storage_limit: number }>()

  if (!user) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'User not found', 404)
  }

  if (user.storage_used + additionalBytes > user.storage_limit) {
    throw new AppError(ErrorCodes.STORAGE_QUOTA_EXCEEDED, 'Storage quota exceeded', 413)
  }
}
