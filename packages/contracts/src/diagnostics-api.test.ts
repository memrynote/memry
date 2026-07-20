import { describe, expect, it } from 'vitest'
import { DiagnosticLogBatchSchema, DiagnosticReportSchema } from './diagnostics-api'

const line = {
  ts: '2026-07-18T10:00:00.000Z',
  level: 'warn' as const,
  scope: 'Sync',
  message: 'x',
  origin: 'main' as const
}
const batchBase = {
  schemaVersion: 1 as const,
  installId: '550e8400-e29b-41d4-a716-446655440000',
  sessionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  appVersion: '2026.7.18',
  buildChannel: 'production' as const,
  platform: 'linux' as const,
  arch: 'x64'
}

describe('DiagnosticLogBatchSchema', () => {
  it('accepts a valid batch', () => {
    expect(DiagnosticLogBatchSchema.safeParse({ ...batchBase, lines: [line] }).success).toBe(true)
  })
  it('rejects an empty lines array', () => {
    expect(DiagnosticLogBatchSchema.safeParse({ ...batchBase, lines: [] }).success).toBe(false)
  })
  it('rejects > 50 lines', () => {
    expect(
      DiagnosticLogBatchSchema.safeParse({ ...batchBase, lines: Array(51).fill(line) }).success
    ).toBe(false)
  })
  it('rejects an info level (warn/error only)', () => {
    expect(
      DiagnosticLogBatchSchema.safeParse({ ...batchBase, lines: [{ ...line, level: 'info' }] })
        .success
    ).toBe(false)
  })
  it('rejects a message > 2000 chars', () => {
    expect(
      DiagnosticLogBatchSchema.safeParse({
        ...batchBase,
        lines: [{ ...line, message: 'a'.repeat(2001) }]
      }).success
    ).toBe(false)
  })
})

describe('DiagnosticReportSchema', () => {
  const report = {
    ...batchBase,
    incidentId: 'MEMRY-AB12CD34',
    trigger: { source: 'tab_error_boundary' },
    snapshot: {
      appVersion: '2026.7.18',
      buildChannel: 'production',
      platform: 'linux',
      arch: 'x64',
      locale: 'en',
      uptimeSeconds: 120,
      syncEnabled: true,
      syncState: 'enabled',
      queueDepth: 0,
      vaultOpen: true,
      authState: 'signed_in'
    },
    lines: [line]
  }
  it('accepts a valid report', () => {
    expect(DiagnosticReportSchema.safeParse(report).success).toBe(true)
  })
  it('rejects > 200 lines', () => {
    expect(
      DiagnosticReportSchema.safeParse({ ...report, lines: Array(201).fill(line) }).success
    ).toBe(false)
  })
})
