import { describe, expect, it } from 'vitest'

import type { TelemetryBatch } from '@memry/contracts/telemetry-api'

import {
  exceptionEvent,
  identifyEvent,
  personProperties,
  productEvent,
  resolveDistinctId
} from './posthog-transform'

export const batchFixture = (overrides: Partial<TelemetryBatch> = {}): TelemetryBatch => ({
  schemaVersion: 1,
  installId: '11111111-1111-4111-8111-111111111111',
  sessionId: '22222222-2222-4222-8222-222222222222',
  appVersion: '2026.7.1',
  buildChannel: 'production',
  platform: 'darwin',
  arch: 'arm64',
  locale: 'tr-TR',
  timezoneOffsetMinutes: 180,
  authState: 'anonymous',
  syncState: 'enabled',
  events: [],
  ...overrides
})

// hashTelemetryId output shape: 64 lowercase hex chars.
const ACCOUNT_HASH = 'a'.repeat(64)
const RAW_ACCOUNT_ID = '550e8400-e29b-41d4-a716-446655440000'

describe('resolveDistinctId', () => {
  it('uses the account hash when present', () => {
    expect(
      resolveDistinctId({
        installHash: 'hash',
        accountHash: ACCOUNT_HASH,
        environment: 'production'
      })
    ).toBe(ACCOUNT_HASH)
  })

  it('falls back to the install hash', () => {
    expect(resolveDistinctId({ installHash: 'hash', environment: 'production' })).toBe('hash')
  })

  // THE ONE-WAY DOOR. A raw account id reaching distinct_id cannot be undone:
  // $identify merges in PostHog are permanent and cannot be re-keyed. If this
  // test fails, do not "fix" it by loosening the guard.
  it('never lets a raw account id become the distinct id', () => {
    expect(
      resolveDistinctId({
        installHash: 'hash',
        accountHash: RAW_ACCOUNT_ID,
        environment: 'production'
      })
    ).toBe('hash')
  })

  it('rejects anything that is not a 64-char lowercase hex hash', () => {
    for (const value of [
      '',
      'acct_1',
      'kaan@example.com',
      ACCOUNT_HASH.toUpperCase(),
      ACCOUNT_HASH.slice(0, 63),
      `${ACCOUNT_HASH}a`
    ]) {
      expect(
        resolveDistinctId({ installHash: 'hash', accountHash: value, environment: 'production' })
      ).toBe('hash')
    }
  })
})

describe('personProperties', () => {
  it('carries the batch metadata and environment', () => {
    expect(personProperties(batchFixture(), 'production')).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      locale: 'tr-TR',
      app_version: '2026.7.1',
      build_channel: 'production',
      sync_state: 'enabled',
      timezone_offset_minutes: 180,
      environment: 'production'
    })
  })
})

describe('identifyEvent', () => {
  it('returns null when there is no account', () => {
    expect(
      identifyEvent(batchFixture(), { installHash: 'hash', environment: 'production' })
    ).toBeNull()
  })

  it('aliases the install hash onto the account', () => {
    const event = identifyEvent(batchFixture({ authState: 'signed_in' }), {
      installHash: 'hash',
      accountHash: ACCOUNT_HASH,
      environment: 'production'
    })
    expect(event).not.toBeNull()
    expect(event?.event).toBe('$identify')
    expect(event?.distinct_id).toBe(ACCOUNT_HASH)
    expect(event?.properties.$anon_distinct_id).toBe('hash')
    expect(event?.properties.environment).toBe('production')
  })

  // A permanent merge onto a raw account id is the exact irreversible outcome
  // this whole module guards against — refuse to merge rather than fall back.
  it('refuses to merge when the account hash is a raw account id', () => {
    expect(
      identifyEvent(batchFixture({ authState: 'signed_in' }), {
        installHash: 'hash',
        accountHash: RAW_ACCOUNT_ID,
        environment: 'production'
      })
    ).toBeNull()
  })
})

const ctx = { installHash: 'hash', environment: 'production' }

const eventFixture = (overrides = {}) => ({
  id: '33333333-3333-4333-8333-333333333333',
  name: 'note_created' as const,
  occurredAt: '2026-07-22T10:00:00.000Z',
  surface: 'notes' as const,
  action: 'create',
  ...overrides
})

describe('productEvent', () => {
  it('preserves the event name and maps the core fields', () => {
    const result = productEvent(batchFixture(), eventFixture(), ctx)
    expect(result.event).toBe('note_created')
    expect(result.distinct_id).toBe('hash')
    expect(result.timestamp).toBe('2026-07-22T10:00:00.000Z')
    expect(result.properties.surface).toBe('notes')
    expect(result.properties.action).toBe('create')
    expect(result.properties.environment).toBe('production')
  })

  it('emits platform, app_version and build_channel as event properties', () => {
    // Not only as $set person properties: a person property holds the LATEST
    // value, which would make version-adoption charts answer the wrong question,
    // and pre-migration dashboards break down on the event property `platform`.
    const result = productEvent(batchFixture(), eventFixture(), ctx)
    expect(result.properties.platform).toBe('darwin')
    expect(result.properties.app_version).toBe('2026.7.1')
    expect(result.properties.build_channel).toBe('production')
  })

  it('does not let a client dimension override platform or app_version', () => {
    const result = productEvent(
      batchFixture(),
      eventFixture({ dimensions: { platform: 'win32' } }),
      ctx
    )
    expect(result.properties.platform).toBe('darwin')
  })

  it('renames page_viewed to $pageview', () => {
    const result = productEvent(batchFixture(), eventFixture({ name: 'page_viewed' }), ctx)
    expect(result.event).toBe('$pageview')
  })

  it('attaches person properties via $set', () => {
    const result = productEvent(batchFixture(), eventFixture(), ctx)
    expect(result.properties.$set).toMatchObject({ platform: 'darwin', app_version: '2026.7.1' })
  })

  it('flattens metrics and the single dimension', () => {
    const result = productEvent(
      batchFixture(),
      eventFixture({ metrics: { durationMs: 42 }, dimensions: { log_action: 'gpu_gone' } }),
      ctx
    )
    expect(result.properties.duration_ms).toBe(42)
    expect(result.properties.log_action).toBe('gpu_gone')
  })

  it('omits absent optional fields rather than emitting empty strings', () => {
    const result = productEvent(batchFixture(), eventFixture(), ctx)
    expect(result.properties).not.toHaveProperty('error_code')
    expect(result.properties).not.toHaveProperty('object_type')
  })

  it('does not let a client-supplied "environment" dimension override ctx.environment', () => {
    const result = productEvent(
      batchFixture(),
      eventFixture({ dimensions: { environment: 'staging' } }),
      ctx
    )
    expect(result.properties.environment).toBe('production')
  })

  it('does not let a client-supplied "session_id" dimension override the batch session id', () => {
    const result = productEvent(
      batchFixture({ sessionId: '99999999-9999-4999-8999-999999999999' }),
      eventFixture({ dimensions: { session_id: 'spoofed' } }),
      ctx
    )
    expect(result.properties.session_id).toBe('99999999-9999-4999-8999-999999999999')
  })

  it('still flattens a non-colliding dimension onto properties', () => {
    const result = productEvent(
      batchFixture(),
      eventFixture({ dimensions: { log_action: 'gpu_gone' } }),
      ctx
    )
    expect(result.properties.log_action).toBe('gpu_gone')
  })
})

describe('exceptionEvent', () => {
  it('returns null for an event with no error signal', () => {
    expect(exceptionEvent(batchFixture(), eventFixture(), ctx)).toBeNull()
  })

  it('builds a $exception with the error code as type and fingerprint', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({
        name: 'app_error_seen',
        errorCode: 'SYNC_TIMEOUT',
        error: { stack: 'at sync (a.js:1:1)' }
      }),
      ctx
    )
    expect(result?.event).toBe('$exception')
    expect(result?.properties.$exception_fingerprint).toBe('SYNC_TIMEOUT')
    const list = result?.properties.$exception_list as { type: string; value: string }[]
    expect(list[0].type).toBe('SYNC_TIMEOUT')
    expect(list[0].value).toContain('at sync (a.js:1:1)')
  })

  it('prefers the redacted message over the stack for the value', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({
        errorCode: 'DB_LOCKED',
        error: { message: 'database is locked', stack: 'at db (b.js:2:2)' }
      }),
      ctx
    )
    const list = result?.properties.$exception_list as { value: string }[]
    expect(list[0].value).toBe('database is locked\n\nat db (b.js:2:2)')
  })

  it('re-runs redaction on the message as a backstop', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({ errorCode: 'X', error: { message: 'failed for kaan@example.com' } }),
      ctx
    )
    const list = result?.properties.$exception_list as { value: string }[]
    expect(list[0].value).not.toContain('kaan@example.com')
  })

  it('falls back to the error code when there is no message or stack', () => {
    const result = exceptionEvent(batchFixture(), eventFixture({ errorCode: 'NO_DETAIL' }), ctx)
    const list = result?.properties.$exception_list as { value: string }[]
    expect(list[0].value).toBe('NO_DETAIL')
  })

  it('omits $exception_fingerprint entirely when there is no errorCode', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({ name: 'app_error_seen', error: { message: 'boom' } }),
      ctx
    )
    expect(result?.properties).not.toHaveProperty('$exception_fingerprint')
  })

  it('still sets $exception_list[0].type to the event name when there is no errorCode', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({ name: 'app_error_seen', error: { message: 'boom' } }),
      ctx
    )
    const list = result?.properties.$exception_list as { type: string }[]
    expect(list[0].type).toBe('app_error_seen')
  })

  it('pins $exception_fingerprint to the error code when one is present', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({
        name: 'app_error_seen',
        errorCode: 'SYNC_TIMEOUT',
        error: { message: 'boom' }
      }),
      ctx
    )
    expect(result?.properties.$exception_fingerprint).toBe('SYNC_TIMEOUT')
  })
})
