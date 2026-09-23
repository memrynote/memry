import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorHandler } from '../lib/errors'
import type { AppContext } from '../types'

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1')
    c.set('deviceId', 'device-1')
    await next()
  }
}))

import { hashChannelToken } from '../services/google-webhooks'
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

type PrepareFn = (sql: string) => ReturnType<typeof createStatement>

function createEnv(
  prepareImpl: ReturnType<typeof vi.fn<PrepareFn>>,
  batchImpl: ReturnType<typeof vi.fn> = vi.fn(async () => [])
) {
  return {
    DB: {
      prepare: prepareImpl,
      batch: batchImpl
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
    function registerSetup() {
      const statements: Array<{ sql: string; statement: ReturnType<typeof createStatement> }> = []
      const prepare = vi.fn<PrepareFn>((sql) => {
        const statement = createStatement()
        statements.push({ sql, statement })
        return statement
      })
      const batch = vi.fn(async (_statements: unknown[]) => [])
      const env = createEnv(prepare, batch)
      const insert = () => statements.find((s) => s.sql.includes('INSERT INTO'))!
      const del = () => statements.find((s) => s.sql.includes('DELETE FROM'))!
      return { env, batch, insert, del }
    }

    const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60

    it('hashes a plaintext token server-side and stores only the HMAC', async () => {
      // #given a registration carrying the plaintext token
      const { env, batch, insert } = registerSetup()
      const token = 'b'.repeat(64)
      const body = { channelId: 'ch-1', sourceId: 'google-calendar:abc', token, expiresAt }

      // #when
      const res = await app.request('/calendar/channels', jsonPost(body), env)

      // #then the row carries HMAC(WEBHOOK_HMAC_KEY, token), never the token itself
      expect(res.status).toBe(201)
      expect(await res.json()).toMatchObject({ channelId: 'ch-1', expiresAt })
      expect(batch).toHaveBeenCalledTimes(1)
      const bindArgs = insert().statement.bind.mock.calls[0]!
      expect(bindArgs[0]).toBe('ch-1') // channel_id
      expect(bindArgs[1]).toBe('user-1') // user_id (from auth)
      expect(bindArgs[2]).toBe('device-1') // device_id (from auth)
      expect(bindArgs[3]).toBe('google-calendar:abc') // source_id
      expect(bindArgs[4]).toBe(await hashChannelToken('k', token)) // token_hash
      expect(bindArgs).not.toContain(token)
      expect(bindArgs[5]).toBe(expiresAt) // expires_at
    })

    it('still accepts the legacy client-computed tokenHash', async () => {
      // #given an older desktop build that hashed client-side
      const { env, insert } = registerSetup()
      const body = {
        channelId: 'ch-1',
        sourceId: 'google-calendar:abc',
        tokenHash: 'a'.repeat(64),
        expiresAt
      }

      // #when
      const res = await app.request('/calendar/channels', jsonPost(body), env)

      // #then the hash is stored as-is
      expect(res.status).toBe(201)
      expect(insert().statement.bind.mock.calls[0]![4]).toBe('a'.repeat(64))
    })

    it('replaces prior channels for the same user, device and source in the same batch', async () => {
      // #given
      const { env, batch, del, insert } = registerSetup()
      const body = {
        channelId: 'ch-2',
        sourceId: 'google-calendar:abc',
        token: 'c'.repeat(64),
        expiresAt
      }

      // #when
      await app.request('/calendar/channels', jsonPost(body), env)

      // #then the delete runs before the insert, atomically
      expect(del().statement.bind.mock.calls[0]).toEqual([
        'user-1',
        'device-1',
        'google-calendar:abc'
      ])
      expect(batch.mock.calls[0]![0]).toEqual([del().statement, insert().statement])
    })

    it.each([
      ['neither token nor tokenHash', {}],
      ['both token and tokenHash', { token: 'b'.repeat(64), tokenHash: 'a'.repeat(64) }],
      ['a token that is not 64-char hex', { token: 'short' }],
      ['a tokenHash that is not 64-char hex', { tokenHash: 'not-hex' }]
    ])('returns 400 for %s', async (_label, tokenFields) => {
      // #given
      const { env, batch } = registerSetup()
      const body = { channelId: 'ch-1', sourceId: 'google-calendar:abc', expiresAt, ...tokenFields }

      // #when
      const res = await app.request('/calendar/channels', jsonPost(body), env)

      // #then
      expect(res.status).toBe(400)
      expect(batch).not.toHaveBeenCalled()
    })

    it('returns 400 when expiresAt is not a positive integer', async () => {
      // #given
      const { env } = registerSetup()
      const body = {
        channelId: 'ch-1',
        sourceId: 'google-calendar:abc',
        token: 'b'.repeat(64),
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
      const prepare = vi.fn<PrepareFn>(() => statement)
      const env = createEnv(prepare)

      // #when
      const res = await app.request(
        '/calendar/channels/ch-1',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resourceId: 'resource-from-google' })
        },
        env
      )

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
      const prepare = vi.fn<PrepareFn>(() => statement)
      const env = createEnv(prepare)

      // #when
      const res = await app.request(
        '/calendar/channels/ch-unknown',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resourceId: 'x' })
        },
        env
      )

      // #then
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /calendar/channels/:id', () => {
    it('deletes the row scoped by userId, returns 204', async () => {
      // #given
      const statement = createStatement({ run: vi.fn(async () => ({ meta: { changes: 1 } })) })
      const prepare = vi.fn<PrepareFn>(() => statement)
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
      const prepare = vi.fn<PrepareFn>(() => statement)
      const env = createEnv(prepare)

      // #when
      const res = await app.request('/calendar/channels/ch-unknown', { method: 'DELETE' }, env)

      // #then
      expect(res.status).toBe(404)
    })
  })
})
