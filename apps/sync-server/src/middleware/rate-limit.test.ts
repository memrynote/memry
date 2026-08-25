import { describe, it, expect, vi, afterEach } from 'vitest'

import { RateLimiter } from '../durable-objects/rate-limiter'
import { AppError, ErrorCodes } from '../lib/errors'

import { createRateLimiter, deviceIdentifier, noElevation } from './rate-limit'

import type { GetElevatedLimits } from './rate-limit'

// ============================================================================
// Fake RATE_LIMITER namespace — real RateLimiter DO instance per key, backed
// by a Map storage (the shared cloudflare:workers mock storage never
// persists), so these tests exercise the real middleware wiring AND the real
// counter semantics end to end.
// ============================================================================

const makeStorage = () => {
  const map = new Map<string, unknown>()
  let alarm: number | null = null
  return {
    get: async (key: string) => (map.has(key) ? map.get(key) : undefined),
    put: async (key: string, value: unknown) => {
      map.set(key, value)
    },
    getAlarm: async () => alarm,
    setAlarm: async (scheduledTime: number) => {
      alarm = scheduledTime
    },
    deleteAll: async () => {
      map.clear()
      alarm = null
    }
  }
}

const createNamespace = () => {
  const instances = new Map<string, RateLimiter>()
  const namespace = {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn((id: string) => {
      let instance = instances.get(id)
      if (!instance) {
        instance = new RateLimiter({} as DurableObjectState, {} as never)
        ;(instance as unknown as { ctx: { storage: unknown } }).ctx.storage = makeStorage()
        instances.set(id, instance)
      }
      const bound = instance
      return { fetch: (request: Request) => bound.fetch(request) }
    })
  }
  return { namespace, instances }
}

const createContext = (
  namespace: unknown,
  vars: { userId?: string; deviceId?: string; ip?: string } = {}
) => {
  const headers: Record<string, string> = {}
  const c = {
    env: { RATE_LIMITER: namespace },
    get: vi.fn((key: string) => {
      if (key === 'userId') return vars.userId
      if (key === 'deviceId') return vars.deviceId
      return undefined
    }),
    req: {
      url: 'http://localhost/test',
      header: vi.fn((name: string) => {
        if (name === 'CF-Connecting-IP') return vars.ip ?? '1.2.3.4'
        return undefined
      })
    },
    header: vi.fn((name: string, value: string) => {
      headers[name] = value
    }),
    _headers: headers
  }

  const next = vi.fn().mockResolvedValue(undefined)
  return { c, next }
}

const run = async (
  middleware: ReturnType<typeof createRateLimiter>,
  namespace: unknown,
  vars: { userId?: string; deviceId?: string; ip?: string } = {}
) => {
  const { c, next } = createContext(namespace, vars)
  await middleware(c as never, next)
  return { c, next }
}

afterEach(() => {
  vi.useRealTimers()
})

// ============================================================================
// Tests: createRateLimiter
// ============================================================================

describe('createRateLimiter', () => {
  const options = { maxRequests: 5, windowSeconds: 60, keyPrefix: 'test' }

  it('should allow requests under the limit', async () => {
    // #given
    const { namespace } = createNamespace()
    const middleware = createRateLimiter(options)
    await run(middleware, namespace, { userId: 'user-1' })
    await run(middleware, namespace, { userId: 'user-1' })

    // #when — third request in the window
    const { c, next } = await run(middleware, namespace, { userId: 'user-1' })

    // #then
    expect(next).toHaveBeenCalled()
    expect(c._headers['X-RateLimit-Limit']).toBe('5')
    expect(c._headers['X-RateLimit-Remaining']).toBe('2')
  })

  it('should allow requests exactly at the limit', async () => {
    // #given
    const { namespace } = createNamespace()
    const middleware = createRateLimiter(options)
    for (let i = 0; i < 4; i++) {
      await run(middleware, namespace, { userId: 'user-1' })
    }

    // #when — fifth request spends the last slot
    const { c, next } = await run(middleware, namespace, { userId: 'user-1' })

    // #then
    expect(next).toHaveBeenCalled()
    expect(c._headers['X-RateLimit-Remaining']).toBe('0')
  })

  it('should block requests over the limit with the exact 429 shape', async () => {
    // #given
    const { namespace } = createNamespace()
    const middleware = createRateLimiter(options)
    for (let i = 0; i < 5; i++) {
      await run(middleware, namespace, { userId: 'user-1' })
    }

    // #when — sixth request
    const { c, next } = createContext(namespace, { userId: 'user-1' })
    let caught: unknown
    try {
      await middleware(c as never, next)
    } catch (error) {
      caught = error
    }

    // #then — client-visible shape unchanged from the D1 limiter
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).code).toBe(ErrorCodes.RATE_LIMITED)
    expect((caught as AppError).message).toBe('Too many requests')
    expect((caught as AppError).statusCode).toBe(429)
    expect(next).not.toHaveBeenCalled()
  })

  it('should set Retry-After to the remaining window when rate limited', async () => {
    // #given — the whole budget spent at the top of the window
    vi.useFakeTimers()
    const { namespace } = createNamespace()
    const middleware = createRateLimiter(options)
    for (let i = 0; i < 5; i++) {
      await run(middleware, namespace, { userId: 'user-1' })
    }

    // #when — 30s into the window
    vi.advanceTimersByTime(30_000)
    const { c, next } = createContext(namespace, { userId: 'user-1' })
    await expect(middleware(c as never, next)).rejects.toThrow(AppError)

    // #then — exact remaining window, not a blanket fallback
    expect(c._headers['Retry-After']).toBe('30')
  })

  it('should reset the window after windowSeconds elapse', async () => {
    // #given — an exhausted bucket
    vi.useFakeTimers()
    const { namespace } = createNamespace()
    const middleware = createRateLimiter(options)
    for (let i = 0; i < 5; i++) {
      await run(middleware, namespace, { userId: 'user-1' })
    }
    const blocked = createContext(namespace, { userId: 'user-1' })
    await expect(middleware(blocked.c as never, blocked.next)).rejects.toThrow(AppError)

    // #when — the window lapses
    vi.advanceTimersByTime(61_000)
    const { c, next } = await run(middleware, namespace, { userId: 'user-1' })

    // #then — fresh budget
    expect(next).toHaveBeenCalled()
    expect(c._headers['X-RateLimit-Remaining']).toBe('4')
  })

  it('should use userId as identifier when available', async () => {
    // #given
    const { namespace } = createNamespace()
    const middleware = createRateLimiter(options)

    // #when
    await run(middleware, namespace, { userId: 'user-1' })

    // #then
    expect(namespace.idFromName).toHaveBeenCalledWith('test:user-1')
  })

  it('should fall back to IP when userId is not set', async () => {
    // #given
    const { namespace } = createNamespace()
    const middleware = createRateLimiter(options)

    // #when
    await run(middleware, namespace, { ip: '10.0.0.1' })

    // #then
    expect(namespace.idFromName).toHaveBeenCalledWith('test:10.0.0.1')
  })

  it('should key by the custom identifier when provided', async () => {
    // #given — e.g. linking routes keying by sessionId instead of shared IP
    const { namespace } = createNamespace()
    const middleware = createRateLimiter({ ...options, identifier: () => 'session:abc' })

    // #when
    await run(middleware, namespace, { userId: 'user-1', ip: '10.0.0.1' })

    // #then — sessionId wins over userId/IP, so devices don't share a bucket
    expect(namespace.idFromName).toHaveBeenCalledWith('test:session:abc')
  })

  it('should fall back to userId/IP when the custom identifier returns null', async () => {
    // #given
    const { namespace } = createNamespace()
    const middleware = createRateLimiter({ ...options, identifier: () => null })

    // #when
    await run(middleware, namespace, { userId: 'user-1' })

    // #then
    expect(namespace.idFromName).toHaveBeenCalledWith('test:user-1')
  })

  it('should give different keys independent budgets', async () => {
    // #given — user-1 spends the whole bucket
    const { namespace } = createNamespace()
    const middleware = createRateLimiter(options)
    for (let i = 0; i < 5; i++) {
      await run(middleware, namespace, { userId: 'user-1' })
    }
    const exhausted = createContext(namespace, { userId: 'user-1' })
    await expect(middleware(exhausted.c as never, exhausted.next)).rejects.toThrow(AppError)

    // #when — user-2 makes a first request
    const { c, next } = await run(middleware, namespace, { userId: 'user-2' })

    // #then
    expect(next).toHaveBeenCalled()
    expect(c._headers['X-RateLimit-Remaining']).toBe('4')
  })
})

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
    const { namespace, instances } = createNamespace()
    const middleware = createRateLimiter(limiterOptions)
    for (let i = 0; i < 3; i++) {
      await run(middleware, namespace, { userId: 'user-1', deviceId: 'device-a' })
    }
    const exhausted = createContext(namespace, { userId: 'user-1', deviceId: 'device-a' })
    await expect(middleware(exhausted.c as never, exhausted.next)).rejects.toThrow(AppError)

    // #when — device B on the SAME account makes its first request
    const { c, next } = await run(middleware, namespace, { userId: 'user-1', deviceId: 'device-b' })

    // #then — device B is untouched by device A's spending
    expect(next).toHaveBeenCalled()
    expect(c._headers['X-RateLimit-Remaining']).toBe('2')
    expect([...instances.keys()].sort()).toEqual([
      'crdt_pull:device:device-a',
      'crdt_pull:device:device-b'
    ])
  })

  it('should fall back to the user bucket when the request has no deviceId', async () => {
    // #given
    const { namespace, instances } = createNamespace()
    const middleware = createRateLimiter(limiterOptions)

    // #when
    const { next } = await run(middleware, namespace, { userId: 'user-1' })

    // #then — the userId/IP chain still applies; no invented placeholder key
    expect(next).toHaveBeenCalled()
    expect([...instances.keys()]).toEqual(['crdt_pull:user-1'])
  })

  it('should not collapse deviceless requests from different users into one bucket', async () => {
    // #given
    const { namespace, instances } = createNamespace()
    const middleware = createRateLimiter(limiterOptions)

    // #when — two accounts, neither carrying a deviceId
    for (const userId of ['user-1', 'user-2']) {
      await run(middleware, namespace, { userId })
    }

    // #then
    expect([...instances.keys()].sort()).toEqual(['crdt_pull:user-1', 'crdt_pull:user-2'])
  })
})

// ============================================================================
// Tests: P1.2 elevation seam (getElevatedLimits)
// ============================================================================

describe('getElevatedLimits seam', () => {
  const options = { maxRequests: 2, windowSeconds: 60, keyPrefix: 'seam' }

  it('should widen the effective ceiling when elevation returns a multiplier', async () => {
    // #given — a bootstrap-session stand-in elevating this bucket 4x
    const { namespace } = createNamespace()
    const middleware = createRateLimiter({ ...options, getElevatedLimits: () => 4 })

    // #when — 8 requests, four times the base ceiling of 2
    let last: Awaited<ReturnType<typeof run>> | undefined
    for (let i = 0; i < 8; i++) {
      last = await run(middleware, namespace, { userId: 'user-1' })
    }

    // #then — all pass, the 9th is the first to 429
    expect(last?.c._headers['X-RateLimit-Limit']).toBe('8')
    expect(last?.c._headers['X-RateLimit-Remaining']).toBe('0')
    const ninth = createContext(namespace, { userId: 'user-1' })
    await expect(middleware(ninth.c as never, ninth.next)).rejects.toThrow(AppError)
  })

  it('should ceil fractional multipliers — 5 × 1.5 widens to 8, not 7', async () => {
    // #given — an odd multiplier whose product lands off the integer grid,
    // where ceil and floor disagree (7.5)
    const { namespace } = createNamespace()
    const middleware = createRateLimiter({
      maxRequests: 5,
      windowSeconds: 60,
      keyPrefix: 'seam',
      getElevatedLimits: () => 1.5
    })

    // #when — exactly ceil(7.5) = 8 requests
    let last: Awaited<ReturnType<typeof run>> | undefined
    for (let i = 0; i < 8; i++) {
      last = await run(middleware, namespace, { userId: 'user-1' })
    }

    // #then — the 8th passes under a ceiling of 8 (a floor mutant allows only
    // 7 and 429s here); the 9th is blocked
    expect(last?.c._headers['X-RateLimit-Limit']).toBe('8')
    expect(last?.c._headers['X-RateLimit-Remaining']).toBe('0')
    const ninth = createContext(namespace, { userId: 'user-1' })
    await expect(middleware(ninth.c as never, ninth.next)).rejects.toThrow(AppError)
  })

  it.each([
    ['a sub-1 fraction', 0.5],
    ['a negative value', -2],
    ['NaN', Number.NaN]
  ])('should treat %s from the elevation hook as no elevation', async (_label, multiplier) => {
    // #given — a buggy P1.2 hook that would shrink or poison the ceiling
    const { namespace } = createNamespace()
    const middleware = createRateLimiter({
      maxRequests: 5,
      windowSeconds: 60,
      keyPrefix: 'seam',
      getElevatedLimits: () => multiplier
    })

    // #when — the full base budget, then one past it
    let last: Awaited<ReturnType<typeof run>> | undefined
    for (let i = 0; i < 5; i++) {
      last = await run(middleware, namespace, { userId: 'user-1' })
    }

    // #then — ceiling stays at the bucket base of 5; the 6th request is
    // blocked instead of sailing through an unlimited/NaN comparison
    expect(last?.c._headers['X-RateLimit-Limit']).toBe('5')
    const sixth = createContext(namespace, { userId: 'user-1' })
    await expect(middleware(sixth.c as never, sixth.next)).rejects.toThrow(AppError)
  })

  it('should keep the base ceiling when elevation returns null', async () => {
    // #given
    const { namespace } = createNamespace()
    const middleware = createRateLimiter({ ...options, getElevatedLimits: () => null })
    await run(middleware, namespace, { userId: 'user-1' })
    await run(middleware, namespace, { userId: 'user-1' })

    // #when — one past the base ceiling
    const { c, next } = createContext(namespace, { userId: 'user-1' })

    // #then
    await expect(middleware(c as never, next)).rejects.toThrow(AppError)
  })

  it('should pass the request context and the bucket to the elevation check', async () => {
    // #given
    const { namespace } = createNamespace()
    const getElevatedLimits = vi.fn<GetElevatedLimits>(() => null)
    const middleware = createRateLimiter({ ...options, getElevatedLimits })

    // #when
    const { c } = await run(middleware, namespace, { userId: 'user-1' })

    // #then — P1.2 gets the Hono context (for the session) and the bucket name
    expect(getElevatedLimits).toHaveBeenCalledWith(c, {
      maxRequests: 2,
      windowSeconds: 60,
      keyPrefix: 'seam'
    })
  })

  it('noElevation default should never elevate', async () => {
    // #given / #when / #then
    expect(noElevation({} as never, { maxRequests: 2, windowSeconds: 60, keyPrefix: 'x' })).toBe(
      null
    )
  })
})

// ============================================================================
// Tests: failure semantics — the D1 limiter blocked the request when the
// database errored (the exception propagated to the error handler). The DO
// limiter must do the same: no silent fail-open.
// ============================================================================

describe('failure semantics', () => {
  const options = { maxRequests: 5, windowSeconds: 60, keyPrefix: 'test' }

  it('should block the request when the RATE_LIMITER binding is absent', async () => {
    // #given — an env without the binding (mirrors a missing DB before)
    const middleware = createRateLimiter(options)
    const { c, next } = createContext(undefined)

    // #when / #then — the request never reaches the handler
    await expect(middleware(c as never, next)).rejects.toThrow()
    expect(next).not.toHaveBeenCalled()
  })

  it('should block the request when the durable object call fails', async () => {
    // #given — a namespace whose stub rejects (mirrors a D1 batch error)
    const middleware = createRateLimiter(options)
    const namespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({ fetch: vi.fn().mockRejectedValue(new Error('DO unreachable')) }))
    }
    const { c, next } = createContext(namespace)

    // #when / #then
    await expect(middleware(c as never, next)).rejects.toThrow('DO unreachable')
    expect(next).not.toHaveBeenCalled()
  })
})
