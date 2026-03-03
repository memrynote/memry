import { AppError, ErrorCodes } from '../lib/errors'

export interface StorageBreakdown {
  used: number
  limit: number
  breakdown: {
    notes: number
    attachments: number
    crdt: number
    other: number
  }
}

export async function getStorageBreakdown(
  db: D1Database,
  userId: string
): Promise<StorageBreakdown> {
  const [user, categories, crdtResult] = await Promise.all([
    db
      .prepare('SELECT storage_used, storage_limit FROM users WHERE id = ?')
      .bind(userId)
      .first<{ storage_used: number; storage_limit: number }>(),

    db
      .prepare(
        'SELECT item_type, SUM(size_bytes) as total_bytes FROM sync_items WHERE user_id = ? AND deleted_at IS NULL GROUP BY item_type'
      )
      .bind(userId)
      .all<{ item_type: string; total_bytes: number }>(),

    db
      .prepare(
        'SELECT COALESCE(SUM(size_bytes), 0) as total_bytes FROM crdt_snapshots WHERE user_id = ?'
      )
      .bind(userId)
      .first<{ total_bytes: number }>()
  ])

  if (!user) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'User not found', 404)
  }

  const breakdown = { notes: 0, attachments: 0, crdt: crdtResult?.total_bytes ?? 0, other: 0 }

  for (const row of categories.results ?? []) {
    switch (row.item_type) {
      case 'note':
      case 'journal':
        breakdown.notes += row.total_bytes
        break
      case 'attachment':
        breakdown.attachments += row.total_bytes
        break
      default:
        breakdown.other += row.total_bytes
    }
  }

  return { used: user.storage_used, limit: user.storage_limit, breakdown }
}
