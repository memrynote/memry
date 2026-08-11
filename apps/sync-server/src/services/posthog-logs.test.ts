import { describe, expect, it, vi } from 'vitest'

import type { TelemetryBatch, TelemetryEvent } from '@memry/contracts/telemetry-api'

import {
  desktopErrorRecord,
  desktopLogRecord,
  desktopReportRecords,
  pushPostHogLogs
} from './posthog-logs'

const env = {
  POSTHOG_KEY: 'phc_test',
  POSTHOG_HOST: 'https://us.i.posthog.com',
  ENVIRONMENT: 'staging'
}

describe('pushPostHogLogs', () => {
  it('posts OTLP-JSON with the token as a bearer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await pushPostHogLogs(env, [
      { level: 'error', app: 'desktop', distinctId: 'hash', line: { error_code: 'X' } }
    ])

    const [url, init] = fetchSpy.mock.calls[0]
    // `/i/v1/logs`, not `/v1/logs` — the latter is a 404 on the edge host and
    // this assertion previously locked that in, so the Logs tab stayed empty.
    expect(url).toBe('https://us.i.posthog.com/i/v1/logs')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer phc_test' })

    const body = JSON.parse((init as RequestInit).body as string)
    const resource = body.resourceLogs[0].resource.attributes
    expect(resource).toContainEqual({ key: 'service.name', value: { stringValue: 'desktop' } })
    expect(resource).toContainEqual({
      key: 'deployment.environment',
      value: { stringValue: 'staging' }
    })

    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0]
    expect(record.severityText).toBe('error')
    expect(record.attributes).toContainEqual({
      key: 'posthogDistinctId',
      value: { stringValue: 'hash' }
    })
    vi.unstubAllGlobals()
  })

  it('is a no-op without a key', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await pushPostHogLogs({}, [{ level: 'error', app: 'server', line: {} }])
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('never throws when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    await expect(
      pushPostHogLogs(env, [{ level: 'error', app: 'server', line: {} }])
    ).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('groups records into one resourceLogs entry per app', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await pushPostHogLogs(env, [
      { level: 'error', app: 'desktop', line: { id: 'd1' } },
      { level: 'error', app: 'server', line: { id: 's1' } },
      { level: 'error', app: 'desktop', line: { id: 'd2' } }
    ])

    const [, init] = fetchSpy.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.resourceLogs).toHaveLength(2)

    type ResourceAttribute = { key: string; value: { stringValue: string } }
    type ResourceLogsEntry = { resource: { attributes: ResourceAttribute[] } }

    const desktopEntry = body.resourceLogs.find((r: ResourceLogsEntry) =>
      r.resource.attributes.some(
        (a) => a.key === 'service.name' && a.value.stringValue === 'desktop'
      )
    )
    const serverEntry = body.resourceLogs.find((r: ResourceLogsEntry) =>
      r.resource.attributes.some(
        (a) => a.key === 'service.name' && a.value.stringValue === 'server'
      )
    )

    expect(
      desktopEntry.scopeLogs[0].logRecords.map(
        (r: { body: { stringValue: string } }) => r.body.stringValue
      )
    ).toEqual([JSON.stringify({ id: 'd1' }), JSON.stringify({ id: 'd2' })])
    expect(
      serverEntry.scopeLogs[0].logRecords.map(
        (r: { body: { stringValue: string } }) => r.body.stringValue
      )
    ).toEqual([JSON.stringify({ id: 's1' })])
    vi.unstubAllGlobals()
  })

  it('resolves instead of rejecting when a line is not JSON-safe', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const line: Record<string, unknown> = {}
    line.self = line

    await expect(
      pushPostHogLogs(env, [{ level: 'error', app: 'server', line }])
    ).resolves.toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('desktopLogRecord', () => {
  it('re-runs redaction on the message', () => {
    const record = desktopLogRecord(
      {
        ts: '2026-07-22T10:00:00.000Z',
        level: 'error',
        scope: 'Sync',
        message: 'failed for kaan@example.com',
        origin: 'main'
      } as never,
      { appVersion: '1.0.0', buildChannel: 'production', platform: 'darwin', arch: 'arm64' },
      'hash'
    )
    expect(JSON.stringify(record.line)).not.toContain('kaan@example.com')
    expect(record.distinctId).toBe('hash')
    expect(record.kind).toBe('log')
  })

  it('carries kind=log, the level, and passes through a message needing no redaction', () => {
    const record = desktopLogRecord(
      {
        ts: '2026-07-18T10:00:00.000Z',
        level: 'warn',
        scope: 'Sync',
        message: 'pull_page_dropped',
        origin: 'main',
        fields: { droppedCount: 3 }
      } as never,
      { appVersion: '2026.7.18', buildChannel: 'production', platform: 'linux', arch: 'x64' },
      'installhash'
    )
    expect(record.kind).toBe('log')
    expect(record.level).toBe('warn')
    expect(record.line.message).toBe('pull_page_dropped')
    expect(record.distinctId).toBe('installhash')
  })
})

describe('desktopErrorRecord', () => {
  const batch: TelemetryBatch = {
    schemaVersion: 1,
    installId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222',
    appVersion: '1.2.3',
    buildChannel: 'production',
    platform: 'darwin',
    arch: 'arm64',
    locale: 'en-US',
    timezoneOffsetMinutes: 180,
    authState: 'signed_in',
    syncState: 'enabled',
    events: []
  }

  const event: TelemetryEvent = {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'app_error_seen',
    occurredAt: '2026-07-04T00:00:00.000Z',
    surface: 'app',
    action: 'render',
    errorCode: 'RangeError',
    source: 'renderer',
    error: { stack: 'at doThing (app://bundle.js:1:2)', componentStack: 'at NoteEditor' }
  }

  it('maps batch + event to a desktop error line with stack and an empty message when absent', () => {
    const result = desktopErrorRecord(batch, event, 'hash123')
    expect(result.level).toBe('error')
    expect(result.app).toBe('desktop')
    expect(result.kind).toBe('error')
    expect(result.distinctId).toBe('hash123')
    expect(result.line).toEqual({
      name: 'app_error_seen',
      error_code: 'RangeError',
      surface: 'app',
      action: 'render',
      source: 'renderer',
      app_version: '1.2.3',
      build_channel: 'production',
      platform: 'darwin',
      message: '',
      stack: 'at doThing (app://bundle.js:1:2)',
      component_stack: 'at NoteEditor',
      install_hash: 'hash123',
      log_action: '',
      exit_code: ''
    })
  })

  it('redacts event.error.message on the line when present, and the raw value does not survive', () => {
    const eventWithMessage: TelemetryEvent = {
      ...event,
      error: { ...event.error, message: 'failed for leak@evil.com' }
    }
    const result = desktopErrorRecord(batch, eventWithMessage, 'hash123')
    expect(result.line.message).not.toContain('leak@evil.com')
    expect(result.line.message).toBe('failed for <email>')
  })

  it('carries log_action so log-type error events are identifiable in Grafana', () => {
    const logEvent: TelemetryEvent = {
      ...event,
      name: 'app_log_recorded',
      action: 'error',
      errorCode: 'Utility:crashed:Embeddings',
      dimensions: { log_action: 'child_process_gone' },
      error: undefined
    }
    const result = desktopErrorRecord(batch, logEvent, 'hash123')
    expect(result.line.log_action).toBe('child_process_gone')
    expect(result.line.error_code).toBe('Utility:crashed:Embeddings')
  })

  it('carries the child-process exit code so the crash signal is visible in Grafana', () => {
    // #given a utility crash reported with a POSIX signal status (11 = SIGSEGV)
    const crashEvent: TelemetryEvent = {
      ...event,
      name: 'app_log_recorded',
      action: 'error',
      errorCode: 'Utility:crashed:Embeddings',
      dimensions: { log_action: 'child_process_gone' },
      metrics: { value: 11 },
      error: undefined
    }
    const result = desktopErrorRecord(batch, crashEvent, 'hash123')
    expect(result.line.exit_code).toBe(11)
  })

  it('leaves exit_code empty for events that carry no exit status', () => {
    // #given exit code 0 is meaningful, so the empty case must not collapse to 0
    const result = desktopErrorRecord(batch, event, 'hash123')
    expect(result.line.exit_code).toBe('')
  })
})

describe('desktopReportRecords', () => {
  it('stamps incident_id on every line and carries the distinctId', () => {
    const entries = desktopReportRecords(
      {
        schemaVersion: 1,
        installId: 'i',
        sessionId: 's',
        appVersion: '1',
        buildChannel: 'production',
        platform: 'linux',
        arch: 'x64',
        incidentId: 'MEMRY-AB12CD34',
        trigger: { source: 'boundary' },
        snapshot: {} as never,
        lines: [
          {
            ts: '2026-07-18T10:00:00.000Z',
            level: 'warn',
            scope: 'S',
            message: 'm',
            origin: 'main'
          }
        ]
      } as never,
      'h'
    )
    expect(
      entries.every(
        (e) =>
          e.kind === 'report' && e.line.incident_id === 'MEMRY-AB12CD34' && e.distinctId === 'h'
      )
    ).toBe(true)
  })
})
