import { Hono } from 'hono'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ErrorCodes, errorHandler } from '../lib/errors'
import type { AppContext } from '../types'

vi.mock('../services/device', () => ({
  getDevice: vi.fn(),
  listDevices: vi.fn(),
  revokeDevice: vi.fn().mockResolvedValue(undefined),
  updateDevice: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('userId', 'user-1')
    c.set('deviceId', 'device-current')
    await next()
  })
}))

vi.mock('../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn().mockReturnValue(
    vi.fn().mockImplementation(async (_c: any, next: any) => {
      await next()
    })
  )
}))

import { devices } from './devices'
import { getDevice, listDevices, revokeDevice, updateDevice } from '../services/device'

const createApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/devices', devices)
  return app
}

const doStub = {
  fetch: vi.fn().mockResolvedValue(Response.json({ ok: true }))
}

const createEnv = () => ({
  DB: {} as D1Database,
  STORAGE: {} as R2Bucket,
  USER_SYNC_STATE: {
    idFromName: vi.fn().mockReturnValue('user-do-id'),
    get: vi.fn().mockReturnValue(doStub)
  } as unknown as DurableObjectNamespace,
  LINKING_SESSION: {} as DurableObjectNamespace,
  ENVIRONMENT: 'development',
  JWT_PUBLIC_KEY: 'pk',
  JWT_PRIVATE_KEY: 'sk',
  RESEND_API_KEY: 'resend',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost/callback',
  RECOVERY_DUMMY_SECRET: 'dummy'
})

const makeDevice = (overrides: Record<string, unknown> = {}) => ({
  id: 'device-2',
  user_id: 'user-1',
  name: 'MacBook',
  platform: 'darwin',
  os_version: null,
  app_version: '1.0.0',
  auth_public_key: 'pk',
  push_token: null,
  last_sync_at: 100,
  revoked_at: null,
  created_at: 50,
  updated_at: 75,
  ...overrides
})

describe('device routes', () => {
  let app: ReturnType<typeof createApp>
  let env: ReturnType<typeof createEnv>

  beforeEach(() => {
    vi.clearAllMocks()
    doStub.fetch.mockResolvedValue(Response.json({ ok: true }))
    app = createApp()
    env = createEnv()
    vi.mocked(listDevices).mockResolvedValue([makeDevice()] as any)
    vi.mocked(getDevice).mockResolvedValue(makeDevice() as any)
  })

  it('lists non-revoked devices using the authenticated user id', async () => {
    const res = await app.request('/devices', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      devices: [
        {
          id: 'device-2',
          name: 'MacBook',
          platform: 'darwin',
          lastSyncAt: 100,
          createdAt: 50,
          updatedAt: 75
        }
      ]
    })
    expect(listDevices).toHaveBeenCalledWith(env.DB, 'user-1')
  })

  it('rejects attempts to revoke the current device', async () => {
    const res = await app.request('/devices/device-current', { method: 'DELETE' }, env)

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.VALIDATION_ERROR
    )
    expect(getDevice).not.toHaveBeenCalled()
  })

  it('returns 404 when revoking a missing device', async () => {
    vi.mocked(getDevice).mockResolvedValueOnce(null)

    const res = await app.request('/devices/missing', { method: 'DELETE' }, env)

    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.AUTH_DEVICE_NOT_FOUND
    )
  })

  it('returns 409 when revoking an already revoked device', async () => {
    vi.mocked(getDevice).mockResolvedValueOnce(makeDevice({ revoked_at: 123 }) as any)

    const res = await app.request('/devices/device-2', { method: 'DELETE' }, env)

    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.AUTH_DEVICE_REVOKED
    )
  })

  it('revokes another device and notifies the user sync durable object', async () => {
    const res = await app.request('/devices/device-2', { method: 'DELETE' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
    expect(revokeDevice).toHaveBeenCalledWith(env.DB, 'device-2', 'user-1')
    expect(env.USER_SYNC_STATE.idFromName).toHaveBeenCalledWith('user-1')
    expect(doStub.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST'
      })
    )
  })

  it('validates rename request bodies', async () => {
    const res = await app.request(
      '/devices/device-2',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '' })
      },
      env
    )

    expect(res.status).toBe(400)
    expect(updateDevice).not.toHaveBeenCalled()
  })

  it('returns 404 when renaming a missing device', async () => {
    vi.mocked(getDevice).mockResolvedValueOnce(null)

    const res = await app.request(
      '/devices/missing',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Office Mac' })
      },
      env
    )

    expect(res.status).toBe(404)
  })

  it('returns 409 when renaming a revoked device', async () => {
    vi.mocked(getDevice).mockResolvedValueOnce(makeDevice({ revoked_at: 123 }) as any)

    const res = await app.request(
      '/devices/device-2',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Office Mac' })
      },
      env
    )

    expect(res.status).toBe(409)
    expect(updateDevice).not.toHaveBeenCalled()
  })

  it('renames an active device', async () => {
    const res = await app.request(
      '/devices/device-2',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Office Mac' })
      },
      env
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      device: { id: 'device-2', name: 'Office Mac' }
    })
    expect(updateDevice).toHaveBeenCalledWith(env.DB, 'device-2', 'user-1', {
      name: 'Office Mac'
    })
  })
})
