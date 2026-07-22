import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { errorHandler } from '../lib/errors'
import { hashChannelToken } from '../services/google-webhooks'
import { hashTelemetryId } from '../services/telemetry'
import type { AppContext } from '../types'

import { webhooks } from './webhooks'

const WEBHOOK_HMAC_KEY = 'test-hmac-key-abcdef012345'
const PADDLE_WEBHOOK_SECRET = 'paddle-secret'
const TELEMETRY_HMAC_KEY = 'test-telemetry-hmac-key'

function createApp() {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/webhooks', webhooks)
  return app
}

function createExecutionCtx(): ExecutionContext {
  return {
    waitUntil: (p: Promise<unknown>) => {
      void p.catch(() => {})
    },
    passThroughOnException: () => {},
    props: {}
  }
}

function createEnv(opts: {
  channelRow?: Record<string, unknown> | null
  broadcastFetch?: ReturnType<typeof vi.fn>
}) {
  const broadcastFetch =
    opts.broadcastFetch ??
    vi.fn(async () => new Response(JSON.stringify({ sent: 1 }), { status: 200 }))

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
      WEBHOOK_HMAC_KEY,
      PADDLE_WEBHOOK_SECRET: 'paddle-secret',
      PADDLE_CHECKOUT_TOKEN_SECRET: 'checkout-secret'
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

function createPaddleDb() {
  const statements: Array<{ sql: string; bindings: unknown[] }> = []
  const db = {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        bindings: [] as unknown[],
        bind: vi.fn((...args: unknown[]) => {
          stmt.bindings = args
          statements.push({ sql, bindings: args })
          return stmt
        }),
        first: vi.fn(async () => {
          if (sql.includes('FROM paddle_webhook_events')) return null
          if (sql.includes('FROM users')) return { id: 'user-1' }
          if (sql.includes('FROM sync_entitlements')) return null
          return null
        }),
        run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } })
      }
      return stmt
    })
  }
  return { db: db as unknown as D1Database, statements }
}

function createPaddleEnv(db: D1Database) {
  const { env } = createEnv({})
  return {
    ...env,
    DB: db,
    PADDLE_WEBHOOK_SECRET,
    TELEMETRY_HMAC_KEY,
    POSTHOG_KEY: 'phc_test',
    POSTHOG_HOST: 'https://us.i.posthog.com'
  }
}

async function signPaddleBody(secret: string, timestamp: number, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}:${rawBody}`)
  )
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

describe('POST /webhooks/paddle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hashes paddle_customer_id before it reaches the PostHog wire', async () => {
    // #given a valid, signed transaction.completed event carrying a customer id
    const app = createApp()
    const { db } = createPaddleDb()
    const env = createPaddleEnv(db)
    const rawBody = JSON.stringify({
      event_id: 'evt_1',
      event_type: 'transaction.completed',
      data: {
        id: 'txn_1',
        customer_id: 'ctm_raw_customer_id',
        subscription_id: 'sub_1',
        status: 'completed',
        custom_data: { app: 'memry', entitlement: 'sync', plan: 'plus', userId: 'user-1' }
      }
    })
    const timestamp = Math.floor(Date.now() / 1000)
    const signature = await signPaddleBody(PADDLE_WEBHOOK_SECRET, timestamp, rawBody)

    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    // #when the webhook is processed
    const res = await app.request(
      '/webhooks/paddle',
      {
        method: 'POST',
        headers: {
          'Paddle-Signature': `ts=${timestamp};h1=${signature}`,
          'content-type': 'application/json'
        },
        body: rawBody
      },
      env,
      createExecutionCtx()
    )
    expect(res.status).toBe(200)

    // waitUntil in the test execution context is fire-and-forget; poll for it
    // rather than assuming a fixed number of microtask ticks.
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled()
    })

    // #then the raw customer id never reaches the PostHog wire — only its hash
    const businessEventCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/batch/'))
    expect(businessEventCall).toBeDefined()
    const body = JSON.parse((businessEventCall![1] as RequestInit).body as string)
    const expectedHash = await hashTelemetryId(TELEMETRY_HMAC_KEY, 'ctm_raw_customer_id')
    expect(body.batch[0].properties.paddle_customer_id).toBe(expectedHash)
    expect(body.batch[0].properties.paddle_customer_id).not.toBe('ctm_raw_customer_id')
    expect(JSON.stringify(body)).not.toContain('ctm_raw_customer_id')
  })
})

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
      channelRow: makeChannelRow({
        token_hash: hash,
        expires_at: Math.floor(Date.now() / 1000) - 10
      })
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
