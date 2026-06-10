import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next())
}))

vi.mock('../lib/jwt-verify', () => ({
  verifyAccessToken: vi.fn(),
  JwtKeyError: class JwtKeyError extends Error {}
}))

import { app } from '../index'
import { verifyAccessToken } from '../lib/jwt-verify'

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

function createDataset() {
  const writeDataPoint = vi.fn()
  const dataset = { writeDataPoint } as unknown as AnalyticsEngineDataset
  return { dataset, writeDataPoint }
}

function createEnv(overrides?: Record<string, unknown>) {
  const { dataset, writeDataPoint } = createDataset()
  const env = {
    DB: {} as D1Database,
    STORAGE: {} as R2Bucket,
    USER_SYNC_STATE: {} as DurableObjectNamespace,
    LINKING_SESSION: {} as DurableObjectNamespace,
    PRODUCT_TELEMETRY: dataset,
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
  return { env, writeDataPoint }
}

describe('POST /telemetry/batch', () => {
  it('accepts a valid anonymous batch and returns 202 with the accepted count', async () => {
    // #given a valid telemetry batch and a wired analytics dataset
    const { env, writeDataPoint } = createEnv()
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
    expect(writeDataPoint).toHaveBeenCalledTimes(1)
  })

  it('schedules PostHog mirroring in waitUntil without blocking the response', async () => {
    // #given a PostHog mirror that has not resolved yet
    const { env } = createEnv({
      POSTHOG_API_KEY: 'phc_test_project',
      POSTHOG_HOST: 'https://us.i.posthog.com'
    })
    let resolveFetch: (() => void) | undefined
    const fetchPromise = new Promise<Response>((resolve) => {
      resolveFetch = () => resolve(new Response(JSON.stringify({ status: 1 }), { status: 200 }))
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => fetchPromise)
    )

    const waitUntilPromises: Promise<unknown>[] = []
    const executionCtx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waitUntilPromises.push(promise)
      })
    } as unknown as ExecutionContext
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sampleBatch)
    })

    // #when posting through the route
    const responsePromise = Promise.resolve(app.request(request, {}, env, executionCtx))
    const result = await Promise.race([
      responsePromise,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 25))
    ])
    resolveFetch?.()
    await responsePromise.catch(() => undefined)

    // #then the request is accepted before PostHog finishes
    expect(result).not.toBe('timeout')
    expect((result as Response).status).toBe(202)
    expect(executionCtx.waitUntil).toHaveBeenCalledWith(expect.any(Promise))
    expect(waitUntilPromises).toHaveLength(1)
    await Promise.all(waitUntilPromises)
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

describe('telemetry route + rate limiter', () => {
  it('uses createRateLimiter with the telemetry key prefix', async () => {
    const { createRateLimiter } = await import('../middleware/rate-limit')
    expect(createRateLimiter).toHaveBeenCalledWith(
      expect.objectContaining({ keyPrefix: 'telemetry' })
    )
  })
})

const readFetchJson = <T>(fetchMock: ReturnType<typeof vi.fn>, path: string): T => {
  const call = fetchMock.mock.calls.find((args: unknown[]) => String(args[0]).includes(path))
  expect(call).toBeDefined()
  const init = call?.[1] as RequestInit | undefined
  expect(init?.body).toBeDefined()
  return JSON.parse(init?.body as string) as T
}

describe('POST /telemetry/batch — optional bearer verification', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.mocked(verifyAccessToken).mockReset()
  })

  it('uses verified userId as PostHog distinct_id when bearer token is valid', async () => {
    // #given a valid token that resolves to user_123
    vi.mocked(verifyAccessToken).mockResolvedValue({
      userId: 'user_123',
      deviceId: 'dev_1',
      exp: 9999999999
    })
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const { env } = createEnv({
      POSTHOG_API_KEY: 'phc_test',
      POSTHOG_HOST: 'https://us.i.posthog.com',
      JWT_PUBLIC_KEY: 'pk'
    })
    const waitUntilPromises: Promise<unknown>[] = []
    const executionCtx = {
      waitUntil: vi.fn((p: Promise<unknown>) => {
        waitUntilPromises.push(p)
      })
    } as unknown as ExecutionContext
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-token' },
      body: JSON.stringify(sampleBatch)
    })

    // #when posting
    const response = await app.request(request, {}, env, executionCtx)

    // #then 202 and PostHog payload uses user_123 as distinct_id
    expect(response.status).toBe(202)
    await Promise.all(waitUntilPromises)
    expect(fetchMock).toHaveBeenCalled()
    const body = readFetchJson<{ batch: Array<{ event: string; distinct_id: string }> }>(
      fetchMock,
      '/batch/'
    )
    const nonIdentify = body.batch.filter((e) => e.event !== '$identify')
    for (const event of nonIdentify) {
      expect(event.distinct_id).toBe('user_123')
    }
    const identify = body.batch.find((e) => e.event === '$identify')
    expect(identify).toBeDefined()
  })

  it('falls back to anonymous path when bearer token is invalid', async () => {
    // #given a token that fails verification
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('Token has expired'))
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const { env } = createEnv({
      POSTHOG_API_KEY: 'phc_test',
      POSTHOG_HOST: 'https://us.i.posthog.com',
      JWT_PUBLIC_KEY: 'pk'
    })
    const waitUntilPromises: Promise<unknown>[] = []
    const executionCtx = {
      waitUntil: vi.fn((p: Promise<unknown>) => {
        waitUntilPromises.push(p)
      })
    } as unknown as ExecutionContext
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bad-token' },
      body: JSON.stringify(sampleBatch)
    })

    // #when posting
    const response = await app.request(request, {}, env, executionCtx)

    // #then still 202, no $identify, install-hash distinct_id
    expect(response.status).toBe(202)
    await Promise.all(waitUntilPromises)
    expect(fetchMock).toHaveBeenCalled()
    const body = readFetchJson<{ batch: Array<{ event: string; distinct_id: string }> }>(
      fetchMock,
      '/batch/'
    )
    const identify = body.batch.find((e) => e.event === '$identify')
    expect(identify).toBeUndefined()
    for (const event of body.batch) {
      expect(event.distinct_id).not.toBe('user_123')
    }
  })

  it('accepts batch without Authorization header — anonymous path unchanged', async () => {
    // #given no Authorization header
    const { env } = createEnv()
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sampleBatch)
    })

    // #when posting
    const response = await app.request(request, {}, env)

    // #then 202, verifyAccessToken never called
    expect(response.status).toBe(202)
    expect(vi.mocked(verifyAccessToken)).not.toHaveBeenCalled()
  })

  it('empty token after "Bearer " — Headers trims trailing space, treated as no token, 202 anonymous', async () => {
    // #given Authorization: 'Bearer ' — the Headers API trims trailing whitespace, storing 'Bearer'
    // which does not match the 'Bearer ' prefix check, so we fall through to the anonymous path
    const { env } = createEnv({ JWT_PUBLIC_KEY: 'pk' })
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' },
      body: JSON.stringify(sampleBatch)
    })

    // #when posting
    const response = await app.request(request, {}, env)

    // #then 'Bearer' (trimmed) fails startsWith('Bearer '), verifyAccessToken never called, still 202
    expect(response.status).toBe(202)
    expect(vi.mocked(verifyAccessToken)).not.toHaveBeenCalled()
  })

  it('lowercase "bearer" scheme — treated as no token, verifyAccessToken never called, 202', async () => {
    // #given Authorization: 'bearer good-token' (wrong casing)
    const { env } = createEnv({ JWT_PUBLIC_KEY: 'pk' })
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'bearer good-token' },
      body: JSON.stringify(sampleBatch)
    })

    // #when posting
    const response = await app.request(request, {}, env)

    // #then the header is ignored entirely — anonymous path, no JWT call
    expect(response.status).toBe(202)
    expect(vi.mocked(verifyAccessToken)).not.toHaveBeenCalled()
  })

  it('double space after "Bearer" — verifyAccessToken called with leading-space token, 202 anonymous', async () => {
    // #given Authorization: 'Bearer  good-token' (two spaces after Bearer)
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('invalid token'))
    const { env } = createEnv({ JWT_PUBLIC_KEY: 'pk' })
    const request = new Request('http://localhost/telemetry/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer  good-token' },
      body: JSON.stringify(sampleBatch)
    })

    // #when posting
    const response = await app.request(request, {}, env)

    // #then verifyAccessToken receives the token with its leading space and we still get 202
    expect(response.status).toBe(202)
    expect(vi.mocked(verifyAccessToken)).toHaveBeenCalledWith(' good-token', 'pk')
  })
})
