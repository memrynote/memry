# PostHog Migration — Train 1: Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PostHog the only telemetry sink on the server side — product events, logs, errors, business events and landing analytics — and delete Cloudflare Analytics Engine, Loki and Grafana.

**Architecture:** Every telemetry flow already funnels through sync-server, so the sink swap is a server change: a pure transform module (`posthog-transform.ts`) converts today's `TelemetryBatch` into PostHog-native events, a thin fire-and-forget client (`posthog.ts`) posts them, and a second client (`posthog-logs.ts`) ships log lines as OTLP-JSON. Landing is the exception — session replay cannot be proxied, so it moves to browser-side `posthog-js`.

**Tech Stack:** TypeScript, Hono, Cloudflare Workers, Zod v4, Vitest, `posthog-js` (landing only), PostHog Cloud US.

**Spec:** `docs/superpowers/specs/2026-07-22-posthog-migration-design.md`

## Global Constraints

- PostHog project token: `phc_kDK2222jL4FipMrvyS3bsQ5vELDeD2NSYpfe8zxSBv68`, project 412311, host `https://us.i.posthog.com`. Landing ingests through the reverse proxy `https://e.memrynote.com`.
- Every event carries an `environment` property sourced from `env.ENVIRONMENT` (`development` | `staging` | `production`). One project, environments separated by property — never separate projects.
- All PostHog calls are fire-and-forget and must **never** throw into request handling. Same posture as today's `pushLokiEntries`: absent config is a silent no-op.
- `packages/contracts/src/redact.ts` behaviour is unchanged. Server-side redaction runs in mask mode (no hasher).
- `distinct_id` = resolved account id when present, else `installHash` (HMAC via `hashTelemetryId`). Never a raw `installId`.
- Contract changes are **additive and optional only**. Existing clients must keep validating.
- Error Tracking events must be named exactly `$exception`. A plain `exception` never reaches Error Tracking.
- Never upload crash minidumps.
- Run sync-server tests with `npx vitest run <file>` from `apps/sync-server` — `pnpm --filter @memry/sync-server test -- run <file>` runs the whole suite.
- Golden transform tests live in **`apps/sync-server`**, not `packages/contracts`: contracts has no `test` script, so its tests are skipped by the root runner.

---

### Task 1: Widen the telemetry contract

Additive schema changes only. This must reach production **before** any desktop build can emit the new shapes — `TelemetryBatchSchema` validates the whole batch, so an unknown field rejects every event in it.

**Files:**

- Modify: `packages/contracts/src/telemetry-api.ts`
- Test: `packages/contracts/src/telemetry-api.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `TelemetryEventNameSchema` gains `'app_crashed'`; `TelemetryErrorDetailSchema` gains optional `message: string` (max 512).

- [ ] **Step 1: Write the failing tests**

Append to `packages/contracts/src/telemetry-api.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/telemetry-api.test.ts` from `packages/contracts`
Expected: FAIL — `app_crashed` is not in the enum, and `message` is stripped rather than accepted.

- [ ] **Step 3: Implement the widening**

In `packages/contracts/src/telemetry-api.ts`, add `'app_crashed'` to `TelemetryEventNameSchema` immediately after `'app_error_seen'`:

```ts
  'app_error_seen',
  'app_crashed',
```

Replace `TelemetryErrorDetailSchema` with:

```ts
export const TelemetryErrorDetailSchema = z.object({
  // Historically there was NO message field: on the desktop an error message can
  // embed a note title, filename, or content. That rule predates redact.ts. The
  // message is now allowed, but ONLY after the client has run it through
  // redactText — the server re-runs redaction in mask mode as a backstop.
  message: z.string().max(512).optional(),
  stack: z.string().max(4000).optional(),
  componentStack: z.string().max(2000).optional()
})
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/telemetry-api.test.ts` from `packages/contracts`
Expected: PASS, and every pre-existing test in the file still passes.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/telemetry-api.ts packages/contracts/src/telemetry-api.test.ts
git commit -m "feat(contracts): add app_crashed event and optional redacted error message"
```

---

### Task 2: PostHog capture client

A fire-and-forget batch poster, modelled on `pushLokiEntries`.

**Files:**

- Create: `apps/sync-server/src/services/posthog.ts`
- Test: `apps/sync-server/src/services/posthog.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `interface PostHogEnv { POSTHOG_KEY?: string; POSTHOG_HOST?: string; ENVIRONMENT?: string }`
  - `interface PostHogEvent { event: string; distinct_id: string; properties: Record<string, unknown>; timestamp?: string }`
  - `capturePostHogEvents(env: PostHogEnv, events: PostHogEvent[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `apps/sync-server/src/services/posthog.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { capturePostHogEvents } from './posthog'

const env = {
  POSTHOG_KEY: 'phc_test',
  POSTHOG_HOST: 'https://us.i.posthog.com',
  ENVIRONMENT: 'staging'
}

describe('capturePostHogEvents', () => {
  it('posts a batch with the api key', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await capturePostHogEvents(env, [
      { event: 'note_created', distinct_id: 'abc', properties: { surface: 'notes' } }
    ])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://us.i.posthog.com/batch/')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.api_key).toBe('phc_test')
    expect(body.batch[0].event).toBe('note_created')
    vi.unstubAllGlobals()
  })

  it('is a no-op without a key', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await capturePostHogEvents({ ENVIRONMENT: 'staging' }, [
      { event: 'x', distinct_id: 'a', properties: {} }
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('is a no-op for an empty batch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await capturePostHogEvents(env, [])
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('never throws when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    await expect(
      capturePostHogEvents(env, [{ event: 'x', distinct_id: 'a', properties: {} }])
    ).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/services/posthog.test.ts` from `apps/sync-server`
Expected: FAIL — cannot resolve `./posthog`.

- [ ] **Step 3: Implement the client**

Create `apps/sync-server/src/services/posthog.ts`:

```ts
import { createLogger } from '../lib/logger'

// Product, business and exception events → PostHog capture API. Fire-and-forget:
// absent config or a failed post must never affect request handling. Same posture
// as the Loki pusher this replaces.

const logger = createLogger('PostHog')

const DEFAULT_HOST = 'https://us.i.posthog.com'

export interface PostHogEnv {
  POSTHOG_KEY?: string
  POSTHOG_HOST?: string
  ENVIRONMENT?: string
}

export interface PostHogEvent {
  event: string
  distinct_id: string
  properties: Record<string, unknown>
  timestamp?: string
}

export const capturePostHogEvents = async (
  env: PostHogEnv,
  events: PostHogEvent[]
): Promise<void> => {
  if (!env.POSTHOG_KEY || events.length === 0) return
  const host = env.POSTHOG_HOST ?? DEFAULT_HOST
  try {
    const response = await fetch(`${host}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: env.POSTHOG_KEY, batch: events })
    })
    if (!response.ok) logger.warn('PostHog capture failed', { status: response.status })
  } catch (error) {
    logger.warn('PostHog capture failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/services/posthog.test.ts` from `apps/sync-server`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/services/posthog.ts apps/sync-server/src/services/posthog.test.ts
git commit -m "feat(sync-server): add fire-and-forget PostHog capture client"
```

---

### Task 3: Transform — identity and person properties

The pure transform is the heart of this migration and the only thing the golden tests can protect. Build it in three tasks; this one establishes the module and the identity rules.

**Files:**

- Create: `apps/sync-server/src/services/posthog-transform.ts`
- Test: `apps/sync-server/src/services/posthog-transform.test.ts`

**Interfaces:**

- Consumes: `PostHogEvent` from Task 2.
- Produces:
  - `interface TransformContext { installHash: string; accountId?: string; environment: string }`
  - `resolveDistinctId(ctx: TransformContext): string`
  - `personProperties(batch: TelemetryBatch, environment: string): Record<string, unknown>`
  - `identifyEvent(batch: TelemetryBatch, ctx: TransformContext): PostHogEvent | null`

- [ ] **Step 1: Write the failing tests**

Create `apps/sync-server/src/services/posthog-transform.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/services/posthog-transform.test.ts` from `apps/sync-server`
Expected: FAIL — cannot resolve `./posthog-transform`.

- [ ] **Step 3: Implement identity and person properties**

Create `apps/sync-server/src/services/posthog-transform.ts`:

```ts
import type { TelemetryBatch } from '@memry/contracts/telemetry-api'

import type { PostHogEvent } from './posthog'

// Pure transform: today's anonymous-by-design TelemetryBatch → PostHog-native
// events. Kept free of I/O so the golden tests can pin every mapping. The live
// route and any future tooling MUST import this module rather than reimplement it.

export interface TransformContext {
  installHash: string
  accountId?: string
  environment: string
}

export const resolveDistinctId = (ctx: TransformContext): string =>
  ctx.accountId && ctx.accountId.length > 0 ? ctx.accountId : ctx.installHash

export const personProperties = (
  batch: TelemetryBatch,
  environment: string
): Record<string, unknown> => ({
  platform: batch.platform,
  arch: batch.arch,
  locale: batch.locale,
  app_version: batch.appVersion,
  build_channel: batch.buildChannel,
  sync_state: batch.syncState,
  timezone_offset_minutes: batch.timezoneOffsetMinutes,
  environment
})

// Emitted once per session by the caller (see the KV guard in the route), not on
// every batch: $identify is idempotent in PostHog but bills as an identified event.
// The merge it performs is PERMANENT and cannot be undone.
export const identifyEvent = (
  batch: TelemetryBatch,
  ctx: TransformContext
): PostHogEvent | null => {
  if (!ctx.accountId || ctx.accountId.length === 0) return null
  return {
    event: '$identify',
    distinct_id: ctx.accountId,
    properties: {
      $anon_distinct_id: ctx.installHash,
      $set: personProperties(batch, ctx.environment),
      environment: ctx.environment
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/services/posthog-transform.test.ts` from `apps/sync-server`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/services/posthog-transform.ts apps/sync-server/src/services/posthog-transform.test.ts
git commit -m "feat(sync-server): add PostHog transform identity and person properties"
```

---

### Task 4: Transform — product events

**Files:**

- Modify: `apps/sync-server/src/services/posthog-transform.ts`
- Test: `apps/sync-server/src/services/posthog-transform.test.ts`

**Interfaces:**

- Consumes: `TransformContext`, `personProperties` from Task 3.
- Produces: `productEvent(batch: TelemetryBatch, event: TelemetryEvent, ctx: TransformContext): PostHogEvent`

- [ ] **Step 1: Write the failing tests**

Append to `apps/sync-server/src/services/posthog-transform.test.ts`:

```ts
import { productEvent } from './posthog-transform'

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/services/posthog-transform.test.ts` from `apps/sync-server`
Expected: FAIL — `productEvent` is not exported.

- [ ] **Step 3: Implement the product event mapping**

Append to `apps/sync-server/src/services/posthog-transform.ts` (and add `TelemetryEvent` to the type import at the top):

```ts
// page_viewed is the one rename: $pageview unlocks path analysis and the native
// web-analytics views. Every other name is preserved so existing dashboards and
// the 50-event contract stay legible.
const EVENT_NAME_OVERRIDES: Record<string, string> = {
  page_viewed: '$pageview'
}

const METRIC_KEYS = [
  ['durationMs', 'duration_ms'],
  ['itemCount', 'item_count'],
  ['byteCount', 'byte_count'],
  ['queueCount', 'queue_count'],
  ['resultCount', 'result_count'],
  ['retryCount', 'retry_count'],
  ['activeSeconds', 'active_seconds'],
  ['value', 'value']
] as const

export const productEvent = (
  batch: TelemetryBatch,
  event: TelemetryEvent,
  ctx: TransformContext
): PostHogEvent => {
  const properties: Record<string, unknown> = {
    surface: event.surface,
    action: event.action,
    environment: ctx.environment,
    session_id: batch.sessionId,
    $set: personProperties(batch, ctx.environment)
  }

  if (event.objectType) properties.object_type = event.objectType
  if (event.source) properties.source = event.source
  if (event.result) properties.result = event.result
  if (event.errorCode) properties.error_code = event.errorCode

  for (const [from, to] of METRIC_KEYS) {
    const value = event.metrics?.[from]
    if (typeof value === 'number') properties[to] = value
  }

  // The contract permits at most one dimension; flatten it so it is filterable
  // like any other property instead of nesting an object.
  if (event.dimensions) {
    for (const [key, value] of Object.entries(event.dimensions)) properties[key] = value
  }

  return {
    event: EVENT_NAME_OVERRIDES[event.name] ?? event.name,
    distinct_id: resolveDistinctId(ctx),
    properties,
    timestamp: event.occurredAt
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/services/posthog-transform.test.ts` from `apps/sync-server`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/services/posthog-transform.ts apps/sync-server/src/services/posthog-transform.test.ts
git commit -m "feat(sync-server): map product telemetry events to PostHog shape"
```

---

### Task 5: Transform — exceptions

**Files:**

- Modify: `apps/sync-server/src/services/posthog-transform.ts`
- Test: `apps/sync-server/src/services/posthog-transform.test.ts`

**Interfaces:**

- Consumes: `TransformContext`, `resolveDistinctId` from Task 3.
- Produces: `exceptionEvent(batch: TelemetryBatch, event: TelemetryEvent, ctx: TransformContext): PostHogEvent | null`

- [ ] **Step 1: Write the failing tests**

Append to `apps/sync-server/src/services/posthog-transform.test.ts`:

```ts
import { exceptionEvent } from './posthog-transform'

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
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/services/posthog-transform.test.ts` from `apps/sync-server`
Expected: FAIL — `exceptionEvent` is not exported.

- [ ] **Step 3: Implement the exception mapping**

Add the redaction import to the top of `apps/sync-server/src/services/posthog-transform.ts`:

```ts
import { redactText } from '@memry/contracts/redact'
```

Then append:

```ts
// Error Tracking requires the event name to be exactly `$exception`; a plain
// `exception` lands in Events and never reaches the Error Tracking product.
//
// $exception_fingerprint is set explicitly to our own errorCode. Left unset,
// PostHog derives a hash from the exception pattern — pinning it to errorCode
// reproduces the grouping semantics of the retired "errors by code" panel.
export const exceptionEvent = (
  batch: TelemetryBatch,
  event: TelemetryEvent,
  ctx: TransformContext
): PostHogEvent | null => {
  if (!event.errorCode && !event.error) return null

  const type = event.errorCode ?? event.name
  // Defense in depth: the client already redacted, re-run in mask mode (no hasher).
  const message = event.error?.message ? redactText(event.error.message, {}) : ''
  const stack = event.error?.stack ?? ''
  const value = [message, stack].filter((part) => part.length > 0).join('\n\n') || type

  return {
    event: '$exception',
    distinct_id: resolveDistinctId(ctx),
    properties: {
      $exception_list: [
        {
          type,
          value,
          mechanism: { handled: true, synthetic: false }
        }
      ],
      $exception_fingerprint: type,
      surface: event.surface,
      action: event.action,
      app_version: batch.appVersion,
      build_channel: batch.buildChannel,
      platform: batch.platform,
      environment: ctx.environment
    },
    timestamp: event.occurredAt
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/services/posthog-transform.test.ts` from `apps/sync-server`
Expected: PASS (15 tests).

- [ ] **Step 5: Verify the redaction backstop signature**

Run: `grep -n "export const redactText" packages/contracts/src/redact.ts`
Expected: a signature accepting `(text: string, options)`. If the second parameter differs, adjust the call — do **not** change `redact.ts`.

- [ ] **Step 6: Commit**

```bash
git add apps/sync-server/src/services/posthog-transform.ts apps/sync-server/src/services/posthog-transform.test.ts
git commit -m "feat(sync-server): map desktop errors to PostHog \$exception events"
```

---

### Task 6: OTLP log shipping

Replaces `pushLokiEntries` with a PostHog Logs client. PostHog's log capture service accepts plain OTLP-JSON with the project token as a bearer, so no OpenTelemetry SDK is pulled into the Worker.

**Files:**

- Create: `apps/sync-server/src/services/posthog-logs.ts`
- Test: `apps/sync-server/src/services/posthog-logs.test.ts`

**Interfaces:**

- Consumes: `PostHogEnv` from Task 2.
- Produces:
  - `interface LogRecord { level: 'warn' | 'error'; app: 'desktop' | 'server'; kind?: 'error' | 'log' | 'report'; distinctId?: string; line: Record<string, unknown> }`
  - `pushPostHogLogs(env: PostHogEnv, records: LogRecord[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `apps/sync-server/src/services/posthog-logs.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { pushPostHogLogs } from './posthog-logs'

const env = {
  POSTHOG_KEY: 'phc_test',
  POSTHOG_HOST: 'https://us.i.posthog.com',
  ENVIRONMENT: 'staging'
}

describe('pushPostHogLogs', () => {
  it('posts OTLP-JSON with the token as a bearer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await pushPostHogLogs(env, [
      { level: 'error', app: 'desktop', distinctId: 'hash', line: { error_code: 'X' } }
    ])

    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://us.i.posthog.com/v1/logs')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer phc_test' })

    const body = JSON.parse((init as RequestInit).body as string)
    const resource = body.resourceLogs[0].resource.attributes
    expect(resource).toContainEqual({ key: 'service.name', value: { stringValue: 'desktop' } })
    expect(resource).toContainEqual({
      key: 'deployment.environment',
      value: { stringValue: 'staging' }
    })

    const record = body.resourceLogs[0].scopeLogs[0].logRecords[0]
    expect(record.severityText).toBe('error')
    expect(record.attributes).toContainEqual({
      key: 'posthogDistinctId',
      value: { stringValue: 'hash' }
    })
    vi.unstubAllGlobals()
  })

  it('is a no-op without a key', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await pushPostHogLogs({}, [{ level: 'error', app: 'server', line: {} }])
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('never throws when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    await expect(
      pushPostHogLogs(env, [{ level: 'error', app: 'server', line: {} }])
    ).resolves.toBeUndefined()
    vi.unstubAllGlobals()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/services/posthog-logs.test.ts` from `apps/sync-server`
Expected: FAIL — cannot resolve `./posthog-logs`.

- [ ] **Step 3: Implement the OTLP client**

Create `apps/sync-server/src/services/posthog-logs.ts`:

```ts
import { createLogger } from '../lib/logger'

import type { PostHogEnv } from './posthog'

// Log lines → PostHog Logs, a plain OTLP receiver. No OpenTelemetry SDK: the
// endpoint accepts OTLP-JSON over HTTP with the project token as a bearer, which
// is the same shape as the Loki pusher this replaces and suits a Worker.
//
// Retention is 14 days. Anything that must outlive that cannot rely on this path.

const logger = createLogger('PostHogLogs')

const DEFAULT_HOST = 'https://us.i.posthog.com'

export interface LogRecord {
  level: 'warn' | 'error'
  app: 'desktop' | 'server'
  kind?: 'error' | 'log' | 'report'
  distinctId?: string
  line: Record<string, unknown>
}

const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } })

export const pushPostHogLogs = async (env: PostHogEnv, records: LogRecord[]): Promise<void> => {
  if (!env.POSTHOG_KEY || records.length === 0) return
  const host = env.POSTHOG_HOST ?? DEFAULT_HOST
  const environment = env.ENVIRONMENT ?? 'unknown'
  const timeUnixNano = `${Date.now()}000000`

  // One resourceLogs entry per app so service.name stays a resource attribute
  // rather than being duplicated onto every record.
  const byApp = new Map<LogRecord['app'], LogRecord[]>()
  for (const record of records) {
    const bucket = byApp.get(record.app) ?? []
    bucket.push(record)
    byApp.set(record.app, bucket)
  }

  const resourceLogs = [...byApp.entries()].map(([app, appRecords]) => ({
    resource: {
      attributes: [attribute('service.name', app), attribute('deployment.environment', environment)]
    },
    scopeLogs: [
      {
        logRecords: appRecords.map((record) => ({
          timeUnixNano,
          severityText: record.level,
          body: { stringValue: JSON.stringify(record.line) },
          attributes: [
            attribute('kind', record.kind ?? 'error'),
            ...(record.distinctId ? [attribute('posthogDistinctId', record.distinctId)] : [])
          ]
        }))
      }
    ]
  }))

  try {
    const response = await fetch(`${host}/v1/logs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.POSTHOG_KEY}`
      },
      body: JSON.stringify({ resourceLogs })
    })
    if (!response.ok) logger.warn('PostHog log push failed', { status: response.status })
  } catch (error) {
    logger.warn('PostHog log push failed', {
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/services/posthog-logs.test.ts` from `apps/sync-server`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/services/posthog-logs.ts apps/sync-server/src/services/posthog-logs.test.ts
git commit -m "feat(sync-server): ship logs to PostHog over OTLP-JSON"
```

---

### Task 7: Port the log line builders off Loki

`desktopErrorEntry`, `desktopLogEntry` and `desktopReportEntry` hold real, hard-won mapping detail (the `exit_code` comment about POSIX signals, the mask-mode re-redaction). Move them onto `LogRecord` rather than rewriting them.

**Files:**

- Modify: `apps/sync-server/src/services/posthog-logs.ts`
- Test: `apps/sync-server/src/services/posthog-logs.test.ts`
- Read for reference: `apps/sync-server/src/services/loki.ts:56-158`

**Interfaces:**

- Consumes: `LogRecord` from Task 6.
- Produces: `desktopErrorRecord`, `desktopLogRecord`, `desktopReportRecords` — same signatures as their Loki counterparts, with a trailing `distinctId` argument replacing `installHash`, returning `LogRecord` / `LogRecord[]`.

- [ ] **Step 1: Write the failing test**

Append to `apps/sync-server/src/services/posthog-logs.test.ts`:

```ts
import { desktopLogRecord } from './posthog-logs'

describe('desktopLogRecord', () => {
  it('re-runs redaction on the message', () => {
    const record = desktopLogRecord(
      {
        ts: '2026-07-22T10:00:00.000Z',
        level: 'error',
        scope: 'Sync',
        message: 'failed for kaan@example.com',
        origin: 'main'
      } as never,
      { appVersion: '1.0.0', buildChannel: 'production', platform: 'darwin', arch: 'arm64' },
      'hash'
    )
    expect(JSON.stringify(record.line)).not.toContain('kaan@example.com')
    expect(record.distinctId).toBe('hash')
    expect(record.kind).toBe('log')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/services/posthog-logs.test.ts` from `apps/sync-server`
Expected: FAIL — `desktopLogRecord` is not exported.

- [ ] **Step 3: Port the builders**

Copy the three builder functions from `apps/sync-server/src/services/loki.ts:56-158` into `posthog-logs.ts`, keeping every existing comment. Apply exactly these changes:

- Rename `desktopErrorEntry` → `desktopErrorRecord`, `desktopLogEntry` → `desktopLogRecord`, `desktopReportEntry` → `desktopReportRecords`.
- Change the return type from `LokiEntry` to `LogRecord`.
- Rename the trailing `installHash: string` parameter to `distinctId: string`, set `distinctId` on the returned record, and keep `install_hash: distinctId` inside `line` so existing log shapes stay searchable.
- Add `message` to the `desktopErrorRecord` line, redacted the same way as Task 5:
  `message: event.error?.message ? redactText(event.error.message, {}) : ''`
- Add the imports `redactText` from `@memry/contracts/redact` and the `DiagnosticLogLine`, `DiagnosticReport`, `TelemetryBatch`, `TelemetryEvent` types.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/services/posthog-logs.test.ts` from `apps/sync-server`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/services/posthog-logs.ts apps/sync-server/src/services/posthog-logs.test.ts
git commit -m "feat(sync-server): port desktop log line builders to PostHog records"
```

---

### Task 8: Wire the telemetry routes to PostHog

**Files:**

- Modify: `apps/sync-server/src/routes/telemetry.ts`
- Modify: `apps/sync-server/src/types.ts:6-8,30-31`
- Modify: `apps/sync-server/wrangler.toml`
- Test: `apps/sync-server/src/routes/telemetry.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 2–7.
- Produces: `/telemetry/batch` and `/telemetry/logs` writing to PostHog only.

- [ ] **Step 1: Write the failing test**

Append to `apps/sync-server/src/routes/telemetry.test.ts`:

```ts
describe('POST /telemetry/batch → PostHog', () => {
  it('captures each event and writes no Analytics Engine data point', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const writeDataPoint = vi.fn()

    const response = await app.request(
      '/telemetry/batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
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
          events: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              name: 'note_created',
              occurredAt: '2026-07-22T10:00:00.000Z',
              surface: 'notes',
              action: 'create'
            }
          ]
        })
      },
      {
        ...testEnv,
        POSTHOG_KEY: 'phc_test',
        POSTHOG_HOST: 'https://us.i.posthog.com',
        PRODUCT_TELEMETRY: { writeDataPoint }
      }
    )

    expect(response.status).toBe(202)
    expect(writeDataPoint).not.toHaveBeenCalled()

    const captureCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/batch/'))
    expect(captureCall).toBeDefined()
    const body = JSON.parse((captureCall?.[1] as RequestInit).body as string)
    expect(body.batch.map((e: { event: string }) => e.event)).toContain('note_created')
    vi.unstubAllGlobals()
  })
})
```

Reconcile `app` and `testEnv` with whatever the existing tests in that file already use; do not introduce a second harness.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/routes/telemetry.test.ts` from `apps/sync-server`
Expected: FAIL — the route still writes to Analytics Engine.

- [ ] **Step 3: Add the env bindings**

In `apps/sync-server/src/types.ts`, **add** to `Bindings`:

```ts
  POSTHOG_KEY?: string
  POSTHOG_HOST?: string
```

In `apps/sync-server/wrangler.toml`, add `POSTHOG_HOST = "https://us.i.posthog.com"` to the staging and production `[vars]` (not `dev`).

**Do not remove** `PRODUCT_TELEMETRY`, `LANDING_TELEMETRY`, `LOKI_URL` or `LOKI_TOKEN` here. The code that consumes them (`writeTelemetryBatch`, `TelemetryEnv`, the Loki service) is still present until Task 11, and removing the bindings first leaves the tree failing typecheck for three tasks. Task 11 removes the consumers and the bindings together.

- [ ] **Step 4: Rewrite the route handlers**

In `apps/sync-server/src/routes/telemetry.ts`, replace the Loki import with:

```ts
import { capturePostHogEvents } from '../services/posthog'
import { desktopErrorRecord, desktopLogRecord, pushPostHogLogs } from '../services/posthog-logs'
import { exceptionEvent, identifyEvent, productEvent } from '../services/posthog-transform'
```

Replace the body of `telemetry.post('/batch', ...)` after validation with:

```ts
const batch = parsed.data
const installHash = await hashTelemetryId(c.env.TELEMETRY_HMAC_KEY, batch.installId)
// accountId stays undefined in this train. /telemetry/* deliberately bypasses
// the auth middleware and TelemetryBatchSchema carries no account identifier,
// so every install reports anonymously until Train 2 restores the bearer.
// resolveDistinctId already falls back to installHash — nothing here changes
// when that lands except this one field becoming populated.
const ctx = {
  installHash,
  accountId: undefined as string | undefined,
  environment: c.env.ENVIRONMENT ?? 'unknown'
}
const distinctId = resolveDistinctId(ctx)

const events = batch.events.map((event) => productEvent(batch, event, ctx))
const exceptions = batch.events
  .map((event) => exceptionEvent(batch, event, ctx))
  .filter((event): event is NonNullable<typeof event> => event !== null)

// $identify merges the anonymous install into the account PERMANENTLY, so emit
// it once per session rather than on every 30s batch.
const identify = (await shouldIdentify(c.env, batch.sessionId, ctx.accountId))
  ? identifyEvent(batch, ctx)
  : null

safeWaitUntil(
  c,
  capturePostHogEvents(c.env, [...(identify ? [identify] : []), ...events, ...exceptions])
)

const errorEvents = batch.events.filter((event) => event.errorCode || event.error)
if (errorEvents.length > 0) {
  safeWaitUntil(
    c,
    pushPostHogLogs(
      c.env,
      // distinctId, not installHash: §2.3 requires log records to carry the same
      // identity as events so they surface on the person's Logs tab.
      errorEvents.map((event) => desktopErrorRecord(batch, event, distinctId))
    )
  )
}

return c.json({ accepted: batch.events.length }, 202)
```

Add the session guard above the route:

```ts
// One $identify per session. KV write is best-effort: a lost write costs a
// duplicate $identify, which PostHog treats as idempotent — the merge itself is
// not repeated.
const shouldIdentify = async (
  env: AppContext['Bindings'],
  sessionId: string,
  accountId?: string
): Promise<boolean> => {
  if (!accountId) return false
  const key = `ph_identified:${sessionId}`
  const seen = await env.RATE_LIMIT.get(key)
  if (seen) return false
  await env.RATE_LIMIT.put(key, '1', { expirationTtl: 86400 })
  return true
}
```

In the `/logs` handler, replace `pushLokiEntries(c.env, batch.lines.map((line) => desktopLogEntry(line, meta, installHash)))` with `pushPostHogLogs(c.env, batch.lines.map((line) => desktopLogRecord(line, meta, installHash)))`.

Add `resolveDistinctId` to the `posthog-transform` import added at the top of this task.

- [ ] **Step 5: Reconcile the KV binding name**

Run: `grep -n "KVNamespace" apps/sync-server/src/types.ts`
Use whichever KV binding actually exists for `shouldIdentify`; if there is none, store the marker in D1 instead of adding a binding.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/routes/telemetry.test.ts` from `apps/sync-server`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/sync-server/src/routes/telemetry.ts apps/sync-server/src/types.ts apps/sync-server/wrangler.toml apps/sync-server/src/routes/telemetry.test.ts
git commit -m "feat(sync-server): route telemetry and logs to PostHog"
```

---

### Task 9: Business events and diagnostic reports

**Files:**

- Modify: `apps/sync-server/src/services/analytics.ts:268-396`
- Modify: `apps/sync-server/src/routes/diagnostics.ts`
- Test: `apps/sync-server/src/services/analytics.test.ts`

**Interfaces:**

- Consumes: `capturePostHogEvents`, `pushPostHogLogs`, `desktopReportRecords`.
- Produces: `captureBusinessEvent`, `captureServerError`, `captureServerLog` with unchanged signatures and PostHog-backed bodies.

- [ ] **Step 1: Write the failing test**

Append to `apps/sync-server/src/services/analytics.test.ts`:

```ts
describe('captureBusinessEvent → PostHog', () => {
  it('captures a server-surface event tagged with the environment', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await captureBusinessEvent(
      { POSTHOG_KEY: 'phc_test', POSTHOG_HOST: 'https://us.i.posthog.com', ENVIRONMENT: 'staging' },
      { name: 'vault_registered', properties: { plan: 'believer' } }
    )

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.batch[0].event).toBe('vault_registered')
    expect(body.batch[0].properties.surface).toBe('server')
    expect(body.batch[0].properties.environment).toBe('staging')
    expect(body.batch[0].distinct_id).toBe('memry_server_staging')
    vi.unstubAllGlobals()
  })
})
```

Reconcile the `captureBusinessEvent` argument shape with its current signature in `analytics.ts:268` — keep that signature, do not change call sites.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/services/analytics.test.ts` from `apps/sync-server`
Expected: FAIL — still writing Analytics Engine data points.

- [ ] **Step 3: Reimplement the three capture functions**

Keep every exported signature identical so the ~30 call sites are untouched. Replace each body: build a `PostHogEvent` with `distinct_id` = `memry_server_${env.ENVIRONMENT}`, `properties.surface = 'server'`, `properties.environment = env.ENVIRONMENT`, and hand it to `capturePostHogEvents`. In `captureServerError`, also call `pushPostHogLogs` with the redacted `detail`, `level: 'error'` for 5xx/unhandled and `'warn'` for handled 4xx — matching today's behaviour exactly.

Delete `toDataPoint` and the Analytics Engine writes.

- [ ] **Step 4: Point the diagnostics route at PostHog**

In `apps/sync-server/src/routes/diagnostics.ts`, replace `pushLokiEntries(... desktopReportEntry(...))` with `pushPostHogLogs(... desktopReportRecords(...))`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/services/analytics.test.ts src/routes/diagnostics.test.ts` from `apps/sync-server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/sync-server/src/services/analytics.ts apps/sync-server/src/routes/diagnostics.ts apps/sync-server/src/services/analytics.test.ts
git commit -m "feat(sync-server): move business events and diagnostic reports to PostHog"
```

---

### Task 10: Landing site on posthog-js

Session replay cannot be server-proxied, so landing talks to PostHog directly.

**Files:**

- Modify: `apps/landing/src/lib/analytics.ts`
- Modify: `apps/landing/vercel.json`
- Modify: `apps/landing/src/lib/csp.test.ts:7`
- Modify: `apps/landing/package.json`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `trackLandingEvent(name, target)` and `trackLandingPageView(pathname, search)` keep their current signatures so all 17 call sites are untouched.

- [ ] **Step 1: Write the failing CSP test**

In `apps/landing/src/lib/csp.test.ts`, change line 7 to:

```ts
const REQUIRED_CONNECT_SRC = ['https://sync.memrynote.com', 'https://e.memrynote.com']
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/lib/csp.test.ts` from `apps/landing`
Expected: FAIL — `connect-src is missing https://e.memrynote.com`.

This is not hypothetical: this exact omission silently killed landing pageviews and replay for 16 days.

- [ ] **Step 3: Fix the CSP**

In `apps/landing/vercel.json`, add `https://e.memrynote.com` to the `connect-src` directive, after `https://sync.memrynote.com`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/lib/csp.test.ts` from `apps/landing`
Expected: PASS.

- [ ] **Step 5: Install and initialise posthog-js**

Run: `pnpm --filter @memry/landing add posthog-js`

Rewrite the tracking half of `apps/landing/src/lib/analytics.ts`, keeping the existing pure UTM/campaign helpers (`readLandingCampaignParams`, `createLandingEventData`, `createLandingPageViewData`) exactly as they are:

```ts
import posthog from 'posthog-js'

let initialised = false

const init = (): void => {
  if (initialised || typeof window === 'undefined') return
  const key = import.meta.env.VITE_POSTHOG_KEY
  if (!key) return
  posthog.init(key, {
    api_host: import.meta.env.VITE_POSTHOG_HOST ?? 'https://e.memrynote.com',
    person_profiles: 'identified_only',
    disable_external_dependency_loading: true,
    session_recording: { maskAllInputs: true }
  })
  // Landing previously carried no environment tag, so prod, previews and local
  // all blended into one stream. Tag it here to close that gap.
  posthog.register({
    environment: import.meta.env.MODE === 'production' ? 'production' : 'development'
  })
  initialised = true
}

export function trackLandingPageView(pathname: string, search = ''): void {
  init()
  const data = createLandingPageViewData(pathname, search)
  posthog.capture('$pageview', data)
}

export function trackLandingEvent(name: LandingEventName, target: string): void {
  init()
  posthog.capture(name, createLandingEventData(name, target))
}
```

- [ ] **Step 6: Verify the existing analytics tests still pass**

Run: `npx tsx --test src/lib/analytics.test.ts` from `apps/landing`
Expected: PASS — the pure helpers are unchanged. Delete only assertions that asserted `sendBeacon` transport.

- [ ] **Step 7: Commit**

```bash
git add apps/landing/src/lib/analytics.ts apps/landing/vercel.json apps/landing/src/lib/csp.test.ts apps/landing/package.json pnpm-lock.yaml
git commit -m "feat(landing): move analytics and session replay to posthog-js"
```

---

### Task 11: Delete Analytics Engine, Loki and the landing ingest path

Only now, with every replacement green.

**Files:**

- Delete: `apps/sync-server/src/services/loki.ts`, `apps/sync-server/src/services/loki.test.ts`
- Modify: `apps/sync-server/src/services/telemetry.ts`
- Modify: `apps/sync-server/src/routes/telemetry.ts`
- Modify: `packages/contracts/src/telemetry-api.ts`

- [ ] **Step 1: Remove the code**

Delete both Loki files. From `apps/sync-server/src/services/telemetry.ts` delete `toDataPoint`, `writeTelemetryBatch`, `toLandingDataPoint`, `writeLandingTelemetryBatch`, `TelemetryEnv`, `LandingTelemetryEnv` and the blob/double constants — keep `hashTelemetryId`, which the routes still use. Delete the `/web` route and its rate limiter from `apps/sync-server/src/routes/telemetry.ts`. Delete `LandingTelemetryEventSchema`, `LandingTelemetryBatchSchema` and their exported types from `packages/contracts/src/telemetry-api.ts`, plus their tests.

- [ ] **Step 1b: Remove the now-unused bindings**

Only after the consumers above are gone, so the tree never sits in a state where a binding is referenced but undeclared.

In `apps/sync-server/src/types.ts`, delete `PRODUCT_TELEMETRY`, `LANDING_TELEMETRY`, `LOKI_URL` and `LOKI_TOKEN` from `Bindings`. In `apps/sync-server/wrangler.toml`, remove both `[[analytics_engine_datasets]]` blocks and the `LOKI_URL` vars from every environment. Also drop the `PRODUCT_TELEMETRY` stub from any test env fixture that still passes it.

- [ ] **Step 2: Run the full gates**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm ipc:check
```

Expected: all green. Any failure here is a real dangling reference — fix it rather than deleting the test.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "refactor(telemetry): remove Analytics Engine and Loki sinks"
```

---

### Task 12: Staging verification

D4 removed the backfill parity check, so this is the only gate before production. Do not skip it.

- [ ] **Step 1: Deploy to staging**

Merge to `main`; staging deploys automatically. Confirm `POSTHOG_KEY` is set as a secret on the staging Worker.

- [ ] **Step 2: Drive a staging desktop build**

Point a desktop build at the staging sync-server and exercise: onboarding, note create/open/update, task create/complete, inbox capture and file, search, calendar, agent chat, an induced error.

- [ ] **Step 3: Assert event coverage**

In PostHog, filter `environment = staging` and confirm every event name produced appears, that `$pageview` is present (not `page_viewed`), that person properties are populated, and that an induced error shows up under Error Tracking grouped by its `errorCode`.

- [ ] **Step 4: Assert logs**

Confirm `service.name = desktop` log records arrive, that a known line is present, and that a synthetic secret written into a log line does **not** appear.

- [ ] **Step 5: Production deploy**

`gh workflow run "Deploy sync-server (production)" --ref main`, wait for `status=waiting`, then approve via `gh api -X POST .../runs/<id>/pending_deployments -F "environment_ids[]=<envid>" -f state=approved`.

---

### Task 13: Rebuild dashboards and decommission the VPS

- [ ] **Step 1: Audit the two surviving dashboards**

Project 412311 still holds `1694748` (Desktop Product Analytics) and `1694749` (Sync Server Business & Health) from the earlier attempt. Adapt them rather than rebuilding. Every tile must filter `environment = production` — an unfiltered tile blends dev noise into production numbers.

- [ ] **Step 2: Rebuild the remaining panels**

29 product panels → trends insights, a native Funnel for onboarding, SQL insights for the top-events and feature-usage tables, breakdowns for platform and version. 11 landing panels → mostly native Web Analytics; only the demo funnel and CTA/target tables need custom insights. The two log timeseries → event and Error Tracking insights, **not** log queries.

- [ ] **Step 3: Optional cold archive**

Before removing Grafana, dump both AE datasets to R2 as CSV via the AE SQL API. This is a hedge, not a backfill, and does not reopen D4.

- [ ] **Step 4: Decommission**

```bash
ssh root@178.105.205.174 'cd /opt/grafana && docker compose down && docker rm -f grafana loki'
```

Then remove `/opt/grafana`, the Caddy `/loki/api/v1/push` route and `/opt/grafana/loki-push-token`. Leave Postiz and Temporal untouched — they share this host.

- [ ] **Step 5: Update the privacy policy**

Re-add PostHog to the sub-processor list in `apps/landing/src/pages/Privacy.tsx`; it was removed on 2026-07-04. Settle the cookie-consent posture for session replay before this ships — the previous landing pipeline was cookie-free.

- [ ] **Step 6: Commit**

```bash
git add apps/landing/src/pages/Privacy.tsx
git commit -m "docs(privacy): restore PostHog as a sub-processor"
```

---

## Follow-on plans

- **Train 2 (desktop):** identity bearer, durable ship queue, crash detection, client-side message redaction. Must not ship until Task 12 has deployed the widened schema to production.
- **Train 3 (cron):** GitHub Releases download counts. Independent of both.
