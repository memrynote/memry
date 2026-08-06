import { afterEach, describe, expect, it, vi } from 'vitest'

import worker, { app } from './index'

const ONE_MB = 1024 * 1024
const TEN_MB = 10 * ONE_MB

function createEnv(overrides?: Partial<Record<string, unknown>>) {
  return {
    DB: {} as D1Database,
    STORAGE: {} as R2Bucket,
    USER_SYNC_STATE: {} as DurableObjectNamespace,
    LINKING_SESSION: {} as DurableObjectNamespace,
    ENVIRONMENT: 'development',
    ALLOWED_ORIGIN: 'https://app.memry.test',
    JWT_PUBLIC_KEY: '',
    JWT_PRIVATE_KEY: '',
    RESEND_API_KEY: '',
    OTP_HMAC_KEY: '',
    RECOVERY_DUMMY_SECRET: '',
    WEBHOOK_HMAC_KEY: '',
    PADDLE_WEBHOOK_SECRET: '',
    PADDLE_CHECKOUT_TOKEN_SECRET: '',
    PADDLE_API_KEY: '',
    TELEMETRY_HMAC_KEY: '',
    ...overrides
  }
}

describe('sync-server app entry point', () => {
  it('returns health metadata in development even when secrets are missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await app.request('http://localhost/health', {}, createEnv())

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(warnSpy).toHaveBeenCalled()
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('fails fast outside development when required secrets are missing', async () => {
    const response = await app.request(
      'http://localhost/health',
      {},
      createEnv({
        ENVIRONMENT: 'production',
        JWT_PUBLIC_KEY: '',
        JWT_PRIVATE_KEY: '',
        RESEND_API_KEY: ''
      })
    )

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error'
      }
    })
  })

  it('succeeds in production when required secrets are present', async () => {
    const response = await app.request(
      'http://localhost/health',
      {
        headers: {
          Origin: 'https://app.memry.test'
        }
      },
      createEnv({
        ENVIRONMENT: 'production',
        JWT_PUBLIC_KEY: 'public-key',
        JWT_PRIVATE_KEY: 'private-key',
        RESEND_API_KEY: 'resend-key',
        OTP_HMAC_KEY: 'test-hmac-key',
        RECOVERY_DUMMY_SECRET: 'test-dummy-secret',
        WEBHOOK_HMAC_KEY: 'test-webhook-hmac-key',
        PADDLE_WEBHOOK_SECRET: 'test-paddle-webhook-secret',
        PADDLE_CHECKOUT_TOKEN_SECRET: 'test-checkout-token-secret',
        PADDLE_API_KEY: 'test-paddle-api-key',
        TELEMETRY_HMAC_KEY: 'test-telemetry-hmac-key',
        ALLOWED_ORIGIN: 'https://app.memry.test'
      })
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(response.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains'
    )
  })

  it('fails fast in production when TELEMETRY_HMAC_KEY is missing', async () => {
    const response = await app.request(
      'http://localhost/health',
      {},
      createEnv({
        ENVIRONMENT: 'production',
        JWT_PUBLIC_KEY: 'public-key',
        JWT_PRIVATE_KEY: 'private-key',
        RESEND_API_KEY: 'resend-key',
        OTP_HMAC_KEY: 'test-hmac-key',
        RECOVERY_DUMMY_SECRET: 'test-dummy-secret',
        WEBHOOK_HMAC_KEY: 'test-webhook-hmac-key',
        PADDLE_WEBHOOK_SECRET: 'test-paddle-webhook-secret',
        PADDLE_CHECKOUT_TOKEN_SECRET: 'test-checkout-token-secret',
        PADDLE_API_KEY: 'test-paddle-api-key',
        TELEMETRY_HMAC_KEY: ''
      })
    )

    expect(response.status).toBe(500)
  })

  it('rejects oversized telemetry bodies above 128KB', async () => {
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new Uint8Array(128 * 1024 + 1)
    })

    const response = await app.request(request, {}, createEnv())

    expect(response.status).toBe(413)
    const body = await response.json()
    expect(body).toEqual({
      error: {
        code: 'VALIDATION_BODY_TOO_LARGE',
        message: 'Request body too large'
      }
    })
  })

  it('rejects oversized API bodies even when Content-Length is omitted', async () => {
    const request = new Request('http://localhost/health', {
      method: 'POST',
      body: new Uint8Array(ONE_MB + 1)
    })
    expect(request.headers.get('Content-Length')).toBeNull()

    const response = await app.request(request, {}, createEnv())

    expect(response.status).toBe(413)
    const body = await response.json()
    expect(body).toEqual({
      error: {
        code: 'VALIDATION_BODY_TOO_LARGE',
        message: 'Request body too large'
      }
    })
  })

  it('rejects oversized blob bodies even when Content-Length is omitted', async () => {
    const request = new Request('http://localhost/sync/blob/blob-key', {
      method: 'PUT',
      body: new Uint8Array(TEN_MB + 1)
    })
    expect(request.headers.get('Content-Length')).toBeNull()

    const response = await app.request(request, {}, createEnv())

    expect(response.status).toBe(413)
    const body = await response.json()
    expect(body).toEqual({
      error: {
        code: 'VALIDATION_BODY_TOO_LARGE',
        message: 'Request body too large'
      }
    })
  })

  it('uses a larger body limit for blob routes', async () => {
    const request = new Request('http://localhost/sync/blob/blob-key', {
      method: 'PUT',
      body: new Uint8Array(2 * ONE_MB)
    })

    const response = await app.request(request, {}, createEnv())

    expect(response.status).toBe(401)
    const body = await response.json()
    expect(body).toEqual({
      error: {
        code: 'AUTH_INVALID_TOKEN',
        message: 'Missing or malformed Authorization header'
      }
    })
  })
})

describe('scheduled cleanup', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('captures each failed cleanup task to PostHog', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const env = createEnv({
      DB: {
        prepare: vi.fn(() => {
          throw new Error('D1 down')
        }),
        batch: vi.fn().mockRejectedValue(new Error('D1 down'))
      },
      ENVIRONMENT: 'test',
      POSTHOG_KEY: 'phc_test',
      POSTHOG_HOST: 'https://us.i.posthog.com'
    })

    await worker.scheduled(
      {} as never,
      env as never,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as never
    )

    // all 8 cleanup tasks fail against the broken DB — each must reach PostHog
    // Logs (redacted detail) and PostHog events (server_error_seen), one of each per failure.
    const logCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/logs'))
    const eventCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/batch/'))
    expect(logCalls).toHaveLength(8)
    expect(eventCalls).toHaveLength(8)
    const body = JSON.parse((logCalls[0][1] as RequestInit).body as string)
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0]
    expect(record.severityText).toBe('error')
    const line = JSON.parse(record.body.stringValue)
    expect(line.source).toBe('cron')
    expect(line.action).toMatch(/^cleanup_/)
    expect(line.message).toBe('D1 down')
  })

  it('pulls release download counts only on the daily trigger', async () => {
    // #given a GitHub API that answers and a DB that does not
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          String(url).startsWith('https://api.github.com/')
            ? new Response(
                JSON.stringify([
                  { tag_name: 'v1', assets: [{ id: 1, name: 'a.dmg', download_count: 5 }] }
                ]),
                { status: 200 }
              )
            : new Response('{}', { status: 200 })
        )
      )
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const env = createEnv({
      DB: {
        prepare: vi.fn(() => {
          throw new Error('D1 down')
        }),
        batch: vi.fn().mockRejectedValue(new Error('D1 down'))
      },
      ENVIRONMENT: 'test',
      POSTHOG_KEY: 'phc_test',
      POSTHOG_HOST: 'https://us.i.posthog.com'
    })
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as never

    // #when the 6-hourly trigger fires
    await worker.scheduled({ cron: '0 */6 * * *' } as never, env as never, ctx)

    // #then the GitHub API is not touched — only the 8 cleanups ran
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://api.github.com/'))
    ).toHaveLength(0)

    // #when the daily trigger fires
    fetchMock.mockClear()
    await worker.scheduled({ cron: '0 4 * * *' } as never, env as never, ctx)

    // #then the release pull runs and its D1 failure is reported under its own action
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).startsWith('https://api.github.com/'))
    ).toHaveLength(1)
    const actions = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/v1/logs'))
      .map(([, init]) => {
        const body = JSON.parse((init as RequestInit).body as string)
        return JSON.parse(body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue).action
      })
    expect(actions).toContain('release_download_counts')
    expect(actions).toHaveLength(9)
  })
})
