import { describe, expect, it } from 'vitest'

import {
  LandingTelemetryBatchSchema,
  TelemetryBatchSchema,
  TelemetryEventNameSchema,
  TelemetryEventSchema,
  buildErrorDetail,
  normalizeRejectionReason,
  toErrorCode
} from './telemetry-api'

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

    it('accepts launch, log, and error diagnostic events', () => {
      // #given a batch with app diagnostics that use only enum-like metadata
      const batch = {
        ...baseBatch,
        events: [
          {
            ...baseEvent,
            name: 'app_launch_phase_completed',
            action: 'renderer_ready',
            source: 'renderer',
            metrics: { durationMs: 42 }
          },
          {
            ...baseEvent,
            id: '550e8400-e29b-41d4-a716-446655440003',
            name: 'app_log_recorded',
            action: 'warn',
            source: 'SyncRuntime',
            objectType: 'log',
            dimensions: { log_action: 'flush_failed' }
          },
          {
            ...baseEvent,
            id: '550e8400-e29b-41d4-a716-446655440004',
            name: 'app_error_seen',
            action: 'unhandled_rejection',
            source: 'main_process',
            objectType: 'exception',
            result: 'failed',
            errorCode: 'TypeError'
          }
        ]
      }

      // #when validating the batch
      const result = TelemetryBatchSchema.safeParse(batch)

      // #then diagnostic events stay inside the typed telemetry allowlist
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

  it('accepts the agent chat, command palette, and updater event names', () => {
    for (const name of [
      'agent_chat_started',
      'agent_chat_message_sent',
      'command_palette_opened',
      'app_update_installed'
    ]) {
      expect(TelemetryEventNameSchema.safeParse(name).success).toBe(true)
    }
  })
})

describe('LandingTelemetryBatchSchema', () => {
  const baseLandingBatch = {
    visitorId: VALID_INSTALL_ID,
    events: [
      {
        name: 'landing_pricing_cta_click',
        page: '/pricing',
        target: 'pricing:plus',
        utm_source: 'waitlist',
        utm_medium: 'email',
        utm_campaign: 'waitlist_01_launch',
        utm_content: 'primary_cta',
        utm_term: 'notes'
      }
    ]
  }

  it('accepts a valid landing batch', () => {
    expect(LandingTelemetryBatchSchema.safeParse(baseLandingBatch).success).toBe(true)
  })

  it('accepts a minimal pageview event', () => {
    const result = LandingTelemetryBatchSchema.safeParse({
      visitorId: VALID_INSTALL_ID,
      events: [{ name: 'landing_page_view', page: '/' }]
    })
    expect(result.success).toBe(true)
  })

  it('rejects a non-uuid visitor id', () => {
    const result = LandingTelemetryBatchSchema.safeParse({
      ...baseLandingBatch,
      visitorId: 'visitor-1'
    })
    expect(result.success).toBe(false)
  })

  it('rejects values that look like emails, URLs, paths, or raw identifiers', () => {
    const badEvents = [
      { name: 'landing_nav_click', page: '/pricing', target: 'user@example.com' },
      { name: 'landing_nav_click', page: '/pricing', utm_source: 'https://evil.example' },
      { name: 'landing_nav_click', page: '/pricing', utm_campaign: 'a/b' },
      { name: 'landing_nav_click', page: '/pricing', utm_term: 'line\nbreak' },
      { name: 'landing_nav_click', page: `/note/${VALID_INSTALL_ID}` },
      { name: 'landing_nav_click', page: 'pricing' },
      { name: 'Landing Nav Click!', page: '/pricing' }
    ]
    for (const event of badEvents) {
      const result = LandingTelemetryBatchSchema.safeParse({
        visitorId: VALID_INSTALL_ID,
        events: [event]
      })
      expect(result.success).toBe(false)
    }
  })

  it('rejects empty and oversize event lists', () => {
    const empty = LandingTelemetryBatchSchema.safeParse({ ...baseLandingBatch, events: [] })
    expect(empty.success).toBe(false)

    const oversize = LandingTelemetryBatchSchema.safeParse({
      ...baseLandingBatch,
      events: Array.from({ length: 21 }, () => baseLandingBatch.events[0])
    })
    expect(oversize.success).toBe(false)
  })
})

describe('toErrorCode', () => {
  it('prefers a typed code over the class name for NoteError-shaped errors', () => {
    // #given a NoteError carrying one of the 7 typed NoteErrorCode values
    const error = Object.assign(new Error('could not write /Users/kaan/note.md'), {
      name: 'NoteError',
      code: 'NOTE_WRITE_FAILED'
    })

    // #then the typed code survives instead of collapsing to "NoteError"
    expect(toErrorCode(error)).toBe('NOTE_WRITE_FAILED')
  })

  it('prefers better-sqlite3 SQLITE_* codes over the SqliteError class name', () => {
    // #given a better-sqlite3-shaped error (code lives on error.code)
    const error = Object.assign(new Error('database is locked'), {
      name: 'SqliteError',
      code: 'SQLITE_BUSY'
    })

    // #then we can tell a locked file from a disk-full
    expect(toErrorCode(error)).toBe('SQLITE_BUSY')
  })

  it('falls back to the class name when there is no typed code', () => {
    expect(toErrorCode(new TypeError('boom'))).toBe('TypeError')
  })

  it('falls back to the class name when the code is not a usable string', () => {
    // #given errors whose code is absent, empty, or a non-string
    const numeric = Object.assign(new Error('boom'), { name: 'SystemError', code: -4058 })
    const empty = Object.assign(new Error('boom'), { name: 'SystemError', code: '' })

    // #then the class name is used rather than a meaningless token
    expect(toErrorCode(numeric)).toBe('SystemError')
    expect(toErrorCode(empty)).toBe('SystemError')
  })

  it('never leaks a path/email/url through a code (safe-token invariants hold)', () => {
    // #given hostile "codes" that would leak private data if trusted verbatim
    const cases: Array<[unknown, string]> = [
      [
        Object.assign(new Error('x'), { name: 'NoteError', code: '/Users/kaan/secret.md' }),
        'NoteError'
      ],
      [
        Object.assign(new Error('x'), { name: 'NoteError', code: 'C:\\Users\\kaan\\a.md' }),
        'NoteError'
      ],
      [
        Object.assign(new Error('x'), { name: 'AuthError', code: 'kaan@memrynote.com' }),
        'AuthError'
      ],
      [
        Object.assign(new Error('x'), { name: 'HttpError', code: 'https://api.memrynote.com/x' }),
        'HttpError'
      ],
      // a 200-char "code" is prose, not a code: reject it rather than truncate
      [Object.assign(new Error('x'), { name: 'LongError', code: 'A'.repeat(200) }), 'LongError']
    ]

    // #then every code path stays inside the safe-token rules
    for (const [error, expected] of cases) {
      const code = toErrorCode(error)
      expect(code).toBe(expected)
      expect(code).not.toContain('@')
      expect(code).not.toContain('://')
      expect(code).not.toContain('/')
      expect(code).not.toContain('\\')
      expect(code.length).toBeLessThanOrEqual(64)
    }
  })

  it('keeps the existing non-Error behaviour', () => {
    expect(toErrorCode('boom')).toBe('StringError')
    expect(toErrorCode(undefined)).toBe('UnknownError')
    expect(toErrorCode({ constructor: { name: 'PlainThing' } })).toBe('PlainThing')
  })
})

describe('normalizeRejectionReason', () => {
  it('passes through a real Error that already has stack frames', () => {
    // #given a normal rejection
    const error = new Error('boom')

    // #then it is used as-is (its own stack is the actionable one)
    expect(normalizeRejectionReason(error)).toBe(error)
  })

  it('adopts the stack of a cross-realm error that fails instanceof Error', () => {
    // #given an error from another realm: constructor says Error, instanceof fails
    const crossRealm = {
      name: 'Error',
      message: 'private note /Users/kaan/secret.md failed',
      stack:
        'Error: private note /Users/kaan/secret.md failed\n    at doThing (/app/out/main.js:1:1)'
    }

    // #when normalizing the reason
    const normalized = normalizeRejectionReason(crossRealm)

    // #then a real Error carrying the original frames comes back
    expect(normalized).toBeInstanceOf(Error)
    expect(buildErrorDetail(normalized)?.stack).toContain('at doThing')
    // #and the message never rides along
    expect(JSON.stringify(buildErrorDetail(normalized))).not.toContain('secret.md')
  })

  it('synthesizes a stack and names the reason type for a non-Error reason', () => {
    // #given a rejection whose reason is a bare string (no stack at all)
    const normalized = normalizeRejectionReason('everything is on fire')

    // #then something actionable is captured: a real stack + the reason's type
    expect(normalized).toBeInstanceOf(Error)
    expect(normalized.name).toBe('Rejection_string')
    expect(buildErrorDetail(normalized)?.stack).toContain('at ')
    // #and the reason's value is never shipped
    expect(normalized.message).toBe('')
    expect(JSON.stringify(buildErrorDetail(normalized))).not.toContain('on fire')
  })

  it('names the constructor for a plain-object reason', () => {
    class Boom {}
    expect(normalizeRejectionReason(new Boom()).name).toBe('Rejection_Boom')
    expect(normalizeRejectionReason({ a: 1 }).name).toBe('Rejection_Object')
  })

  it('names null/undefined reasons instead of dropping them', () => {
    expect(normalizeRejectionReason(null).name).toBe('Rejection_null')
    expect(normalizeRejectionReason(undefined).name).toBe('Rejection_undefined')
  })

  it('produces codes that satisfy the safe-token invariants', () => {
    for (const reason of ['x', 42, null, undefined, { a: 1 }, Symbol('s')]) {
      const code = toErrorCode(normalizeRejectionReason(reason))
      expect(code).not.toContain('@')
      expect(code).not.toContain('://')
      expect(code).not.toContain('/')
      expect(code).not.toContain('\\')
      expect(code.length).toBeLessThanOrEqual(64)
    }
  })
})
