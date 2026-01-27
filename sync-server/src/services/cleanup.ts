/**
 * T034a: OTP Cleanup Job
 * T034b: Linking Session Cleanup Job
 *
 * Scheduled cleanup jobs for expired data.
 */

import { cleanupRefreshTokens } from './auth'
import { cleanupRateLimits } from '../middleware/rate-limit'
import { cleanupOrphanedCrdtUpdates } from './crdt'

/**
 * OTP code expiry time (10 minutes).
 */
const OTP_EXPIRY_MS = 10 * 60 * 1000

/**
 * Linking session expiry time (5 minutes).
 */
const LINKING_SESSION_EXPIRY_MS = 5 * 60 * 1000

/**
 * T034a: Delete expired OTP codes.
 * OTP codes expire after 10 minutes.
 *
 * @param db - D1 database instance
 * @returns Number of deleted OTP codes
 */
export const cleanupExpiredOtpCodes = async (db: D1Database): Promise<number> => {
  const now = Date.now()

  const result = await db
    .prepare(
      `
      DELETE FROM otp_codes
      WHERE expires_at < ?
    `
    )
    .bind(now)
    .run()

  return result.meta.changes ?? 0
}

/**
 * T034b: Delete expired linking sessions.
 * Linking sessions expire after 5 minutes unless completed.
 * Valid statuses: 'pending', 'scanned', 'approved', 'completed', 'expired'
 *
 * @param db - D1 database instance
 * @returns Number of deleted linking sessions
 */
export const cleanupExpiredLinkingSessions = async (db: D1Database): Promise<number> => {
  const now = Date.now()

  // Delete expired sessions that haven't completed
  // Completed sessions are cleaned up separately after audit retention period
  const result = await db
    .prepare(
      `
      DELETE FROM linking_sessions
      WHERE expires_at < ? AND status != 'completed'
    `
    )
    .bind(now)
    .run()

  return result.meta.changes ?? 0
}

/**
 * Delete old completed linking sessions.
 * Completed sessions are kept for 24 hours for audit purposes.
 *
 * @param db - D1 database instance
 * @returns Number of deleted sessions
 */
export const cleanupCompletedLinkingSessions = async (db: D1Database): Promise<number> => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000 // 24 hours ago

  const result = await db
    .prepare(
      `
      DELETE FROM linking_sessions
      WHERE status = 'completed' AND created_at < ?
    `
    )
    .bind(cutoff)
    .run()

  return result.meta.changes ?? 0
}

/**
 * Delete old used OTP codes.
 * Used codes are kept for 1 hour for audit purposes.
 *
 * @param db - D1 database instance
 * @returns Number of deleted codes
 */
export const cleanupUsedOtpCodes = async (db: D1Database): Promise<number> => {
  const cutoff = Date.now() - 60 * 60 * 1000 // 1 hour ago

  // Schema uses 'used' INTEGER flag, not 'used_at' timestamp
  // We use created_at as proxy for when it was used (within OTP lifetime)
  const result = await db
    .prepare(
      `
      DELETE FROM otp_codes
      WHERE used = 1 AND created_at < ?
    `
    )
    .bind(cutoff)
    .run()

  return result.meta.changes ?? 0
}

/**
 * Cleanup result summary.
 */
export interface CleanupResult {
  otpCodes: number
  usedOtpCodes: number
  linkingSessions: number
  completedLinkingSessions: number
  refreshTokens: number
  rateLimits: number
  crdtUpdates: number
  totalCleaned: number
  durationMs: number
}

/**
 * Run all cleanup jobs.
 * Called by the scheduled worker trigger.
 *
 * @param db - D1 database instance
 * @returns Summary of cleanup results
 */
export const runCleanupJobs = async (db: D1Database): Promise<CleanupResult> => {
  const startTime = Date.now()

  // Run cleanup jobs in parallel for efficiency
  const [
    otpCodes,
    usedOtpCodes,
    linkingSessions,
    completedLinkingSessions,
    refreshTokens,
    rateLimits,
    crdtUpdates
  ] = await Promise.all([
    cleanupExpiredOtpCodes(db),
    cleanupUsedOtpCodes(db),
    cleanupExpiredLinkingSessions(db),
    cleanupCompletedLinkingSessions(db),
    cleanupRefreshTokens(db),
    cleanupRateLimits(db),
    cleanupOrphanedCrdtUpdates(db)
  ])

  const durationMs = Date.now() - startTime
  const totalCleaned =
    otpCodes +
    usedOtpCodes +
    linkingSessions +
    completedLinkingSessions +
    refreshTokens +
    rateLimits +
    crdtUpdates

  return {
    otpCodes,
    usedOtpCodes,
    linkingSessions,
    completedLinkingSessions,
    refreshTokens,
    rateLimits,
    crdtUpdates,
    totalCleaned,
    durationMs
  }
}

/**
 * Log cleanup results (for monitoring).
 *
 * @param result - Cleanup result to log
 */
export const logCleanupResult = (result: CleanupResult): void => {
  console.log(
    `[Cleanup] Completed in ${result.durationMs}ms: ` +
      `${result.totalCleaned} records removed ` +
      `(OTP: ${result.otpCodes + result.usedOtpCodes}, ` +
      `Sessions: ${result.linkingSessions + result.completedLinkingSessions}, ` +
      `Tokens: ${result.refreshTokens}, ` +
      `RateLimits: ${result.rateLimits}, ` +
      `CRDT: ${result.crdtUpdates})`
  )
}
