import { describe, expect, it } from 'vitest'

import type {
  TelemetryBatch,
  TelemetryEvent,
  TelemetryMetrics
} from '@memry/contracts/telemetry-api'

import {
  exceptionEvent,
  identifyEvent,
  isLegacyMutationDropNoise,
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
    expect(result.properties).not.toHaveProperty('http_status')
    expect(result.properties).not.toHaveProperty('server_code')
    expect(result.properties).not.toHaveProperty('retryable')
  })

  // #1584: a 400 VALIDATION_ERROR and a 503 with no server code both shipped as
  // the single label `server_error`, so no chart and no alert threshold could
  // separate "our contract is broken" from "the edge is having a bad day".
  it('flattens the failure detail so a 4xx and a 5xx are different rows', () => {
    const clientFailure = productEvent(
      batchFixture(),
      eventFixture({
        name: 'sync_error',
        surface: 'sync',
        action: 'push_failed',
        errorCode: 'server_error',
        failure: { httpStatus: 400, serverCode: 'VALIDATION_ERROR', retryable: false }
      }),
      ctx
    )
    const serverFailure = productEvent(
      batchFixture(),
      eventFixture({
        name: 'sync_error',
        surface: 'sync',
        action: 'pull_failed',
        errorCode: 'server_error',
        failure: { httpStatus: 503, retryable: true }
      }),
      ctx
    )

    expect(clientFailure.properties.http_status).toBe(400)
    expect(clientFailure.properties.server_code).toBe('VALIDATION_ERROR')
    expect(clientFailure.properties.retryable).toBe(false)

    expect(serverFailure.properties.http_status).toBe(503)
    expect(serverFailure.properties).not.toHaveProperty('server_code')
    expect(serverFailure.properties.retryable).toBe(true)

    // The old label is deliberately unchanged, so dashboards built on it keep working.
    expect(clientFailure.properties.error_code).toBe('server_error')
    expect(serverFailure.properties.error_code).toBe('server_error')
  })

  it('does not let a client dimension override the failure detail', () => {
    const result = productEvent(
      batchFixture(),
      eventFixture({
        dimensions: { http_status: '200' },
        failure: { httpStatus: 500, retryable: true }
      }),
      ctx
    )
    expect(result.properties.http_status).toBe(500)
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

// productEvent writes client dimensions FIRST and every server-derived key after,
// so a trusted value always overwrites a colliding client one. Only `environment`
// and `session_id` had dedicated regression tests above; the rest of the trusted
// keys rested on that structural ordering plus a code comment, so an edit that
// inserted a new trusted assignment ABOVE the dimensions loop would have gone
// unnoticed. The sweep below covers every trusted key at once.
//
// SafeDimensionKeySchema now also rejects reserved and `$`-prefixed dimension
// keys outright, which reduces but does not replace this: the ordering is the
// second line of defence, and these fixtures are built directly rather than
// parsed so they deliberately carry keys the schema would refuse.
const SPOOFED_DIMENSION_VALUE = 'client-spoofed'

// The Required<> annotations are the anti-drift guard. TRUSTED_KEYS is derived
// from the implementation, but a NEW conditional trusted key would only show up
// there if these fixtures populate the field that gates it. Typing them as
// Required<> means a fresh optional field on TelemetryEvent, TelemetryMetrics or
// TelemetryBatch stops this file typechecking until the fixture covers it, so
// the gap cannot reopen quietly.
const maximalMetrics: Required<TelemetryMetrics> = {
  durationMs: 42,
  itemCount: 7,
  byteCount: 2048,
  queueCount: 3,
  resultCount: 11,
  retryCount: 2,
  activeSeconds: 90,
  value: 5
}

const maximalBatch = (): TelemetryBatch => {
  const batch: Required<TelemetryBatch> = { ...batchFixture(), clientQueueDepth: 4 }
  return batch
}

const maximalEvent = (dimensions?: Record<string, string>): TelemetryEvent => {
  const event: Required<Omit<TelemetryEvent, 'dimensions'>> = {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'note_created',
    occurredAt: '2026-07-22T10:00:00.000Z',
    surface: 'notes',
    action: 'create',
    objectType: 'note',
    source: 'command_palette',
    result: 'success',
    errorCode: 'SYNC_TIMEOUT',
    metrics: maximalMetrics,
    error: { message: 'boom', stack: 'at boom (a.js:1:1)', componentStack: 'at Note' },
    failure: { httpStatus: 503, serverCode: 'SYNC_UNAVAILABLE', retryable: true }
  }
  return dimensions ? { ...event, dimensions } : event
}

// Read off the implementation rather than hand-listed, so a trusted key added
// later is swept without anyone remembering to extend this file.
const TRUSTED_KEYS = Object.keys(productEvent(maximalBatch(), maximalEvent(), ctx).properties)

describe('productEvent trusted-key collisions', () => {
  it('owns exactly the reviewed set of server-derived keys', () => {
    // The sweep below adapts on its own; this is the reviewed record of what
    // productEvent is allowed to own, so adding or dropping a trusted key has to
    // be a deliberate, visible change rather than a silent one.
    expect([...TRUSTED_KEYS].sort()).toEqual(
      [
        'surface',
        'action',
        'environment',
        'session_id',
        '$set',
        'platform',
        'app_version',
        'build_channel',
        'object_type',
        'source',
        'result',
        'error_code',
        'duration_ms',
        'item_count',
        'byte_count',
        'queue_count',
        'result_count',
        'retry_count',
        'active_seconds',
        'value',
        'http_status',
        'server_code',
        'retryable'
      ].sort()
    )
  })

  it.each(TRUSTED_KEYS)(
    'does not let a client dimension named "%s" overwrite the server-derived value',
    (key) => {
      const baseline = productEvent(maximalBatch(), maximalEvent(), ctx).properties
      const spoofed = productEvent(
        maximalBatch(),
        maximalEvent({ [key]: SPOOFED_DIMENSION_VALUE }),
        ctx
      ).properties

      // Fixture sanity: a trusted value that already equalled the sentinel would
      // make the assertions below pass for the wrong reason.
      expect(baseline[key]).not.toBe(SPOOFED_DIMENSION_VALUE)
      expect(spoofed[key]).toEqual(baseline[key])
      // Nothing else shifts either: the colliding key is fully absorbed, so the
      // client cannot smuggle a value in under any trusted name.
      expect(spoofed).toEqual(baseline)
    }
  )
})

describe('exceptionEvent', () => {
  it('returns null for an event with no error signal', () => {
    expect(exceptionEvent(batchFixture(), eventFixture(), ctx)).toBeNull()
  })

  // The desktop demotes expected failures to warn-level app_log_recorded lines
  // so they stay OUT of Error Tracking (#1587). Promoting them back is how the
  // local_mutation_dropped tripwire became the stackless `calendar_source`
  // issue that at peak was 45% of the project's PostHog volume.
  it('never promotes a warn-level log line into Error Tracking', () => {
    expect(
      exceptionEvent(
        batchFixture(),
        eventFixture({
          name: 'app_log_recorded',
          action: 'warn',
          errorCode: 'calendar_source'
        }),
        ctx
      )
    ).toBeNull()
  })

  it('still promotes an error-level log line', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({
        name: 'app_log_recorded',
        action: 'error',
        errorCode: 'Utility_crashed_CrdtPreflight'
      }),
      ctx
    )
    expect(result?.event).toBe('$exception')
    expect(result?.properties.$exception_fingerprint).toBe('Utility_crashed_CrdtPreflight')
  })

  it('builds a $exception with the error code as type and fingerprint', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({
        name: 'app_error_seen',
        errorCode: 'SYNC_TIMEOUT',
        error: { stack: '    at sync (a.js:1:1)' }
      }),
      ctx
    )
    expect(result?.event).toBe('$exception')
    expect(result?.properties.$exception_fingerprint).toBe('SYNC_TIMEOUT')
    const list = result?.properties.$exception_list as { type: string; value: string }[]
    expect(list[0].type).toBe('SYNC_TIMEOUT')
    expect(list[0].value).toBe('SYNC_TIMEOUT')
  })

  it('uses the redacted message alone as the value — the stack belongs in frames', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({
        errorCode: 'DB_LOCKED',
        error: { message: 'database is locked', stack: '    at db (b.js:2:2)' }
      }),
      ctx
    )
    const list = result?.properties.$exception_list as { value: string }[]
    expect(list[0].value).toBe('database is locked')
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

  // Error Tracking reads frames ONLY from $exception_list[].stacktrace. A stack
  // pasted into `value` renders as "No stacktrace available", which is what every
  // desktop issue showed before this block existed.
  it('emits a raw stacktrace with one frame per parsed stack line', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({
        errorCode: 'SYNC_TIMEOUT',
        error: {
          message: 'timed out',
          stack: '    at push (~/app/sync.ts:12:5)\n    at flush (~/app/queue.ts:40:11)'
        }
      }),
      ctx
    )
    const list = result?.properties.$exception_list as {
      stacktrace: { type: string; frames: Record<string, unknown>[] }
    }[]
    expect(list[0].stacktrace.type).toBe('raw')
    // Reversed: PostHog renders the LAST frame as the throw site, but a JS stack
    // string is innermost-first. Unreversed, every issue blames the outermost caller.
    expect(list[0].stacktrace.frames.map((frame) => frame.function)).toEqual(['flush', 'push'])
    expect(list[0].stacktrace.frames[1]).toMatchObject({
      platform: 'custom',
      lang: 'javascript',
      function: 'push',
      filename: '~/app/sync.ts',
      lineno: 12,
      colno: 5,
      resolved: true,
      in_app: true
    })
  })

  it('parses a bare "at file:line:col" frame with no function name', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({ errorCode: 'X', error: { stack: '    at file:///app/index-a1b2.js:9:3' } }),
      ctx
    )
    const list = result?.properties.$exception_list as {
      stacktrace: { frames: Record<string, unknown>[] }
    }[]
    expect(list[0].stacktrace.frames[0]).toMatchObject({
      function: '<anonymous>',
      filename: 'file:///app/index-a1b2.js',
      lineno: 9,
      colno: 3
    })
  })

  it('marks node internals and dependency frames as not in_app', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({
        errorCode: 'X',
        error: {
          stack: [
            '    at open (node:fs:120:3)',
            '    at run (~/app/node_modules/better-sqlite3/lib/db.js:8:1)',
            '    at save (~/app/src/vault.ts:3:9)'
          ].join('\n')
        }
      }),
      ctx
    )
    const list = result?.properties.$exception_list as {
      stacktrace: { frames: { filename: string; in_app: boolean }[] }
    }[]
    const byFile = Object.fromEntries(
      list[0].stacktrace.frames.map((frame) => [frame.filename, frame.in_app])
    )
    expect(byFile['node:fs']).toBe(false)
    expect(byFile['~/app/node_modules/better-sqlite3/lib/db.js']).toBe(false)
    expect(byFile['~/app/src/vault.ts']).toBe(true)
  })

  // Utility-process crashes and log-derived errors carry no stack at all. Emitting
  // `stacktrace: { frames: [] }` would claim we resolved a stack and found nothing.
  it('omits stacktrace entirely when no frame line parses', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({ errorCode: 'Utility:crashed:Embeddings' }),
      ctx
    )
    const list = result?.properties.$exception_list as Record<string, unknown>[]
    expect(list[0]).not.toHaveProperty('stacktrace')
  })

  it('falls back to component-stack frames when there is no JS stack', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({
        errorCode: 'RENDER_FAILED',
        error: { componentStack: '    at NoteEditor (~/app/note-editor.tsx:1:1)' }
      }),
      ctx
    )
    const list = result?.properties.$exception_list as {
      stacktrace: { frames: { function: string }[] }
    }[]
    expect(list[0].stacktrace.frames[0].function).toBe('NoteEditor')
  })

  it('keeps the raw component stack as its own property for React triage', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({
        errorCode: 'RENDER_FAILED',
        error: { stack: '    at x (a.js:1:1)', componentStack: '    at NoteEditor (b.tsx:2:2)' }
      }),
      ctx
    )
    expect(result?.properties.$exception_component_stack).toBe('    at NoteEditor (b.tsx:2:2)')
  })

  it('re-runs redaction over stack frames as a backstop', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({
        errorCode: 'X',
        error: { stack: '    at send (/Users/kaan/app/mail.ts:1:1)' }
      }),
      ctx
    )
    const list = result?.properties.$exception_list as {
      stacktrace: { frames: { filename: string }[] }
    }[]
    expect(list[0].stacktrace.frames[0].filename).toBe('~/app/mail.ts')
  })

  // Verbatim from a production `Error` issue (Linux AppImage). Two shapes here
  // are not in any hand-written fixture: `at async fn (…)` and — the one that
  // matters — `at async <path>` with NO parentheses, where a naive parser folds
  // the `async` keyword into the filename.
  it('parses a real production stack, async frames and all', () => {
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({
        errorCode: 'ENOENT',
        error: {
          stack: [
            '    at async rename (node:internal/fs/promises:785:10)',
            '    at async renameFolder (/tmp/.mount_MemryNkMktI7/resources/app.asar/out/main/index.js:7442:3)',
            '    at async /tmp/.mount_MemryNkMktI7/resources/app.asar/out/main/index.js:28913:7',
            '    at async Session.<anonymous> (node:electron/js2c/browser_init:2:114924)'
          ].join('\n')
        }
      }),
      ctx
    )
    const frames = (
      result?.properties.$exception_list as {
        stacktrace: { frames: { function: string; filename: string; in_app: boolean }[] }
      }[]
    )[0].stacktrace.frames

    // innermost-last after the reverse: `rename` is where it actually threw
    expect(frames.at(-1)).toMatchObject({
      function: 'async rename',
      filename: 'node:internal/fs/promises',
      in_app: false
    })
    // the parenthesis-free async frame keeps a clean filename
    expect(frames.map((frame) => frame.filename)).toContain(
      '/tmp/.mount_MemryNkMktI7/resources/app.asar/out/main/index.js'
    )
    // our own bundle is in_app; electron internals are not
    expect(frames.find((frame) => frame.filename.includes('app.asar'))?.in_app).toBe(true)
    expect(frames.find((frame) => frame.filename.includes('js2c'))?.in_app).toBe(false)
  })

  it('caps frames so a hostile stack cannot inflate the payload', () => {
    const stack = Array.from({ length: 90 }, (_, i) => `    at fn${i} (a.js:${i + 1}:1)`).join('\n')
    const result = exceptionEvent(
      batchFixture(),
      eventFixture({ errorCode: 'X', error: { stack } }),
      ctx
    )
    const list = result?.properties.$exception_list as {
      stacktrace: { frames: unknown[] }
    }[]
    expect(list[0].stacktrace.frames).toHaveLength(50)
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

describe('isLegacyMutationDropNoise', () => {
  const dropEvent = (overrides = {}) =>
    eventFixture({
      name: 'app_log_recorded',
      action: 'warn',
      errorCode: 'calendar_source',
      dimensions: { log_action: 'local_mutation_dropped' },
      ...overrides
    })

  it('flags the tripwire from a pre-fix desktop version', () => {
    expect(isLegacyMutationDropNoise(batchFixture({ appVersion: '2026.817.1' }), dropEvent())).toBe(
      true
    )
  })

  it('lets the throttled tripwire from a fixed version through', () => {
    for (const appVersion of ['2026.821.1', '2026.823.2', '2027.101.1']) {
      expect(isLegacyMutationDropNoise(batchFixture({ appVersion }), dropEvent())).toBe(false)
    }
  })

  it('ignores other log actions and other event names on old versions', () => {
    const batch = batchFixture({ appVersion: '2026.817.1' })
    expect(
      isLegacyMutationDropNoise(batch, dropEvent({ dimensions: { log_action: 'other' } }))
    ).toBe(false)
    expect(isLegacyMutationDropNoise(batch, dropEvent({ name: 'app_error_seen' }))).toBe(false)
  })

  it('fails open on an unparseable version', () => {
    expect(isLegacyMutationDropNoise(batchFixture({ appVersion: 'dev' }), dropEvent())).toBe(false)
  })
})
