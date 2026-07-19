import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next())
}))

import { app } from '../index'

const VALID_INSTALL_ID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_SESSION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

const validReport = {
  schemaVersion: 1,
  installId: VALID_INSTALL_ID,
  sessionId: VALID_SESSION_ID,
  appVersion: '2026.7.18',
  buildChannel: 'production',
  platform: 'linux',
  arch: 'x64',
  incidentId: 'MEMRY-AB12CD34',
  trigger: { source: 'boundary' },
  snapshot: {
    appVersion: '1',
    buildChannel: 'production',
    platform: 'linux',
    arch: 'x64',
    locale: 'en',
    uptimeSeconds: 1,
    syncEnabled: false,
    syncState: 'disabled',
    queueDepth: 0,
    vaultOpen: true,
    authState: 'anonymous'
  },
  lines: []
}

function createEnv(overrides?: Record<string, unknown>) {
  return {
    DB: {} as D1Database,
    TELEMETRY_HMAC_KEY: 'test-hmac-key',
    ENVIRONMENT: 'development',
    LOKI_URL: 'https://grafana.example.com',
    LOKI_TOKEN: 'tok',
    ...overrides
  }
}

function postReport(env: Record<string, unknown>, body: unknown) {
  const request = new Request('http://localhost/diagnostics/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
  return app.request(request, {}, env)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /diagnostics/report', () => {
  it('202s and pushes a report to Loki', async () => {
    // #given a valid diagnostic report and a configured Loki target
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    // #when posting through the app
    const response = await postReport(createEnv(), validReport)

    // #then it 202s with the incidentId and eventually pushes to Loki
    expect(response.status).toBe(202)
    expect((await response.json()) as { incidentId: string }).toEqual({
      incidentId: 'MEMRY-AB12CD34'
    })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('grafana.example.com')
    const parsedBody = JSON.parse((init as { body: string }).body)
    expect(parsedBody.streams[0].stream).toMatchObject({ kind: 'report' })
  })

  it('returns 400 on invalid payload', async () => {
    // #given a payload that does not match DiagnosticReportSchema
    const response = await postReport(createEnv(), { bad: true })

    // #then validation fails with 400
    expect(response.status).toBe(400)
  })

  it('returns 400 for malformed JSON bodies', async () => {
    // #given an invalid JSON body
    const response = await postReport(createEnv(), 'not-json')

    // #then the route returns 400
    expect(response.status).toBe(400)
  })

  it('still 202s (no-op) when Loki is unconfigured', async () => {
    // #given no LOKI_URL/LOKI_TOKEN
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // #when posting a valid report
    const response = await postReport(
      createEnv({ LOKI_URL: undefined, LOKI_TOKEN: undefined }),
      validReport
    )

    // #then it still 202s and never calls fetch
    expect(response.status).toBe(202)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('diagnostics route + rate limiter', () => {
  it('uses createRateLimiter with the diagnostics key prefix', async () => {
    const { createRateLimiter } = await import('../middleware/rate-limit')
    expect(createRateLimiter).toHaveBeenCalledWith(
      expect.objectContaining({ keyPrefix: 'diagnostics' })
    )
  })
})
