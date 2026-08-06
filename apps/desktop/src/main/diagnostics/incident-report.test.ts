import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

const recentLinesMock = vi.fn()
vi.mock('../telemetry/log-ship', () => ({
  getLogShip: vi.fn(() => ({ recentLines: recentLinesMock }))
}))

const getTelemetryRuntimeMock = vi.fn()
vi.mock('../telemetry/runtime', () => ({
  getTelemetryRuntime: () => getTelemetryRuntimeMock()
}))

vi.mock('../telemetry/state', () => ({
  getTelemetryAuthState: vi.fn(() => 'signed_in'),
  getTelemetrySyncState: vi.fn(() => 'enabled')
}))

vi.mock('../telemetry/diagnostics-salt', () => ({
  getOrCreateDiagnosticsSalt: vi.fn(() => 'abcdef0123456789abcdef0123456789'),
  makeSaltedHasher: (salt: string) => (value: string) => `h-${salt.slice(0, 4)}-${value.length}`
}))

const getSyncEngineMock = vi.fn()
vi.mock('../sync/token-manager', () => ({
  getValidAccessToken: vi.fn(async () => null)
}))
vi.mock('../sync/runtime', () => ({
  getSyncEngine: () => getSyncEngineMock()
}))

vi.mock('../vault', () => ({
  getStatus: vi.fn(() => ({
    isOpen: true,
    path: '/test-vault',
    isIndexing: false,
    indexProgress: 0,
    error: null
  }))
}))

import { DiagnosticReportSchema } from '@memry/contracts/diagnostics-api'
import type { DiagnosticLogLine, DiagnosticSnapshot } from '@memry/contracts/diagnostics-api'

import {
  buildIncidentReport,
  collectIncidentDeps,
  generateIncidentId,
  sendIncidentReport,
  type BuildIncidentReportDeps
} from './incident-report'

const baseContext = {
  installId: '550e8400-e29b-41d4-a716-446655440000',
  sessionId: '550e8400-e29b-41d4-a716-446655440001',
  appVersion: '0.1.0',
  buildChannel: 'production' as const,
  platform: 'darwin' as const,
  arch: 'arm64'
}

const baseSnapshot: DiagnosticSnapshot = {
  appVersion: '0.1.0',
  buildChannel: 'production',
  platform: 'darwin',
  arch: 'arm64',
  locale: 'en',
  uptimeSeconds: 42,
  syncEnabled: true,
  syncState: 'enabled',
  queueDepth: 3,
  vaultOpen: true,
  authState: 'signed_in'
}

const baseLines: DiagnosticLogLine[] = [
  {
    ts: new Date().toISOString(),
    level: 'warn',
    scope: 'Sync',
    message: 'already redacted by log-ship',
    origin: 'main'
  }
]

const baseDeps: BuildIncidentReportDeps = {
  incidentId: 'MEMRY-ABCDEFGH',
  recentLines: baseLines,
  context: baseContext,
  snapshot: baseSnapshot,
  hash: (value: string) => `h-${value.length}`
}

describe('generateIncidentId', () => {
  it('matches the MEMRY-XXXXXXXX base32 shape', () => {
    expect(generateIncidentId()).toMatch(/^MEMRY-[A-Z2-7]{8}$/)
  })

  it('validates against the DiagnosticReportSchema incidentId field', () => {
    const result = DiagnosticReportSchema.shape.incidentId.safeParse(generateIncidentId())
    expect(result.success).toBe(true)
  })

  it('produces different ids across calls', () => {
    expect(generateIncidentId()).not.toBe(generateIncidentId())
  })
})

describe('buildIncidentReport', () => {
  it('carries the injected recentLines and snapshot through unchanged (no re-redaction)', () => {
    const report = buildIncidentReport({ source: 'renderer-crash' }, baseDeps)
    expect(report.lines).toBe(baseDeps.recentLines)
    expect(report.snapshot).toBe(baseDeps.snapshot)
    expect(report.incidentId).toBe(baseDeps.incidentId)
  })

  it('redacts the trigger stack: drops the header line, strips home paths and content basenames, keeps code frames', () => {
    const stack = 'Error: opened /Users/kaan/v/Secret.md\n    at foo (/app/src/x.ts:10:5)'
    const report = buildIncidentReport({ source: 'renderer-crash', stack }, baseDeps)
    expect(report.trigger.stack).toBeDefined()
    expect(report.trigger.stack).toContain('at foo (')
    expect(report.trigger.stack).toContain('x.ts')
    expect(report.trigger.stack).not.toContain('/Users/kaan')
    expect(report.trigger.stack).not.toContain('Secret')
  })

  it('omits trigger.stack entirely when the stack has no frame lines', () => {
    const report = buildIncidentReport({ source: 'renderer-crash', stack: 'Error: boom' }, baseDeps)
    expect(report.trigger.stack).toBeUndefined()
  })

  it('produces a report that validates against DiagnosticReportSchema', () => {
    const stack = 'Error: opened /Users/kaan/v/Secret.md\n    at foo (/app/src/x.ts:10:5)'
    const report = buildIncidentReport(
      { source: 'renderer-crash', errorCode: 'ERR_BOOM', stack },
      baseDeps
    )
    const result = DiagnosticReportSchema.safeParse(report)
    expect(result.success).toBe(true)
  })
})

describe('sendIncidentReport', () => {
  const report = buildIncidentReport({ source: 'renderer-crash' }, baseDeps)

  it('POSTs the report body to the /diagnostics/report endpoint and returns the incident id', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined })
      return { ok: true, status: 202 }
    })

    const result = await sendIncidentReport(report, {
      fetch: fetchMock,
      endpoint: 'http://localhost:8787/diagnostics/report'
    })

    expect(result).toEqual({ incidentId: report.incidentId })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('http://localhost:8787/diagnostics/report')
    expect(calls[0].body).toEqual(report)
  })

  it('attaches the access token so the report lands on the account person profile', async () => {
    const headers: Record<string, string>[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>)
      return { ok: true, status: 202 }
    })

    await sendIncidentReport(report, {
      fetch: fetchMock,
      endpoint: 'http://localhost:8787/diagnostics/report',
      getAccessToken: async () => 'jwt-token'
    })

    expect(headers[0].Authorization).toBe('Bearer jwt-token')
  })

  it('sends anonymously when there is no token', async () => {
    const headers: Record<string, string>[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>)
      return { ok: true, status: 202 }
    })

    await sendIncidentReport(report, {
      fetch: fetchMock,
      endpoint: 'http://localhost:8787/diagnostics/report',
      getAccessToken: async () => null
    })

    expect(headers[0]).not.toHaveProperty('Authorization')
  })

  it('still sends the report when the token lookup throws', async () => {
    // Signed out, keychain locked, refresh failed — losing the incident report
    // would be worse than losing its attribution.
    const headers: Record<string, string>[] = []
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      headers.push(init?.headers as Record<string, string>)
      return { ok: true, status: 202 }
    })

    const result = await sendIncidentReport(report, {
      fetch: fetchMock,
      endpoint: 'http://localhost:8787/diagnostics/report',
      getAccessToken: async () => {
        throw new Error('keychain locked')
      }
    })

    expect(result).toEqual({ incidentId: report.incidentId })
    expect(headers[0]).not.toHaveProperty('Authorization')
  })

  // DoD: "verified with a synthetic secret that does not appear in [what reaches] Loki".
  // Symmetric with the Path A wire-boundary check in log-ship.test.ts — inject a raw
  // secret via the only free-text input to buildIncidentReport (trigger.stack) and assert
  // the raw value is absent from the exact bytes that would be POSTed to /diagnostics/report.
  it('never lets a raw trigger secret reach the /diagnostics/report POST body', async () => {
    const secretPath = '/Users/victim/Vault/Very Secret Note.md'
    const report = buildIncidentReport(
      {
        source: 'tab_error_boundary',
        stack: `Error: opened ${secretPath}\n    at f (/app/src/x.ts:1:1)`
      },
      baseDeps
    )
    let sentBody = ''
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      sentBody = String(init?.body ?? '')
      return { ok: true, status: 202 }
    })

    await sendIncidentReport(report, {
      fetch: fetchMock,
      endpoint: 'http://localhost:8787/diagnostics/report'
    })

    expect(sentBody).not.toContain('Very Secret Note')
    expect(sentBody).not.toContain('/Users/victim')
    // The useful code frame still rides along.
    expect(sentBody).toContain('x.ts')
  })

  it('throws on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }))
    await expect(
      sendIncidentReport(report, {
        fetch: fetchMock,
        endpoint: 'http://localhost:8787/diagnostics/report'
      })
    ).rejects.toThrow()
  })

  it('resolves the production default endpoint from the report buildChannel when no override is given', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }))
    await sendIncidentReport(report, { fetch: fetchMock })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://sync.memrynote.com/diagnostics/report',
      expect.anything()
    )
  })

  it('resolves the dev default endpoint for a development-channel report', async () => {
    const devReport = buildIncidentReport(
      { source: 'renderer-crash' },
      { ...baseDeps, context: { ...baseContext, buildChannel: 'development' } }
    )
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }))
    await sendIncidentReport(devReport, { fetch: fetchMock })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8787/diagnostics/report',
      expect.anything()
    )
  })
})

describe('collectIncidentDeps', () => {
  beforeEach(() => {
    getTelemetryRuntimeMock.mockReset()
    recentLinesMock.mockReset()
    getSyncEngineMock.mockReset()
  })

  it('throws a clear error when the telemetry runtime is unavailable', () => {
    getTelemetryRuntimeMock.mockReturnValue(null)
    expect(() => collectIncidentDeps({ source: 'renderer-crash' })).toThrow(/telemetry runtime/i)
  })

  it('gathers real runtime/vault/sync state into deps for buildIncidentReport', () => {
    getTelemetryRuntimeMock.mockReturnValue({
      context: { ...baseContext, locale: 'en', timezoneOffsetMinutes: 0 }
    })
    recentLinesMock.mockReturnValue(baseLines)
    getSyncEngineMock.mockReturnValue({ getStatus: () => ({ pendingCount: 7 }) })

    const deps = collectIncidentDeps({ source: 'renderer-crash' })

    expect(deps.incidentId).toMatch(/^MEMRY-[A-Z2-7]{8}$/)
    expect(deps.recentLines).toBe(baseLines)
    expect(deps.context).toEqual(baseContext)
    expect(deps.snapshot.vaultOpen).toBe(true)
    expect(deps.snapshot.authState).toBe('signed_in')
    expect(deps.snapshot.syncState).toBe('enabled')
    expect(deps.snapshot.syncEnabled).toBe(true)
    expect(deps.snapshot.queueDepth).toBe(7)
    expect(typeof deps.hash).toBe('function')
  })

  it('defaults queueDepth to 0 when no sync engine is running', () => {
    getTelemetryRuntimeMock.mockReturnValue({
      context: { ...baseContext, locale: 'en', timezoneOffsetMinutes: 0 }
    })
    recentLinesMock.mockReturnValue([])
    getSyncEngineMock.mockReturnValue(null)

    const deps = collectIncidentDeps({ source: 'renderer-crash' })
    expect(deps.snapshot.queueDepth).toBe(0)
  })
})
