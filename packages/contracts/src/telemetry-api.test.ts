import { describe, expect, it } from 'vitest'

import {
  TELEMETRY_DIMENSION_KEYS,
  TelemetryBatchSchema,
  TelemetryDimensionsSchema,
  TelemetryErrorDetailSchema,
  TelemetryEventNameSchema,
  TelemetryEventSchema,
  TelemetryFailureDetailSchema,
  TelemetrySurfaceSchema,
  buildErrorDetail,
  normalizeRejectionReason,
  normalizeWindowError,
  sanitizeTelemetryDimensions,
  sanitizeTelemetryFailure,
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

    it('rejects reserved PostHog dimension keys, one at a time', () => {
      // #given each key PostHog treats as reserved/special-purpose
      const reservedKeys = [
        'distinct_id',
        '$distinct_id',
        '$set',
        '$set_once',
        'set',
        'set_once',
        'groups',
        'session_id',
        'ip'
      ]

      for (const key of reservedKeys) {
        // #when an event carries that key as its one dimension
        const batch = {
          ...baseBatch,
          events: [{ ...baseEvent, dimensions: { [key]: 'safe_value' } }]
        }
        const result = TelemetryBatchSchema.safeParse(batch)

        // #then validation fails — a caller cannot smuggle an identity field
        // through the dimensions bag
        expect(result.success, `expected "${key}" to be rejected`).toBe(false)
      }
    })

    it('still accepts a representative real dimension key from the desktop app', () => {
      // #given the actual dimension keys the desktop app sends today (grepped
      // from apps/desktop/src): log_action, capture_type, setting, from_version,
      // itemType, transport, result_bucket
      for (const key of [
        'log_action',
        'capture_type',
        'setting',
        'from_version',
        'itemType',
        'transport',
        'result_bucket'
      ]) {
        const batch = {
          ...baseBatch,
          events: [{ ...baseEvent, dimensions: { [key]: 'safe_value' } }]
        }
        const result = TelemetryBatchSchema.safeParse(batch)

        // #then none of the desktop's real keys are collateral damage
        expect(result.success, `expected "${key}" to still validate`).toBe(true)
      }
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

describe('canvas rollout telemetry', () => {
  it('accepts the canvas rollout event names', () => {
    expect(TelemetryEventNameSchema.safeParse('canvas_created').success).toBe(true)
    expect(TelemetryEventNameSchema.safeParse('canvas_opened').success).toBe(true)
  })

  it('accepts the canvas surface', () => {
    expect(TelemetrySurfaceSchema.safeParse('canvas').success).toBe(true)
  })

  it('still rejects an unknown event name', () => {
    expect(TelemetryEventNameSchema.safeParse('canvas_exploded').success).toBe(false)
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

  it('walks the cause chain: an undici fetch failure surfaces the nested code', () => {
    // #given undici raises `TypeError: fetch failed` with the real code on .cause,
    // so reading only the top-level code reports a useless "TypeError"
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        code: 'ECONNREFUSED'
      })
    })

    // #then the nested code wins over the top-level class name
    expect(toErrorCode(refused)).toBe('ECONNREFUSED')
  })

  it('walks AggregateError.errors for dual-stack localhost failures', () => {
    // #given a dual-stack localhost connect: undici nests an AggregateError
    const aggregate = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new AggregateError([], 'all attempts failed'), {
        errors: [
          Object.assign(new Error('connect ECONNREFUSED ::1:11434'), { code: 'ECONNREFUSED' }),
          Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' })
        ]
      })
    })

    expect(toErrorCode(aggregate)).toBe('ECONNREFUSED')
  })

  it('surfaces a nested ENOTFOUND (a real misconfiguration), not TypeError', () => {
    const dns = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND ollama.local'), { code: 'ENOTFOUND' })
    })

    expect(toErrorCode(dns)).toBe('ENOTFOUND')
  })

  it('prefers a richer telemetryCode (code + errno) over the bare code', () => {
    // #given a NoteError-shaped error exposing telemetryCode = code:errno
    const error = Object.assign(new Error('failed to write /Users/kaan/note.md'), {
      name: 'NoteError',
      code: 'NOTE_WRITE_FAILED',
      telemetryCode: 'NOTE_WRITE_FAILED:EBUSY'
    })

    // #then the errno-enriched code survives so EBUSY (locked) != ENOSPC (disk-full)
    expect(toErrorCode(error)).toBe('NOTE_WRITE_FAILED:EBUSY')
  })

  it('stops walking the cause chain at a bounded depth', () => {
    // #given a cause chain far deeper than the walker's bound
    let deepest: unknown = Object.assign(new Error('root'), { code: 'ECONNREFUSED' })
    for (let i = 0; i < 8; i++) {
      deepest = Object.assign(new TypeError('fetch failed'), { cause: deepest })
    }

    // #then it does not chase forever — falls back to the class name
    expect(toErrorCode(deepest)).toBe('TypeError')
  })

  it('never leaks a path through a nested cause code', () => {
    // #given a nested cause whose "code" is really a path
    const error = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('x'), { code: '/Users/kaan/secret.md' })
    })

    // #then the hostile nested code is rejected, and no path fragment ships
    const code = toErrorCode(error)
    expect(code).toBe('TypeError')
    expect(code).not.toContain('/')
    expect(code).not.toContain('secret')
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
    // #and the reason's own text rides along, which is the only thing that makes
    // the Rejection_string issue readable at all (#1989)
    expect(buildErrorDetail(normalized)?.message).toBe('everything is on fire')
  })

  // #1989: the reason's message used to be dropped outright, so every
  // Rejection_* issue in Error Tracking was titled after its own error code.
  // Redaction, not omission, is the privacy control.
  it.each([
    ['a home path', 'could not open /Users/kaan/Vault/notes', '/Users/kaan'],
    ['an e-mail', 'sync rejected for kaan@example.com', 'kaan@example.com'],
    ['a note title', 'failed to parse Quarterly Review.md', 'Quarterly Review'],
    ['a bearer token', 'Authorization: Bearer abc.def.ghi expired', 'abc.def.ghi']
  ])('redacts %s carried in a rejection message', (_label, raw, secret) => {
    const detail = buildErrorDetail(normalizeRejectionReason(raw))

    expect(detail?.message).toBeTruthy()
    expect(detail?.message).not.toContain(secret)
  })

  it('carries the message of a cross-realm error, redacted', () => {
    // #given an error from another realm whose message names a vault note
    const crossRealm = {
      name: 'Error',
      message: 'private note /Users/kaan/secret.md failed',
      stack: 'Error: boom\n    at doThing (/app/out/main.js:1:1)'
    }

    const detail = buildErrorDetail(normalizeRejectionReason(crossRealm))

    // #then the message survives with the path and the title both masked
    expect(detail?.message).toBe('private note ~/[name].md failed')
  })

  it('ships the error message, redacted, so the issue title says what broke', () => {
    // #given a real Error whose message is the only human-readable "what happened"
    const detail = buildErrorDetail(new Error('database is locked'))

    // #then it rides along — without it PostHog titles every issue with the bare
    // error code and there is nothing to read on the issue page
    expect(detail?.message).toBe('database is locked')
  })

  it('redacts note titles, emails and home paths out of the message', () => {
    const detail = buildErrorDetail(
      new Error('failed to write /Users/kaan/Vault/secret.md for kaan@example.com')
    )

    expect(detail?.message).not.toContain('secret.md')
    expect(detail?.message).not.toContain('kaan@example.com')
    expect(detail?.message).not.toContain('/Users/kaan')
    // #and the diagnostic shape survives
    expect(detail?.message).toContain('failed to write')
  })

  it('caps the message at the contract length so a dumped payload cannot ride in', () => {
    // Words, not one long run of characters: an unbroken 40+ char token is a
    // secret shape and redactText collapses it to <redacted> before any capping.
    const detail = buildErrorDetail(new Error('failed to write note '.repeat(50)))
    expect(detail?.message).toHaveLength(512)
  })

  it('returns a detail for a message-only error that carries no stack', () => {
    const stackless = new Error('boom')
    stackless.stack = undefined
    // #then the error is still reportable — previously this returned undefined and
    // the event reached PostHog with no error detail at all
    expect(buildErrorDetail(stackless)?.message).toBe('boom')
  })

  it('still returns undefined when there is nothing at all to report', () => {
    const empty = new Error('')
    empty.stack = undefined
    expect(buildErrorDetail(empty)).toBeUndefined()
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

  it('does not adopt a reason name that is not an enum-ish token', () => {
    // #given an error-shaped reason whose own .name is really a path — running it
    // through toSafeToken would character-substitute it (_Users_kaan_secret.md)
    // and still leak the structure
    const reason = {
      name: '/Users/kaan/secret.md',
      stack: 'boom\n    at doThing (/app/out/main.js:1:1)'
    }

    // #then the path-shaped name is rejected outright; the synthesized Rejection_*
    // name is kept and no path fragment rides along in the code
    const normalized = normalizeRejectionReason(reason)
    expect(normalized.name).toBe('Rejection_Object')
    expect(toErrorCode(normalized)).not.toContain('secret')
    expect(toErrorCode(normalized)).not.toContain('/')
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

  it('names the reason by its own error name when it has no usable stack', () => {
    // #given an error-shaped reason that crossed a structured-clone / IPC boundary:
    // the name survives, the stack does not, and the constructor is plain Object
    const cloned = { name: 'TypeError', message: 'x is not a function' }

    // #then the useful name is kept instead of collapsing to Rejection_Object
    expect(normalizeRejectionReason(cloned).name).toBe('Rejection_TypeError')
  })

  it('survives a reason whose property access throws', () => {
    // #given a reason with hostile getters on every property the handler reads
    const hostile = {
      get name() {
        throw new Error('hostile name')
      },
      get stack() {
        throw new Error('hostile stack')
      },
      get constructor() {
        throw new Error('hostile constructor')
      }
    }

    // #then normalizing does not throw out of the rejection handler
    expect(() => normalizeRejectionReason(hostile)).not.toThrow()
    expect(normalizeRejectionReason(hostile)).toBeInstanceOf(Error)
    expect(() => toErrorCode(hostile)).not.toThrow()
    expect(() => buildErrorDetail(hostile)).not.toThrow()
  })

  it('survives a Proxy reason that traps instanceof and every read', () => {
    // #given a reason that throws from `get`, `has` and `getPrototypeOf` — so even
    // `reason instanceof Error` throws before any property is touched
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('hostile get')
        },
        has: () => {
          throw new Error('hostile has')
        },
        getPrototypeOf: () => {
          throw new Error('hostile prototype')
        }
      }
    )

    // #then the handler still produces a safe, code-carrying Error
    expect(() => normalizeRejectionReason(hostile)).not.toThrow()
    expect(toErrorCode(normalizeRejectionReason(hostile))).toBe('Rejection_object')
    expect(() => toErrorCode(hostile)).not.toThrow()
    expect(() => buildErrorDetail(hostile)).not.toThrow()
  })

  it('survives a null-prototype reason that has no constructor at all', () => {
    // #given a reason built with Object.create(null)
    const bare = Object.create(null) as Record<string, unknown>
    bare.detail = 'nope'

    // #then the type is still described rather than crashing the handler
    expect(normalizeRejectionReason(bare).name).toBe('Rejection_object')
  })
})

describe('normalizeWindowError', () => {
  it('passes through a real error that already has stack frames', () => {
    // #given a window error carrying the original Error object
    const error = new Error('boom')

    // #then it is used as-is (its own stack is the actionable one)
    expect(normalizeWindowError({ error, message: 'Uncaught Error: boom' })).toBe(error)
  })

  it('recovers the error class and source location when the error object is missing', () => {
    // #given a window error with no `error` — the case that reached telemetry as
    // StringError with an empty stack and nothing to triage
    const normalized = normalizeWindowError({
      error: null,
      message: 'Uncaught TypeError: n.focus is not a function',
      filename: 'file:///Users/kaan/Memry.app/out/renderer/assets/index-VP6Jd1Vs.js',
      lineno: 121718,
      colno: 22
    })

    // #then the class name and the code location both survive
    expect(normalized.name).toBe('TypeError')
    const detail = buildErrorDetail(normalized)
    expect(detail?.stack).toContain('at ')
    expect(detail?.stack).toContain('index-VP6Jd1Vs.js:121718:22')
    // #and the message rides along so the issue is readable (#1989), while the
    // username in the filename is still masked
    expect(detail?.message).toBe('Uncaught TypeError: n.focus is not a function')
    expect(JSON.stringify(detail)).not.toContain('/Users/kaan')
  })

  it('keeps a generic code when the message names no error class', () => {
    // #given the opaque cross-origin case: "Script error." and no location
    const normalized = normalizeWindowError({ error: null, message: 'Script error.' })

    // #then a stable, non-leaking code is reported, and the message says which
    // of the several message-less window failures this one was
    expect(toErrorCode(normalized)).toBe('WindowError')
    expect(buildErrorDetail(normalized)?.message).toBe('Script error.')
  })

  it('redacts a path carried in a window error message', () => {
    const normalized = normalizeWindowError({
      error: null,
      message: '/Users/kaan/secret.md: failed to load'
    })

    // #then the code stays a bounded token and the message ships masked
    expect(normalized.name).toBe('WindowError')
    expect(buildErrorDetail(normalized)?.message).toBe('~/[name].md: failed to load')
  })

  it('does not adopt a message-derived name that is not an enum-ish token', () => {
    // #given a message whose leading token is really a path
    const normalized = normalizeWindowError({
      error: null,
      message: '/Users/kaan/secret.md: failed to load'
    })

    // #then the path-shaped token is rejected outright
    expect(normalized.name).toBe('WindowError')
    expect(toErrorCode(normalized)).not.toContain('secret')
    expect(toErrorCode(normalized)).not.toContain('/')
  })

  it('survives a hostile error value on the event', () => {
    // #given `event.error` is a Proxy that throws on every read
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error('hostile get')
        },
        getPrototypeOf: () => {
          throw new Error('hostile prototype')
        }
      }
    )

    // #then the window error handler still reports something
    expect(() => normalizeWindowError({ error: hostile, message: 'boom' })).not.toThrow()
    expect(normalizeWindowError({ error: hostile, message: 'boom' })).toBeInstanceOf(Error)
  })
})

describe('contract widening for PostHog migration', () => {
  it('accepts the app_crashed event name', () => {
    expect(TelemetryEventNameSchema.safeParse('app_crashed').success).toBe(true)
  })

  it('accepts an optional redacted error message', () => {
    const parsed = TelemetryErrorDetailSchema.safeParse({
      message: 'Cannot read property id of undefined',
      stack: 'at foo (app.js:1:1)'
    })
    expect(parsed.success).toBe(true)
  })

  it('still accepts an error detail with no message', () => {
    expect(TelemetryErrorDetailSchema.safeParse({ stack: 'at foo (app.js:1:1)' }).success).toBe(
      true
    )
  })

  it('rejects an over-long error message', () => {
    const parsed = TelemetryErrorDetailSchema.safeParse({ message: 'x'.repeat(513) })
    expect(parsed.success).toBe(false)
  })
})

describe('sanitizeTelemetryDimensions', () => {
  it('keeps an allowlisted key whose value is a bounded enum', () => {
    expect(sanitizeTelemetryDimensions({ capture_type: 'clipper' })).toEqual({
      capture_type: 'clipper'
    })
  })

  it('drops scraped page metadata even though it clears the safe-value shape', () => {
    // Every value here is short, has no @, no :// and no slash, so the value
    // blocklist alone would have shipped all of it (#1142).
    const scraped = {
      page_title: 'Divorce settlement calculator - LawFirm',
      description: 'What you are owed after separation',
      og_site_name: 'Sensitive Health Forum'
    }
    for (const [key, value] of Object.entries(scraped)) {
      expect(sanitizeTelemetryDimensions({ [key]: value })).toBeUndefined()
    }
  })

  it('drops an allowlisted key whose value breaks the safe-value shape', () => {
    expect(sanitizeTelemetryDimensions({ target: 'https://example.com/x' })).toBeUndefined()
    expect(sanitizeTelemetryDimensions({ setting: 'a'.repeat(65) })).toBeUndefined()
    expect(
      sanitizeTelemetryDimensions({ value: '550e8400-e29b-41d4-a716-446655440000' })
    ).toBeUndefined()
  })

  it('keeps at most one dimension, skipping past disallowed keys', () => {
    expect(
      sanitizeTelemetryDimensions({ page_title: 'Anything', transport: 'record', tool: 'read' })
    ).toEqual({ transport: 'record' })
  })

  it('passes undefined through untouched so the caller can omit the field', () => {
    expect(sanitizeTelemetryDimensions(undefined)).toBeUndefined()
  })

  it('only allowlists keys the schema itself would accept', () => {
    for (const key of TELEMETRY_DIMENSION_KEYS) {
      expect(TelemetryDimensionsSchema.safeParse({ [key]: 'ok' }).success).toBe(true)
    }
  })
})

// #1584: `sync_error` carried one opaque `server_error` label with no status and
// no server code, so a permanent 400 and a transient edge 5xx were the same row.
describe('TelemetryFailureDetailSchema', () => {
  it('accepts a bounded status, server code and retryable verdict', () => {
    expect(
      TelemetryFailureDetailSchema.safeParse({
        httpStatus: 400,
        serverCode: 'VALIDATION_ERROR',
        retryable: false
      }).success
    ).toBe(true)
  })

  it('rejects anything that could turn the server code into free text', () => {
    for (const serverCode of [
      'Invalid push request',
      'validation_error',
      '/Users/kaan/vault/note.md',
      'kaan@example.com',
      'A'.repeat(65)
    ]) {
      expect(TelemetryFailureDetailSchema.safeParse({ serverCode }).success).toBe(false)
    }
  })

  it('rejects a status outside the HTTP range', () => {
    for (const httpStatus of [0, 99, 600, 4.5]) {
      expect(TelemetryFailureDetailSchema.safeParse({ httpStatus }).success).toBe(false)
    }
  })

  // BACKWARD COMPATIBILITY, both directions. An older desktop omits the field —
  // it is optional, so the batch stays valid. A newer desktop sends it to a
  // sync-server on older contracts — z.object STRIPS unknown keys rather than
  // rejecting, so the whole batch is not 400'd and the other events survive.
  it('leaves an event without a failure detail valid', () => {
    expect(TelemetryEventSchema.safeParse(baseEvent).success).toBe(true)
  })

  it('does not reject an event carrying a key the schema does not know', () => {
    const parsed = TelemetryEventSchema.safeParse({ ...baseEvent, someFutureField: { a: 1 } })
    expect(parsed.success).toBe(true)
    expect(parsed.success && 'someFutureField' in parsed.data).toBe(false)
  })
})

describe('sanitizeTelemetryFailure', () => {
  it('passes a valid detail through untouched', () => {
    const failure = { httpStatus: 503, retryable: true }
    expect(sanitizeTelemetryFailure(failure)).toBe(failure)
  })

  it('passes undefined through so the caller can omit the field', () => {
    expect(sanitizeTelemetryFailure(undefined)).toBeUndefined()
  })

  // The sync-server rejects an ENTIRE batch when one event fails validation, so
  // a malformed field must cost that field, never the 99 events queued with it.
  it('drops only the offending field', () => {
    expect(
      sanitizeTelemetryFailure({
        httpStatus: 400,
        serverCode: 'Invalid push request' as string,
        retryable: false
      })
    ).toEqual({ httpStatus: 400, retryable: false })
  })

  it('returns undefined when nothing survives', () => {
    expect(sanitizeTelemetryFailure({ httpStatus: 42, serverCode: 'nope' })).toBeUndefined()
  })
})
