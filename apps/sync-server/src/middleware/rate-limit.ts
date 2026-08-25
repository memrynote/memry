import type { Context, MiddlewareHandler } from 'hono'

import type { ConsumeResponse } from '../durable-objects/rate-limiter'
import { AppError, ErrorCodes } from '../lib/errors'
import type { AppContext } from '../types'

// The static shape of a bucket, as seen by the elevation seam. `keyPrefix` is
// the bucket's stable name — elevation implementations key off it.
export interface RateLimitBucket {
  maxRequests: number
  windowSeconds: number
  keyPrefix: string
}

/**
 * P1.2 seam — bootstrap-session elevation (#1828 Phase 1).
 *
 * The middleware asks this hook for a ceiling multiplier before comparing the
 * window count against the bucket's `maxRequests`. Returning `null` means "no
 * elevation, use the bucket ceiling as-is"; returning a multiplier > 1 widens
 * the effective ceiling to `ceil(maxRequests * multiplier)` for this request
 * only. Nothing else in the middleware needs to change for P1.2: a bootstrap
 * session implementation plugs in via `RateLimitOptions.getElevatedLimits`
 * (per bucket) and decides from request context (e.g. a validated bootstrap
 * session on the Hono context) whether this request deserves a wider window.
 */
export type GetElevatedLimits = (
  c: Context<AppContext>,
  bucket: RateLimitBucket
) => Promise<number | null> | number | null

// Default elevation: none. P1.2 replaces this per bucket via
// `RateLimitOptions.getElevatedLimits`.
export const noElevation: GetElevatedLimits = () => null

export interface RateLimitOptions extends RateLimitBucket {
  // Optional per-request identity. Lets a route key its bucket by something
  // other than userId/IP (e.g. a request's sessionId). Falls back to the
  // userId/IP chain when it returns null/undefined. Used by the linking routes,
  // which are unauthenticated — keying by IP collapses every local device
  // profile (and devices behind one NAT) into a single shared bucket.
  identifier?: (c: Context<AppContext>) => Promise<string | null> | string | null
  // P1.2 seam — see GetElevatedLimits above. Defaults to noElevation.
  getElevatedLimits?: GetElevatedLimits
}

// Keys a bucket by the requesting device instead of the account. A second
// device on the same account is normal use, not contention: with a per-user
// bucket, a legitimate sign-in sweep on device B spent device A's budget and
// both devices started collecting 429s for work neither of them did wrong.
// Returns null when the request carries no deviceId so the userId/IP chain in
// the limiter still applies — a placeholder key would put every anonymous
// request into one shared bucket, which is worse than the per-user default.
export const deviceIdentifier = (c: Context<AppContext>): string | null => {
  const deviceId = c.get('deviceId')
  return deviceId ? `device:${deviceId}` : null
}

// Fixed-window limiter backed by the RateLimiter Durable Object (one instance
// per key), replacing the old D1 `rate_limits` upsert — same window semantics,
// same 429 shape, no D1 write contention on the hot path.
//
// Failure semantics mirror the D1 version: a missing RATE_LIMITER binding or a
// DO error throws out of the middleware and blocks the request (500), exactly
// as a D1 error did before. There is no fail-open path.
export const createRateLimiter = (options: RateLimitOptions): MiddlewareHandler<AppContext> => {
  const { maxRequests, windowSeconds, keyPrefix } = options
  const bucket: RateLimitBucket = { maxRequests, windowSeconds, keyPrefix }
  const getElevatedLimits = options.getElevatedLimits ?? noElevation

  return async (c, next) => {
    const identifier =
      (await options.identifier?.(c)) ??
      c.get('userId') ??
      c.req.header('CF-Connecting-IP') ??
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      'unknown'
    const key = `${keyPrefix}:${identifier}`
    const now = Math.floor(Date.now() / 1000)

    const multiplier = (await getElevatedLimits(c, bucket)) ?? null
    const effectiveMax = multiplier === null ? maxRequests : Math.ceil(maxRequests * multiplier)

    const namespace = c.env.RATE_LIMITER
    const stub = namespace.get(namespace.idFromName(key))
    const response = await stub.fetch(
      new Request(new URL('/consume', c.req.url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowSeconds })
      })
    )
    const { count, windowStart } = (await response.json()) as ConsumeResponse

    if (count > effectiveMax) {
      const retryAfter = windowStart + windowSeconds - now
      c.header('Retry-After', String(Math.max(retryAfter, 1)))
      throw new AppError(ErrorCodes.RATE_LIMITED, 'Too many requests', 429)
    }

    c.header('X-RateLimit-Limit', String(effectiveMax))
    c.header('X-RateLimit-Remaining', String(Math.max(effectiveMax - count, 0)))

    await next()
  }
}
