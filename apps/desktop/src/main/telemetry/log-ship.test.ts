import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import log from 'electron-log'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

const getCurrentVaultPathMock = vi.fn<() => string | null>(() => null)
vi.mock('../store', () => ({
  getCurrentVaultPath: () => getCurrentVaultPathMock()
}))

const getSettingsMock = vi.fn(() => ({ enabled: true }))
const getTelemetryRuntimeMock = vi.fn(() => ({
  context: {
    installId: '550e8400-e29b-41d4-a716-446655440000',
    sessionId: '550e8400-e29b-41d4-a716-446655440001',
    appVersion: '0.1.0',
    buildChannel: 'production',
    platform: 'darwin',
    arch: 'arm64'
  },
  getSettings: getSettingsMock
}))
vi.mock('./runtime', () => ({
  getTelemetryRuntime: () => getTelemetryRuntimeMock()
}))

import { getLogShip, installLogShip, parseRecord, type RawLogRecord } from './log-ship'

const FIXED_SALT = 'abcdef0123456789abcdef0123456789'

type RawTransport = (message: { data: unknown[]; level: string; scope?: string }) => void

const getTransport = (): RawTransport => {
  const transport = (log.transports as unknown as Record<string, unknown>).logShip
  if (typeof transport !== 'function') throw new Error('logShip transport not installed')
  return transport as RawTransport
}

const createFetch = () => {
  const calls: { url: string; body: unknown }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined })
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 })
  })
  return { calls, fetchMock }
}

describe('parseRecord', () => {
  it('splits the first string arg as message and merges object args as fields', () => {
    const p = parseRecord({
      level: 'warn',
      scope: 'Sync',
      data: ['blocked path', { filePath: '/Users/kaan/v/x.md' }]
    })
    expect(p.message).toBe('blocked path')
    expect(p.fields.filePath).toBe('/Users/kaan/v/x.md')
  })

  it('maps any non-error level to warn', () => {
    expect(parseRecord({ level: 'info', data: ['hi'] }).level).toBe('warn')
    expect(parseRecord({ level: 'error', data: ['boom'] }).level).toBe('error')
  })

  it('defaults scope to app when absent', () => {
    expect(parseRecord({ level: 'warn', data: ['x'] }).scope).toBe('app')
  })

  it('captures an Error argument as errorName and keeps the error message', () => {
    const p = parseRecord({ level: 'error', data: [new Error('kaboom')] })
    expect(p.message).toBe('kaboom')
    expect(p.fields.errorName).toBe('Error')
  })

  it('keeps the raw (pre-redaction) error message for an Error with sensitive content', () => {
    // redaction happens downstream in redactLogLine; parseRecord must not discard
    // the message by collapsing it to arg.name.
    const p = parseRecord({
      level: 'error',
      data: [new Error('Sync failed: /Users/x/v/note.md')]
    })
    expect(p.message).toBe('Sync failed: /Users/x/v/note.md')
    expect(p.fields.errorName).toBe('Error')
  })

  it('falls back to the error name when the Error has no message', () => {
    const p = parseRecord({ level: 'error', data: [new Error('')] })
    expect(p.message).toBe('Error')
  })

  it('keeps the error message as a field when a label already claimed the message', () => {
    // logger.error('updater error', err) shipped `{"errorName":"Error"}` and nothing
    // else — the label won the message slot and the Error's own message was dropped,
    // leaving prod failures undiagnosable (#842).
    const p = parseRecord({ level: 'error', data: ['updater error', new Error('kaboom')] })
    expect(p.message).toBe('updater error')
    expect(p.fields.errorName).toBe('Error')
    expect(p.fields.errorMessage).toBe('kaboom')
  })

  it('does not overwrite an explicit errorMessage field', () => {
    const p = parseRecord({
      level: 'error',
      data: ['updater error', { errorMessage: 'curated' }, new Error('raw')]
    })
    expect(p.fields.errorMessage).toBe('curated')
  })
})

describe('installLogShip', () => {
  beforeEach(() => {
    getCurrentVaultPathMock.mockReturnValue('/Users/kaan/v')
    getSettingsMock.mockReturnValue({ enabled: true })
  })

  afterEach(async () => {
    await getLogShip()?.dispose()
    vi.clearAllMocks()
  })

  it('redacts message + fields and never leaks the raw vault path', async () => {
    const { fetchMock } = createFetch()
    const shipped = installLogShip({
      buildChannel: 'production',
      fetch: fetchMock,
      endpoint: 'https://sync.test/telemetry/logs',
      salt: FIXED_SALT,
      flushIntervalMs: null
    })

    getTransport()({
      level: 'warn',
      scope: 'Sync',
      data: ['blocked path', { filePath: '/Users/kaan/v/x.md' }]
    })

    const lines = shipped.recentLines()
    expect(lines).toHaveLength(1)
    expect(lines[0].message).toBe('blocked path')
    expect(lines[0].level).toBe('warn')
    expect(lines[0].scope).toBe('Sync')
    expect(lines[0].origin).toBe('main')
    expect(JSON.stringify(lines[0].fields)).not.toContain('/Users/kaan/v')
    // content basenames are further hashed by redactLogLine (see redact.ts
    // CONTENT_FILE) — assert the vault collapsed and the raw filename is gone,
    // without coupling to the exact hash digest (that's redact.test.ts's job).
    expect(lines[0].fields?.filePath).toMatch(/^<vault>\/\[name:[0-9a-f]{8}\]\.md$/)
  })

  it('ignores records from its own re-entrancy scopes (LogShip/Telemetry/QueueStore)', () => {
    const { fetchMock } = createFetch()
    const shipped = installLogShip({
      buildChannel: 'production',
      fetch: fetchMock,
      endpoint: 'https://sync.test/telemetry/logs',
      salt: FIXED_SALT,
      flushIntervalMs: null
    })

    getTransport()({ level: 'warn', scope: 'LogShip', data: ['flush failed'] })
    getTransport()({ level: 'warn', scope: 'Telemetry', data: ['flush failed'] })
    getTransport()({ level: 'warn', scope: 'TelemetryQueueStore', data: ['flush failed'] })

    expect(shipped.recentLines()).toHaveLength(0)
  })

  it('drops info/debug records below the warn threshold', () => {
    const { fetchMock } = createFetch()
    const shipped = installLogShip({
      buildChannel: 'production',
      fetch: fetchMock,
      endpoint: 'https://sync.test/telemetry/logs',
      salt: FIXED_SALT,
      flushIntervalMs: null
    })

    getTransport()({ level: 'info', scope: 'Sync', data: ['just fyi'] })
    getTransport()({ level: 'debug', scope: 'Sync', data: ['noisy'] })

    expect(shipped.recentLines()).toHaveLength(0)
  })

  it('ships redacted lines when telemetry is enabled, on dispose flush', async () => {
    const { calls, fetchMock } = createFetch()
    const shipped = installLogShip({
      buildChannel: 'production',
      fetch: fetchMock,
      endpoint: 'https://sync.test/telemetry/logs',
      salt: FIXED_SALT,
      flushIntervalMs: null
    })

    getTransport()({
      level: 'warn',
      scope: 'Sync',
      data: ['blocked path', { filePath: '/Users/kaan/v/x.md' }]
    })
    await shipped.dispose()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(calls[0].url).toBe('https://sync.test/telemetry/logs')
    const body = calls[0].body as {
      lines: Array<{ message: string; fields?: Record<string, unknown> }>
    }
    expect(body.lines).toHaveLength(1)
    expect(JSON.stringify(body.lines[0])).not.toContain('/Users/kaan/v')
  })

  it('when telemetry is disabled, nothing ships but the ring buffer still fills', async () => {
    getSettingsMock.mockReturnValue({ enabled: false })
    const { fetchMock } = createFetch()
    const shipped = installLogShip({
      buildChannel: 'production',
      fetch: fetchMock,
      endpoint: 'https://sync.test/telemetry/logs',
      salt: FIXED_SALT,
      flushIntervalMs: null
    })

    getTransport()({ level: 'warn', scope: 'Sync', data: ['blocked path'] })
    await shipped.dispose()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('in development builds, fills the ring buffer but never ships', async () => {
    getSettingsMock.mockReturnValue({ enabled: true })
    const { fetchMock } = createFetch()
    const shipped = installLogShip({
      buildChannel: 'development',
      fetch: fetchMock,
      endpoint: 'https://sync.test/telemetry/logs',
      salt: FIXED_SALT,
      flushIntervalMs: null
    })

    getTransport()({ level: 'warn', scope: 'Sync', data: ['dev warn'] })
    expect(shipped.recentLines()).toHaveLength(1)

    await shipped.dispose()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bounds recentLines() to 200 entries', () => {
    const { fetchMock } = createFetch()
    const shipped = installLogShip({
      buildChannel: 'production',
      fetch: fetchMock,
      endpoint: 'https://sync.test/telemetry/logs',
      salt: FIXED_SALT,
      flushIntervalMs: null
    })

    for (let i = 0; i < 250; i++) {
      getTransport()({ level: 'warn', scope: 'Sync', data: [`msg-${i}`] })
    }

    expect(shipped.recentLines()).toHaveLength(200)
  })

  it('collapses repeated identical warns within the throttle window into a repeat count', () => {
    const { fetchMock } = createFetch()
    const shipped = installLogShip({
      buildChannel: 'production',
      fetch: fetchMock,
      endpoint: 'https://sync.test/telemetry/logs',
      salt: FIXED_SALT,
      flushIntervalMs: null
    })

    for (let i = 0; i < 5; i++) {
      getTransport()({ level: 'warn', scope: 'Sync', data: ['same warn'] })
    }

    const lines = shipped.recentLines()
    expect(lines).toHaveLength(1)
    expect(lines[0].fields?.repeatCount).toBe(5)
  })

  it('re-emits a fresh line once the throttle window elapses, even mid-loop (sustained warning loop)', () => {
    // Regression for the sliding-window bug: a warning recurring faster than
    // every THROTTLE_WINDOW_MS must not suppress forever. The window is
    // anchored to when the line was first emitted, not to the last hit, so an
    // intermediate hit inside the window must NOT push the deadline out.
    vi.useFakeTimers()
    try {
      const { fetchMock } = createFetch()
      const shipped = installLogShip({
        buildChannel: 'production',
        fetch: fetchMock,
        endpoint: 'https://sync.test/telemetry/logs',
        salt: FIXED_SALT,
        flushIntervalMs: null
      })

      getTransport()({ level: 'warn', scope: 'Sync', data: ['same warn'] }) // t=0: fresh line
      vi.advanceTimersByTime(1500)
      getTransport()({ level: 'warn', scope: 'Sync', data: ['same warn'] }) // t=1500: within window, suppressed
      vi.advanceTimersByTime(1600) // t=3100: >3000ms since the ORIGINAL emit, but only 1600ms since the last hit
      getTransport()({ level: 'warn', scope: 'Sync', data: ['same warn'] }) // must re-emit, not suppress again

      const lines = shipped.recentLines()
      expect(lines).toHaveLength(2)
      expect(lines[0].fields?.repeatCount).toBe(2)
      expect(lines[1].fields?.repeatCount).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ingestForwarded tags the line with origin worker and the worker name', () => {
    const { fetchMock } = createFetch()
    const shipped = installLogShip({
      buildChannel: 'production',
      fetch: fetchMock,
      endpoint: 'https://sync.test/telemetry/logs',
      salt: FIXED_SALT,
      flushIntervalMs: null
    })

    const record: RawLogRecord = { level: 'error', scope: 'Embeddings', data: ['worker died'] }
    shipped.ingestForwarded(record, 'embeddings-worker')

    const lines = shipped.recentLines()
    expect(lines).toHaveLength(1)
    expect(lines[0].origin).toBe('worker')
    expect(lines[0].workerName).toBe('embeddings-worker')
  })

  it('getLogShip() exposes the installed singleton', () => {
    const { fetchMock } = createFetch()
    const shipped = installLogShip({
      buildChannel: 'production',
      fetch: fetchMock,
      endpoint: 'https://sync.test/telemetry/logs',
      salt: FIXED_SALT,
      flushIntervalMs: null
    })

    expect(getLogShip()).toBe(shipped)
  })
})
