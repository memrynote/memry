import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureServerError, captureServerLog, waitUntilWithPostHog } from './posthog'

const env = {
  POSTHOG_API_KEY: 'phc_test_project',
  POSTHOG_HOST: 'https://us.i.posthog.com/',
  ENVIRONMENT: 'development'
}

const UUID = '550e8400-e29b-41d4-a716-446655440000'

const readPostHogBody = () => {
  const fetchMock = vi.mocked(fetch)
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
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

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('sync-server PostHog capture', () => {
  it('captures sanitized server errors without raw messages, ids, or query strings', async () => {
    // #given a configured PostHog project and an error with sensitive-looking details
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: 1 }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const error = Object.assign(new Error(`private-note-title ${UUID}`), {
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
    const body = readPostHogBody()
    expect(body.api_key).toBe('phc_test_project')
    expect(body.batch).toHaveLength(1)
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
    const payloadText = JSON.stringify(body)
    expect(payloadText).not.toContain(UUID)
    expect(payloadText).not.toContain('private-note-title')
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
