import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../middleware/rate-limit', () => ({
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

function createDataset() {
  const writeDataPoint = vi.fn()
  const dataset = { writeDataPoint } as unknown as AnalyticsEngineDataset
  return { dataset, writeDataPoint }
}

function createEnv(overrides?: Record<string, unknown>) {
  const { dataset, writeDataPoint } = createDataset()
  const landing = createDataset()
  const env = {
    DB: {} as D1Database,
    STORAGE: {} as R2Bucket,
    USER_SYNC_STATE: {} as DurableObjectNamespace,
    LINKING_SESSION: {} as DurableObjectNamespace,
    PRODUCT_TELEMETRY: dataset,
    LANDING_TELEMETRY: landing.dataset,
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
  return { env, writeDataPoint, writeLandingDataPoint: landing.writeDataPoint }
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

describe('POST /telemetry/web', () => {
  const VALID_VISITOR_ID = '550e8400-e29b-41d4-a716-446655440003'

  const sampleWebEvent = {
    name: 'landing_pricing_cta_click',
    page: '/pricing',
    target: 'pricing:plus',
    utm_source: 'waitlist',
    utm_medium: 'email'
  }

  const sampleWebBatch = {
    visitorId: VALID_VISITOR_ID,
    events: [sampleWebEvent]
  }

  function postWeb(env: Record<string, unknown>, body: unknown) {
    const request = new Request('http://localhost/telemetry/web', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
    return app.request(request, {}, env)
  }

  it('accepts a valid batch and writes one landing datapoint per event', async () => {
    // #given a valid landing batch with two events
    const { env, writeDataPoint, writeLandingDataPoint } = createEnv()

    // #when posting through the app without authentication
    const response = await postWeb(env, {
      ...sampleWebBatch,
      events: [sampleWebEvent, { name: 'landing_page_view', page: '/' }]
    })

    // #then it 202s and writes to LANDING_TELEMETRY only
    expect(response.status).toBe(202)
    const body = (await response.json()) as { accepted: number }
    expect(body.accepted).toBe(2)
    expect(writeLandingDataPoint).toHaveBeenCalledTimes(2)
    expect(writeDataPoint).not.toHaveBeenCalled()
  })

  it('writes the documented blob layout and a hashed visitor index', async () => {
    // #given a valid batch with every UTM field set
    const { env, writeLandingDataPoint } = createEnv()

    // #when posting
    const response = await postWeb(env, {
      ...sampleWebBatch,
      events: [{ ...sampleWebEvent, utm_campaign: 'launch', utm_content: 'cta', utm_term: 'notes' }]
    })

    // #then blob1..blob8 follow the layout and index1 never holds the raw id
    expect(response.status).toBe(202)
    const point = writeLandingDataPoint.mock.calls[0][0] as {
      blobs: string[]
      doubles: number[]
      indexes: string[]
    }
    expect(point.blobs).toEqual([
      'landing_pricing_cta_click',
      '/pricing',
      'pricing:plus',
      'waitlist',
      'email',
      'launch',
      'cta',
      'notes'
    ])
    expect(point.doubles).toEqual([1])
    expect(point.indexes).toHaveLength(1)
    expect(point.indexes[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(point.indexes[0]).not.toContain(VALID_VISITOR_ID)
  })

  it('returns 400 for invalid payloads', async () => {
    // #given a batch missing its events
    const { env, writeLandingDataPoint } = createEnv()

    // #when posting
    const response = await postWeb(env, { visitorId: 'not-a-uuid' })

    // #then validation fails with 400 and nothing is written
    expect(response.status).toBe(400)
    expect(writeLandingDataPoint).not.toHaveBeenCalled()
  })

  it('rejects values that look like emails, URLs, or raw identifiers', async () => {
    // #given events whose values trip the privacy guards
    const { env, writeLandingDataPoint } = createEnv()
    const badEvents = [
      { name: 'landing_nav_click', page: '/pricing', target: 'user@example.com' },
      { name: 'landing_nav_click', page: '/pricing', utm_source: 'https://evil.example' },
      { name: 'landing_nav_click', page: `/note/${VALID_VISITOR_ID}` }
    ]

    // #when posting each
    for (const event of badEvents) {
      const response = await postWeb(env, { ...sampleWebBatch, events: [event] })

      // #then the schema rejects it with 400
      expect(response.status).toBe(400)
    }
    expect(writeLandingDataPoint).not.toHaveBeenCalled()
  })

  it('returns 400 for malformed JSON bodies', async () => {
    // #given an invalid JSON body
    const { env } = createEnv()

    // #when posting
    const response = await postWeb(env, 'not-json')

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

  it('uses createRateLimiter with the telemetry-web key prefix', async () => {
    const { createRateLimiter } = await import('../middleware/rate-limit')
    expect(createRateLimiter).toHaveBeenCalledWith(
      expect.objectContaining({ keyPrefix: 'telemetry-web' })
    )
  })
})
