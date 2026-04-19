export const cleanupExpiredOtpCodes = async (db: D1Database): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)
  const result = await db.prepare('DELETE FROM otp_codes WHERE expires_at < ?').bind(now).run()
  return result.meta.changes ?? 0
}

export const cleanupExpiredLinkingSessions = async (db: D1Database): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)
  const result = await db
    .prepare('DELETE FROM linking_sessions WHERE expires_at < ?')
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}

export const cleanupExpiredUploadSessions = async (
  db: D1Database,
  storage: R2Bucket
): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)

  const stale = await db
    .prepare('SELECT id, r2_upload_id, r2_key FROM upload_sessions WHERE expires_at < ?')
    .bind(now)
    .all<{ id: string; r2_upload_id: string; r2_key: string }>()

  for (const session of stale.results ?? []) {
    if (session.r2_upload_id && session.r2_key) {
      try {
        await storage.resumeMultipartUpload(session.r2_key, session.r2_upload_id).abort()
      } catch {
        // Multipart upload may already be completed or expired
      }
    }
  }

  const result = await db
    .prepare('DELETE FROM upload_sessions WHERE expires_at < ?')
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}

export const cleanupConsumedSetupTokens = async (db: D1Database): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)
  const result = await db
    .prepare('DELETE FROM consumed_setup_tokens WHERE expires_at < ?')
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}

export const cleanupExpiredGoogleCalendarChannels = async (db: D1Database): Promise<number> => {
  const now = Math.floor(Date.now() / 1000)
  const result = await db
    .prepare('DELETE FROM google_calendar_channels WHERE expires_at < ?')
    .bind(now)
    .run()
  return result.meta.changes ?? 0
}

export const cleanupStaleRateLimits = async (db: D1Database): Promise<number> => {
  const oneHourAgo = Math.floor(Date.now() / 1000) - 3600
  const result = await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(oneHourAgo)
    .run()
  return result.meta.changes ?? 0
}

const TOMBSTONE_RETENTION_SECONDS = 90 * 24 * 60 * 60
const CLEANUP_BATCH_SIZE = 1000

export const cleanupExpiredTombstones = async (
  db: D1Database,
  storage: R2Bucket
): Promise<number> => {
  const cutoff = Math.floor(Date.now() / 1000) - TOMBSTONE_RETENTION_SECONDS

  const expired = await db
    .prepare(
      `SELECT id, blob_key FROM sync_items WHERE deleted_at IS NOT NULL AND deleted_at < ? LIMIT ${CLEANUP_BATCH_SIZE}`
    )
    .bind(cutoff)
    .all<{ id: string; blob_key: string }>()

  const rows = expired.results ?? []
  if (rows.length === 0) return 0

  for (const row of rows) {
    try {
      await storage.delete(row.blob_key)
    } catch {
      // R2 delete may fail if blob already removed; proceed with D1 cleanup
    }
  }

  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(',')
  const result = await db
    .prepare(`DELETE FROM sync_items WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run()

  return result.meta.changes ?? 0
}

export const cleanupOrphanedBlobChunks = async (
  db: D1Database,
  storage: R2Bucket
): Promise<number> => {
  const orphaned = await db
    .prepare(`SELECT id, r2_key FROM blob_chunks WHERE ref_count <= 0 LIMIT ${CLEANUP_BATCH_SIZE}`)
    .all<{ id: string; r2_key: string }>()

  const rows = orphaned.results ?? []
  if (rows.length === 0) return 0

  for (const row of rows) {
    try {
      await storage.delete(row.r2_key)
    } catch {
      // R2 delete may fail if blob already removed; proceed with D1 cleanup
    }
  }

  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => '?').join(',')
  const result = await db
    .prepare(`DELETE FROM blob_chunks WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run()

  return result.meta.changes ?? 0
}
