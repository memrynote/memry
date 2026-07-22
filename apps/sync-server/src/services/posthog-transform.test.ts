import { describe, expect, it } from 'vitest'

import type { TelemetryBatch } from '@memry/contracts/telemetry-api'

import { identifyEvent, personProperties, resolveDistinctId } from './posthog-transform'

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
