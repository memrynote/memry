/**
 * T032: Rate Limiting Middleware
 *
 * Provides rate limiting using D1 for persistence across worker restarts.
 * Implements sliding window rate limiting.
 */

import type { Context, MiddlewareHandler } from 'hono'
import { rateLimited } from '../lib/errors'

/**
 * Rate limit configuration for different operation types.
 */
export const RATE_LIMITS = {
  otp_request: { requests: 3, windowMs: 10 * 60 * 1000 }, // 3 per 10 min
  otp_verify: { attempts: 5 }, // 5 attempts per code (tracked separately)
  token_refresh: { requests: 30, windowMs: 60 * 1000 }, // 30 per min
  sync_push: { requests: 100, windowMs: 60 * 1000 }, // 100 per min
  sync_pull: { requests: 200, windowMs: 60 * 1000 }, // 200 per min
  blob_upload: { requests: 50, windowMs: 60 * 1000 }, // 50 per min
  default: { requests: 1000, windowMs: 60 * 1000 }, // 1000 per min
} as const

export type RateLimitType = keyof typeof RATE_LIMITS

/**
 * Environment type expected for rate limiting.
 */
interface RateLimitEnv {
  DB: D1Database
}

/**
 * Rate limit entry stored in D1.
 */
interface RateLimitEntry {
  key: string
  count: number
  window_start: number
}

/**
 * Check and update rate limit for a key.
 * Returns remaining requests and reset time.
 *
 * @param db - D1 database
 * @param key - Rate limit key (e.g., "otp_request:email@example.com")
 * @param limit - Request limit
 * @param windowMs - Window duration in milliseconds
 * @returns Object with allowed status, remaining count, and reset time
 */
export const checkRateLimit = async (
  db: D1Database,
  key: string,
  limit: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> => {
  const now = Date.now()
  const windowStart = now - windowMs

  try {
    // Get or create rate limit entry
    const existing = await db
      .prepare(`SELECT count, window_start FROM rate_limits WHERE key = ?`)
      .bind(key)
      .first<RateLimitEntry>()

    if (!existing || existing.window_start < windowStart) {
      // No entry or window expired - create new entry
      const id = crypto.randomUUID()
      await db
        .prepare(
          `
          INSERT INTO rate_limits (id, key, count, window_start)
          VALUES (?, ?, 1, ?)
          ON CONFLICT (key) DO UPDATE SET count = 1, window_start = ?
        `
        )
        .bind(id, key, now, now)
        .run()

      return {
        allowed: true,
        remaining: limit - 1,
        resetAt: now + windowMs,
      }
    }

    // Window still active
    if (existing.count >= limit) {
      // Rate limit exceeded
      const resetAt = existing.window_start + windowMs
      return {
        allowed: false,
        remaining: 0,
        resetAt,
      }
    }

    // Increment count
    await db
      .prepare(`UPDATE rate_limits SET count = count + 1 WHERE key = ?`)
      .bind(key)
      .run()

    return {
      allowed: true,
      remaining: limit - existing.count - 1,
      resetAt: existing.window_start + windowMs,
    }
  } catch {
    // On error, allow the request (fail open for availability)
    // Log would go here in production
    return {
      allowed: true,
      remaining: limit,
      resetAt: now + windowMs,
    }
  }
}

/**
 * Create rate limiting middleware for a specific operation type.
 *
 * @param limitType - The type of rate limit to apply
 * @param keyExtractor - Function to extract the rate limit key from context
 * @returns Hono middleware handler
 */
export const rateLimitMiddleware = <E extends { Bindings: RateLimitEnv }>(
  limitType: RateLimitType,
  keyExtractor: (c: Context<E>) => string
): MiddlewareHandler<E> => {
  const config = RATE_LIMITS[limitType]

  // otp_verify uses attempts instead of requests
  if (!('requests' in config)) {
    throw new Error(`Rate limit type ${limitType} does not support request limiting`)
  }

  const { requests: limit, windowMs } = config

  return async (c, next) => {
    const key = `${limitType}:${keyExtractor(c)}`
    const result = await checkRateLimit(c.env.DB, key, limit, windowMs)

    // Set rate limit headers
    c.header('X-RateLimit-Limit', String(limit))
    c.header('X-RateLimit-Remaining', String(result.remaining))
    c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)))

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetAt - Date.now()) / 1000)
      c.header('Retry-After', String(retryAfter))
      throw rateLimited(retryAfter)
    }

    await next()
  }
}

/**
 * Track OTP verification attempts.
 * OTP verification has a different model - fixed attempts per code, not per window.
 *
 * @param db - D1 database
 * @param otpId - OTP code identifier
 * @returns Current attempt count
 */
export const incrementOtpAttempts = async (
  db: D1Database,
  otpId: string
): Promise<{ attempts: number; maxExceeded: boolean }> => {
  const maxAttempts = RATE_LIMITS.otp_verify.attempts
  const key = `otp_verify:${otpId}`

  try {
    // Get current attempts
    const existing = await db
      .prepare(`SELECT count FROM rate_limits WHERE key = ?`)
      .bind(key)
      .first<{ count: number }>()

    const currentAttempts = existing?.count ?? 0

    if (currentAttempts >= maxAttempts) {
      return { attempts: currentAttempts, maxExceeded: true }
    }

    // Increment attempts
    const id = crypto.randomUUID()
    await db
      .prepare(
        `
        INSERT INTO rate_limits (id, key, count, window_start)
        VALUES (?, ?, 1, ?)
        ON CONFLICT (key) DO UPDATE SET count = count + 1
      `
      )
      .bind(id, key, Date.now())
      .run()

    return { attempts: currentAttempts + 1, maxExceeded: currentAttempts + 1 >= maxAttempts }
  } catch {
    // On error, allow the attempt (fail open)
    return { attempts: 0, maxExceeded: false }
  }
}

/**
 * Clear OTP verification attempts (on successful verification).
 *
 * @param db - D1 database
 * @param otpId - OTP code identifier
 */
export const clearOtpAttempts = async (db: D1Database, otpId: string): Promise<void> => {
  const key = `otp_verify:${otpId}`
  await db.prepare(`DELETE FROM rate_limits WHERE key = ?`).bind(key).run()
}

/**
 * Clean up expired rate limit entries.
 * Should be run periodically (e.g., via cron).
 *
 * @param db - D1 database
 * @returns Number of deleted entries
 */
export const cleanupRateLimits = async (db: D1Database): Promise<number> => {
  // Delete entries older than the longest window (10 minutes for otp_request)
  const cutoff = Date.now() - 10 * 60 * 1000

  const result = await db
    .prepare(`DELETE FROM rate_limits WHERE window_start < ?`)
    .bind(cutoff)
    .run()

  return result.meta.changes ?? 0
}
