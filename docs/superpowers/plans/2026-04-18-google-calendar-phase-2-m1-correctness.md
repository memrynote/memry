# Google Calendar Phase 2 — Milestone 1: Correctness Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three correctness bugs in the Google Calendar pull loop so that Google-side updates, deletions, and cursor-invalidation all propagate to bound Memry records. No schema changes, no new surface area — minimal wiring fix in one file plus one repository helper.

**Architecture:** Extend the `for (const remoteEvent of result.events)` loop in `syncGoogleCalendarSource` ([sync-service.ts:544](../../../apps/desktop/src/main/calendar/google/sync-service.ts)) with a binding lookup. When a binding exists, route to the existing (already-implemented, already-tested in isolation) `applyGoogleCalendarWriteback` / `applyGoogleCalendarDelete` functions. When no binding exists, keep current mirror-upsert behaviour — except for `status='cancelled'` without a binding, which archives the mirror row. Add a defensive 410-Gone catch around `client.listEvents` that clears `syncCursor` and retries once.

**Tech Stack:** TypeScript, Electron, better-sqlite3 (via Drizzle), Vitest, existing `GoogleCalendarClient` mock pattern.

**Scope boundary (what M1 does NOT do):** schema changes (M3/M5), target-calendar picker (M2), conflict resolution via `If-Match` (M3), push channels (M4), new entity fields (M5), multi-account (M6), token portability (M7).

**Design doc:** [2026-04-18-google-calendar-phase-2-design.md](../specs/2026-04-18-google-calendar-phase-2-design.md).

---

## File map

| File | Change | Purpose |
|---|---|---|
| `apps/desktop/src/main/calendar/repositories/calendar-sources-repository.ts` | Modify | Add `findCalendarBindingByRemoteEvent()` helper |
| `apps/desktop/src/main/calendar/google/sync-service.ts` | Modify | Rewrite the inbound loop; add 410 catch |
| `apps/desktop/src/main/calendar/google/sync-service.test.ts` | Modify | Four new tests covering bound-update / bound-cancel / unbound-cancel / 410 |

No migrations. No new files.

---

## Task 1: Add repository helper for binding lookup by remote event

**Files:**
- Modify: `apps/desktop/src/main/calendar/repositories/calendar-sources-repository.ts`
- Test: `apps/desktop/src/main/calendar/repositories/calendar-sources-repository.test.ts` (create if absent; otherwise extend)

- [ ] **Step 1: Write the failing test**

Add to `calendar-sources-repository.test.ts` (or create the file with standard test-db scaffolding first):

```typescript
// #given two active bindings for one source-id + one archived binding
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDataDb, type TestDatabaseResult, type TestDb } from '@tests/utils/test-db'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { findCalendarBindingByRemoteEvent } from './calendar-sources-repository'

describe('findCalendarBindingByRemoteEvent', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('returns the active binding matching provider + remoteCalendarId + remoteEventId', () => {
    // #given
    const now = '2026-04-18T09:00:00.000Z'
    db.insert(calendarBindings)
      .values([
        {
          id: 'binding-1',
          sourceType: 'event',
          sourceId: 'event-a',
          provider: 'google',
          remoteCalendarId: 'cal-1',
          remoteEventId: 'evt-1',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad',
          remoteVersion: '"etag-1"',
          lastLocalSnapshot: null,
          archivedAt: null,
          clock: { 'device-a': 1 },
          syncedAt: now,
          createdAt: now,
          modifiedAt: now
        },
        {
          id: 'binding-archived',
          sourceType: 'task',
          sourceId: 'task-a',
          provider: 'google',
          remoteCalendarId: 'cal-1',
          remoteEventId: 'evt-2',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad',
          remoteVersion: null,
          lastLocalSnapshot: null,
          archivedAt: now,
          clock: { 'device-a': 1 },
          syncedAt: now,
          createdAt: now,
          modifiedAt: now
        }
      ])
      .run()

    // #when
    const match = findCalendarBindingByRemoteEvent(db, 'google', 'cal-1', 'evt-1')
    const archivedMatch = findCalendarBindingByRemoteEvent(db, 'google', 'cal-1', 'evt-2')
    const missing = findCalendarBindingByRemoteEvent(db, 'google', 'cal-1', 'evt-missing')

    // #then
    expect(match?.id).toBe('binding-1')
    expect(archivedMatch).toBeUndefined()
    expect(missing).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/repositories/calendar-sources-repository.test.ts
```

Expected: FAIL with `findCalendarBindingByRemoteEvent is not a function` (or similar module-export error).

- [ ] **Step 3: Implement the helper**

Append to `apps/desktop/src/main/calendar/repositories/calendar-sources-repository.ts`:

```typescript
import { and, eq, isNull } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import type { DataDb } from '../../database'

export function findCalendarBindingByRemoteEvent(
  db: DataDb,
  provider: string,
  remoteCalendarId: string,
  remoteEventId: string
): typeof calendarBindings.$inferSelect | undefined {
  return db
    .select()
    .from(calendarBindings)
    .where(
      and(
        eq(calendarBindings.provider, provider),
        eq(calendarBindings.remoteCalendarId, remoteCalendarId),
        eq(calendarBindings.remoteEventId, remoteEventId),
        isNull(calendarBindings.archivedAt)
      )
    )
    .get()
}
```

(If `and`, `eq`, `isNull` are already imported at the top of the file, reuse the existing import.)

- [ ] **Step 4: Run the test and confirm it passes**

Run the same command as Step 2. Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/calendar/repositories/calendar-sources-repository.ts apps/desktop/src/main/calendar/repositories/calendar-sources-repository.test.ts
git commit -m "feat(calendar): add findCalendarBindingByRemoteEvent helper"
```

---

## Task 2: Route bound-remote updates through `applyGoogleCalendarWriteback`

**Files:**
- Modify: `apps/desktop/src/main/calendar/google/sync-service.ts` (inbound loop, lines 544-553)
- Test: `apps/desktop/src/main/calendar/google/sync-service.test.ts` (add new `describe` block)

- [ ] **Step 1: Write the failing test**

Add to `sync-service.test.ts` inside the existing `describe('google calendar sync service', ...)`:

```typescript
it('routes Google updates for bound events through applyGoogleCalendarWriteback instead of the mirror', async () => {
  // #given a selected non-managed source with an active binding for one remote event
  const now = '2026-04-18T09:00:00.000Z'
  db.insert(calendarSources)
    .values({
      id: 'google-calendar:selected',
      provider: 'google',
      kind: 'calendar',
      accountId: 'google-account:1',
      remoteId: 'remote-selected-calendar',
      title: 'Personal',
      timezone: 'UTC',
      color: null,
      isPrimary: false,
      isSelected: true,
      isMemryManaged: false,
      syncCursor: 'cursor-1',
      syncStatus: 'ok',
      metadata: null,
      clock: { 'device-a': 1 },
      createdAt: now,
      modifiedAt: now
    })
    .run()

  db.insert(calendarEvents)
    .values({
      id: 'event-bound-1',
      title: 'Old title',
      description: null,
      location: null,
      startAt: '2026-04-20T09:00:00.000Z',
      endAt: '2026-04-20T10:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false,
      clock: { 'device-a': 1 },
      createdAt: now,
      modifiedAt: now
    })
    .run()

  db.insert(calendarBindings)
    .values({
      id: 'binding-bound-1',
      sourceType: 'event',
      sourceId: 'event-bound-1',
      provider: 'google',
      remoteCalendarId: 'remote-selected-calendar',
      remoteEventId: 'remote-event-bound-1',
      ownershipMode: 'memry_managed',
      writebackMode: 'broad',
      remoteVersion: '"etag-old"',
      lastLocalSnapshot: null,
      archivedAt: null,
      clock: { 'device-a': 1 },
      syncedAt: now,
      createdAt: now,
      modifiedAt: now
    })
    .run()

  const client = {
    listEvents: vi.fn(async () => ({
      nextSyncCursor: 'cursor-2',
      events: [
        {
          id: 'remote-event-bound-1',
          calendarId: 'remote-selected-calendar',
          title: 'Updated from Google',
          description: 'Updated description',
          location: 'Updated location',
          startAt: '2026-04-20T11:00:00.000Z',
          endAt: '2026-04-20T12:00:00.000Z',
          isAllDay: false,
          timezone: 'UTC',
          status: 'confirmed' as const,
          etag: '"etag-new"',
          updatedAt: '2026-04-18T08:00:00.000Z',
          raw: {}
        }
      ]
    }))
  }

  // #when
  await syncGoogleCalendarSource(db, 'google-calendar:selected', { client })

  // #then: the native row was updated, the mirror was NOT, the binding etag refreshed
  const updatedEvent = db
    .select()
    .from(calendarEvents)
    .where(eq(calendarEvents.id, 'event-bound-1'))
    .get()
  expect(updatedEvent).toMatchObject({
    title: 'Updated from Google',
    description: 'Updated description',
    location: 'Updated location',
    startAt: '2026-04-20T11:00:00.000Z',
    endAt: '2026-04-20T12:00:00.000Z'
  })

  const mirrorRows = db.select().from(calendarExternalEvents).all()
  expect(mirrorRows).toHaveLength(0)

  const refreshedBinding = db
    .select()
    .from(calendarBindings)
    .where(eq(calendarBindings.id, 'binding-bound-1'))
    .get()
  expect(refreshedBinding?.remoteVersion).toBe('"etag-new"')
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/google/sync-service.test.ts -t "routes Google updates for bound events"
```

Expected: FAIL — `updatedEvent.title` still equals `'Old title'` because the current loop writes to the mirror instead of the native event.

- [ ] **Step 3: Rewrite the inbound loop**

In `apps/desktop/src/main/calendar/google/sync-service.ts`, replace the block starting at line 544 (`for (const remoteEvent of result.events) { ... }`) with:

```typescript
for (const remoteEvent of result.events) {
  const binding = findCalendarBindingByRemoteEvent(
    db,
    'google',
    remoteEvent.calendarId,
    remoteEvent.id
  )

  if (binding) {
    await applyGoogleCalendarWriteback(db, binding, remoteEvent)
    continue
  }

  const record = mapGoogleEventToExternalEventRecord(source.id, remoteEvent, now)
  const existing = getCalendarExternalEventById(db, record.id)
  upsertCalendarExternalEvent(db, {
    ...record,
    clock: existing?.clock
  })
  markSyncedTableMutation('calendar_external_event', record.id, Boolean(existing))
  emitCalendarChanged({ entityType: 'calendar_external_event', id: record.id })
}
```

Add the import at the top of the file (merge with the existing repository import):

```typescript
import {
  findCalendarBindingByRemoteEvent,
  getCalendarSourceById,
  listCalendarBindingsForSource,
  listCalendarSources,
  upsertCalendarBinding,
  upsertCalendarSource
} from '../repositories/calendar-sources-repository'
```

- [ ] **Step 4: Run the test and confirm it passes**

Run:
```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/google/sync-service.test.ts -t "routes Google updates for bound events"
```

Expected: PASS.

- [ ] **Step 5: Run the full sync-service test file to confirm no regressions**

Run:
```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/google/sync-service.test.ts
```

Expected: all existing tests still green. If a prior test breaks (for example, one that seeded a binding but expected a mirror write), update the fixture so it does not seed a binding for that case — the old behaviour was incorrect.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/calendar/google/sync-service.ts apps/desktop/src/main/calendar/google/sync-service.test.ts
git commit -m "fix(calendar): route bound Google updates through applyGoogleCalendarWriteback"
```

---

## Task 3: Propagate Google deletes through `applyGoogleCalendarDelete`

**Files:**
- Modify: `apps/desktop/src/main/calendar/google/sync-service.ts` (inbound loop, inside `if (binding)` branch)
- Test: `apps/desktop/src/main/calendar/google/sync-service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `sync-service.test.ts`:

```typescript
it('deletes the native record when a bound Google event is cancelled', async () => {
  // #given a selected source, a native calendar_events row, and a binding
  const now = '2026-04-18T09:00:00.000Z'
  db.insert(calendarSources)
    .values({
      id: 'google-calendar:selected',
      provider: 'google',
      kind: 'calendar',
      accountId: 'google-account:1',
      remoteId: 'remote-selected-calendar',
      title: 'Personal',
      timezone: 'UTC',
      color: null,
      isPrimary: false,
      isSelected: true,
      isMemryManaged: false,
      syncCursor: 'cursor-1',
      syncStatus: 'ok',
      metadata: null,
      clock: { 'device-a': 1 },
      createdAt: now,
      modifiedAt: now
    })
    .run()

  db.insert(calendarEvents)
    .values({
      id: 'event-bound-delete',
      title: 'About to be deleted',
      startAt: '2026-04-20T09:00:00.000Z',
      endAt: '2026-04-20T10:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false,
      clock: { 'device-a': 1 },
      createdAt: now,
      modifiedAt: now
    })
    .run()

  db.insert(calendarBindings)
    .values({
      id: 'binding-bound-delete',
      sourceType: 'event',
      sourceId: 'event-bound-delete',
      provider: 'google',
      remoteCalendarId: 'remote-selected-calendar',
      remoteEventId: 'remote-event-bound-delete',
      ownershipMode: 'memry_managed',
      writebackMode: 'broad',
      remoteVersion: '"etag-old"',
      lastLocalSnapshot: null,
      archivedAt: null,
      clock: { 'device-a': 1 },
      syncedAt: now,
      createdAt: now,
      modifiedAt: now
    })
    .run()

  const client = {
    listEvents: vi.fn(async () => ({
      nextSyncCursor: 'cursor-2',
      events: [
        {
          id: 'remote-event-bound-delete',
          calendarId: 'remote-selected-calendar',
          title: 'About to be deleted',
          description: null,
          location: null,
          startAt: '2026-04-20T09:00:00.000Z',
          endAt: '2026-04-20T10:00:00.000Z',
          isAllDay: false,
          timezone: 'UTC',
          status: 'cancelled' as const,
          etag: '"etag-cancelled"',
          updatedAt: '2026-04-18T08:30:00.000Z',
          raw: {}
        }
      ]
    }))
  }

  // #when
  await syncGoogleCalendarSource(db, 'google-calendar:selected', { client })

  // #then: native row gone, binding archived, mirror untouched
  const survivingEvent = db
    .select()
    .from(calendarEvents)
    .where(eq(calendarEvents.id, 'event-bound-delete'))
    .get()
  expect(survivingEvent).toBeUndefined()

  const archivedBinding = db
    .select()
    .from(calendarBindings)
    .where(eq(calendarBindings.id, 'binding-bound-delete'))
    .get()
  expect(archivedBinding?.archivedAt).toBeTruthy()

  const mirrorRows = db.select().from(calendarExternalEvents).all()
  expect(mirrorRows).toHaveLength(0)
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/google/sync-service.test.ts -t "deletes the native record when a bound Google event is cancelled"
```

Expected: FAIL — `survivingEvent` is still the row because `applyGoogleCalendarWriteback` is called instead of `applyGoogleCalendarDelete`.

- [ ] **Step 3: Branch on `status === 'cancelled'` inside the bound path**

In `sync-service.ts`, update the `if (binding)` branch added in Task 2 so it reads:

```typescript
if (binding) {
  if (remoteEvent.status === 'cancelled') {
    await applyGoogleCalendarDelete(db, binding)
  } else {
    await applyGoogleCalendarWriteback(db, binding, remoteEvent)
  }
  continue
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run the same command as Step 2. Expected: PASS.

- [ ] **Step 5: Re-run the full sync-service suite**

Run:
```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/google/sync-service.test.ts
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/calendar/google/sync-service.ts apps/desktop/src/main/calendar/google/sync-service.test.ts
git commit -m "fix(calendar): propagate Google cancellations through applyGoogleCalendarDelete"
```

---

## Task 4: Archive the mirror row for unbound cancelled events

**Files:**
- Modify: `apps/desktop/src/main/calendar/google/sync-service.ts` (unbound branch)
- Test: `apps/desktop/src/main/calendar/google/sync-service.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
it('archives the mirror row when an unbound Google event is cancelled', async () => {
  // #given a selected source with an existing mirror row and no binding
  const now = '2026-04-18T09:00:00.000Z'
  db.insert(calendarSources)
    .values({
      id: 'google-calendar:selected',
      provider: 'google',
      kind: 'calendar',
      accountId: 'google-account:1',
      remoteId: 'remote-selected-calendar',
      title: 'Personal',
      timezone: 'UTC',
      color: null,
      isPrimary: false,
      isSelected: true,
      isMemryManaged: false,
      syncCursor: 'cursor-1',
      syncStatus: 'ok',
      metadata: null,
      clock: { 'device-a': 1 },
      createdAt: now,
      modifiedAt: now
    })
    .run()

  db.insert(calendarExternalEvents)
    .values({
      id: 'calendar_external_event:google-calendar:selected:remote-unbound-1',
      sourceId: 'google-calendar:selected',
      remoteEventId: 'remote-unbound-1',
      remoteEtag: '"etag-old"',
      remoteUpdatedAt: '2026-04-18T07:00:00.000Z',
      title: 'External event',
      description: null,
      location: null,
      startAt: '2026-04-20T09:00:00.000Z',
      endAt: '2026-04-20T10:00:00.000Z',
      timezone: 'UTC',
      isAllDay: false,
      status: 'confirmed',
      recurrenceRule: null,
      rawPayload: {},
      archivedAt: null,
      clock: { 'device-a': 1 },
      createdAt: now,
      modifiedAt: now
    })
    .run()

  const client = {
    listEvents: vi.fn(async () => ({
      nextSyncCursor: 'cursor-2',
      events: [
        {
          id: 'remote-unbound-1',
          calendarId: 'remote-selected-calendar',
          title: 'External event',
          description: null,
          location: null,
          startAt: '2026-04-20T09:00:00.000Z',
          endAt: '2026-04-20T10:00:00.000Z',
          isAllDay: false,
          timezone: 'UTC',
          status: 'cancelled' as const,
          etag: '"etag-cancelled"',
          updatedAt: '2026-04-18T08:45:00.000Z',
          raw: {}
        }
      ]
    }))
  }

  // #when
  await syncGoogleCalendarSource(db, 'google-calendar:selected', { client })

  // #then: the mirror row is archived (archivedAt set), not deleted
  const mirrorRow = db
    .select()
    .from(calendarExternalEvents)
    .where(eq(calendarExternalEvents.id, 'calendar_external_event:google-calendar:selected:remote-unbound-1'))
    .get()
  expect(mirrorRow?.archivedAt).toBeTruthy()
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/google/sync-service.test.ts -t "archives the mirror row when an unbound Google event is cancelled"
```

Expected: FAIL — `archivedAt` is still `null` because the current unbound path re-upserts without archiving.

- [ ] **Step 3: Branch on `status === 'cancelled'` in the unbound path**

Update the unbound section of the loop (the code that runs after `if (binding) { ... continue }`):

```typescript
const record = mapGoogleEventToExternalEventRecord(source.id, remoteEvent, now)
const existing = getCalendarExternalEventById(db, record.id)

if (remoteEvent.status === 'cancelled') {
  if (!existing) continue
  upsertCalendarExternalEvent(db, {
    ...record,
    clock: existing.clock,
    archivedAt: now
  })
  markSyncedTableMutation('calendar_external_event', record.id, true)
  emitCalendarChanged({ entityType: 'calendar_external_event', id: record.id })
  continue
}

upsertCalendarExternalEvent(db, {
  ...record,
  clock: existing?.clock
})
markSyncedTableMutation('calendar_external_event', record.id, Boolean(existing))
emitCalendarChanged({ entityType: 'calendar_external_event', id: record.id })
```

If `mapGoogleEventToExternalEventRecord` does not currently pass `archivedAt` through to `upsertCalendarExternalEvent`, verify the repository accepts it. If it does not, extend the repository's `NewCalendarExternalEvent` type to include `archivedAt?: string | null` (the schema column already exists). This is the only possible ripple — inspect [calendar-external-events-repository.ts](../../../apps/desktop/src/main/calendar/repositories/calendar-external-events-repository.ts) before assuming the signature.

- [ ] **Step 4: Run the test and confirm it passes**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Re-run the full sync-service suite**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/google/sync-service.test.ts
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/calendar/google/sync-service.ts apps/desktop/src/main/calendar/google/sync-service.test.ts apps/desktop/src/main/calendar/repositories/calendar-external-events-repository.ts
git commit -m "fix(calendar): archive mirror row when unbound Google event is cancelled"
```

---

## Task 5: Defensive 410 Gone handling around `client.listEvents`

**Files:**
- Modify: `apps/desktop/src/main/calendar/google/sync-service.ts` (wrap the `listEvents` call)
- Test: `apps/desktop/src/main/calendar/google/sync-service.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
it('recovers from a 410 Gone by clearing syncCursor and re-syncing', async () => {
  // #given a selected source with a stale syncCursor
  const now = '2026-04-18T09:00:00.000Z'
  db.insert(calendarSources)
    .values({
      id: 'google-calendar:selected',
      provider: 'google',
      kind: 'calendar',
      accountId: 'google-account:1',
      remoteId: 'remote-selected-calendar',
      title: 'Personal',
      timezone: 'UTC',
      color: null,
      isPrimary: false,
      isSelected: true,
      isMemryManaged: false,
      syncCursor: 'stale-cursor',
      syncStatus: 'ok',
      metadata: null,
      clock: { 'device-a': 1 },
      createdAt: now,
      modifiedAt: now
    })
    .run()

  const goneError = Object.assign(new Error('Gone'), { status: 410 })
  const listEvents = vi
    .fn()
    .mockRejectedValueOnce(goneError)
    .mockResolvedValueOnce({
      nextSyncCursor: 'cursor-fresh',
      events: []
    })

  const client = { listEvents }

  // #when
  await syncGoogleCalendarSource(db, 'google-calendar:selected', { client })

  // #then: listEvents was called twice — once with the stale cursor, once with null
  expect(listEvents).toHaveBeenCalledTimes(2)
  expect(listEvents.mock.calls[0]?.[0]).toMatchObject({ syncCursor: 'stale-cursor' })
  expect(listEvents.mock.calls[1]?.[0]).toMatchObject({ syncCursor: null })

  const refreshedSource = db
    .select()
    .from(calendarSources)
    .where(eq(calendarSources.id, 'google-calendar:selected'))
    .get()
  expect(refreshedSource?.syncCursor).toBe('cursor-fresh')
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run:
```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar/google/sync-service.test.ts -t "recovers from a 410 Gone"
```

Expected: FAIL — the rejected Gone error propagates up and `syncCursor` is never reset.

- [ ] **Step 3: Wrap `listEvents` with a 410 catch**

In `sync-service.ts`, replace the current `const result = await client.listEvents({ ... })` call inside `syncGoogleCalendarSource` with:

```typescript
let result: Awaited<ReturnType<GoogleCalendarClient['listEvents']>>
try {
  result = await client.listEvents({
    calendarId: source.remoteId,
    syncCursor: source.syncCursor ?? null,
    timeMin: isInitialSync ? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() : null,
    timeMax: isInitialSync ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() : null
  })
} catch (error) {
  if (isGoneError(error) && source.syncCursor) {
    log.warn('Google returned 410 for source; clearing cursor and re-syncing', { sourceId })
    const freshSource = upsertCalendarSource(db, {
      ...source,
      syncCursor: null,
      syncStatus: 'pending',
      modifiedAt: now
    })
    markSyncedTableMutation('calendar_source', freshSource.id, true)
    return await syncGoogleCalendarSource(db, sourceId, deps)
  }
  throw error
}
```

Add a small helper near the top of the file:

```typescript
function isGoneError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status: unknown }).status === 410
  )
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Same command as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/calendar/google/sync-service.ts apps/desktop/src/main/calendar/google/sync-service.test.ts
git commit -m "fix(calendar): clear syncCursor and retry on Google 410 Gone"
```

---

## Task 6: Full verification + PR

- [ ] **Step 1: Run the entire calendar test area**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts src/main/calendar
```

Expected: all green. If a failure surfaces in another calendar test, read the failure, fix root cause (do not weaken the new tests).

- [ ] **Step 2: Run typecheck**

```bash
pnpm typecheck:node && pnpm typecheck:web
```

Expected: clean. Known pre-existing errors in `websocket.test.ts`, `folders.test.ts`, and `sync-telemetry.ts` are not ours to fix — ignore if they match the memory entry "pre-existing type errors in test files".

- [ ] **Step 3: Run lint**

```bash
pnpm lint
```

Expected: clean.

- [ ] **Step 4: Run the full desktop Vitest suite one last time**

```bash
pnpm --filter @memry/desktop exec vitest run
```

Expected: green. If any unrelated flake surfaces, rerun once; if repeatable, stop and investigate before opening the PR.

- [ ] **Step 5: Push the branch and open the PR**

```bash
git push -u origin HEAD
gh pr create --title "fix(calendar): M1 — propagate Google pull-side updates and deletes" --body "$(cat <<'EOF'
## Summary

Milestone 1 of Google Calendar Phase 2. Fixes three correctness bugs in the Google pull loop so Google-side updates, deletions, and cursor-invalidation reach bound Memry records.

- Route bound-remote updates through \`applyGoogleCalendarWriteback\` (was never called)
- Propagate Google cancellations through \`applyGoogleCalendarDelete\` (was dropped)
- Archive the mirror row when an unbound Google event is cancelled (was re-upserted as confirmed)
- Add defensive 410 Gone handling that clears \`syncCursor\` and retries once

No schema changes, no new IPC surface, no renderer changes.

Design: \`docs/superpowers/specs/2026-04-18-google-calendar-phase-2-design.md\`
Plan: \`docs/superpowers/plans/2026-04-18-google-calendar-phase-2-m1-correctness.md\`

## Test plan

- [x] Unit: \`findCalendarBindingByRemoteEvent\` returns the active binding and skips archived ones
- [x] Integration: bound Google update writes through to native \`calendar_events\` row, mirror stays empty
- [x] Integration: bound Google cancellation deletes the native row and archives the binding
- [x] Integration: unbound Google cancellation archives the existing mirror row
- [x] Integration: 410 Gone on \`listEvents\` clears \`syncCursor\` and retries with \`null\`
- [x] Full \`pnpm --filter @memry/desktop exec vitest run\` green
- [x] \`pnpm typecheck:node\` and \`pnpm typecheck:web\` clean
- [x] \`pnpm lint\` clean
EOF
)"
```

- [ ] **Step 6: Return the PR URL**

Paste the PR URL into the conversation for the reviewer.

---

## Self-review checklist (run before handing off)

- [ ] All four new bugs have at least one test each (G1 update path, G2 delete path, G2 unbound cancel path, 410 path).
- [ ] No step uses "TBD", "implement later", or "handle edge cases" language.
- [ ] Every code block references the actual type names in the codebase: `calendarEvents`, `calendarBindings`, `calendarExternalEvents`, `calendarSources`, `GoogleCalendarClient`, `applyGoogleCalendarWriteback`, `applyGoogleCalendarDelete`.
- [ ] Function names match across tasks: `findCalendarBindingByRemoteEvent` appears consistently.
- [ ] Commands are copy-pasteable with the exact pnpm/vitest invocation the repo already uses.
