import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TelemetryBatch, TelemetryEvent } from '@memry/contracts/telemetry-api'

import { desktopErrorEntry, desktopLogEntry, desktopReportEntry, pushLokiEntries } from './loki'

const env = {
  LOKI_URL: 'https://grafana.example.com',
  LOKI_TOKEN: 'tok',
  ENVIRONMENT: 'test'
}

const entry = {
  level: 'error' as const,
  app: 'server' as const,
  line: { error_code: 'BOOM', message: 'it broke' }
}

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

describe('pushLokiEntries', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('no-ops when LOKI_URL or LOKI_TOKEN is unset', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await pushLokiEntries({ ENVIRONMENT: 'test' }, [entry])
    await pushLokiEntries({ ...env, LOKI_TOKEN: undefined }, [entry])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no-ops on empty entries', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await pushLokiEntries(env, [])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs streams with app/env/level labels and JSON line', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await pushLokiEntries(env, [entry])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://grafana.example.com/loki/api/v1/push')
    expect(init.headers.authorization).toBe('Bearer tok')
    const body = JSON.parse(init.body)
    expect(body.streams).toHaveLength(1)
    expect(body.streams[0].stream).toEqual({
      app: 'server',
      env: 'test',
      level: 'error',
      kind: 'error'
    })
    const [ts, line] = body.streams[0].values[0]
    expect(ts).toMatch(/^\d+$/)
    expect(JSON.parse(line)).toEqual({ error_code: 'BOOM', message: 'it broke' })
  })

  it('never throws on fetch rejection or non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    await expect(pushLokiEntries(env, [entry])).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await expect(pushLokiEntries(env, [entry])).resolves.toBeUndefined()
  })
})

describe('desktopErrorEntry', () => {
  it('maps batch + event to a desktop error line with stack, never a message', () => {
    const result = desktopErrorEntry(batch, event, 'hash123')
    expect(result.level).toBe('error')
    expect(result.app).toBe('desktop')
    expect(result.kind).toBe('error')
    expect(result.line).toEqual({
      name: 'app_error_seen',
      error_code: 'RangeError',
      surface: 'app',
      action: 'render',
      source: 'renderer',
      app_version: '1.2.3',
      build_channel: 'production',
      platform: 'darwin',
      stack: 'at doThing (app://bundle.js:1:2)',
      component_stack: 'at NoteEditor',
      install_hash: 'hash123',
      log_action: '',
      exit_code: ''
    })
    expect(Object.keys(result.line)).not.toContain('message')
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
    const result = desktopErrorEntry(batch, logEvent, 'hash123')
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
    const result = desktopErrorEntry(batch, crashEvent, 'hash123')
    expect(result.line.exit_code).toBe(11)
  })

  it('leaves exit_code empty for events that carry no exit status', () => {
    // #given exit code 0 is meaningful, so the empty case must not collapse to 0
    const result = desktopErrorEntry(batch, event, 'hash123')
    expect(result.line.exit_code).toBe('')
  })
})

describe('kind label + diagnostic entries', () => {
  const meta = {
    appVersion: '2026.7.18',
    buildChannel: 'production',
    platform: 'linux',
    arch: 'x64'
  } as const

  it('desktopLogEntry carries kind=log + a redacted message', () => {
    const entry = desktopLogEntry(
      {
        ts: '2026-07-18T10:00:00.000Z',
        level: 'warn',
        scope: 'Sync',
        message: 'pull_page_dropped',
        origin: 'main',
        fields: { droppedCount: 3 }
      },
      meta,
      'installhash'
    )
    expect(entry.kind).toBe('log')
    expect(entry.level).toBe('warn')
    expect(entry.line.message).toBe('pull_page_dropped')
  })

  it('server mask-mode scrubs a leaked email defense-in-depth', () => {
    const entry = desktopLogEntry(
      {
        ts: '2026-07-18T10:00:00.000Z',
        level: 'error',
        scope: 'X',
        message: 'oops leak@evil.com',
        origin: 'main'
      },
      meta,
      'h'
    )
    expect(JSON.stringify(entry.line)).not.toContain('leak@evil.com')
  })

  it('pushLokiEntries emits kind in the stream labels', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await pushLokiEntries(env, [
      desktopLogEntry(
        { ts: '2026-07-18T10:00:00.000Z', level: 'warn', scope: 'S', message: 'm', origin: 'main' },
        meta,
        'h'
      )
    ])
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.streams[0].stream).toMatchObject({ app: 'desktop', level: 'warn', kind: 'log' })
    vi.unstubAllGlobals()
  })

  it('desktopReportEntry stamps incident_id on every line', () => {
    const entries = desktopReportEntry(
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
      },
      'h'
    )
    expect(
      entries.every((e) => e.kind === 'report' && e.line.incident_id === 'MEMRY-AB12CD34')
    ).toBe(true)
  })
})
