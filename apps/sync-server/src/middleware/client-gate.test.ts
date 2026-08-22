import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

import { clientGateMiddleware } from './client-gate'
import type { AppContext } from '../types'
import type { ClientPolicyRow } from '../services/client-policies'

const policyDb = (row: ClientPolicyRow | null) => {
  const first = vi.fn().mockResolvedValue(row)
  const bind = vi.fn().mockReturnValue({ first })
  const prepare = vi.fn().mockReturnValue({ bind })
  return { db: { prepare } as unknown as D1Database, prepare }
}

const buildApp = (row: ClientPolicyRow | null) => {
  const { db, prepare } = policyDb(row)
  const app = new Hono<AppContext>()
  app.use('*', clientGateMiddleware)
  app.all('/thing', (c) => c.json({ ok: true, client: c.get('client') ?? null }))

  const call = (method: string, header?: string) =>
    app.request(
      '/thing',
      { method, headers: header ? { 'x-memry-client': header } : {} },
      { DB: db }
    )

  return { call, prepare }
}

const enabled: ClientPolicyRow = {
  platform: 'ios',
  min_write_version: null,
  writes_enabled: 1,
  updated_at: 0
}

describe('clientGateMiddleware identity parsing', () => {
  it('exposes the parsed identity to downstream handlers', async () => {
    const { call } = buildApp(null)
    const res = await call('GET', 'ios/1.2.3+7')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      ok: true,
      client: { platform: 'ios', version: '1.2.3', build: '7' }
    })
  })

  it('leaves the identity unset for a malformed header instead of rejecting', async () => {
    const { call } = buildApp(null)
    const res = await call('GET', 'not-a-client')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, client: null })
  })
})

describe('clientGateMiddleware', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'never gates %s, even with writes disabled',
    async (method) => {
      const { call, prepare } = buildApp({ ...enabled, writes_enabled: 0 })
      const res = await call(method, 'ios/1.0.0')

      expect(res.status).toBe(200)
      // Reads must not even consult the policy table -- it is a read path with
      // a per-request cost that buys nothing.
      expect(prepare).not.toHaveBeenCalled()
    }
  )

  it('allows a write from a header-less legacy client without touching the policy table', async () => {
    const { call, prepare } = buildApp({ ...enabled, writes_enabled: 0 })
    const res = await call('POST')

    expect(res.status).toBe(200)
    expect(prepare).not.toHaveBeenCalled()
  })

  it('allows a write when no policy row exists for the platform', async () => {
    const { call } = buildApp(null)
    expect((await call('POST', 'ios/1.0.0')).status).toBe(200)
  })

  it('allows a write at or above the floor', async () => {
    const { call } = buildApp({ ...enabled, min_write_version: '1.2.0' })
    expect((await call('POST', 'ios/1.2.0')).status).toBe(200)
  })

  it('rejects a write below the floor with 426 and the floor in the body', async () => {
    const { call } = buildApp({ ...enabled, min_write_version: '1.2.0' })
    const res = await call('POST', 'ios/1.1.0')

    expect(res.status).toBe(426)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: 'CLIENT_UPGRADE_REQUIRED',
        message: expect.stringContaining('1.2.0'),
        minVersion: '1.2.0'
      }
    })
  })

  it('rejects a write with 403 when the platform kill switch is off', async () => {
    const { call } = buildApp({ ...enabled, writes_enabled: 0 })
    const res = await call('POST', 'ios/1.0.0')

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({
      error: { code: 'PLATFORM_WRITES_DISABLED', message: expect.stringContaining('ios') }
    })
  })

  it.each(['PUT', 'DELETE', 'PATCH'])('gates %s as a write', async (method) => {
    const { call } = buildApp({ ...enabled, writes_enabled: 0 })
    expect((await call(method, 'ios/1.0.0')).status).toBe(403)
  })

  it('gates each platform independently', async () => {
    const { call } = buildApp(null)
    expect((await call('POST', 'desktop/1.0.0')).status).toBe(200)
  })
})
