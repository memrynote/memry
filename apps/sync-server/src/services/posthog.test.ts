import { afterEach, describe, expect, it, vi } from 'vitest'

import { redactSensitive } from '@memry/contracts/telemetry-api'

import {
  captureBusinessEvent,
  captureServerError,
  captureServerLog,
  toPostHogExceptionEvent,
  waitUntilWithPostHog
} from './posthog'

const env = {
  POSTHOG_API_KEY: 'phc_test_project',
  POSTHOG_HOST: 'https://us.i.posthog.com/',
  ENVIRONMENT: 'development'
}

const UUID = '550e8400-e29b-41d4-a716-446655440000'
const DEVICE_ID = 'aabbccdd00112233aabbccdd00112233'

const readPostHogBody = (callIndex = 0) => {
  const fetchMock = vi.mocked(fetch)
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined
  expect(init?.body).toBeDefined()
  return JSON.parse(init?.body as string) as {
    api_key: string
    batch: Array<{
      event: string
      distinct_id: string
      properties: Record<string, unknown>
    }>
  }
}

const readPostHogLogsBody = () => {
  const fetchMock = vi.mocked(fetch)
  const call = fetchMock.mock.calls.find(([input]) => String(input).includes('/i/v1/logs'))
  expect(call).toBeDefined()
  const init = call?.[1] as RequestInit | undefined
  expect(init?.body).toBeDefined()
  return JSON.parse(init?.body as string) as {
    resourceLogs: Array<{
      resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> }
      scopeLogs: Array<{
        logRecords: Array<{
          severityText: string
          body: { stringValue: string }
          attributes: Array<{ key: string; value: Record<string, unknown> }>
        }>
      }>
    }>
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sync-server PostHog capture', () => {
  it('captures server errors with a redacted message, scrubbing raw ids and query strings', async () => {
    // #given a configured PostHog project and an error with sensitive-looking details
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    // Server-side error message (the sync server is E2E-blind — it only ever holds
    // ciphertext, so its own error strings are operational, never note content).
    const error = Object.assign(new Error(`record decode failed ${UUID}`), {
      name: 'QuotaFailure',
      code: 'STORAGE_QUOTA_EXCEEDED',
      statusCode: 507
    })

    // #when capturing the server error
    await captureServerError(env, {
      error,
      method: 'GET',
      path: `/sync/items/${UUID}?token=secret-token`,
      source: 'ErrorHandler',
      action: 'request_failed',
      handled: false
    })

    // #then PostHog receives only sanitized routing metadata
    expect(fetchMock).toHaveBeenCalledWith(
      'https://us.i.posthog.com/batch/',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'https://us.i.posthog.com/i/v1/logs?token=phc_test_project',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })
    )
    const body = readPostHogBody()
    expect(body.api_key).toBe('phc_test_project')
    expect(body.batch).toHaveLength(2)
    expect(body.batch[0]).toMatchObject({
      event: 'server_error_seen',
      distinct_id: 'memry_sync_server_development'
    })
    expect(body.batch[0].properties).toMatchObject({
      service_name: 'memry-sync-server',
      environment: 'development',
      method: 'GET',
      path: '/sync/items/:value',
      route_area: 'sync',
      source: 'ErrorHandler',
      action: 'request_failed',
      level: 'error',
      error_type: 'QuotaFailure',
      error_code: 'STORAGE_QUOTA_EXCEEDED',
      status_code: 507,
      handled: 0
    })
    const exceptionEvent = body.batch.find((event) => event.event === '$exception')
    expect(exceptionEvent).toBeDefined()
    expect(exceptionEvent?.properties).toMatchObject({
      service_name: 'memry-sync-server',
      environment: 'development',
      $exception_type: 'QuotaFailure',
      // The server's own message is surfaced (with structured PII redacted) instead
      // of a synthetic diagnostic string, so the error is debuggable in Error Tracking.
      $exception_message: 'record decode failed <uuid>'
    })
    expect(exceptionEvent?.properties.$exception_list).toEqual([
      expect.objectContaining({
        type: 'QuotaFailure',
        value: 'record decode failed <uuid>'
      })
    ])
    expect(body.batch[0].properties.error_message).toBe('record decode failed <uuid>')
    const logsBody = readPostHogLogsBody()
    expect(logsBody.resourceLogs[0].resource.attributes).toEqual(
      expect.arrayContaining([
        { key: 'service.name', value: { stringValue: 'memry-sync-server' } },
        { key: 'deployment.environment', value: { stringValue: 'development' } }
      ])
    )
    expect(logsBody.resourceLogs[0].scopeLogs[0].logRecords[0]).toMatchObject({
      severityText: 'ERROR',
      body: {
        stringValue: 'memry-sync-server:ErrorHandler:request_failed:STORAGE_QUOTA_EXCEEDED'
      }
    })
    const payloadText = JSON.stringify(body)
    const logsPayloadText = JSON.stringify(logsBody)
    // Structured identifiers (raw UUID, path query token) are still scrubbed everywhere.
    expect(payloadText).not.toContain(UUID)
    expect(payloadText).not.toContain('secret-token')
    // The redacted server message text is intentionally present on the event/exception.
    expect(payloadText).toContain('record decode failed')
    expect(payloadText).toContain('<uuid>')
    // Logs keep the synthetic diagnostic body — no raw message or identifiers leak there.
    expect(logsPayloadText).not.toContain(UUID)
    expect(logsPayloadText).not.toContain('private-note-title')
    expect(logsPayloadText).not.toContain('secret-token')
  })

  it('redacts non-UUID path identifiers and file-shaped paths', async () => {
    // #given sensitive-looking path segments that are not UUID-shaped
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    // #when capturing a route error with a device id in the path
    await captureServerError(env, {
      error: new Error('device lookup failed'),
      method: 'PATCH',
      path: `/devices/${DEVICE_ID}`,
      source: 'ErrorHandler',
      action: 'request_failed',
      handled: true
    })

    // #then the identifier is replaced with a route placeholder
    const deviceBody = readPostHogBody()
    expect(deviceBody.batch[0].properties.path).toBe('/devices/:value')
    expect(JSON.stringify(deviceBody)).not.toContain(DEVICE_ID)

    fetchMock.mockClear()

    // #when a file-shaped path accidentally reaches the sanitizer
    await captureServerLog(env, {
      level: 'error',
      method: 'GET',
      path: '/Users/kaan/private-vault/secret-note.md?token=secret-token',
      source: 'Filesystem',
      action: 'read_failed',
      statusCode: 500
    })

    // #then no directory or filename segment survives
    const fileBody = readPostHogBody()
    const payloadText = JSON.stringify(fileBody)
    expect(fileBody.batch[0].properties.path).toBe('/:value/:value/:value/:value')
    expect(payloadText).not.toContain('Users')
    expect(payloadText).not.toContain('kaan')
    expect(payloadText).not.toContain('private-vault')
    expect(payloadText).not.toContain('secret-note')
    expect(payloadText).not.toContain('secret-token')
  })

  it('captures structured server logs when configured', async () => {
    // #given a configured PostHog project
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    // #when capturing a structured server log
    await captureServerLog(env, {
      level: 'warn',
      method: 'POST',
      path: '/webhooks/google-calendar',
      source: 'GoogleWebhook',
      action: 'channel_token_mismatch',
      statusCode: 401
    })

    // #then the log is represented as a filterable PostHog event
    const body = readPostHogBody()
    expect(body.batch[0]).toMatchObject({
      event: 'server_log_recorded',
      distinct_id: 'memry_sync_server_development'
    })
    expect(body.batch[0].properties).toMatchObject({
      service_name: 'memry-sync-server',
      environment: 'development',
      level: 'warn',
      method: 'POST',
      path: '/webhooks/google-calendar',
      route_area: 'webhooks',
      source: 'GoogleWebhook',
      action: 'channel_token_mismatch',
      status_code: 401
    })
    const logsBody = readPostHogLogsBody()
    expect(logsBody.resourceLogs[0].scopeLogs[0].logRecords[0]).toMatchObject({
      severityText: 'WARN',
      body: { stringValue: 'memry-sync-server:GoogleWebhook:channel_token_mismatch' }
    })
  })

  it('captureBusinessEvent posts a batch with the correct shape', async () => {
    // #given a configured PostHog project
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    // #when capturing a business event
    await captureBusinessEvent(env, 'user_signed_up', 'user_1', { auth_method: 'otp' })

    // #then a single batch request is sent with the expected shape
    expect(fetchMock).toHaveBeenCalledOnce()
    const body = readPostHogBody()
    expect(body.api_key).toBe('phc_test_project')
    expect(body.batch).toHaveLength(1)
    expect(body.batch[0]).toMatchObject({
      event: 'user_signed_up',
      distinct_id: 'user_1'
    })
    expect(body.batch[0].properties).toMatchObject({
      auth_method: 'otp',
      service_name: 'memry-sync-server',
      environment: 'development'
    })
  })

  it('reports rejected waitUntil tasks through PostHog', async () => {
    // #given a context with a background promise that rejects
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const scheduled: Promise<unknown>[] = []
    const context = {
      env,
      req: {
        method: 'POST',
        path: `/sync/records/push/${UUID}`
      },
      executionCtx: {
        waitUntil: vi.fn((promise: Promise<unknown>) => {
          scheduled.push(promise)
        })
      }
    }

    // #when the waitUntil work is wrapped
    waitUntilWithPostHog(context, Promise.reject(new Error(`broadcast ${UUID}`)), {
      source: 'UserSyncState',
      action: 'record_push_broadcast_failed'
    })
    await scheduled[0]

    // #then the rejection is captured without surfacing raw error details
    const body = readPostHogBody()
    expect(body.batch[0].event).toBe('server_error_seen')
    expect(body.batch[0].properties).toMatchObject({
      source: 'UserSyncState',
      action: 'record_push_broadcast_failed',
      method: 'POST',
      path: '/sync/records/push/:value',
      error_code: 'WAIT_UNTIL_REJECTED',
      handled: 0
    })
    expect(JSON.stringify(body)).not.toContain(UUID)
    expect(JSON.stringify(body)).not.toContain('broadcast failed')
  })
})

describe('sync-server error detail', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('redactSensitive scrubs emails, uuids, jwts, bearer tokens, and home paths', () => {
    expect(redactSensitive('user kaan94karaca@gmail.com failed')).toBe('user <email> failed')
    expect(redactSensitive('id 550e8400-e29b-41d4-a716-446655440000 missing')).toBe(
      'id <uuid> missing'
    )
    expect(redactSensitive('token eyJhbGciOi.eyJzdWIi.SflKxwRJ end')).toBe('token <jwt> end')
    expect(redactSensitive('Authorization: Bearer abc.def.ghi123')).toContain('Bearer <token>')
    expect(redactSensitive('at fn (/Users/kaan/vault/note.md:1:1)')).toBe(
      'at fn (~/vault/note.md:1:1)'
    )
  })

  it('parses a real stack trace into $exception frames and keeps the real message', () => {
    // #given an exception input carrying a real (redacted) V8 stack trace
    const event = toPostHogExceptionEvent({
      distinctId: 'user_1',
      serviceName: 'memry-sync-server',
      type: 'TypeError',
      message: 'Cannot read properties of undefined (reading foo)',
      source: 'sync',
      action: 'push',
      handled: false,
      platform: 'node:javascript',
      stack:
        'TypeError: Cannot read properties of undefined (reading foo)\n' +
        '    at pushRecords (~/apps/sync-server/src/routes/sync.ts:120:15)\n' +
        '    at async handler (~/apps/sync-server/src/index.ts:88:5)',
      properties: {}
    })

    // #then the real message is preserved and frames are parsed (not the synthetic stub)
    expect(event.properties.$exception_message).toBe(
      'Cannot read properties of undefined (reading foo)'
    )
    const list = event.properties.$exception_list as Array<{
      value: string
      stacktrace: { frames: Array<{ filename: string; function: string; lineno: number }> }
    }>
    const frames = list[0].stacktrace.frames
    expect(frames).toHaveLength(2)
    // V8 lists most-recent first; frames are reversed → deepest call is last
    expect(frames[frames.length - 1]).toMatchObject({
      function: 'pushRecords',
      filename: '~/apps/sync-server/src/routes/sync.ts',
      lineno: 120
    })
  })

  it('attributes errors to the signed-in user and suppresses $exception for expected 4xx', async () => {
    // #given a configured project and an expected paid-gate rejection for a signed-in user
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    // #when capturing a handled 402 with a userId
    await captureServerError(env, {
      error: new Error('Active sync subscription required'),
      method: 'POST',
      path: '/sync/records/push',
      source: 'ErrorHandler',
      action: 'request_failed',
      statusCode: 402,
      errorCode: 'SYNC_PAYMENT_REQUIRED',
      handled: true,
      userId: 'user_paid_1'
    })

    // #then only the counting event is emitted (no $exception noise) and it is user-attributed
    const body = readPostHogBody()
    expect(body.batch).toHaveLength(1)
    expect(body.batch[0]).toMatchObject({
      event: 'server_error_seen',
      distinct_id: 'user_paid_1'
    })
    expect(body.batch[0].properties).toMatchObject({
      error_code: 'SYNC_PAYMENT_REQUIRED',
      status_code: 402,
      user_id: 'user_paid_1'
    })
    expect(body.batch.find((e) => e.event === '$exception')).toBeUndefined()
  })
})
