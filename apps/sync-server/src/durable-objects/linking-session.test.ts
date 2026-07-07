import { describe, it, expect } from 'vitest'

import { LinkingSession } from './linking-session'

// The mocked cloudflare:workers DurableObject ships a non-persisting storage stub
// (get() always returns null, no deleteAll). Swap in a Map-backed storage so we can
// exercise real create -> transition -> status round-trips.
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
  const doObj = new LinkingSession({} as DurableObjectState, {} as never)
  const storage = makeStorage()
  ;(doObj as unknown as { ctx: { storage: unknown } }).ctx.storage = storage
  return { doObj, storage }
}

function req(path: string, body?: unknown): Request {
  return new Request(`https://do.internal${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

const nowSec = () => Math.floor(Date.now() / 1000)

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    userId: 'user-1',
    initiatorDeviceId: 'device-1',
    expiresAt: nowSec() + 1000,
    ...overrides
  }
}

describe('LinkingSession', () => {
  describe('/create', () => {
    it('stores pending meta and arms the expiry alarm', async () => {
      // #given
      const { doObj, storage } = createDO()
      const expiresAt = nowSec() + 300

      // #when
      const res = await doObj.fetch(req('/create', createBody({ expiresAt })))

      // #then
      expect(await res.json()).toEqual({ ok: true })
      expect(storage.map.get('meta')).toEqual({
        sessionId: 'sess-1',
        userId: 'user-1',
        initiatorDeviceId: 'device-1',
        status: 'pending',
        expiresAt
      })
      expect(await storage.getAlarm()).toBe(expiresAt * 1000)
    })
  })

  describe('transitions', () => {
    it.each([
      ['/scan', 'scanned'],
      ['/approve', 'approved'],
      ['/complete', 'completed']
    ])('%s advances status to %s and echoes owner identity', async (path, expected) => {
      // #given
      const { doObj, storage } = createDO()
      await doObj.fetch(req('/create', createBody()))

      // #when
      const res = await doObj.fetch(req(path, {}))

      // #then
      expect(await res.json()).toEqual({
        ok: true,
        userId: 'user-1',
        initiatorDeviceId: 'device-1'
      })
      expect((storage.map.get('meta') as { status: string }).status).toBe(expected)
    })

    it('returns 404 when transitioning a session that was never created', async () => {
      // #given
      const { doObj } = createDO()

      // #when
      const res = await doObj.fetch(req('/approve', {}))

      // #then
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'Session not found in DO' })
    })
  })

  describe('/status', () => {
    it('reports expired when no session exists', async () => {
      // #given
      const { doObj } = createDO()

      // #when
      const res = await doObj.fetch(req('/status'))

      // #then
      expect(await res.json()).toEqual({ status: 'expired', expiresAt: null })
    })

    it('reports the live status while the session is unexpired', async () => {
      // #given
      const { doObj } = createDO()
      const expiresAt = nowSec() + 1000
      await doObj.fetch(req('/create', createBody({ expiresAt })))
      await doObj.fetch(req('/scan', {}))

      // #when
      const res = await doObj.fetch(req('/status'))

      // #then
      expect(await res.json()).toEqual({ status: 'scanned', expiresAt })
    })

    it('reports expired once the deadline has passed even if meta remains', async () => {
      // #given — meta persisted but expiry is in the past
      const { doObj } = createDO()
      const expiresAt = nowSec() - 5
      await doObj.fetch(req('/create', createBody({ expiresAt })))

      // #when
      const res = await doObj.fetch(req('/status'))

      // #then
      expect(await res.json()).toEqual({ status: 'expired', expiresAt })
    })
  })

  describe('alarm', () => {
    it('wipes all session storage on expiry', async () => {
      // #given
      const { doObj, storage } = createDO()
      await doObj.fetch(req('/create', createBody()))
      expect(storage.map.size).toBe(1)

      // #when
      await doObj.alarm()

      // #then
      expect(storage.map.size).toBe(0)
      expect(await storage.getAlarm()).toBeNull()
    })
  })

  it('returns 404 for unknown paths', async () => {
    // #given
    const { doObj } = createDO()

    // #when
    const res = await doObj.fetch(req('/nope'))

    // #then
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('Not found')
  })
})
