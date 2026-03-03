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
    const identifier =
      c.get('userId') ??
      c.req.header('CF-Connecting-IP') ??
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      'unknown'
    const key = `${keyPrefix}:${identifier}`
    const now = Math.floor(Date.now() / 1000)
    const windowStart = now - windowSeconds

    const result = await db.batch([
      db
        .prepare(
          `INSERT INTO rate_limits (key, count, window_start)
         VALUES (?, 1, ?)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN window_start < ? THEN 1 ELSE count + 1 END,
           window_start = CASE WHEN window_start < ? THEN ? ELSE window_start END`
        )
        .bind(key, now, windowStart, windowStart, now),
      db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key)
    ])

    const row = (result[1] as D1Result).results?.[0] as
      | { count: number; window_start: number }
      | undefined
    const count = row?.count ?? 0

    if (count > maxRequests) {
      const retryAfter = row ? row.window_start + windowSeconds - now : windowSeconds
      c.header('Retry-After', String(Math.max(retryAfter, 1)))
      throw new AppError(ErrorCodes.RATE_LIMITED, 'Too many requests', 429)
    }

    c.header('X-RateLimit-Limit', String(maxRequests))
    c.header('X-RateLimit-Remaining', String(Math.max(maxRequests - count, 0)))

    await next()
  }
}
