import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AppError } from '../lib/errors'

import { createRateLimiter, deviceIdentifier } from './rate-limit'

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

  it('should key by the custom identifier when provided', async () => {
    // #given — e.g. linking routes keying by sessionId instead of shared IP
    const { c, next, db } = createMockContext({ userId: 'user-1', ip: '10.0.0.1', count: 1 })
    const middleware = createRateLimiter({ ...options, identifier: () => 'session:abc' })

    // #when
    await middleware(c as never, next)

    // #then — sessionId wins over userId/IP, so devices don't share a bucket
    const insertStmt = db.batch.mock.calls[0][0][0]
    expect(insertStmt.bind).toHaveBeenCalledWith(
      'test:session:abc',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number)
    )
  })

  it('should fall back to userId/IP when the custom identifier returns null', async () => {
    // #given
    const { c, next, db } = createMockContext({ userId: 'user-1', count: 1 })
    const middleware = createRateLimiter({ ...options, identifier: () => null })

    // #when
    await middleware(c as never, next)

    // #then
    const insertStmt = db.batch.mock.calls[0][0][0]
    expect(insertStmt.bind).toHaveBeenCalledWith(
      'test:user-1',
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number)
    )
  })
})

// ============================================================================
// Stateful D1 stand-in — the fixed-count mock above cannot show one caller
// spending another caller's budget, which is the whole point of a bucket key.
// ============================================================================

interface RateLimitRow {
  count: number
  window_start: number
}

interface RecordingStatement {
  args: unknown[]
  bind: (...args: unknown[]) => RecordingStatement
}

const createRateLimitDb = () => {
  const rows = new Map<string, RateLimitRow>()

  const prepare = vi.fn(() => {
    const stmt: RecordingStatement = {
      args: [],
      bind: (...args: unknown[]) => {
        stmt.args = args
        return stmt
      }
    }
    return stmt
  })

  const batch = vi.fn(async (stmts: RecordingStatement[]) => {
    const [insert, select] = stmts
    const [key, now, windowStart] = insert.args as [string, number, number]
    const existing = rows.get(key)
    if (!existing || existing.window_start < windowStart) {
      rows.set(key, { count: 1, window_start: now })
    } else {
      existing.count += 1
    }
    const row = rows.get(select.args[0] as string)
    return [{ success: true }, { results: row ? [row] : [] }]
  })

  return { db: { prepare, batch }, rows }
}

const createDeviceContext = (
  db: ReturnType<typeof createRateLimitDb>['db'],
  vars: { userId?: string; deviceId?: string }
) => {
  const headers: Record<string, string> = {}
  const c = {
    env: { DB: db },
    get: vi.fn((key: string) => (key === 'userId' ? vars.userId : vars.deviceId)),
    req: {
      header: vi.fn((name: string) => (name === 'CF-Connecting-IP' ? '1.2.3.4' : undefined))
    },
    header: vi.fn((name: string, value: string) => {
      headers[name] = value
    }),
    _headers: headers
  }
  return { c, next: vi.fn().mockResolvedValue(undefined) }
}

// ============================================================================
// Tests: deviceIdentifier
// ============================================================================

describe('deviceIdentifier', () => {
  const limiterOptions = {
    maxRequests: 3,
    windowSeconds: 60,
    keyPrefix: 'crdt_pull',
    identifier: deviceIdentifier
  }

  it('should give two devices on the same account independent budgets', async () => {
    // #given — device A spends its entire budget on a legitimate body sweep
    const { db, rows } = createRateLimitDb()
    const middleware = createRateLimiter(limiterOptions)
    for (let i = 0; i < 3; i++) {
      const { c, next } = createDeviceContext(db, { userId: 'user-1', deviceId: 'device-a' })
      await middleware(c as never, next)
    }
    const exhausted = createDeviceContext(db, { userId: 'user-1', deviceId: 'device-a' })
    await expect(middleware(exhausted.c as never, exhausted.next)).rejects.toThrow(AppError)

    // #when — device B on the SAME account makes its first request
    const deviceB = createDeviceContext(db, { userId: 'user-1', deviceId: 'device-b' })
    await middleware(deviceB.c as never, deviceB.next)

    // #then — device B is untouched by device A's spending
    expect(deviceB.next).toHaveBeenCalled()
    expect(deviceB.c._headers['X-RateLimit-Remaining']).toBe('2')
    expect([...rows.keys()].sort()).toEqual([
      'crdt_pull:device:device-a',
      'crdt_pull:device:device-b'
    ])
  })

  it('should fall back to the user bucket when the request has no deviceId', async () => {
    // #given
    const { db, rows } = createRateLimitDb()
    const middleware = createRateLimiter(limiterOptions)
    const { c, next } = createDeviceContext(db, { userId: 'user-1' })

    // #when
    await middleware(c as never, next)

    // #then — the userId/IP chain still applies; no invented placeholder key
    expect(next).toHaveBeenCalled()
    expect([...rows.keys()]).toEqual(['crdt_pull:user-1'])
  })

  it('should not collapse deviceless requests from different users into one bucket', async () => {
    // #given
    const { db, rows } = createRateLimitDb()
    const middleware = createRateLimiter(limiterOptions)

    // #when — two accounts, neither carrying a deviceId
    for (const userId of ['user-1', 'user-2']) {
      const { c, next } = createDeviceContext(db, { userId })
      await middleware(c as never, next)
    }

    // #then
    expect([...rows.keys()].sort()).toEqual(['crdt_pull:user-1', 'crdt_pull:user-2'])
  })
})
