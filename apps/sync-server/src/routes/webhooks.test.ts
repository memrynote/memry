import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { errorHandler } from '../lib/errors'
import { hashChannelToken } from '../services/google-webhooks'
import type { AppContext } from '../types'

import { webhooks } from './webhooks'

const WEBHOOK_HMAC_KEY = 'test-hmac-key-abcdef012345'

function createApp() {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/webhooks', webhooks)
  return app
}

function createExecutionCtx() {
  return {
    waitUntil: (p: Promise<unknown>) => {
      void p.catch(() => {})
    },
    passThroughOnException: () => {}
  }
}

function createEnv(opts: {
  channelRow?: Record<string, unknown> | null
  broadcastFetch?: ReturnType<typeof vi.fn>
}) {
  const broadcastFetch =
    opts.broadcastFetch ?? vi.fn(async () => new Response(JSON.stringify({ sent: 1 }), { status: 200 }))

  return {
    env: {
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            first: vi.fn(async () => opts.channelRow ?? null)
          }))
        }))
      } as unknown as D1Database,
      STORAGE: {} as R2Bucket,
      USER_SYNC_STATE: {
        idFromName: vi.fn(() => ({ toString: () => 'do-id-stub' })),
        get: vi.fn(() => ({ fetch: broadcastFetch }))
      } as unknown as DurableObjectNamespace,
      LINKING_SESSION: {} as DurableObjectNamespace,
      ENVIRONMENT: 'development',
      JWT_PUBLIC_KEY: 'mock-public-key',
      JWT_PRIVATE_KEY: 'mock-private-key',
      RESEND_API_KEY: 'mock-resend-key',
      OTP_HMAC_KEY: 'mock-otp-key',
      GOOGLE_CLIENT_ID: 'mock-google-client-id',
      GOOGLE_CLIENT_SECRET: 'mock-google-client-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost/callback',
      MIN_APP_VERSION: '1.0.0',
      RECOVERY_DUMMY_SECRET: 'mock-dummy-recovery-secret',
      WEBHOOK_HMAC_KEY
    },
    broadcastFetch
  }
}

function makeChannelRow(overrides: {
  token_hash: string
  expires_at?: number
  source_id?: string
}) {
  return {
    channel_id: 'ch-1',
    user_id: 'user-1',
    device_id: 'device-1',
    source_id: overrides.source_id ?? 'google-calendar:abc',
    resource_id: 'resource-1',
    token_hash: overrides.token_hash,
    expires_at: overrides.expires_at ?? Math.floor(Date.now() / 1000) + 3600
  }
}

describe('POST /webhooks/google-calendar', () => {
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    vi.clearAllMocks()
    app = createApp()
  })

  it('returns 200 without broadcasting when X-Goog-Resource-State=sync (setup ping)', async () => {
    // #given a valid channel and the sync setup ping
    const hash = await hashChannelToken(WEBHOOK_HMAC_KEY, 'secret-token')
    const { env, broadcastFetch } = createEnv({ channelRow: makeChannelRow({ token_hash: hash }) })

    // #when
    const res = await app.request(
      '/webhooks/google-calendar',
      {
        method: 'POST',
        headers: {
          'X-Goog-Channel-Id': 'ch-1',
          'X-Goog-Channel-Token': 'secret-token',
          'X-Goog-Resource-State': 'sync',
          'X-Goog-Resource-Id': 'resource-1'
        }
      },
      env,
      createExecutionCtx()
    )

    // #then
    expect(res.status).toBe(200)
    expect(broadcastFetch).not.toHaveBeenCalled()
  })

  it('fans out to the user DO with type=calendar_changes_available + sourceId when state=exists', async () => {
    // #given
    const hash = await hashChannelToken(WEBHOOK_HMAC_KEY, 'secret-token')
    const { env, broadcastFetch } = createEnv({ channelRow: makeChannelRow({ token_hash: hash }) })

    // #when
    const res = await app.request(
      '/webhooks/google-calendar',
      {
        method: 'POST',
        headers: {
          'X-Goog-Channel-Id': 'ch-1',
          'X-Goog-Channel-Token': 'secret-token',
          'X-Goog-Resource-State': 'exists',
          'X-Goog-Resource-Id': 'resource-1'
        }
      },
      env,
      createExecutionCtx()
    )

    // #then
    expect(res.status).toBe(200)
    expect(broadcastFetch).toHaveBeenCalledTimes(1)
    const forwarded = broadcastFetch.mock.calls[0]![0] as Request
    expect(new URL(forwarded.url).pathname).toBe('/broadcast')
    const forwardedBody = (await forwarded.json()) as Record<string, unknown>
    expect(forwardedBody).toMatchObject({
      type: 'calendar_changes_available',
      sourceId: 'google-calendar:abc',
      excludeDeviceId: ''
    })
  })

  it('returns 401 when the channel id is unknown', async () => {
    // #given
    const { env, broadcastFetch } = createEnv({ channelRow: null })

    // #when
    const res = await app.request(
      '/webhooks/google-calendar',
      {
        method: 'POST',
        headers: {
          'X-Goog-Channel-Id': 'ch-unknown',
          'X-Goog-Channel-Token': 'secret-token',
          'X-Goog-Resource-State': 'exists'
        }
      },
      env,
      createExecutionCtx()
    )

    // #then
    expect(res.status).toBe(401)
    expect(broadcastFetch).not.toHaveBeenCalled()
  })

  it('returns 401 when the channel token hash does not match', async () => {
    // #given the row stores a hash of a different token
    const hash = await hashChannelToken(WEBHOOK_HMAC_KEY, 'real-token')
    const { env, broadcastFetch } = createEnv({ channelRow: makeChannelRow({ token_hash: hash }) })

    // #when the webhook presents a different plaintext
    const res = await app.request(
      '/webhooks/google-calendar',
      {
        method: 'POST',
        headers: {
          'X-Goog-Channel-Id': 'ch-1',
          'X-Goog-Channel-Token': 'attacker-token',
          'X-Goog-Resource-State': 'exists'
        }
      },
      env,
      createExecutionCtx()
    )

    // #then
    expect(res.status).toBe(401)
    expect(broadcastFetch).not.toHaveBeenCalled()
  })

  it('returns 410 when the stored channel has expired', async () => {
    // #given
    const hash = await hashChannelToken(WEBHOOK_HMAC_KEY, 'secret-token')
    const { env, broadcastFetch } = createEnv({
      channelRow: makeChannelRow({ token_hash: hash, expires_at: Math.floor(Date.now() / 1000) - 10 })
    })

    // #when
    const res = await app.request(
      '/webhooks/google-calendar',
      {
        method: 'POST',
        headers: {
          'X-Goog-Channel-Id': 'ch-1',
          'X-Goog-Channel-Token': 'secret-token',
          'X-Goog-Resource-State': 'exists'
        }
      },
      env,
      createExecutionCtx()
    )

    // #then
    expect(res.status).toBe(410)
    expect(broadcastFetch).not.toHaveBeenCalled()
  })

  it('returns 400 when required Google headers are missing', async () => {
    // #given
    const { env, broadcastFetch } = createEnv({ channelRow: null })

    // #when
    const res = await app.request(
      '/webhooks/google-calendar',
      { method: 'POST' },
      env,
      createExecutionCtx()
    )

    // #then
    expect(res.status).toBe(400)
    expect(broadcastFetch).not.toHaveBeenCalled()
  })
})
