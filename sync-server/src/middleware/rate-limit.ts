/**
 * Rate Limiting Middleware
 *
 * Provides configurable rate limiting using D1 for persistence.
 * Uses sliding window algorithm with customizable limits per endpoint.
 *
 * @module middleware/rate-limit
 */

import { createMiddleware } from 'hono/factory'
import type { Env } from '../index'
import { RateLimitError } from '../lib/errors'

// =============================================================================
// Types
// =============================================================================

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum requests allowed */
  limit: number
  /** Time window in milliseconds */
  windowMs: number
  /** Key generator function */
  keyGenerator: (c: {
    req: { header: (name: string) => string | undefined }
    get: (key: string) => unknown
  }) => string
  /** Skip rate limiting based on condition */
  skip?: (c: { req: { header: (name: string) => string | undefined } }) => boolean
  /** Error message */
  message?: string
}

/**
 * Rate limit entry in D1
 */
interface RateLimitEntry {
  key: string
  count: number
  window_start: number
  expires_at: number
}

// =============================================================================
// Default Configurations
// =============================================================================

/**
 * Default rate limit configurations by endpoint type
 */
export const RATE_LIMITS = {
  /** Login attempts: 5 per 15 minutes */
  LOGIN: {
    limit: 5,
    windowMs: 15 * 60 * 1000,
    keyGenerator: (c: { req: { header: (name: string) => string | undefined } }) => {
      const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
      return `login:${ip}`
    },
    message: 'Too many login attempts. Please try again later.'
  },

  /** Signup: 3 per hour */
  SIGNUP: {
    limit: 3,
    windowMs: 60 * 60 * 1000,
    keyGenerator: (c: { req: { header: (name: string) => string | undefined } }) => {
      const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
      return `signup:${ip}`
    },
    message: 'Too many signup attempts. Please try again later.'
  },

  /** Email verification resend: 5 per hour */
  EMAIL_VERIFICATION: {
    limit: 5,
    windowMs: 60 * 60 * 1000,
    keyGenerator: (c: { req: { header: (name: string) => string | undefined } }) => {
      const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
      return `email_verify:${ip}`
    },
    message: 'Too many verification email requests. Please try again later.'
  },

  /** Password reset: 3 per hour */
  PASSWORD_RESET: {
    limit: 3,
    windowMs: 60 * 60 * 1000,
    keyGenerator: (c: { req: { header: (name: string) => string | undefined } }) => {
      const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
      return `password_reset:${ip}`
    },
    message: 'Too many password reset requests. Please try again later.'
  },

  /** Sync push: 100 per minute per user */
  SYNC_PUSH: {
    limit: 100,
    windowMs: 60 * 1000,
    keyGenerator: (c: { get: (key: string) => unknown }) => {
      const user = c.get('user') as { userId: string } | undefined
      return `sync_push:${user?.userId || 'unknown'}`
    },
    message: 'Too many sync requests. Please slow down.'
  },

  /** Sync pull: 60 per minute per user */
  SYNC_PULL: {
    limit: 60,
    windowMs: 60 * 1000,
    keyGenerator: (c: { get: (key: string) => unknown }) => {
      const user = c.get('user') as { userId: string } | undefined
      return `sync_pull:${user?.userId || 'unknown'}`
    },
    message: 'Too many sync requests. Please slow down.'
  },

  /** Device linking: 10 per hour */
  DEVICE_LINKING: {
    limit: 10,
    windowMs: 60 * 60 * 1000,
    keyGenerator: (c: { get: (key: string) => unknown }) => {
      const user = c.get('user') as { userId: string } | undefined
      return `device_linking:${user?.userId || 'unknown'}`
    },
    message: 'Too many device linking attempts. Please try again later.'
  },

  /** Linking status polling: 500 per 5 minutes per session (supports 2 devices at 2.5s for 10+ minutes) */
  LINKING_STATUS: {
    limit: 500,
    windowMs: 5 * 60 * 1000,
    keyGenerator: (c: { req: { param: (name: string) => string } }) => {
      const sessionId = c.req.param('session_id') || 'unknown'
      return `linking_status:${sessionId}`
    },
    message: 'Too many status requests for this linking session.'
  },

  /** Global API: 1000 per minute per IP */
  GLOBAL_API: {
    limit: 1000,
    windowMs: 60 * 1000,
    keyGenerator: (c: { req: { header: (name: string) => string | undefined } }) => {
      const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown'
      return `global:${ip}`
    },
    message: 'Too many requests. Please slow down.'
  }
} as const

// =============================================================================
// Rate Limit Functions
// =============================================================================

/**
 * Check and increment rate limit counter.
 *
 * @param db - D1 database
 * @param key - Rate limit key
 * @param config - Rate limit configuration
 * @returns Object with isLimited flag and remaining count
 */
export async function checkRateLimit(
  db: D1Database,
  key: string,
  config: { limit: number; windowMs: number }
): Promise<{ isLimited: boolean; remaining: number; resetAt: number }> {
  const now = Date.now()
  const windowStart = now - config.windowMs

  // Get current entry
  const entry = await db
    .prepare('SELECT key, count, window_start, expires_at FROM rate_limits WHERE key = ?')
    .bind(key)
    .first<RateLimitEntry>()

  if (!entry || entry.window_start < windowStart) {
    // No entry or window expired - create new entry
    await db
      .prepare(
        `INSERT OR REPLACE INTO rate_limits (key, count, window_start, expires_at)
         VALUES (?, 1, ?, ?)`
      )
      .bind(key, now, now + config.windowMs)
      .run()

    return {
      isLimited: false,
      remaining: config.limit - 1,
      resetAt: now + config.windowMs
    }
  }

  // Entry exists within window
  const newCount = entry.count + 1

  if (newCount > config.limit) {
    // Rate limited
    return {
      isLimited: true,
      remaining: 0,
      resetAt: entry.window_start + config.windowMs
    }
  }

  // Increment counter
  await db.prepare('UPDATE rate_limits SET count = ? WHERE key = ?').bind(newCount, key).run()

  return {
    isLimited: false,
    remaining: config.limit - newCount,
    resetAt: entry.window_start + config.windowMs
  }
}

/**
 * Clean up expired rate limit entries.
 *
 * Should be called periodically (e.g., via cron trigger).
 */
export async function cleanupExpiredRateLimits(db: D1Database): Promise<number> {
  const now = Date.now()

  const result = await db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now).run()

  return result.meta.changes || 0
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Create rate limiting middleware with custom configuration.
 *
 * @param config - Rate limit configuration
 * @returns Hono middleware
 */
export function rateLimit(config: RateLimitConfig) {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    // Check if rate limiting should be skipped
    if (config.skip?.(c)) {
      await next()
      return
    }

    const key = config.keyGenerator(c)
    const { isLimited, remaining, resetAt } = await checkRateLimit(c.env.DB, key, {
      limit: config.limit,
      windowMs: config.windowMs
    })

    // Set rate limit headers
    c.header('X-RateLimit-Limit', config.limit.toString())
    c.header('X-RateLimit-Remaining', remaining.toString())
    c.header('X-RateLimit-Reset', Math.ceil(resetAt / 1000).toString())

    if (isLimited) {
      const retryAfter = Math.ceil((resetAt - Date.now()) / 1000)
      c.header('Retry-After', retryAfter.toString())

      throw new RateLimitError(config.message || 'Too many requests', retryAfter)
    }

    await next()
  })
}

/**
 * Pre-configured rate limit middleware for common use cases.
 */
export const rateLimitMiddleware = {
  login: rateLimit(RATE_LIMITS.LOGIN),
  signup: rateLimit(RATE_LIMITS.SIGNUP),
  emailVerification: rateLimit(RATE_LIMITS.EMAIL_VERIFICATION),
  passwordReset: rateLimit(RATE_LIMITS.PASSWORD_RESET),
  syncPush: rateLimit(RATE_LIMITS.SYNC_PUSH),
  syncPull: rateLimit(RATE_LIMITS.SYNC_PULL),
  deviceLinking: rateLimit(RATE_LIMITS.DEVICE_LINKING),
  global: rateLimit(RATE_LIMITS.GLOBAL_API)
}
