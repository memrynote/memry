import { afterEach, describe, expect, it, vi } from 'vitest'

import { AppError, ErrorCodes } from '../lib/errors'
import {
  captureBusinessEvent,
  captureServerError,
  captureServerLog,
  waitUntilCaptured
} from './analytics'
import { hashTelemetryId } from './telemetry'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const posthogEnv = {
  POSTHOG_KEY: 'phc_test',
  POSTHOG_HOST: 'https://us.i.posthog.com',
  ENVIRONMENT: 'staging',
  TELEMETRY_HMAC_KEY: 'test-hmac-key'
}

function stubFetch(status = 200) {
  const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status }))
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

describe('captureBusinessEvent → PostHog', () => {
  it('captures a server-surface event tagged with the environment', async () => {
    const fetchSpy = stubFetch()

    await captureBusinessEvent(posthogEnv, 'vault_registered', 'user-1', { plan: 'believer' })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(String(url)).toBe('https://us.i.posthog.com/batch/')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.batch[0].event).toBe('vault_registered')
    expect(body.batch[0].properties.surface).toBe('server')
    expect(body.batch[0].properties.environment).toBe('staging')
    expect(body.batch[0].distinct_id).toBe('memry_server_staging')
  })

  it('keeps caller-supplied properties and hashes the caller distinct id into user_id', async () => {
    const fetchSpy = stubFetch()

    await captureBusinessEvent(posthogEnv, 'vault_registered', 'user-1', { plan: 'believer' })

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.batch[0].properties.plan).toBe('believer')
    // user_id must never be the raw id — only the opaque HMAC hash may reach
    // PostHog, a third-party service.
    const expectedHash = await hashTelemetryId(posthogEnv.TELEMETRY_HMAC_KEY, 'user-1')
    expect(body.batch[0].properties.user_id).toBe(expectedHash)
    expect(body.batch[0].properties.user_id).not.toBe('user-1')
  })

  it('does not call fetch when PostHog is unconfigured', async () => {
    const fetchSpy = stubFetch()

    await captureBusinessEvent(
      { ENVIRONMENT: 'staging', TELEMETRY_HMAC_KEY: 'test-hmac-key' },
      'vault_registered',
      'user-1',
      {}
    )

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never throws and skips the send when TELEMETRY_HMAC_KEY is missing', async () => {
    const fetchSpy = stubFetch()

    await expect(
      captureBusinessEvent(
        { ...posthogEnv, TELEMETRY_HMAC_KEY: '' },
        'vault_registered',
        'user-1',
        {}
      )
    ).resolves.toBeUndefined()

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('captureServerError → PostHog', () => {
  it('sends a redacted log line and a server_error_seen event, both distinct_id-fixed per environment', async () => {
    const fetchSpy = stubFetch()

    await captureServerError(posthogEnv, {
      error: new Error('record decode failed'),
      method: 'POST',
      path: '/sync/records/push/550e8400-e29b-41d4-a716-446655440000',
      source: 'sync',
      action: 'push_items',
      handled: false,
      userId: 'user-1'
    })

    const logCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/v1/logs'))
    const eventCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/batch/'))
    expect(logCall).toBeDefined()
    expect(eventCall).toBeDefined()

    const logBody = JSON.parse((logCall![1] as RequestInit).body as string)
    expect(logBody.resourceLogs[0].resource.attributes).toContainEqual({
      key: 'deployment.environment',
      value: { stringValue: 'staging' }
    })
    const record = logBody.resourceLogs[0].scopeLogs[0].logRecords[0]
    expect(record.severityText).toBe('error')
    const line = JSON.parse(record.body.stringValue)
    expect(line.message).toBe('record decode failed')
    expect(line.path).toBe('/sync/records/push/:value')
    // user_id must never be the raw id on the wire — only the opaque HMAC
    // hash may reach PostHog, a third-party service.
    const expectedHash = await hashTelemetryId(posthogEnv.TELEMETRY_HMAC_KEY, 'user-1')
    expect(line.user_id).toBe(expectedHash)
    expect(line.user_id).not.toBe('user-1')

    const eventBody = JSON.parse((eventCall![1] as RequestInit).body as string)
    expect(eventBody.batch[0].event).toBe('server_error_seen')
    expect(eventBody.batch[0].distinct_id).toBe('memry_server_staging')
    expect(eventBody.batch[0].properties.status_code).toBe(500)
    expect(eventBody.batch[0].properties.path).toBe('/sync/records/push/:value')
    // The event never carries the redacted message — that stays log-only.
    expect(JSON.stringify(eventBody.batch[0].properties)).not.toContain('record decode failed')
  })

  it('logs at warn for a handled 4xx and error for an unhandled/5xx', async () => {
    const fetchSpy = stubFetch()

    await captureServerError(posthogEnv, {
      error: new Error('bad input'),
      source: 'sync',
      action: 'push_items',
      statusCode: 400,
      handled: true
    })

    const logCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/v1/logs'))
    const logBody = JSON.parse((logCall![1] as RequestInit).body as string)
    expect(logBody.resourceLogs[0].scopeLogs[0].logRecords[0].severityText).toBe('warn')
  })

  // Relocated from loki.test.ts's 'captureServerError → Loki' describe block:
  // captureServerError no longer touches Loki at all, so this now pins the
  // PostHog Logs equivalent instead.
  it('pushes the redacted server detail with app=server', async () => {
    const fetchMock = stubFetch()

    await captureServerError(posthogEnv, {
      error: new Error('record decode failed'),
      method: 'POST',
      path: '/sync/items/push',
      source: 'sync',
      action: 'push_items',
      handled: false
    })

    const logCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/v1/logs'))
    expect(logCall).toBeDefined()
    const body = JSON.parse((logCall![1] as RequestInit).body as string)
    // Previously pinned via the Loki stream label `env`; PostHog Logs carries
    // it as a resource attribute instead.
    expect(body.resourceLogs[0].resource.attributes).toContainEqual({
      key: 'deployment.environment',
      value: { stringValue: 'staging' }
    })
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0]
    expect(record.severityText).toBe('error')
    expect(record.attributes).toContainEqual({ key: 'kind', value: { stringValue: 'error' } })
    const line = JSON.parse(record.body.stringValue)
    expect(line.message).toBe('record decode failed')
    expect(line.error_code).toBe('UNHANDLED_ERROR')
    expect(line.source).toBe('sync')
  })

  it('hashes userId, deviceId and vaultId before they reach PostHog Logs', async () => {
    const fetchSpy = stubFetch()

    await captureServerError(posthogEnv, {
      error: new Error('record decode failed'),
      method: 'POST',
      path: '/sync/records/push/550e8400-e29b-41d4-a716-446655440000',
      source: 'sync',
      action: 'push_items',
      handled: false,
      userId: 'user-1',
      deviceId: 'device-1',
      vaultId: 'vault-1'
    })

    const logCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/v1/logs'))
    const logBody = JSON.parse((logCall![1] as RequestInit).body as string)
    const line = JSON.parse(logBody.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue)

    const expectedUserHash = await hashTelemetryId(posthogEnv.TELEMETRY_HMAC_KEY, 'user-1')
    const expectedDeviceHash = await hashTelemetryId(posthogEnv.TELEMETRY_HMAC_KEY, 'device-1')
    const expectedVaultHash = await hashTelemetryId(posthogEnv.TELEMETRY_HMAC_KEY, 'vault-1')

    expect(line.user_id).toBe(expectedUserHash)
    expect(line.device_id).toBe(expectedDeviceHash)
    expect(line.vault_id).toBe(expectedVaultHash)

    // Raw ids must never appear anywhere in the wire body sent to PostHog.
    const wireBody = JSON.stringify(logBody)
    expect(wireBody).not.toContain('user-1')
    expect(wireBody).not.toContain('device-1')
    expect(wireBody).not.toContain('vault-1')
  })

  it('keeps the raw ids in the local logger call — first-party Cloudflare console, not PostHog', async () => {
    stubFetch()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await captureServerError(posthogEnv, {
      error: new Error('record decode failed'),
      source: 'sync',
      action: 'push_items',
      handled: false,
      userId: 'user-1',
      deviceId: 'device-1',
      vaultId: 'vault-1'
    })

    expect(errorSpy).toHaveBeenCalled()
    const logged = JSON.parse(errorSpy.mock.calls[0][0] as string)
    expect(logged.user_id).toBe('user-1')
    expect(logged.device_id).toBe('device-1')
    expect(logged.vault_id).toBe('vault-1')
  })

  it('never throws and still logs locally when TELEMETRY_HMAC_KEY is missing', async () => {
    stubFetch()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      captureServerError(
        { ...posthogEnv, TELEMETRY_HMAC_KEY: '' },
        {
          error: new Error('record decode failed'),
          source: 'sync',
          action: 'push_items',
          handled: false,
          userId: 'user-1',
          deviceId: 'device-1',
          vaultId: 'vault-1'
        }
      )
    ).resolves.toBeUndefined()

    // The local logger path (first-party, no hashing needed) must still fire.
    expect(errorSpy).toHaveBeenCalled()
    const logged = JSON.parse(errorSpy.mock.calls[0][0] as string)
    expect(logged.user_id).toBe('user-1')
  })
})

describe('captureServerLog → PostHog', () => {
  it('captures a server_log_recorded event tagged with the environment', async () => {
    const fetchSpy = stubFetch()

    await captureServerLog(posthogEnv, {
      level: 'info',
      method: 'POST',
      path: '/webhooks/paddle',
      source: 'webhooks',
      action: 'paddle_webhook_received',
      statusCode: 200
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.batch[0].event).toBe('server_log_recorded')
    expect(body.batch[0].distinct_id).toBe('memry_server_staging')
    expect(body.batch[0].properties.surface).toBe('server')
    expect(body.batch[0].properties.environment).toBe('staging')
    expect(body.batch[0].properties.level).toBe('info')
    expect(body.batch[0].properties.status_code).toBe(200)
  })
})

/**
 * Background-task classification (#1997). A rejected waitUntil promise used to
 * be stamped 500/WAIT_UNTIL_REJECTED/handled:false unconditionally, which
 * buried expected backpressure in the unhandled-error stream.
 */
describe('waitUntilCaptured classification', () => {
  const contextFor = () => {
    const scheduled: Promise<unknown>[] = []
    return {
      ctx: {
        env: posthogEnv,
        req: { method: 'POST', path: '/sync/push' },
        executionCtx: {
          waitUntil: (promise: Promise<unknown>) => {
            scheduled.push(promise)
          }
        }
      },
      settle: () => Promise.all(scheduled)
    }
  }

  const logLineFrom = (fetchSpy: ReturnType<typeof stubFetch>) => {
    const logCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/v1/logs'))
    const body = JSON.parse((logCall![1] as RequestInit).body as string)
    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0]
    return { severity: record.severityText, line: JSON.parse(record.body.stringValue) }
  }

  it('records a typed error as expected backpressure, not an unhandled 500', async () => {
    const fetchSpy = stubFetch()
    const { ctx, settle } = contextFor()
    const rateLimited = new AppError(
      ErrorCodes.PACK_ENQUEUE_RATE_LIMITED,
      'Pack compaction enqueue rate-limited; deferred to the backfill cron',
      429
    )

    waitUntilCaptured(ctx, Promise.reject(rateLimited), {
      source: 'PackQueue',
      action: 'pack_enqueue_failed'
    })
    await settle()

    const { severity, line } = logLineFrom(fetchSpy)
    expect(severity).toBe('warn')
    expect(line.handled).toBe(true)
    expect(line.status_code).toBe(429)
    expect(line.error_code).toBe('PACK_ENQUEUE_RATE_LIMITED')
  })

  it('still records an untyped rejection as an unhandled 500', async () => {
    const fetchSpy = stubFetch()
    const { ctx, settle } = contextFor()

    waitUntilCaptured(ctx, Promise.reject(new Error('queue exploded')), {
      source: 'PackQueue',
      action: 'pack_enqueue_failed'
    })
    await settle()

    const { severity, line } = logLineFrom(fetchSpy)
    expect(severity).toBe('error')
    expect(line.handled).toBe(false)
    expect(line.status_code).toBe(500)
    expect(line.error_code).toBe('WAIT_UNTIL_REJECTED')
  })
})
