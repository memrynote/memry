import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AppError } from '../lib/errors'

import { createRateLimiter } from './rate-limit'

// ============================================================================
// Hono context / D1 mock helpers
// ============================================================================

interface MockStatement {
  bind: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
}

const createMockStatement = (): MockStatement => {
  const stmt: MockStatement = {
    bind: vi.fn(),
    run: vi.fn().mockResolvedValue({ success: true })
  }
  stmt.bind.mockReturnValue(stmt)
  return stmt
}

const createMockContext = (overrides?: {
  userId?: string
  ip?: string
  count?: number
  windowStart?: number
}) => {
  const count = overrides?.count ?? 1
  const windowStart = overrides?.windowStart ?? Math.floor(Date.now() / 1000)

  const stmts = [createMockStatement(), createMockStatement()]

  const db = {
    prepare: vi.fn().mockImplementation(() => {
      const idx = db.prepare.mock.calls.length - 1
      return stmts[idx] ?? createMockStatement()
    }),
    batch: vi
      .fn()
      .mockResolvedValue([
        { success: true },
        { results: [{ count, window_start: windowStart }] } as D1Result
      ])
  }

  const headers: Record<string, string> = {}
  const c = {
    env: { DB: db },
    get: vi.fn((key: string) => {
      if (key === 'userId') return overrides?.userId
      return undefined
    }),
    req: {
      header: vi.fn((name: string) => {
        if (name === 'CF-Connecting-IP') return overrides?.ip ?? '1.2.3.4'
        return undefined
      })
    },
    header: vi.fn((name: string, value: string) => {
      headers[name] = value
    }),
    _headers: headers
  }

  const next = vi.fn().mockResolvedValue(undefined)

  return { c, next, db }
}

// ============================================================================
// Tests: createRateLimiter
// ============================================================================

describe('createRateLimiter', () => {
  const options = { maxRequests: 5, windowSeconds: 60, keyPrefix: 'test' }

  it('should allow requests under the limit', async () => {
    // #given
    const { c, next } = createMockContext({ count: 3 })
    const middleware = createRateLimiter(options)

    // #when
    await middleware(c as never, next)

    // #then
    expect(next).toHaveBeenCalled()
    expect(c._headers['X-RateLimit-Limit']).toBe('5')
    expect(c._headers['X-RateLimit-Remaining']).toBe('2')
  })

  it('should allow requests exactly at the limit', async () => {
    // #given
    const { c, next } = createMockContext({ count: 5 })
    const middleware = createRateLimiter(options)

    // #when
    await middleware(c as never, next)

    // #then
    expect(next).toHaveBeenCalled()
    expect(c._headers['X-RateLimit-Remaining']).toBe('0')
  })

  it('should block requests over the limit with 429', async () => {
    // #given
    const { c, next } = createMockContext({ count: 6 })
    const middleware = createRateLimiter(options)

    // #when / #then
    await expect(middleware(c as never, next)).rejects.toThrow(AppError)
    expect(next).not.toHaveBeenCalled()
  })

  it('should set Retry-After header when rate limited', async () => {
    // #given
    const now = Math.floor(Date.now() / 1000)
    const { c, next } = createMockContext({ count: 10, windowStart: now - 30 })
    const middleware = createRateLimiter(options)

    // #when
    try {
      await middleware(c as never, next)
    } catch {
      // expected
    }

    // #then
    expect(c._headers['Retry-After']).toBeDefined()
    expect(Number(c._headers['Retry-After'])).toBeGreaterThan(0)
  })

  it('should use userId as identifier when available', async () => {
    // #given
    const { c, next, db } = createMockContext({ userId: 'user-1', count: 1 })
    const middleware = createRateLimiter(options)

    // #when
    await middleware(c as never, next)

    // #then
    const batchArgs = db.batch.mock.calls[0][0]
    const insertStmt = batchArgs[0]
    expect(insertStmt.bind).toHaveBeenCalledWith(
      'test:user-1',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number)
    )
  })

  it('should fall back to IP when userId is not set', async () => {
    // #given
    const { c, next, db } = createMockContext({ ip: '10.0.0.1', count: 1 })
    const middleware = createRateLimiter(options)

    // #when
    await middleware(c as never, next)

    // #then
    const batchArgs = db.batch.mock.calls[0][0]
    const insertStmt = batchArgs[0]
    expect(insertStmt.bind).toHaveBeenCalledWith(
      'test:10.0.0.1',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number)
    )
  })
})
