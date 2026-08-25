import { describe, it, expect, vi, afterEach } from 'vitest'

import { RateLimiter } from './rate-limiter'

// The mocked cloudflare:workers DurableObject ships a non-persisting storage
// stub (get() always returns null, no deleteAll). Swap in a Map-backed storage
// so we can exercise real window rollover round-trips.
function makeStorage() {
  const map = new Map<string, unknown>()
  let alarm: number | null = null
  return {
    map,
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

function createDO() {
  const doObj = new RateLimiter({} as DurableObjectState, {} as never)
  const storage = makeStorage()
  ;(doObj as unknown as { ctx: { storage: unknown } }).ctx.storage = storage
  return { doObj, storage }
}

function consume(doObj: RateLimiter, windowSeconds = 60): Promise<Response> {
  return doObj.fetch(
    new Request('https://do.internal/consume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowSeconds })
    })
  )
}

const nowSec = () => Math.floor(Date.now() / 1000)

afterEach(() => {
  vi.useRealTimers()
})

describe('RateLimiter', () => {
  it('starts a window at count 1 and arms the cleanup alarm', async () => {
    // #given
    const { doObj, storage } = createDO()
    const before = nowSec()

    // #when
    const response = await consume(doObj)
    const body = (await response.json()) as { count: number; windowStart: number }

    // #then
    expect(body.count).toBe(1)
    expect(body.windowStart).toBeGreaterThanOrEqual(before)
    expect(await storage.getAlarm()).toBe((body.windowStart + 61) * 1000)
  })

  it('increments the count within the window and keeps windowStart fixed', async () => {
    // #given
    const { doObj } = createDO()
    const first = (await (await consume(doObj)).json()) as { count: number; windowStart: number }

    // #when
    const second = (await (await consume(doObj)).json()) as { count: number; windowStart: number }
    const third = (await (await consume(doObj)).json()) as { count: number; windowStart: number }

    // #then
    expect(second.count).toBe(2)
    expect(third.count).toBe(3)
    expect(second.windowStart).toBe(first.windowStart)
    expect(third.windowStart).toBe(first.windowStart)
  })

  it('resets to a fresh window once windowSeconds have elapsed', async () => {
    // #given
    vi.useFakeTimers()
    const { doObj } = createDO()
    const first = (await (await consume(doObj)).json()) as { count: number; windowStart: number }
    await consume(doObj)

    // #when — one second past the window end
    vi.advanceTimersByTime(61_000)
    const rolled = (await (await consume(doObj)).json()) as { count: number; windowStart: number }

    // #then — same reset condition as the old D1 upsert (window_start < now - windowSeconds)
    expect(rolled.count).toBe(1)
    expect(rolled.windowStart).toBe(first.windowStart + 61)
  })

  it('keeps incrementing the stale window at exactly windowSeconds', async () => {
    // #given
    vi.useFakeTimers()
    const { doObj } = createDO()
    const first = (await (await consume(doObj)).json()) as { count: number; windowStart: number }
    await consume(doObj)

    // #when — advance EXACTLY windowSeconds, not one second past: at t ===
    // windowStart + windowSeconds the strict `<` in
    // `existing.windowStart < now - windowSeconds` is still false, so the
    // stored window stays live and keeps counting
    vi.advanceTimersByTime(60_000)
    const boundary = (await (await consume(doObj)).json()) as {
      count: number
      windowStart: number
    }

    // #then — count continues in the stale window (a `<=` mutant would reset
    // to a fresh window here); only strictly older windows roll over
    expect(boundary.count).toBe(3)
    expect(boundary.windowStart).toBe(first.windowStart)
  })

  it('keeps counting past any ceiling — the middleware owns the comparison', async () => {
    // #given
    const { doObj } = createDO()

    // #when
    let last = 0
    for (let i = 0; i < 7; i++) {
      const body = (await (await consume(doObj)).json()) as { count: number }
      last = body.count
    }

    // #then — no clamping inside the DO, so elevation can widen ceilings later
    expect(last).toBe(7)
  })

  it('clears all storage when the alarm fires', async () => {
    // #given
    const { doObj, storage } = createDO()
    await consume(doObj)
    expect(storage.map.size).toBe(1)

    // #when
    await doObj.alarm()

    // #then — the key is dropped, the instance is evictable
    expect(storage.map.size).toBe(0)
    expect(await storage.getAlarm()).toBe(null)
  })

  it('returns 404 for unknown paths', async () => {
    // #given
    const { doObj } = createDO()

    // #when
    const response = await doObj.fetch(new Request('https://do.internal/nope'))

    // #then
    expect(response.status).toBe(404)
  })
})
