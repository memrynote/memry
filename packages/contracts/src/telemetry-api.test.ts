import { describe, expect, it } from 'vitest'

import { TelemetryBatchSchema, TelemetryEventSchema } from './telemetry-api'

const VALID_INSTALL_ID = '550e8400-e29b-41d4-a716-446655440000'
const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440001'
const VALID_EVENT_ID = '550e8400-e29b-41d4-a716-446655440002'
const VALID_TIMESTAMP = '2026-05-01T12:00:00.000Z'

const baseEvent = {
  id: VALID_EVENT_ID,
  name: 'app_started' as const,
  occurredAt: VALID_TIMESTAMP,
  surface: 'app' as const,
  action: 'started',
  result: 'success' as const
}

const baseBatch = {
  schemaVersion: 1 as const,
  installId: VALID_INSTALL_ID,
  sessionId: VALID_SESSION_ID,
  appVersion: '0.1.0',
  buildChannel: 'development' as const,
  platform: 'darwin' as const,
  arch: 'arm64',
  locale: 'en',
  timezoneOffsetMinutes: -180,
  authState: 'anonymous' as const,
  syncState: 'disabled' as const,
  events: [baseEvent]
}

describe('TelemetryBatchSchema', () => {
  describe('happy path', () => {
    it('accepts a valid anonymous batch with app_started', () => {
      // #given a minimal valid batch with one app_started event
      // #when validating the batch
      const result = TelemetryBatchSchema.safeParse(baseBatch)

      // #then it parses successfully
      expect(result.success).toBe(true)
    })

    it('accepts a batch with valid metrics fields', () => {
      // #given an event with all numeric metrics fields populated
      const batch = {
        ...baseBatch,
        events: [
          {
            ...baseEvent,
            metrics: {
              durationMs: 123,
              itemCount: 5,
              byteCount: 1024,
              queueCount: 3,
              resultCount: 10,
              retryCount: 2,
              activeSeconds: 60,
              value: 1.5
            }
          }
        ]
      }

      // #when validating the batch
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then it parses successfully
      expect(result.success).toBe(true)
    })

    it('accepts a batch with one safe optional dimension', () => {
      // #given an event with safe enum-like dimensions
      const batch = {
        ...baseBatch,
        events: [
          {
            ...baseEvent,
            objectType: 'note',
            source: 'sidebar',
            errorCode: 'sync_replay',
            dimensions: {
              capture_type: 'text'
            }
          }
        ]
      }

      // #when validating the batch
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then it parses successfully
      expect(result.success).toBe(true)
    })
  })

  describe('rejects unsafe event names', () => {
    it('rejects an unknown event name', () => {
      // #given a batch with an event name not in the allowlist
      const batch = {
        ...baseBatch,
        events: [{ ...baseEvent, name: 'unknown_event' }]
      }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })
  })

  describe('rejects unsafe surfaces', () => {
    it('rejects an unknown surface', () => {
      // #given a batch with a surface not in the allowlist
      const batch = {
        ...baseBatch,
        events: [{ ...baseEvent, surface: 'unknown_surface' }]
      }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })
  })

  describe('rejects unsafe dimension values', () => {
    it('rejects an email-shaped dimension value', () => {
      // #given an event whose dimension contains an email address
      const batch = {
        ...baseBatch,
        events: [
          {
            ...baseEvent,
            dimensions: { user: 'alice@example.com' }
          }
        ]
      }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })

    it('rejects a URL-shaped dimension value', () => {
      // #given an event whose dimension contains a URL
      const batch = {
        ...baseBatch,
        events: [
          {
            ...baseEvent,
            dimensions: { src: 'https://example.com/path' }
          }
        ]
      }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })

    it('rejects a posix path-shaped dimension value', () => {
      // #given an event whose dimension contains a unix path
      const batch = {
        ...baseBatch,
        events: [
          {
            ...baseEvent,
            dimensions: { folder: '/Users/me/Documents' }
          }
        ]
      }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })

    it('rejects a windows path-shaped dimension value', () => {
      // #given an event whose dimension contains a windows path
      const batch = {
        ...baseBatch,
        events: [
          {
            ...baseEvent,
            dimensions: { folder: 'C:\\Users\\me' }
          }
        ]
      }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })

    it('rejects a long free-form dimension value', () => {
      // #given an event whose dimension exceeds 64 characters
      const batch = {
        ...baseBatch,
        events: [
          {
            ...baseEvent,
            dimensions: { description: 'a'.repeat(200) }
          }
        ]
      }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })

    it('rejects a dimension key that looks like a path', () => {
      // #given an event whose dimension key contains a path
      const batch = {
        ...baseBatch,
        events: [
          {
            ...baseEvent,
            dimensions: { '/Users/me/Documents': 'safe_value' }
          }
        ]
      }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })

    it('rejects UUID-shaped dimension values', () => {
      // #given an event whose dimension value is a raw identifier
      const batch = {
        ...baseBatch,
        events: [
          {
            ...baseEvent,
            dimensions: { account_id: VALID_INSTALL_ID }
          }
        ]
      }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })

    it('rejects UUID-shaped source values', () => {
      // #given an event whose source is a raw identifier
      const batch = {
        ...baseBatch,
        events: [{ ...baseEvent, source: VALID_INSTALL_ID }]
      }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })

    it('rejects events with more than one dimension', () => {
      // #given an event with two dimensions but only one analytics slot
      const batch = {
        ...baseBatch,
        events: [
          {
            ...baseEvent,
            dimensions: {
              search_type: 'global',
              result_bucket: 'six_plus'
            }
          }
        ]
      }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails instead of silently dropping one dimension
      expect(result.success).toBe(false)
    })

    it('rejects an action with a path separator', () => {
      // #given an event whose action contains a slash
      const batch = {
        ...baseBatch,
        events: [{ ...baseEvent, action: 'open/note' }]
      }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })
  })

  describe('rejects oversized batches', () => {
    it('rejects more than 100 events', () => {
      // #given a batch with 101 events
      const events = Array.from({ length: 101 }, (_, i) => ({
        ...baseEvent,
        id: `550e8400-e29b-41d4-a716-${String(i).padStart(12, '0')}`
      }))
      const batch = { ...baseBatch, events }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })

    it('rejects an empty events array', () => {
      // #given a batch with no events
      const batch = { ...baseBatch, events: [] }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })
  })

  describe('rejects missing identifiers', () => {
    it('rejects a batch missing installId', () => {
      // #given a batch without installId
      const { installId: _installId, ...rest } = baseBatch
      void _installId

      // #when validating
      const result = TelemetryBatchSchema.safeParse(rest)

      // #then validation fails
      expect(result.success).toBe(false)
    })

    it('rejects a batch missing sessionId', () => {
      // #given a batch without sessionId
      const { sessionId: _sessionId, ...rest } = baseBatch
      void _sessionId

      // #when validating
      const result = TelemetryBatchSchema.safeParse(rest)

      // #then validation fails
      expect(result.success).toBe(false)
    })

    it('rejects an installId that is not a UUID', () => {
      // #given a batch with a non-UUID installId
      const batch = { ...baseBatch, installId: 'not-a-uuid' }

      // #when validating
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then validation fails
      expect(result.success).toBe(false)
    })
  })
})

describe('TelemetryEventSchema', () => {
  it('accepts a minimal valid event', () => {
    // #given a minimal event with only required fields
    const result = TelemetryEventSchema.safeParse(baseEvent)

    // #then validation passes
    expect(result.success).toBe(true)
  })

  it('rejects a non-UUID event id', () => {
    // #given an event with a malformed id
    const result = TelemetryEventSchema.safeParse({ ...baseEvent, id: 'abc' })

    // #then validation fails
    expect(result.success).toBe(false)
  })

  it('rejects an event without an occurredAt timestamp', () => {
    // #given an event missing occurredAt
    const { occurredAt: _occurredAt, ...rest } = baseEvent
    void _occurredAt

    // #when validating
    const result = TelemetryEventSchema.safeParse(rest)

    // #then validation fails
    expect(result.success).toBe(false)
  })

  it('rejects negative metrics values', () => {
    // #given an event with negative durationMs
    const result = TelemetryEventSchema.safeParse({
      ...baseEvent,
      metrics: { durationMs: -1 }
    })

    // #then validation fails
    expect(result.success).toBe(false)
  })
})
