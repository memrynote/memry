import { describe, expect, it, vi } from 'vitest'

// http-client reaches for electron's `net` at import time.
vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

// Mask-mode redaction (no vault root, no salted hasher) so this suite never
// touches electron's app paths or the diagnostics salt file. The redaction rules
// themselves are packages/contracts/src/redact.test.ts' subject.
vi.mock('../telemetry/redact-options', () => ({
  getMainRedactOptions: () => ({})
}))

import { SyncServerError, NetworkError } from './http-client'
import { syncErrorTelemetry, syncErrorTelemetryFor } from './sync-error-telemetry'
import { classifyError } from './sync-errors'

// #1584: every one of these used to ship the single event
// `{error_code: 'server_error', message: ''}` — a permanent 400 and a transient
// 503 were indistinguishable without hand-joining sync-server logs.
describe('syncErrorTelemetry', () => {
  it('#given a 400 VALIDATION_ERROR #then status, code, retryable and a message all ship', () => {
    const detail =
      'VALIDATION_ERROR: Invalid push request: Record sync item type "calendar_external_event" requires clock metadata'
    const fields = syncErrorTelemetryFor(new SyncServerError('Invalid push request', 400, detail))

    expect(fields.errorCode).toBe('server_error')
    expect(fields.failure).toEqual({
      httpStatus: 400,
      serverCode: 'VALIDATION_ERROR',
      retryable: false
    })
    expect(fields.error?.message).toContain('requires clock metadata')
  })

  it('#given a 503 with no server code #then it is distinguishable from the 400', () => {
    const client = syncErrorTelemetryFor(new SyncServerError('Bad Request', 400, 'VALIDATION_ERROR: nope'))
    const server = syncErrorTelemetryFor(new SyncServerError('Server returned 503', 503))

    expect(server.failure).toEqual({ httpStatus: 503, retryable: true })
    // Same label, different rows: this is what makes an alert threshold possible.
    expect(server.errorCode).toBe(client.errorCode)
    expect(server.failure).not.toEqual(client.failure)
  })

  it('#given a known code on a 413 #then the code lands in its own field', () => {
    const body = '{"error":{"code":"STORAGE_QUOTA_EXCEEDED","message":"Storage quota exceeded"}}'
    const fields = syncErrorTelemetryFor(new SyncServerError('Quota', 413, body))

    expect(fields.errorCode).toBe('storage_quota_exceeded')
    expect(fields.failure).toEqual({
      httpStatus: 413,
      serverCode: 'STORAGE_QUOTA_EXCEEDED',
      retryable: false
    })
  })

  it('#given a failure with no HTTP request #then only the retryable verdict ships', () => {
    const fields = syncErrorTelemetryFor(new NetworkError('fetch failed'))

    expect(fields.errorCode).toBe('network_offline')
    expect(fields.failure).toEqual({ retryable: true })
    expect(fields.error?.message).toBe('fetch failed')
  })

  it('#given a message carrying a home path #then it is redacted before it ships', () => {
    const fields = syncErrorTelemetryFor(
      new Error("ENOENT: no such file or directory, open '/Users/kaan/Vault/Secret.md'")
    )

    expect(fields.error?.message).toBeDefined()
    expect(fields.error?.message).not.toContain('/Users/kaan')
    expect(fields.error?.message).not.toContain('Secret.md')
  })

  it('#given an over-long message #then it is capped at the schema limit', () => {
    const fields = syncErrorTelemetry(classifyError(new Error('server unavailable '.repeat(100))))

    expect(fields.error?.message?.length).toBe(512)
  })

  it('#given classification itself throwing #then telemetry degrades instead of throwing', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile getter')
        }
      }
    )

    expect(syncErrorTelemetryFor(hostile).errorCode).toBe('unknown')
  })
})
