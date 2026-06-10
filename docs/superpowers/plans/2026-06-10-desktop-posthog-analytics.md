# Desktop PostHog Product Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Account-linked PostHog identity for desktop telemetry plus the remaining uninstrumented events, per `docs/superpowers/specs/2026-06-10-desktop-posthog-analytics-design.md`.

**Architecture:** Desktop keeps zero PostHog SDK. The existing pipeline (renderer/main track wrappers → batching runtime → sync-server `/telemetry/batch` → Analytics Engine + PostHog mirror) gains: (1) an optional verified bearer token so signed-in batches resolve to the account `user.id` in PostHog with a `$identify` merge, (2) a throttle for autosave-driven events, (3) the missing contract events, (4) four new contract events.

**Tech Stack:** TypeScript, Electron main process, Hono on Cloudflare Workers, Zod contracts, Vitest.

**Conventions:** Prettier: single quotes, no semicolons, 100 char width. Logging via `createLogger('Scope')`. No Co-Authored-By in commits. Run desktop tests with `pnpm --filter @memry/desktop test:main`, sync-server tests with `pnpm test:sync-server`. If `better-sqlite3` fails with ERR_DLOPEN_FAILED in Node tests: `pnpm --filter @memry/desktop rebuild:node`.

---

### Task 1: Branch + commit in-flight wizard changes

The working tree has uncommitted PostHog-wizard changes (`apps/sync-server/src/routes/{auth,sync,webhooks}.ts`, `apps/sync-server/src/services/posthog.ts`, `README.md`, untracked `posthog-setup-report.md`). They are prerequisite, related work — commit them first as their own commit so this plan's diffs stay reviewable.

- [ ] **Step 1: Create branch**

```bash
git checkout -b telemetry-account-identity
```

- [ ] **Step 2: Verify the wizard changes pass sync-server tests**

Run: `pnpm test:sync-server`
Expected: PASS (known exception: 4 `schema/d1.test.ts` cases may fail under parallel workers — pre-existing isolation flake; re-run with `--no-file-parallelism` to confirm they pass solo).

- [ ] **Step 3: Commit wizard work**

```bash
git add apps/sync-server/src/routes/auth.ts apps/sync-server/src/routes/sync.ts apps/sync-server/src/routes/webhooks.ts apps/sync-server/src/services/posthog.ts README.md posthog-setup-report.md
git commit -m "feat(sync-server): capture business events in PostHog (signup, login, device, subscription, vault)"
```

---

### Task 2: Sync-server — PostHog identity override + `$identify` merge

**Files:**

- Modify: `apps/sync-server/src/services/telemetry.ts`
- Test: `apps/sync-server/src/services/telemetry.test.ts`

`writeTelemetryBatch` gains `options.userId`. When set, every mirrored PostHog event uses `userId` as `distinct_id` and the batch is prefixed with a `$identify` event whose `$anon_distinct_id` is the install-hash distinct id, merging the anonymous person into the account person. The Analytics Engine write path is untouched.

- [ ] **Step 1: Write the failing tests**

Add to `apps/sync-server/src/services/telemetry.test.ts`, following the file's existing harness (it already builds `TelemetryBatch` fixtures, stubs `PRODUCT_TELEMETRY` via a `writeDataPoint` mock, and stubs `fetch` for the PostHog mirror — reuse those helpers):

```typescript
describe('writeTelemetryBatch with userId', () => {
  it('uses userId as distinct_id and prepends $identify with $anon_distinct_id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    const { dataset } = createDataset()
    const batch = createBatch() // existing fixture helper in this file
    const env = {
      PRODUCT_TELEMETRY: dataset,
      TELEMETRY_HMAC_KEY: 'test-key',
      POSTHOG_API_KEY: 'phk',
      POSTHOG_HOST: 'https://ph.example.com',
      ENVIRONMENT: 'test'
    }

    await writeTelemetryBatch(env, batch, { userId: 'user_123' })

    const batchCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/batch/'))
    expect(batchCall).toBeDefined()
    const payload = JSON.parse(batchCall![1].body as string)
    const identify = payload.batch.find((e: { event: string }) => e.event === '$identify')
    const installHash = await hashTelemetryId('test-key', batch.installId)
    expect(identify).toBeDefined()
    expect(identify.distinct_id).toBe('user_123')
    expect(identify.properties.$anon_distinct_id).toBe(`memry_desktop_test_${installHash}`)
    const events = payload.batch.filter((e: { event: string }) => e.event !== '$identify')
    for (const event of events) {
      expect(event.distinct_id).toBe('user_123')
    }
  })

  it('keeps install-hash distinct_id and sends no $identify without userId', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', fetchMock)
    const { dataset } = createDataset()
    const batch = createBatch()
    const env = {
      PRODUCT_TELEMETRY: dataset,
      TELEMETRY_HMAC_KEY: 'test-key',
      POSTHOG_API_KEY: 'phk',
      POSTHOG_HOST: 'https://ph.example.com',
      ENVIRONMENT: 'test'
    }

    await writeTelemetryBatch(env, batch, {})

    const batchCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/batch/'))
    const payload = JSON.parse(batchCall![1].body as string)
    expect(payload.batch.some((e: { event: string }) => e.event === '$identify')).toBe(false)
    const installHash = await hashTelemetryId('test-key', batch.installId)
    for (const event of payload.batch) {
      expect(event.distinct_id).toBe(`memry_desktop_test_${installHash}`)
    }
  })
})
```

If the file's fixture helper has a different name than `createBatch`, use the existing one — do not invent a second fixture.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memry/sync-server test -- services/telemetry.test.ts`
Expected: FAIL — `writeTelemetryBatch` ignores `userId` (option does not exist yet).

- [ ] **Step 3: Implement in `services/telemetry.ts`**

Extend `TelemetryWriteOptions` and thread `userId` through the mirror:

```typescript
export interface TelemetryWriteOptions {
  waitUntil?: (promise: Promise<unknown>) => void
  userId?: string
}
```

Change `toPostHogEvent` to accept an override (keep the existing signature order, append the new param):

```typescript
export const toPostHogEvent = (
  batch: TelemetryBatch,
  event: TelemetryEvent,
  installHash: string,
  environment?: string,
  overrideDistinctId?: string
): PostHogEventPayload => {
  // ...existing body unchanged except the return:
  return {
    event: event.name,
    distinct_id: overrideDistinctId ?? desktopDistinctId(batch, installHash, environment),
    timestamp: event.occurredAt,
    properties
  }
}
```

Thread through `toPostHogBatchPayload`:

```typescript
export const toPostHogBatchPayload = (
  apiKey: string,
  batch: TelemetryBatch,
  installHash: string,
  environment?: string,
  overrideDistinctId?: string
): PostHogBatchPayload => ({
  api_key: apiKey,
  batch: batch.events.map((event) =>
    toPostHogEvent(batch, event, installHash, environment, overrideDistinctId)
  )
})
```

In `mirrorTelemetryBatchToPostHog`, accept `userId` and prepend the merge event:

```typescript
const mirrorTelemetryBatchToPostHog = async (
  env: TelemetryEnv,
  batch: TelemetryBatch,
  hashes: BatchHashes,
  userId?: string
): Promise<void> => {
  if (!env.POSTHOG_API_KEY || !env.POSTHOG_HOST) return

  const payload = toPostHogBatchPayload(
    env.POSTHOG_API_KEY,
    batch,
    hashes.installHash,
    env.ENVIRONMENT,
    userId
  )
  const identifyEvents: PostHogEventPayload[] = userId
    ? [
        {
          event: '$identify',
          distinct_id: userId,
          timestamp: new Date().toISOString(),
          properties: {
            $anon_distinct_id: desktopDistinctId(batch, hashes.installHash, env.ENVIRONMENT),
            service_name: DESKTOP_SERVICE_NAME
          }
        }
      ]
    : []
  // ...existing exceptionEvents/logRecords derivation unchanged...
  await Promise.all([
    sendPostHogBatch(env, [...identifyEvents, ...payload.batch, ...exceptionEvents]),
    sendPostHogLogs(env, logRecords)
  ])
}
```

And in `writeTelemetryBatch`, pass it through:

```typescript
const mirrorPromise = mirrorTelemetryBatchToPostHog(env, batch, hashes, options.userId)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memry/sync-server test -- services/telemetry.test.ts`
Expected: PASS, including all pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/services/telemetry.ts apps/sync-server/src/services/telemetry.test.ts
git commit -m "feat(sync-server): resolve telemetry PostHog identity to account user with \$identify merge"
```

---

### Task 3: Sync-server — optional bearer verification on `/telemetry/batch`

**Files:**

- Modify: `apps/sync-server/src/routes/telemetry.ts`
- Test: `apps/sync-server/src/routes/telemetry.test.ts`

Do NOT use `authMiddleware` (it throws 401 and queries the devices table). Telemetry must never reject for auth reasons: verify the JWT inline, swallow all failures.

- [ ] **Step 1: Write the failing tests**

Add to `apps/sync-server/src/routes/telemetry.test.ts` (it already builds the Hono app and a valid batch body; follow its env/dataset stubs). Mock JWT verification:

```typescript
import { verifyAccessToken } from '../lib/jwt-verify'

vi.mock('../lib/jwt-verify', () => ({
  verifyAccessToken: vi.fn(),
  JwtKeyError: class JwtKeyError extends Error {}
}))

describe('optional auth on /telemetry/batch', () => {
  it('passes verified userId to writeTelemetryBatch', async () => {
    vi.mocked(verifyAccessToken).mockResolvedValue({
      userId: 'user_123',
      deviceId: 'dev_1'
    } as Awaited<ReturnType<typeof verifyAccessToken>>)
    const res = await app.request(
      '/telemetry/batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer good-token'
        },
        body: JSON.stringify(validBatch)
      },
      env
    )
    expect(res.status).toBe(202)
    // assert via the fetch stub that PostHog payload events carry distinct_id 'user_123'
  })

  it('still accepts the batch when the token is invalid', async () => {
    vi.mocked(verifyAccessToken).mockRejectedValue(new Error('Token has expired'))
    const res = await app.request(
      '/telemetry/batch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer bad-token'
        },
        body: JSON.stringify(validBatch)
      },
      env
    )
    expect(res.status).toBe(202)
  })

  it('behaves exactly as before with no Authorization header', async () => {
    const res = await app.request(
      '/telemetry/batch',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validBatch)
      },
      env
    )
    expect(res.status).toBe(202)
  })
})
```

Adapt `app`, `env`, and `validBatch` to the file's existing test setup — reuse, don't duplicate.

- [ ] **Step 2: Run tests to verify the first one fails**

Run: `pnpm --filter @memry/sync-server test -- routes/telemetry.test.ts`
Expected: first test FAILS (events carry install-hash distinct_id, not `user_123`); the other two pass already.

- [ ] **Step 3: Implement in `routes/telemetry.ts`**

```typescript
import { verifyAccessToken } from '../lib/jwt-verify'

const resolveOptionalUserId = async (
  authHeader: string | undefined,
  jwtPublicKey: string
): Promise<string | undefined> => {
  if (!authHeader?.startsWith('Bearer ')) return undefined
  try {
    const claims = await verifyAccessToken(authHeader.slice(7), jwtPublicKey)
    return claims.userId
  } catch {
    return undefined
  }
}

telemetry.post('/batch', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = TelemetryBatchSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid telemetry payload', 400)
  }

  const userId = await resolveOptionalUserId(c.req.header('Authorization'), c.env.JWT_PUBLIC_KEY)

  const result = await writeTelemetryBatch(c.env, parsed.data, {
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    userId
  })
  return c.json(result, 202)
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memry/sync-server test -- routes/telemetry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/sync-server/src/routes/telemetry.ts apps/sync-server/src/routes/telemetry.test.ts
git commit -m "feat(sync-server): accept optional verified bearer token on telemetry batch"
```

---

### Task 4: Desktop — attach bearer token to telemetry flush

**Files:**

- Modify: `apps/desktop/src/main/telemetry/client.ts`
- Test: `apps/desktop/src/main/telemetry/client.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `client.test.ts`, following its existing `createTelemetryClient` harness (deps with a `vi.fn()` fetch):

```typescript
it('attaches Authorization header when getAccessToken returns a token', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 })
  const client = createTelemetryClient({
    ...baseDeps, // the file's existing deps fixture
    fetch: fetchMock,
    getAccessToken: async () => 'jwt-token'
  })
  client.track(makeEvent()) // the file's existing event fixture
  await client.flush('manual')
  const [, init] = fetchMock.mock.calls[0]
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-token')
})

it('omits Authorization header when getAccessToken returns null', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 })
  const client = createTelemetryClient({
    ...baseDeps,
    fetch: fetchMock,
    getAccessToken: async () => null
  })
  client.track(makeEvent())
  await client.flush('manual')
  const [, init] = fetchMock.mock.calls[0]
  expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
})

it('flushes without header when getAccessToken throws', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 })
  const client = createTelemetryClient({
    ...baseDeps,
    fetch: fetchMock,
    getAccessToken: async () => {
      throw new Error('keychain locked')
    }
  })
  client.track(makeEvent())
  const result = await client.flush('manual')
  expect(result.success).toBe(true)
  const [, init] = fetchMock.mock.calls[0]
  expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:main -- telemetry/client.test.ts`
Expected: FAIL — `getAccessToken` is not a known dep; header never set.

- [ ] **Step 3: Implement in `client.ts`**

```typescript
export interface TelemetryClientDeps {
  fetch: TelemetryFetch
  endpoint: string
  context: TelemetryClientContext
  initialEnabled: boolean
  getAuthState: () => TelemetryAuthState
  getSyncState: () => TelemetrySyncState
  getAccessToken?: () => Promise<string | null>
}
```

In `flush`, before the fetch:

```typescript
let token: string | null = null
if (deps.getAccessToken) {
  try {
    token = await deps.getAccessToken()
  } catch {
    token = null
  }
}

const response = await deps.fetch(deps.endpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  },
  body: JSON.stringify(batch)
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:main -- telemetry/client.test.ts`
Expected: PASS, including pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/telemetry/client.ts apps/desktop/src/main/telemetry/client.test.ts
git commit -m "feat(desktop): send bearer token with telemetry batches when signed in"
```

---

### Task 5: Desktop — wire token provider through runtime into app init

**Files:**

- Modify: `apps/desktop/src/main/telemetry/runtime.ts`
- Modify: `apps/desktop/src/main/index.ts:731` (the `initializeTelemetryRuntime` call)
- Test: `apps/desktop/src/main/telemetry/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `runtime.test.ts` (follow its existing init/dispose pattern — it passes `fetch`, `flushIntervalMs: null`, etc.):

```typescript
it('passes accessTokenProvider through to the client flush', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 })
  const runtime = initializeTelemetryRuntime({
    ...baseRuntimeDeps, // the file's existing deps fixture
    fetch: fetchMock,
    initialEnabled: true,
    flushIntervalMs: null,
    accessTokenProvider: async () => 'jwt-token'
  })
  await runtime.flush('manual') // app_started is auto-queued on init
  const [, init] = fetchMock.mock.calls[0]
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-token')
  await runtime.dispose()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- telemetry/runtime.test.ts`
Expected: FAIL — `accessTokenProvider` unknown.

- [ ] **Step 3: Implement**

`runtime.ts` — add to `TelemetryRuntimeDeps`:

```typescript
accessTokenProvider?: () => Promise<string | null>
```

and pass it in `createTelemetryClient`:

```typescript
const client = createTelemetryClient({
  fetch: wrapFetch(deps?.fetch),
  endpoint,
  context,
  initialEnabled,
  getAuthState: deps?.authStateProvider ?? (() => 'anonymous'),
  getSyncState: deps?.syncStateProvider ?? (() => 'unknown'),
  getAccessToken: deps?.accessTokenProvider
})
```

`index.ts` — extend the existing init call (import `getValidAccessToken` from `./sync/token-manager`):

```typescript
initializeTelemetryRuntime({
  appVersion: app.getVersion(),
  locale: app.getLocale(),
  authStateProvider: getTelemetryAuthState,
  syncStateProvider: getTelemetrySyncState,
  accessTokenProvider: () => getValidAccessToken()
})
```

(`getValidAccessToken` already returns `Promise<string | null>` and never prompts; the client wraps it in try/catch.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @memry/desktop test:main -- telemetry/ && pnpm --filter @memry/desktop typecheck:node`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/telemetry/runtime.ts apps/desktop/src/main/telemetry/runtime.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): wire access-token provider into telemetry runtime"
```

---

### Task 6: Desktop — throttle autosave-driven events

**Files:**

- Create: `apps/desktop/src/main/telemetry/throttle.ts`
- Create: `apps/desktop/src/main/telemetry/throttle.test.ts`
- Modify: `apps/desktop/src/main/ipc/notes-handlers.ts` (the `trackMainEvent('note_updated', …)` site, ~line 274)
- Modify: `apps/desktop/src/main/ipc/journal-handlers.ts` (the `trackMainEvent('journal_updated', …)` site, ~line 269)

- [ ] **Step 1: Write the failing tests**

`throttle.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetTelemetryThrottle, shouldEmitThrottled } from './throttle'

describe('shouldEmitThrottled', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetTelemetryThrottle()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits the first event for a key', () => {
    expect(shouldEmitThrottled('note_updated:abc')).toBe(true)
  })

  it('suppresses repeats inside the window', () => {
    shouldEmitThrottled('note_updated:abc')
    vi.advanceTimersByTime(4 * 60 * 1000)
    expect(shouldEmitThrottled('note_updated:abc')).toBe(false)
  })

  it('emits again after the window', () => {
    shouldEmitThrottled('note_updated:abc')
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(shouldEmitThrottled('note_updated:abc')).toBe(true)
  })

  it('tracks keys independently', () => {
    shouldEmitThrottled('note_updated:abc')
    expect(shouldEmitThrottled('note_updated:def')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:main -- telemetry/throttle.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `throttle.ts`**

```typescript
export const TELEMETRY_THROTTLE_WINDOW_MS = 5 * 60 * 1000
const MAX_TRACKED_KEYS = 1000

const lastEmitted = new Map<string, number>()

/**
 * Returns true when an event for this key should be emitted, false while a
 * previous emission is still inside the throttle window. In-memory only —
 * the window intentionally resets on app restart.
 */
export const shouldEmitThrottled = (
  key: string,
  windowMs: number = TELEMETRY_THROTTLE_WINDOW_MS
): boolean => {
  const now = Date.now()
  const last = lastEmitted.get(key)
  if (last !== undefined && now - last < windowMs) return false
  lastEmitted.set(key, now)
  if (lastEmitted.size > MAX_TRACKED_KEYS) {
    for (const [trackedKey, emittedAt] of lastEmitted) {
      if (now - emittedAt >= windowMs) lastEmitted.delete(trackedKey)
    }
  }
  return true
}

export const resetTelemetryThrottle = (): void => {
  lastEmitted.clear()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:main -- telemetry/throttle.test.ts`
Expected: PASS.

- [ ] **Step 5: Wrap the two call sites**

In `notes-handlers.ts`, the UPDATE handler currently does:

```typescript
const note = await updateNoteCommand(input)
trackMainEvent('note_updated', {
  /* existing args */
})
```

Wrap the existing call **without changing its arguments** (read the file first; the note's id field is on the returned `note`):

```typescript
const note = await updateNoteCommand(input)
if (shouldEmitThrottled(`note_updated:${note.id}`)) {
  trackMainEvent('note_updated', {
    /* existing args, unchanged */
  })
}
```

In `journal-handlers.ts`, same pattern keyed on the entry date:

```typescript
if (shouldEmitThrottled(`journal_updated:${entry.date}`)) {
  trackMainEvent('journal_updated', {
    /* existing args, unchanged */
  })
}
```

Import `shouldEmitThrottled` from `../telemetry/throttle` in both files. If either handler's test file asserts `trackMainEvent` is called on every update, update those tests to call `resetTelemetryThrottle()` in `beforeEach` and assert the second rapid update does NOT track.

- [ ] **Step 6: Run handler tests**

Run: `pnpm --filter @memry/desktop test:main -- ipc/notes-handlers ipc/journal-handlers`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/telemetry/throttle.ts apps/desktop/src/main/telemetry/throttle.test.ts apps/desktop/src/main/ipc/notes-handlers.ts apps/desktop/src/main/ipc/journal-handlers.ts
git commit -m "feat(desktop): throttle autosave telemetry to one event per document per 5 minutes"
```

---

### Task 7: Desktop — `app_backgrounded` + `app_active_heartbeat`

**Files:**

- Modify: `apps/desktop/src/main/telemetry/diagnostics.ts`
- Modify: `apps/desktop/src/main/index.ts` (app event wiring, near the other `app.on(...)` registrations)
- Test: `apps/desktop/src/main/telemetry/diagnostics.test.ts`

- [ ] **Step 1: Write the failing test for the heartbeat**

Add to `diagnostics.test.ts` (it already mocks `./runtime`'s `getTelemetryRuntime` — follow that pattern):

```typescript
it('emits app_active_heartbeat every 5 minutes while a window is focused', () => {
  vi.useFakeTimers()
  const track = vi.fn()
  // arrange the file's existing runtime mock so getTelemetryRuntime() returns { track, ... }
  startActiveHeartbeat(() => true) // isFocused provider
  vi.advanceTimersByTime(5 * 60 * 1000)
  expect(track).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'app_active_heartbeat', surface: 'app' })
  )
  vi.useRealTimers()
})

it('skips heartbeat when no window is focused', () => {
  vi.useFakeTimers()
  const track = vi.fn()
  startActiveHeartbeat(() => false)
  vi.advanceTimersByTime(5 * 60 * 1000)
  expect(track).not.toHaveBeenCalled()
  vi.useRealTimers()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @memry/desktop test:main -- telemetry/diagnostics.test.ts`
Expected: FAIL — `startActiveHeartbeat` not exported.

- [ ] **Step 3: Implement in `diagnostics.ts`**

```typescript
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export const startActiveHeartbeat = (isFocused: () => boolean): void => {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    if (!isFocused()) return
    trackMainEvent('app_active_heartbeat', {
      surface: 'app',
      action: 'heartbeat',
      metrics: { activeSeconds: HEARTBEAT_INTERVAL_MS / 1000 }
    })
  }, HEARTBEAT_INTERVAL_MS)
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
}

export const stopActiveHeartbeat = (): void => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}
```

- [ ] **Step 4: Wire both events in `index.ts`**

After `registerMainDiagnostics()`:

```typescript
startActiveHeartbeat(() => BrowserWindow.getFocusedWindow() !== null)

app.on('browser-window-blur', () => {
  // Fires per-window; only count it as backgrounding when focus left the app.
  setImmediate(() => {
    if (BrowserWindow.getFocusedWindow() === null) {
      trackMainEvent('app_backgrounded', { surface: 'app', action: 'backgrounded' })
    }
  })
})
```

Imports: `startActiveHeartbeat` from `./telemetry/diagnostics`, `trackMainEvent` from `./telemetry/track` (check whether index.ts already imports them). `BrowserWindow` is already imported in index.ts.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter @memry/desktop test:main -- telemetry/ && pnpm --filter @memry/desktop typecheck:node`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/telemetry/diagnostics.ts apps/desktop/src/main/telemetry/diagnostics.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): emit app_backgrounded and app_active_heartbeat telemetry"
```

---

### Task 8: Desktop — onboarding events (renderer)

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/vault-onboarding.tsx`
- Test: colocated test if `vault-onboarding.test.tsx` exists; otherwise add the tracking assertions to the component's existing test file (search `apps/desktop/src/renderer/src` for it first)

- [ ] **Step 1: Read the component**

Read `vault-onboarding.tsx` fully. Identify (a) the top-level mount point, (b) the success handler where onboarding finishes (vault created/selected and the app proceeds).

- [ ] **Step 2: Write failing tests**

Renderer tests mock `@/lib/telemetry`:

```typescript
vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))
import { trackTelemetry } from '@/lib/telemetry'

it('tracks onboarding_started on mount', () => {
  render(<VaultOnboarding />)
  expect(trackTelemetry).toHaveBeenCalledWith('onboarding_started', {
    surface: 'onboarding',
    action: 'started'
  })
})
```

And in the completion-path test (drive the same interaction the file's existing tests use to finish onboarding):

```typescript
expect(trackTelemetry).toHaveBeenCalledWith('onboarding_completed', {
  surface: 'onboarding',
  action: 'completed',
  result: 'success'
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @memry/desktop test:renderer -- vault-onboarding`
Expected: FAIL.

- [ ] **Step 4: Implement**

```typescript
import { trackTelemetry } from '@/lib/telemetry'

// inside VaultOnboarding:
useEffect(() => {
  void trackTelemetry('onboarding_started', { surface: 'onboarding', action: 'started' })
}, [])

// in the success handler, right where onboarding completes:
void trackTelemetry('onboarding_completed', {
  surface: 'onboarding',
  action: 'completed',
  result: 'success'
})
```

- [ ] **Step 5: Run tests, commit**

Run: `pnpm --filter @memry/desktop test:renderer -- vault-onboarding`
Expected: PASS.

```bash
git add apps/desktop/src/renderer/src/components/vault-onboarding.tsx <its test file>
git commit -m "feat(desktop): track onboarding started and completed"
```

---

### Task 9: Desktop — `setting_changed` (main)

**Files:**

- Modify: `apps/desktop/src/main/ipc/settings-handlers.ts` (the `SettingsChannels.invoke.SET` handler, ~line 302)
- Test: `apps/desktop/src/main/ipc/settings-handlers.test.ts` (check it exists; if not, add the case to the IPC handler test suite that covers settings)

- [ ] **Step 1: Write the failing test**

Mock `../telemetry/track` the way other handler tests in `ipc/` do:

```typescript
vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
import { trackMainEvent } from '../telemetry/track'

it('tracks setting_changed with the setting key as dimension', async () => {
  // invoke the SET handler through the file's existing harness with key 'appearance.theme'
  expect(trackMainEvent).toHaveBeenCalledWith('setting_changed', {
    surface: 'settings',
    action: 'changed',
    dimensions: { setting: 'appearance.theme' }
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @memry/desktop test:main -- ipc/settings-handlers`
Expected: FAIL.

- [ ] **Step 3: Implement**

In the SET handler, after the value is persisted and broadcast (`SettingsChannels.events.CHANGED`):

```typescript
trackMainEvent('setting_changed', {
  surface: 'settings',
  action: 'changed',
  dimensions: { setting: key }
})
```

Only the key is sent — never the value (values can be free-form text). Setting keys are dot-separated identifiers, which pass the contract's safe-dimension regex. Import `trackMainEvent` from `../telemetry/track`.

- [ ] **Step 4: Run tests, commit**

Run: `pnpm --filter @memry/desktop test:main -- ipc/settings-handlers`
Expected: PASS.

```bash
git add apps/desktop/src/main/ipc/settings-handlers.ts apps/desktop/src/main/ipc/settings-handlers.test.ts
git commit -m "feat(desktop): track setting_changed with setting key dimension"
```

---

### Task 10: Contract — add four new event names

**Files:**

- Modify: `packages/contracts/src/telemetry-api.ts`
- Test: `packages/contracts/src/telemetry-api.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @memry/contracts test -- telemetry-api`
(If contracts has no per-package test script, run `pnpm test` filtered to the contracts test file.)
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `TelemetryEventNameSchema`'s enum array, after `'ai_action_completed'`:

```typescript
  'agent_chat_started',
  'agent_chat_message_sent',
  'command_palette_opened',
  'app_update_installed',
```

- [ ] **Step 4: Regenerate + verify**

Run: `pnpm ipc:generate && pnpm ipc:check && pnpm --filter @memry/contracts test`
Expected: PASS, no invoke-map drift.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/telemetry-api.ts packages/contracts/src/telemetry-api.test.ts
git commit -m "feat(contracts): add agent chat, command palette, and updater telemetry events"
```

(Include any regenerated invoke-map file if `ipc:generate` changed it.)

---

### Task 11: Desktop — command palette events (renderer)

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/search/command-palette.tsx`
- Test: the palette's existing test file (locate it next to the component first)

- [ ] **Step 1: Read the component**

Read `command-palette.tsx` fully. Identify (a) the `open` prop transition (false→true), (b) `openItemTab` (~line 130) where a result item opens a note/journal/task tab.

- [ ] **Step 2: Write failing tests**

```typescript
vi.mock('@/lib/telemetry', () => ({ trackTelemetry: vi.fn() }))
import { trackTelemetry } from '@/lib/telemetry'

it('tracks command_palette_opened when opened', () => {
  const { rerender } = render(<CommandPalette open={false} onOpenChange={() => {}} />)
  rerender(<CommandPalette open onOpenChange={() => {}} />)
  expect(trackTelemetry).toHaveBeenCalledWith('command_palette_opened', {
    surface: 'search',
    action: 'opened'
  })
})

it('tracks search_result_opened when a result opens', () => {
  // drive the file's existing interaction for opening a result item
  expect(trackTelemetry).toHaveBeenCalledWith('search_result_opened', {
    surface: 'search',
    action: 'opened',
    objectType: 'note' // matches the item kind the test opens
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @memry/desktop test:renderer -- command-palette`
Expected: FAIL.

- [ ] **Step 4: Implement**

```typescript
import { trackTelemetry } from '@/lib/telemetry'

// open transition — alongside the existing `if (open) loadReasons()` effect:
useEffect(() => {
  if (open) {
    void trackTelemetry('command_palette_opened', { surface: 'search', action: 'opened' })
  }
}, [open])

// inside openItemTab, once per invocation, with the item's kind:
void trackTelemetry('search_result_opened', {
  surface: 'search',
  action: 'opened',
  objectType: itemKind // 'note' | 'journal' | 'task' — use the discriminator openItemTab already switches on
})
```

- [ ] **Step 5: Run tests, commit**

Run: `pnpm --filter @memry/desktop test:renderer -- command-palette`
Expected: PASS.

```bash
git add apps/desktop/src/renderer/src/components/search/command-palette.tsx <its test file>
git commit -m "feat(desktop): track command palette open and result opens"
```

---

### Task 12: Desktop — Agent Chat events (main)

**Files:**

- Modify: `apps/desktop/src/main/agent/runtime/turn.ts` (`runTurn`, line 43)
- Test: the turn runtime's existing test file under `apps/desktop/src/main/agent/runtime/`

- [ ] **Step 1: Read `runTurn`**

Read `turn.ts` fully. Identify (a) where a new conversation is created (the `DEFAULT_CONVERSATION_TITLE` path) vs an existing one loaded, (b) what `input.backendOptions` exposes as a backend/provider label.

- [ ] **Step 2: Write failing tests**

Following the runtime test file's existing `TurnDeps` mocks:

```typescript
vi.mock('../../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
import { trackMainEvent } from '../../telemetry/track'

it('tracks agent_chat_started when a turn creates a new conversation', async () => {
  await runTurn(depsWithNoExistingConversation, makeTurnInput())
  expect(trackMainEvent).toHaveBeenCalledWith(
    'agent_chat_started',
    expect.objectContaining({
      surface: 'ai',
      action: 'started'
    })
  )
})

it('tracks agent_chat_message_sent on every turn with the backend label', async () => {
  await runTurn(deps, makeTurnInput())
  expect(trackMainEvent).toHaveBeenCalledWith(
    'agent_chat_message_sent',
    expect.objectContaining({
      surface: 'ai',
      action: 'sent'
    })
  )
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @memry/desktop test:main -- agent/runtime/turn`
Expected: FAIL.

- [ ] **Step 4: Implement in `runTurn`**

At the point where the conversation is resolved (after create-if-missing):

```typescript
import { trackMainEvent } from '../../telemetry/track'

if (createdNewConversation) {
  trackMainEvent('agent_chat_started', {
    surface: 'ai',
    action: 'started',
    source: backendLabel
  })
}
trackMainEvent('agent_chat_message_sent', {
  surface: 'ai',
  action: 'sent',
  source: backendLabel
})
```

`backendLabel` is the backend identifier from `input.backendOptions` (e.g. `'claude-cli'`, `'codex-cli'`, `'local'` — use whatever discriminant the type exposes; it must be a static label, NEVER user text). `createdNewConversation` is the existing branch where `DEFAULT_CONVERSATION_TITLE` is used. Never touch `input.text` or attachments.

- [ ] **Step 5: Run tests, commit**

Run: `pnpm --filter @memry/desktop test:main -- agent/runtime/turn`
Expected: PASS.

```bash
git add apps/desktop/src/main/agent/runtime/turn.ts <its test file>
git commit -m "feat(desktop): track agent chat conversation starts and messages"
```

---

### Task 13: Desktop — `app_update_installed`

**Files:**

- Modify: `apps/desktop/src/main/telemetry/config.ts` (add `lastRunVersion` to `TelemetryConfigOnDisk`)
- Modify: `apps/desktop/src/main/telemetry/runtime.ts` (detect version change at init)
- Test: `apps/desktop/src/main/telemetry/runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
it('tracks app_update_installed when appVersion differs from stored lastRunVersion', async () => {
  // arrange the file's existing config mock so readTelemetryConfig returns { enabled: true, lastRunVersion: '1.0.0' }
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 })
  const runtime = initializeTelemetryRuntime({
    ...baseRuntimeDeps,
    fetch: fetchMock,
    appVersion: '1.1.0',
    initialEnabled: true,
    flushIntervalMs: null
  })
  await runtime.flush('manual')
  const payload = JSON.parse(fetchMock.mock.calls[0][1].body as string)
  const updateEvent = payload.events.find(
    (e: { name: string }) => e.name === 'app_update_installed'
  )
  expect(updateEvent).toBeDefined()
  expect(updateEvent.dimensions).toEqual({ from_version: '1.0.0' })
  await runtime.dispose()
})

it('does not track app_update_installed on first run (no stored version)', async () => {
  // config mock returns { enabled: true } with no lastRunVersion
  // ...same arrangement; assert no app_update_installed in the flushed payload
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @memry/desktop test:main -- telemetry/runtime.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`config.ts`:

```typescript
export interface TelemetryConfigOnDisk {
  installId?: string
  enabled?: boolean
  lastRunVersion?: string
}
```

`runtime.ts`, in `initializeTelemetryRuntime` right after the `app_started` track block (so it reuses `stored` and `client`):

```typescript
const currentVersion = context.appVersion
if (initialEnabled && stored.lastRunVersion && stored.lastRunVersion !== currentVersion) {
  client.track({
    id: randomUUID(),
    name: 'app_update_installed',
    occurredAt: new Date().toISOString(),
    surface: 'updater',
    action: 'installed',
    result: 'success',
    dimensions: { from_version: stored.lastRunVersion }
  })
}
if (stored.lastRunVersion !== currentVersion) {
  mergeTelemetryConfig({ lastRunVersion: currentVersion })
}
```

(Version strings like `1.2.3` pass the safe-dimension regex — dots are allowed, slashes are not.)

- [ ] **Step 4: Run tests, commit**

Run: `pnpm --filter @memry/desktop test:main -- telemetry/`
Expected: PASS.

```bash
git add apps/desktop/src/main/telemetry/config.ts apps/desktop/src/main/telemetry/runtime.ts apps/desktop/src/main/telemetry/runtime.test.ts
git commit -m "feat(desktop): track app_update_installed via persisted lastRunVersion"
```

---

### Task 14: Docs + full verification

**Files:**

- Modify: telemetry docs under `apps/docs/src/**` (whatever `docs:impact` flags)

- [ ] **Step 1: Update docs**

```bash
base_commit=$(git merge-base origin/main HEAD)
pnpm docs:ai-update --base "$base_commit"
```

Or manually update the telemetry/analytics page under `apps/docs/src` to document: account-linked identity (verified token, `$identify` merge, anonymous fallback), the throttle, and the four new events.

- [ ] **Step 2: Docs gate**

```bash
pnpm docs:impact --base "$base_commit" --strict && pnpm docs:build
```

Expected: PASS, no `missing-docs`.

- [ ] **Step 3: Full verification suite**

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm ipc:check && git diff --check
```

Expected: all green (modulo the two known pre-existing flakes: `schema/d1.test.ts` under parallel workers, and pre-existing type errors in websocket.test.ts/folders.test.ts).

- [ ] **Step 4: Commit docs**

```bash
git add apps/docs/src
git commit -m "docs: document account-linked telemetry identity and new desktop events"
```

---

## Deferred to follow-up plans

- `voice_recording_completed`, `transcription_completed`, `ai_action_completed` — need exploration of the inbox voice flow (`apps/desktop/src/main/inbox/voice-*`) first.
- PostHog dashboards/insights for desktop feature usage.
- Landing-page `posthog-js` instrumentation.
- Manual two-device QA of the identity merge against staging (verify in PostHog that an install person merges into the account person after sign-in).
