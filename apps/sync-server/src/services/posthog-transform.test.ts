import { describe, expect, it } from 'vitest'

import type { TelemetryBatch } from '@memry/contracts/telemetry-api'

import {
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

describe('resolveDistinctId', () => {
  it('uses the account id when present', () => {
    expect(
      resolveDistinctId({ installHash: 'hash', accountId: 'acct_1', environment: 'production' })
    ).toBe('acct_1')
  })

  it('falls back to the install hash', () => {
    expect(resolveDistinctId({ installHash: 'hash', environment: 'production' })).toBe('hash')
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
      accountId: 'acct_1',
      environment: 'production'
    })
    expect(event).not.toBeNull()
    expect(event?.event).toBe('$identify')
    expect(event?.distinct_id).toBe('acct_1')
    expect(event?.properties.$anon_distinct_id).toBe('hash')
    expect(event?.properties.environment).toBe('production')
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
})
