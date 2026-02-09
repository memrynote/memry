export const cleanupExpiredOtpCodes = async (db: D1Database): Promise<number> => {
  const result = await db
    .prepare('DELETE FROM otp_codes WHERE expires_at < ?')
    .bind(new Date().toISOString())
    .run()
  return result.meta.changes ?? 0
}

export const cleanupExpiredLinkingSessions = async (db: D1Database): Promise<number> => {
  const result = await db
    .prepare('DELETE FROM device_linking_sessions WHERE expires_at < ?')
    .bind(new Date().toISOString())
    .run()
  return result.meta.changes ?? 0
}

export const cleanupExpiredUploadSessions = async (db: D1Database): Promise<number> => {
  const result = await db
    .prepare('DELETE FROM upload_sessions WHERE expires_at < ?')
    .bind(new Date().toISOString())
    .run()
  return result.meta.changes ?? 0
}
