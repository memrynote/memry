import { describe, expect, it, vi } from 'vitest'

import { AppError, ErrorCodes } from '../lib/errors'
import { createRateLimiter } from './rate-limit'

function createPreparedStatement() {
  const statement = {
    bind: vi.fn(() => statement)
  }
  return statement
}

function createContextForCount(
  count: number | undefined,
  windowStart: number,
  userId: string | undefined = undefined
) {
  const prepare = vi.fn(() => createPreparedStatement())
  const batch = vi.fn(async () => [
    { success: true },
    {
      results:
        count === undefined
          ? []
          : [
              {
                count,
                window_start: windowStart
              }
            ]
    }
  ])

  const headers = new Map<string, string>()

  const context = {
    env: {
      DB: {
        prepare,
        batch
      }
    },
    get: vi.fn(() => userId),
    req: {
      header: vi.fn((key: string) => (key === 'CF-Connecting-IP' ? '203.0.113.10' : undefined))
    },
    header: vi.fn((key: string, value: string) => {
      headers.set(key, value)
    })
  }

  return { context, headers, batch }
}

describe('rate-limit middleware', () => {
  it('allows requests under the limit and sets rate limit headers', async () => {
    const limiter = createRateLimiter({ maxRequests: 5, windowSeconds: 60, keyPrefix: 'otp' })
    const { context, headers, batch } = createContextForCount(2, 1000)
    const next = vi.fn(async () => undefined)

    await limiter(context as never, next)

    expect(batch).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledTimes(1)
    expect(headers.get('X-RateLimit-Limit')).toBe('5')
    expect(headers.get('X-RateLimit-Remaining')).toBe('3')
  })

  it('throws RATE_LIMITED with Retry-After when over limit', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(120_000)

    const limiter = createRateLimiter({ maxRequests: 3, windowSeconds: 60, keyPrefix: 'otp' })
    const { context, headers } = createContextForCount(4, 90)

    await expect(limiter(context as never, vi.fn(async () => undefined))).rejects.toMatchObject({
      code: ErrorCodes.RATE_LIMITED,
      statusCode: 429
    } satisfies Partial<AppError>)

    expect(headers.get('Retry-After')).toBe('30')
  })

  it('defaults to zero count when query result is missing', async () => {
    const limiter = createRateLimiter({ maxRequests: 2, windowSeconds: 60, keyPrefix: 'otp' })
    const { context, headers } = createContextForCount(undefined, 0, 'user-1')
    const next = vi.fn(async () => undefined)

    await limiter(context as never, next)

    expect(next).toHaveBeenCalledTimes(1)
    expect(headers.get('X-RateLimit-Remaining')).toBe('2')
  })
})
