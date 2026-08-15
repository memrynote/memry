import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../middleware/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/rate-limit')>()),
  createRateLimiter: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next())
}))

import { app } from '../index'

const VALID_INSTALL_ID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440001'
const VALID_EVENT_ID = '550e8400-e29b-41d4-a716-446655440002'
const VALID_TIMESTAMP = '2026-05-01T12:00:00.000Z'

const sampleEvent = {
  id: VALID_EVENT_ID,
  name: 'app_started',
  occurredAt: VALID_TIMESTAMP,
  surface: 'app',
  action: 'started',
  result: 'success'
}

const sampleBatch = {
  schemaVersion: 1,
  installId: VALID_INSTALL_ID,
  sessionId: VALID_SESSION_ID,
  appVersion: '0.1.0',
  buildChannel: 'development',
  platform: 'darwin',
  arch: 'arm64',
  locale: 'en',
  timezoneOffsetMinutes: -180,
  authState: 'anonymous',
  syncState: 'disabled',
  events: [sampleEvent]
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function createEnv(overrides?: Record<string, unknown>) {
  const env = {
    DB: {} as D1Database,
    STORAGE: {} as R2Bucket,
    USER_SYNC_STATE: {} as DurableObjectNamespace,
    LINKING_SESSION: {} as DurableObjectNamespace,
    TELEMETRY_HMAC_KEY: 'test-hmac-key',
    ENVIRONMENT: 'development',
    ALLOWED_ORIGIN: 'https://app.memry.test',
    JWT_PUBLIC_KEY: '',
    JWT_PRIVATE_KEY: '',
    RESEND_API_KEY: '',
    OTP_HMAC_KEY: '',
    RECOVERY_DUMMY_SECRET: '',
    WEBHOOK_HMAC_KEY: '',
    ...overrides
  }
  return { env }
}

describe('POST /telemetry/batch', () => {
  it('accepts a valid anonymous batch and returns 202 with the accepted count', async () => {
    // #given a valid telemetry batch
    const { env } = createEnv()
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sampleBatch)
    })

    // #when posting through the app
    const response = await app.request(request, {}, env)

    // #then the route accepts the event without authentication
    expect(response.status).toBe(202)
    const body = (await response.json()) as { accepted: number }
    expect(body.accepted).toBe(1)
  })

  it('does not require an Authorization header', async () => {
    // #given a request with no auth header
    const { env } = createEnv()
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sampleBatch)
    })

    // #when posting
    const response = await app.request(request, {}, env)

    // #then the response is a 2xx
    expect(response.status).toBeGreaterThanOrEqual(200)
    expect(response.status).toBeLessThan(300)
  })

  it('returns 400 for invalid payloads', async () => {
    // #given an event missing required fields
    const { env } = createEnv()
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, installId: 'not-a-uuid' })
    })

    // #when posting
    const response = await app.request(request, {}, env)

    // #then validation fails with 400
    expect(response.status).toBe(400)
  })

  it('returns 400 when more than 100 events are submitted', async () => {
    // #given a batch with 101 events
    const events = Array.from({ length: 101 }, (_, i) => ({
      ...sampleEvent,
      id: `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`
    }))
    const { env } = createEnv()
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...sampleBatch, events })
    })

    // #when posting
    const response = await app.request(request, {}, env)

    // #then the schema rejects the oversize event list
    expect(response.status).toBe(400)
  })

  it('logs the failing field path (not its value) when the batch is invalid', async () => {
    // #given an event whose action value trips the privacy dimension guard (contains a slash)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { env } = createEnv()
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...sampleBatch, events: [{ ...sampleEvent, action: 'opened/path' }] })
    })

    // #when posting
    const response = await app.request(request, {}, env)

    // #then it 400s and the log names the offending field but never leaks its value
    expect(response.status).toBe(400)
    const logged = warnSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(logged).toContain('events.0.action')
    expect(logged).not.toContain('opened/path')
    warnSpy.mockRestore()
  })

  it('returns 400 for malformed JSON bodies', async () => {
    // #given an invalid JSON body
    const { env } = createEnv()
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json'
    })

    // #when posting
    const response = await app.request(request, {}, env)

    // #then the route returns 400
    expect(response.status).toBe(400)
  })
})

describe('POST /telemetry/logs', () => {
  const sampleLogLine = {
    ts: VALID_TIMESTAMP,
    level: 'warn' as const,
    scope: 'sync',
    message: 'retrying upload',
    origin: 'main' as const
  }

  const sampleLogBatch = {
    schemaVersion: 1,
    installId: VALID_INSTALL_ID,
    sessionId: VALID_SESSION_ID,
    appVersion: '0.1.0',
    buildChannel: 'development',
    platform: 'darwin',
    arch: 'arm64',
    lines: [sampleLogLine]
  }

  function postLogs(env: Record<string, unknown>, body: unknown) {
    const request = new Request('http://localhost/telemetry/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
    return app.request(request, {}, env)
  }

  it('accepts a valid log batch, returns 202, and pushes lines to PostHog Logs', async () => {
    // #given a valid diagnostic log batch and a configured PostHog target
    const { env } = createEnv({
      POSTHOG_KEY: 'phc_test',
      POSTHOG_HOST: 'https://us.i.posthog.com'
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    // #when posting through the app
    const response = await postLogs(env, sampleLogBatch)

    // #then it 202s with the accepted count and eventually pushes to PostHog Logs
    expect(response.status).toBe(202)
    const body = (await response.json()) as { accepted: number }
    expect(body.accepted).toBe(1)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://us.i.posthog.com/i/v1/logs')
    const parsedBody = JSON.parse((init as { body: string }).body)
    const record = parsedBody.resourceLogs[0].scopeLogs[0].logRecords[0]
    expect(record.attributes).toContainEqual({ key: 'kind', value: { stringValue: 'log' } })
  })

  it('returns 400 for invalid payloads', async () => {
    // #given a batch missing required fields
    const { env } = createEnv()

    // #when posting
    const response = await postLogs(env, { schemaVersion: 1 })

    // #then validation fails with 400
    expect(response.status).toBe(400)
  })

  it('returns 400 for malformed JSON bodies', async () => {
    // #given an invalid JSON body
    const { env } = createEnv()

    // #when posting
    const response = await postLogs(env, 'not-json')

    // #then the route returns 400
    expect(response.status).toBe(400)
  })

  it('still 202s and does not call fetch when PostHog is unconfigured', async () => {
    // #given no POSTHOG_KEY/POSTHOG_HOST
    const { env } = createEnv()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // #when posting a valid batch
    const response = await postLogs(env, sampleLogBatch)

    // #then it still 202s and never calls fetch
    expect(response.status).toBe(202)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('telemetry route + rate limiter', () => {
  it('uses createRateLimiter with the telemetry key prefix', async () => {
    const { createRateLimiter } = await import('../middleware/rate-limit')
    expect(createRateLimiter).toHaveBeenCalledWith(
      expect.objectContaining({ keyPrefix: 'telemetry' })
    )
  })

  it('uses createRateLimiter with the telemetry-logs key prefix', async () => {
    const { createRateLimiter } = await import('../middleware/rate-limit')
    expect(createRateLimiter).toHaveBeenCalledWith(
      expect.objectContaining({ keyPrefix: 'telemetry-logs' })
    )
  })
})

describe('POST /telemetry/batch → PostHog', () => {
  it('captures each event via PostHog', async () => {
    // #given PostHog configured
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const { env } = createEnv({
      POSTHOG_KEY: 'phc_test',
      POSTHOG_HOST: 'https://us.i.posthog.com'
    })
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        installId: '11111111-1111-4111-8111-111111111111',
        sessionId: '22222222-2222-4222-8222-222222222222',
        appVersion: '2026.7.1',
        buildChannel: 'production',
        platform: 'darwin',
        arch: 'arm64',
        locale: 'tr-TR',
        timezoneOffsetMinutes: 180,
        authState: 'anonymous',
        syncState: 'enabled',
        events: [
          {
            id: '33333333-3333-4333-8333-333333333333',
            name: 'note_created',
            occurredAt: '2026-07-22T10:00:00.000Z',
            surface: 'notes',
            action: 'create'
          }
        ]
      })
    })

    // #when posting through the app
    const response = await app.request(request, {}, env)

    // #then it captures via PostHog
    expect(response.status).toBe(202)
    const captureCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/batch/'))
    expect(captureCall).toBeDefined()
    const body = JSON.parse((captureCall?.[1] as RequestInit).body as string)
    expect(body.batch.map((e: { event: string }) => e.event)).toContain('note_created')
  })
})
