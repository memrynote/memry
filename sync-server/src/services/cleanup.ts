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
    .prepare('SELECT id, upload_id, key FROM upload_sessions WHERE expires_at < ?')
    .bind(now)
    .all<{ id: string; upload_id: string; key: string }>()

  for (const session of stale.results ?? []) {
    if (session.upload_id && session.key) {
      try {
        await storage.resumeMultipartUpload(session.key, session.upload_id).abort()
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

export const cleanupStaleRateLimits = async (db: D1Database): Promise<number> => {
  const oneHourAgo = Math.floor(Date.now() / 1000) - 3600
  const result = await db
    .prepare('DELETE FROM rate_limits WHERE window_start < ?')
    .bind(oneHourAgo)
    .run()
  return result.meta.changes ?? 0
}
