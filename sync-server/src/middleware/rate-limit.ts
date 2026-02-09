import type { MiddlewareHandler } from 'hono'

import { AppError, ErrorCodes } from '../lib/errors'
import type { AppContext } from '../types'

export interface RateLimitOptions {
  maxRequests: number
  windowSeconds: number
  keyPrefix: string
}

export const createRateLimiter = (options: RateLimitOptions): MiddlewareHandler<AppContext> => {
  const { maxRequests, windowSeconds, keyPrefix } = options

  return async (c, next) => {
    const db = c.env.DB
    const identifier = c.get('userId') ?? c.req.header('CF-Connecting-IP') ?? 'unknown'
    const key = `${keyPrefix}:${identifier}`
    const now = Math.floor(Date.now() / 1000)
    const windowStart = now - windowSeconds

    await db
      .prepare('DELETE FROM rate_limits WHERE key = ? AND timestamp < ?')
      .bind(key, windowStart)
      .run()

    const result = await db
      .prepare('SELECT COUNT(*) as count FROM rate_limits WHERE key = ? AND timestamp >= ?')
      .bind(key, windowStart)
      .first<{ count: number }>()

    const count = result?.count ?? 0

    if (count >= maxRequests) {
      const oldestInWindow = await db
        .prepare('SELECT MIN(timestamp) as oldest FROM rate_limits WHERE key = ? AND timestamp >= ?')
        .bind(key, windowStart)
        .first<{ oldest: number }>()

      const retryAfter = oldestInWindow?.oldest
        ? oldestInWindow.oldest + windowSeconds - now
        : windowSeconds

      c.header('Retry-After', String(retryAfter))
      throw new AppError(ErrorCodes.RATE_LIMITED, 'Too many requests', 429)
    }

    await db
      .prepare('INSERT INTO rate_limits (key, timestamp) VALUES (?, ?)')
      .bind(key, now)
      .run()

    c.header('X-RateLimit-Limit', String(maxRequests))
    c.header('X-RateLimit-Remaining', String(maxRequests - count - 1))

    await next()
  }
}
