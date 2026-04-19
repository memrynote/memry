import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorHandler } from '../lib/errors'
import type { AppContext } from '../types'

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (
    c: { set: (k: string, v: string) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', 'user-1')
    c.set('deviceId', 'device-1')
    await next()
  }
}))

import { calendarChannels } from './calendar-channels'

function createApp() {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/calendar/channels', calendarChannels)
  return app
}

function createStatement(overrides?: {
  first?: ReturnType<typeof vi.fn>
  run?: ReturnType<typeof vi.fn>
}) {
  const statement = {
    bind: vi.fn(),
    first: overrides?.first ?? vi.fn(async () => null),
    run: overrides?.run ?? vi.fn(async () => ({ success: true, meta: { changes: 1 } }))
  }
  statement.bind.mockReturnValue(statement)
  return statement
}

function createEnv(prepareImpl: ReturnType<typeof vi.fn>) {
  return {
    DB: {
      prepare: prepareImpl
    } as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    USER_SYNC_STATE: {} as DurableObjectNamespace,
    LINKING_SESSION: {} as DurableObjectNamespace,
    ENVIRONMENT: 'development',
    JWT_PUBLIC_KEY: 'k',
    JWT_PRIVATE_KEY: 'k',
    RESEND_API_KEY: 'k',
    OTP_HMAC_KEY: 'k',
    GOOGLE_CLIENT_ID: 'k',
    GOOGLE_CLIENT_SECRET: 'k',
    GOOGLE_REDIRECT_URI: 'http://localhost/callback',
    MIN_APP_VERSION: '1.0.0',
    RECOVERY_DUMMY_SECRET: 'k',
    WEBHOOK_HMAC_KEY: 'k'
  }
}

function jsonPost(body: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }
}

describe('calendar-channels routes', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  describe('POST /calendar/channels', () => {
    it('inserts a row with userId and deviceId from auth, returns 201 with channelId + expiresAt', async () => {
      // #given a valid registration body
      const statement = createStatement()
      const prepare = vi.fn(() => statement)
      const env = createEnv(prepare)
      const body = {
        channelId: 'ch-1',
        sourceId: 'google-calendar:abc',
        tokenHash: 'a'.repeat(64),
        expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60
      }

      // #when
      const res = await app.request('/calendar/channels', jsonPost(body), env)

      // #then
      expect(res.status).toBe(201)
      const json = (await res.json()) as Record<string, unknown>
      expect(json).toMatchObject({ channelId: 'ch-1', expiresAt: body.expiresAt })
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(prepare.mock.calls[0]![0]).toContain('INSERT INTO google_calendar_channels')
      const bindArgs = statement.bind.mock.calls[0]!
      expect(bindArgs[0]).toBe('ch-1') // channel_id
      expect(bindArgs[1]).toBe('user-1') // user_id (from auth)
      expect(bindArgs[2]).toBe('device-1') // device_id (from auth)
      expect(bindArgs[3]).toBe('google-calendar:abc') // source_id
      expect(bindArgs[4]).toBe('a'.repeat(64)) // token_hash
      expect(bindArgs[5]).toBe(body.expiresAt) // expires_at
    })

    it('returns 400 when tokenHash is not a 64-char hex digest', async () => {
      // #given
      const env = createEnv(vi.fn())
      const body = {
        channelId: 'ch-1',
        sourceId: 'google-calendar:abc',
        tokenHash: 'not-hex',
        expiresAt: Math.floor(Date.now() / 1000) + 3600
      }

      // #when
      const res = await app.request('/calendar/channels', jsonPost(body), env)

      // #then
      expect(res.status).toBe(400)
    })

    it('returns 400 when expiresAt is not a positive integer', async () => {
      // #given
      const env = createEnv(vi.fn())
      const body = {
        channelId: 'ch-1',
        sourceId: 'google-calendar:abc',
        tokenHash: 'a'.repeat(64),
        expiresAt: -1
      }

      // #when
      const res = await app.request('/calendar/channels', jsonPost(body), env)

      // #then
      expect(res.status).toBe(400)
    })
  })

  describe('PATCH /calendar/channels/:id', () => {
    it('updates resource_id scoped by userId, returns 204', async () => {
      // #given 1 row changed
      const statement = createStatement({ run: vi.fn(async () => ({ meta: { changes: 1 } })) })
      const prepare = vi.fn(() => statement)
      const env = createEnv(prepare)

      // #when
      const res = await app.request('/calendar/channels/ch-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId: 'resource-from-google' })
      }, env)

      // #then
      expect(res.status).toBe(204)
      expect(prepare.mock.calls[0]![0]).toContain('UPDATE google_calendar_channels')
      const bindArgs = statement.bind.mock.calls[0]!
      expect(bindArgs[0]).toBe('resource-from-google') // new resource_id
      expect(bindArgs[1]).toBe('ch-1') // channel_id
      expect(bindArgs[2]).toBe('user-1') // scope by user
    })

    it('returns 404 when no row matches (wrong owner or unknown id)', async () => {
      // #given zero changes
      const statement = createStatement({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })
      const prepare = vi.fn(() => statement)
      const env = createEnv(prepare)

      // #when
      const res = await app.request('/calendar/channels/ch-unknown', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceId: 'x' })
      }, env)

      // #then
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /calendar/channels/:id', () => {
    it('deletes the row scoped by userId, returns 204', async () => {
      // #given
      const statement = createStatement({ run: vi.fn(async () => ({ meta: { changes: 1 } })) })
      const prepare = vi.fn(() => statement)
      const env = createEnv(prepare)

      // #when
      const res = await app.request('/calendar/channels/ch-1', { method: 'DELETE' }, env)

      // #then
      expect(res.status).toBe(204)
      expect(prepare.mock.calls[0]![0]).toContain('DELETE FROM google_calendar_channels')
      const bindArgs = statement.bind.mock.calls[0]!
      expect(bindArgs[0]).toBe('ch-1')
      expect(bindArgs[1]).toBe('user-1')
    })

    it('returns 404 when no row was deleted', async () => {
      // #given
      const statement = createStatement({ run: vi.fn(async () => ({ meta: { changes: 0 } })) })
      const prepare = vi.fn(() => statement)
      const env = createEnv(prepare)

      // #when
      const res = await app.request('/calendar/channels/ch-unknown', { method: 'DELETE' }, env)

      // #then
      expect(res.status).toBe(404)
    })
  })
})
