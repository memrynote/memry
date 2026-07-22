# Canvas Event Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every non-archived calendar event reachable from the canvas "Add card" picker by replacing its ±90-day `calendar:get-range` fetch with a query-driven `calendar:search-events` IPC channel.

**Architecture:** A new additive IPC channel takes `{ query, limit }` and returns lean event summaries. The SQL lives in the calendar events repository as two bounded queries (upcoming ASC, past DESC) merged by distance from now, so the picker gets the most relevant hits in both time directions without an arbitrary window. The renderer's two async sources collapse into one debounced effect.

**Tech Stack:** TypeScript, Electron IPC via `packages/contracts` + `packages/rpc`, Drizzle ORM over better-sqlite3, Zod v4, React 19, Vitest, cmdk.

**Spec:** `docs/superpowers/specs/2026-07-22-canvas-event-search-design.md`

## Global Constraints

- Issue: #869. Epic #878. Follow-up to PR #868.
- **Additive contract only.** Do not change the shape of any existing channel, schema, or response type. `calendar:list-events` and `calendar:get-range` keep working exactly as they do today — the Calendar page depends on `get-range`.
- Run `pnpm ipc:generate` **before** `pnpm ipc:check` after any edit to `packages/contracts`, `packages/rpc`, preload, or main IPC handlers. `generated-ipc-invoke-map.ts` and `generated-rpc.ts` are generated — never hand-edit them.
- Search matches **title only**. Not description, not location.
- Archived events (`archived_at IS NOT NULL`) are always excluded.
- Zod v4 gotcha: `z.record(z.unknown())` throws in `safeParse` — use `z.record(z.string(), z.unknown())`. Not needed here, but do not reach for bare `z.record`.
- **Logging:** `createLogger('SpatialCanvas')`, never raw `console.*`.
- **Tailwind logical properties:** no `ml-*`/`mr-*`/`left-*`/`right-*`/`text-left`/`text-right` in new markup. No new markup is expected in this plan.
- Test comment convention in this codebase: `// #given`, `// #when`, `// #then`.
- Commit messages: no `Co-Authored-By` trailer.

---

## File Structure

**Create:** nothing. Every change lands in an existing file.

**Modify:**

| File                                                                        | Responsibility after this change                                                                     |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/calendar-api.ts`                                    | Adds `SearchCalendarEventsSchema`, `CalendarEventSearchItem`, `CalendarEventSearchResponse`          |
| `packages/contracts/src/ipc-channels.ts`                                    | Adds `SEARCH_EVENTS` to `CalendarChannels.invoke`                                                    |
| `packages/rpc/src/calendar.ts`                                              | Adds the `searchEvents` method to the calendar domain                                                |
| `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts`                     | **Generated** — `pnpm ipc:generate` writes it                                                        |
| `apps/desktop/src/preload/generated-rpc.ts`                                 | **Generated** — `pnpm ipc:generate` writes it                                                        |
| `apps/desktop/src/main/calendar/repositories/calendar-events-repository.ts` | Adds `searchCalendarEventsByTitle` — the only place this SQL lives                                   |
| `apps/desktop/src/main/ipc/calendar-handlers.ts`                            | Registers/unregisters the channel; maps rows to the lean shape                                       |
| `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.ts`             | `candidatesFromEvents` replaces `candidatesFromProjections`; `eventRange`/`EVENT_RANGE_DAYS` deleted |
| `apps/desktop/src/renderer/src/pages/canvas/use-canvas-add-search.ts`       | One debounced effect driving both sources                                                            |
| `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card-dialog.tsx`     | Consumes `events` instead of `projections`                                                           |
| `apps/docs/src/user-guide/canvas/sync-and-limits.md`                        | Drops the 90-day limitation bullet                                                                   |

**Modify (tests):** `calendar-events-repository.test.ts`, `calendar-handlers.test.ts`, `canvas-add-card.test.ts`, `use-canvas-add-search.test.ts`, `canvas-add-card-dialog.test.tsx`.

**Not touched:** `apps/desktop/tests/e2e/canvas-cards.e2e.ts` — it exercises the note and task paths only (`canvas-add-item-task:` selectors), never events. `apps/docs/src/user-guide/canvas/cards-and-links.md` describes the picker without mentioning a window.

---

### Task 1: Contract + RPC method

**Files:**

- Modify: `packages/contracts/src/calendar-api.ts` (schema block near `ListCalendarEventsSchema:74`, types near `ListCalendarEventsInput:120`, response interfaces near `CalendarEventListResponse:315`)
- Modify: `packages/contracts/src/ipc-channels.ts:621` (`CalendarChannels.invoke`)
- Modify: `packages/rpc/src/calendar.ts` (imports, input type, re-export block, `methods`)
- Generated: `apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts`, `apps/desktop/src/preload/generated-rpc.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `SearchCalendarEventsSchema`, `SearchCalendarEventsInput`, `CalendarEventSearchItem { id: string; title: string; startAt: string; endAt: string | null; isAllDay: boolean }`, `CalendarEventSearchResponse { events: CalendarEventSearchItem[] }`, channel constant `CalendarChannels.invoke.SEARCH_EVENTS`, and the renderer-side call `calendarService.searchEvents(input)`.

There is no meaningful unit test for a type declaration; `pnpm ipc:check` is this task's failing-then-passing gate. Run it _before_ generating to see it fail.

- [x] **Step 1: Add the schema to `packages/contracts/src/calendar-api.ts`**

Directly below `ListCalendarEventsSchema` (line 74-76):

```ts
/** #869: query-driven event lookup for pickers that must reach every event. */
export const SearchCalendarEventsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(20)
})
```

- [x] **Step 2: Add the inferred input type**

In the `export type` block, below `export type ListCalendarEventsInput = z.infer<typeof ListCalendarEventsSchema>` (line 120):

```ts
export type SearchCalendarEventsInput = z.infer<typeof SearchCalendarEventsSchema>
```

- [x] **Step 3: Add the response interfaces**

Directly below `CalendarEventListResponse` (line 315-317):

```ts
/**
 * Lean event summary for pickers: exactly the fields a card candidate needs.
 * Deliberately not CalendarEventRecord — attendees, reminders, conferenceData
 * and clocks are dead weight over IPC for a search result.
 */
export interface CalendarEventSearchItem {
  id: string
  title: string
  startAt: string
  endAt: string | null
  isAllDay: boolean
}

export interface CalendarEventSearchResponse {
  events: CalendarEventSearchItem[]
}
```

- [x] **Step 4: Add the channel constant**

In `packages/contracts/src/ipc-channels.ts`, inside `CalendarChannels.invoke`, directly after `LIST_EVENTS` (line 621):

```ts
    /** #869: title search across every event, for the canvas Add-card picker */
    SEARCH_EVENTS: 'calendar:search-events',
```

- [x] **Step 5: Add the RPC method in `packages/rpc/src/calendar.ts`**

Add `SearchCalendarEventsSchema` to the schema import list (alphabetically after `RetryCalendarSourceSyncSchema`), and `type CalendarEventSearchResponse` to the type import list (after `type CalendarEventRecord`).

Add the input type beside the others (below line 43):

```ts
export type SearchCalendarEventsInput = z.input<typeof SearchCalendarEventsSchema>
```

`z.input` — not `z.infer` — matches this file's convention and keeps `limit` optional for callers while the handler still receives the defaulted value.

Add `CalendarEventSearchResponse` to the `export type { … }` re-export block (after `CalendarEventRecord`).

Add the method inside `methods`, directly after `listEvents` (line 96-102):

```ts
    searchEvents: defineMethod<
      (input: SearchCalendarEventsInput) => Promise<CalendarEventSearchResponse>
    >({
      channel: CalendarChannels.invoke.SEARCH_EVENTS,
      params: ['input']
    }),
```

- [x] **Step 6: Verify `ipc:check` now fails**

Run: `pnpm ipc:check`
Expected: FAIL — the generated invoke map has no entry for `calendar:search-events`. Record the exact message; it confirms the gate is live rather than vacuously green. It does not fail any earlier than this: the generator derives its output from the RPC domain methods and `ipcMain.handle` call sites, not from the raw contracts additions in Steps 3-4, so the gate cannot move until the RPC method above exists.

- [x] **Step 7: Regenerate and verify**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: PASS. `git diff --stat` should show only `generated-rpc.ts` gaining a `calendar:search-events` line:
`"searchEvents": ((input) => invoke("calendar:search-events", input)) as GeneratedRpcApi["calendar"]["searchEvents"],`

`generated-ipc-invoke-map.ts` stays unchanged here — it reflects registered `ipcMain.handle` call sites, not RPC methods, so it doesn't gain a `calendar:search-events` line until Task 3 registers the handler.

- [x] **Step 8: Commit**

```bash
git add packages/contracts/src/calendar-api.ts packages/contracts/src/ipc-channels.ts packages/rpc/src/calendar.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts apps/desktop/src/preload/generated-rpc.ts
git commit -m "feat(contracts): add calendar:search-events channel (#869)"
```

---

### Task 2: Repository query

**Files:**

- Modify: `apps/desktop/src/main/calendar/repositories/calendar-events-repository.ts`
- Test: `apps/desktop/src/main/calendar/repositories/calendar-events-repository.test.ts`

**Interfaces:**

- Consumes: nothing from Task 1 (repository returns raw Drizzle rows, not contract types).
- Produces: `searchCalendarEventsByTitle(db: DataDb, options: { query: string; limit: number; now: string }): CalendarEvent[]` — rows ordered nearest-to-now first.

- [x] **Step 1: Write the failing tests**

Append to `calendar-events-repository.test.ts`. The file already imports `createTestDataDb`, `TestDatabaseResult`, `TestDb` and `DataDb`; add `searchCalendarEventsByTitle` to the existing import from `./calendar-events-repository`.

```ts
describe('searchCalendarEventsByTitle (#869)', () => {
  let dbResult: TestDatabaseResult
  let dataDb: DataDb

  const NOW = '2026-07-22T12:00:00.000Z'

  function seed(id: string, title: string, startAt: string, archivedAt: string | null = null) {
    upsertCalendarEvent(dataDb, {
      id,
      title,
      startAt,
      timezone: 'UTC',
      isAllDay: false,
      archivedAt,
      clock: { 'device-a': 1 },
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z'
    })
  }

  beforeEach(() => {
    dbResult = createTestDataDb()
    dataDb = dbResult.db as unknown as DataDb
  })

  afterEach(() => {
    dbResult.close()
  })

  it('finds events far outside the old ±90-day window', () => {
    // #given — one event three years back and one three years ahead
    seed('old', 'Standup', '2023-07-22T09:00:00.000Z')
    seed('future', 'Standup', '2029-07-22T09:00:00.000Z')

    // #when — we search by title
    const found = searchCalendarEventsByTitle(dataDb, { query: 'standup', limit: 20, now: NOW })

    // #then — both are reachable; the window is gone
    expect(found.map((row) => row.id).sort()).toEqual(['future', 'old'])
  })

  it('matches a case-insensitive title substring', () => {
    // #given — a mixed-case title
    seed('e1', 'Quarterly Planning', '2026-07-23T09:00:00.000Z')

    // #when / #then — either casing finds it, a non-substring does not
    expect(
      searchCalendarEventsByTitle(dataDb, { query: 'PLANNING', limit: 20, now: NOW })
    ).toHaveLength(1)
    expect(
      searchCalendarEventsByTitle(dataDb, { query: 'retro', limit: 20, now: NOW })
    ).toHaveLength(0)
  })

  it('excludes archived events', () => {
    // #given — one live and one archived event with the same title
    seed('live', 'Standup', '2026-07-23T09:00:00.000Z')
    seed('gone', 'Standup', '2026-07-24T09:00:00.000Z', '2026-07-01T00:00:00.000Z')

    // #when — we search
    const found = searchCalendarEventsByTitle(dataDb, { query: 'standup', limit: 20, now: NOW })

    // #then — only the live one comes back
    expect(found.map((row) => row.id)).toEqual(['live'])
  })

  it('orders by distance from now, mixing past and future', () => {
    // #given — a near past event, a near future event, and a distant future one
    seed('far-future', 'Standup', '2026-09-22T09:00:00.000Z')
    seed('near-past', 'Standup', '2026-07-21T12:00:00.000Z')
    seed('near-future', 'Standup', '2026-07-22T18:00:00.000Z')

    // #when — we search
    const found = searchCalendarEventsByTitle(dataDb, { query: 'standup', limit: 20, now: NOW })

    // #then — nearest-to-now first, regardless of direction
    expect(found.map((row) => row.id)).toEqual(['near-future', 'near-past', 'far-future'])
  })

  it('respects the limit across both directions', () => {
    // #given — six matching events, three each side of now, no tied distances
    seed('p1', 'Standup', '2026-07-21T18:00:00.000Z')
    seed('p2', 'Standup', '2026-07-20T12:00:00.000Z')
    seed('p3', 'Standup', '2026-07-19T12:00:00.000Z')
    seed('f1', 'Standup', '2026-07-23T12:00:00.000Z')
    seed('f2', 'Standup', '2026-07-24T12:00:00.000Z')
    seed('f3', 'Standup', '2026-07-25T12:00:00.000Z')

    // #when — we ask for two
    const found = searchCalendarEventsByTitle(dataDb, { query: 'standup', limit: 2, now: NOW })

    // #then — exactly the two closest to now
    expect(found.map((row) => row.id)).toEqual(['p1', 'f1'])
  })

  it('returns nothing for a blank query instead of everything', () => {
    // #given — an event that any unfiltered query would return
    seed('e1', 'Standup', '2026-07-23T09:00:00.000Z')

    // #when / #then — a whitespace query is treated as no query
    expect(searchCalendarEventsByTitle(dataDb, { query: '   ', limit: 20, now: NOW })).toEqual([])
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:main -- calendar-events-repository`
Expected: FAIL — `searchCalendarEventsByTitle is not a function` / import error.

If instead it fails with `ERR_DLOPEN_FAILED`, that is a NODE_MODULE_VERSION mismatch, not your code: run `pnpm --filter @memry/desktop rebuild:node` and re-run.

- [x] **Step 3: Implement the query**

In `calendar-events-repository.ts`, widen the drizzle import on line 1 and append the function:

```ts
import { and, asc, desc, eq, isNull, like, sql } from 'drizzle-orm'
```

```ts
/**
 * Title search across every non-archived event, nearest to `now` first (#869).
 *
 * Two bounded queries rather than `ORDER BY abs(julianday(...))`: both sides
 * use the start_at index and neither depends on SQLite parsing all-day rows.
 * SQLite's LIKE is case-insensitive for ASCII, which is what the picker's old
 * client-side `toLowerCase().includes()` filter did.
 */
export function searchCalendarEventsByTitle(
  db: DataDb,
  options: { query: string; limit: number; now: string }
): CalendarEvent[] {
  const needle = options.query.trim()
  if (!needle) {
    return []
  }

  const matches = and(isNull(calendarEvents.archivedAt), like(calendarEvents.title, `%${needle}%`))

  const upcoming = db
    .select()
    .from(calendarEvents)
    .where(and(matches, sql`${calendarEvents.startAt} >= ${options.now}`))
    .orderBy(asc(calendarEvents.startAt))
    .limit(options.limit)
    .all()

  const past = db
    .select()
    .from(calendarEvents)
    .where(and(matches, sql`${calendarEvents.startAt} < ${options.now}`))
    .orderBy(desc(calendarEvents.startAt))
    .limit(options.limit)
    .all()

  const nowMs = Date.parse(options.now)
  const distance = (startAt: string): number => {
    const parsed = Date.parse(startAt)
    return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : Math.abs(parsed - nowMs)
  }

  return [...upcoming, ...past]
    .sort((a, b) => distance(a.startAt) - distance(b.startAt))
    .slice(0, options.limit)
}
```

`%` and `_` in the query are passed through unescaped, matching the precedent at `apps/desktop/src/main/inbox/queries.ts:254`. For a picker the effect is a surprising match, never an error.

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:main -- calendar-events-repository`
Expected: PASS, all six new tests green plus the pre-existing suite.

- [x] **Step 5: Commit**

```bash
git add apps/desktop/src/main/calendar/repositories/calendar-events-repository.ts apps/desktop/src/main/calendar/repositories/calendar-events-repository.test.ts
git commit -m "feat(calendar): add title search over calendar events (#869)"
```

---

### Task 3: IPC handler

**Files:**

- Modify: `apps/desktop/src/main/ipc/calendar-handlers.ts` (imports 1-42, handler after `LIST_EVENTS:492-506`, teardown at 868-885)
- Test: `apps/desktop/src/main/ipc/calendar-handlers.test.ts`

**Interfaces:**

- Consumes: `SearchCalendarEventsSchema`, `CalendarEventSearchItem`, `CalendarEventSearchResponse`, `CalendarChannels.invoke.SEARCH_EVENTS` (Task 1); `searchCalendarEventsByTitle` (Task 2).
- Produces: a registered `calendar:search-events` handler returning `{ events: CalendarEventSearchItem[] }`.

- [x] **Step 1: Write the failing tests**

Append inside the existing `describe('calendar-handlers', …)` block in `calendar-handlers.test.ts`:

```ts
it('searches events by title, ignoring archived ones, in a lean shape (#869)', async () => {
  // #given — two events created through the real handler, one later archived
  registerCalendarHandlers()
  await invokeHandler(CalendarChannels.invoke.CREATE_EVENT, {
    title: 'Quarterly planning',
    description: 'Align roadmap',
    location: 'Studio',
    startAt: '2026-04-12T09:00:00.000Z',
    endAt: '2026-04-12T10:00:00.000Z',
    timezone: 'UTC',
    isAllDay: false
  })

  // #when — we search for a title substring
  const found = await invokeHandler(CalendarChannels.invoke.SEARCH_EVENTS, {
    query: 'quarterly'
  })

  // #then — the lean shape comes back, without the record's heavy fields
  expect(found.events).toEqual([
    {
      id: 'calendar-event-generated-id',
      title: 'Quarterly planning',
      startAt: '2026-04-12T09:00:00.000Z',
      endAt: '2026-04-12T10:00:00.000Z',
      isAllDay: false
    }
  ])
  expect(found.events[0]).not.toHaveProperty('attendees')
  expect(found.events[0]).not.toHaveProperty('description')
})

it('rejects an empty search query at the schema boundary (#869)', async () => {
  // #given — registered handlers
  registerCalendarHandlers()

  // #when / #then — an empty query never reaches the database
  await expect(invokeHandler(CalendarChannels.invoke.SEARCH_EVENTS, { query: '' })).rejects.toThrow(
    /Validation failed/
  )
})

it('returns no matches for an unrelated query (#869)', async () => {
  // #given — one event
  registerCalendarHandlers()
  await invokeHandler(CalendarChannels.invoke.CREATE_EVENT, {
    title: 'Quarterly planning',
    startAt: '2026-04-12T09:00:00.000Z',
    timezone: 'UTC',
    isAllDay: false
  })

  // #when — we search for something else
  const found = await invokeHandler(CalendarChannels.invoke.SEARCH_EVENTS, { query: 'retro' })

  // #then — an empty list, not an error
  expect(found.events).toEqual([])
})
```

The existing `registers all calendar handlers` test asserts `handleCalls.length === Object.values(CalendarChannels.invoke).length`. It will fail until the handler is registered — that is the guard against adding a channel with no handler. Do not modify it.

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:main -- calendar-handlers`
Expected: FAIL — `registers all calendar handlers` off by one, and the search tests reject with "No handler registered for calendar:search-events".

- [x] **Step 3: Implement the handler**

Add `SearchCalendarEventsSchema` to the schema import list from `@memry/contracts/calendar-api` (after `RetryCalendarSourceSyncSchema`), and `type CalendarEventSearchResponse`, `type CalendarEventSearchItem` to the type list (after `type CalendarEventRecord`).

Add the repository import beside the existing sources-repository import (line 43-47):

```ts
import { searchCalendarEventsByTitle } from '../calendar/repositories/calendar-events-repository'
```

Add the mapper next to `mapCalendarEvent` (line 93):

```ts
/** Lean picker projection — deliberately not mapCalendarEvent (#869). */
function toEventSearchItem(row: typeof calendarEvents.$inferSelect): CalendarEventSearchItem {
  return {
    id: row.id,
    title: row.title,
    startAt: row.startAt,
    endAt: row.endAt ?? null,
    isAllDay: row.isAllDay
  }
}
```

Register the handler directly after the `LIST_EVENTS` block (line 506):

```ts
ipcMain.handle(
  CalendarChannels.invoke.SEARCH_EVENTS,
  createValidatedHandler(SearchCalendarEventsSchema, (input): CalendarEventSearchResponse => {
    const rows = searchCalendarEventsByTitle(requireDatabase(), {
      query: input.query,
      limit: input.limit,
      now: new Date().toISOString()
    })
    return { events: rows.map(toEventSearchItem) }
  })
)
```

Add the teardown line in `unregisterCalendarHandlers`, after `LIST_EVENTS` (line 873):

```ts
ipcMain.removeHandler(CalendarChannels.invoke.SEARCH_EVENTS)
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:main -- calendar-handlers`
Expected: PASS, including `registers all calendar handlers`.

- [x] **Step 5: Verify the IPC contract is whole**

Run: `pnpm ipc:check && pnpm --filter @memry/desktop typecheck:node`
Expected: PASS both.

- [x] **Step 6: Commit**

```bash
git add apps/desktop/src/main/ipc/calendar-handlers.ts apps/desktop/src/main/ipc/calendar-handlers.test.ts
git commit -m "feat(calendar): handle calendar:search-events (#869)"
```

---

### Task 4: Renderer candidate mapper

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.ts`
- Test: `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.test.ts`

**Interfaces:**

- Consumes: `CalendarEventSearchItem` (Task 1).
- Produces: `candidatesFromEvents(items: readonly CalendarEventSearchItem[], allDayLabel: string): AddCardCandidate[]`.

This task **adds** `candidatesFromEvents` and leaves `candidatesFromProjections`, `eventRange` and `EVENT_RANGE_DAYS` in place so the tree stays green. Task 5 removes them once nothing imports them.

- [x] **Step 1: Write the failing test**

Append to `canvas-add-card.test.ts`. Add `candidatesFromEvents` to the existing import from `./canvas-add-card`, and `CalendarEventSearchItem` to the type import from `@memry/contracts/calendar-api`.

```ts
describe('candidatesFromEvents (#869)', () => {
  function eventItem(
    id: string,
    title: string,
    startAt: string,
    isAllDay = false
  ): CalendarEventSearchItem {
    return { id, title, startAt, endAt: null, isAllDay }
  }

  it('maps every event through, trusting main to have filtered and ordered', () => {
    // #given — two events in the order main returned them
    const items = [
      eventItem('e1', 'Standup', '2026-07-22T09:00:00.000Z'),
      eventItem('e2', 'Retro', '2023-01-02T09:00:00.000Z')
    ]

    // #when — we map them to candidates
    const out = candidatesFromEvents(items, 'All day')

    // #then — nothing is dropped or reordered client-side
    expect(out.map((c) => c.entityId)).toEqual(['e1', 'e2'])
    expect(out.every((c) => c.entityType === 'calendar_event')).toBe(true)
    expect(out.every((c) => c.onCanvas === false)).toBe(true)
  })

  it('formats the subtitle with formatEventTime instead of a raw ISO string', () => {
    // #given — a timed event
    const out = candidatesFromEvents(
      [eventItem('e1', 'Standup', '2026-07-02T09:00:00.000Z')],
      'All day'
    )

    // #then — the subtitle is humanized
    expect(out[0].subtitle).not.toBe('2026-07-02T09:00:00.000Z')
    expect(out[0].subtitle.length).toBeGreaterThan(0)
  })

  it('uses the all-day label for all-day events', () => {
    // #given — an all-day event
    const out = candidatesFromEvents(
      [eventItem('e1', 'Offsite', '2026-07-02T00:00:00.000Z', true)],
      'All day'
    )

    // #then — the label appears in the subtitle
    expect(out[0].subtitle).toContain('All day')
  })

  it('returns an empty list for no items', () => {
    // #given / #when / #then — no events in, no candidates out
    expect(candidatesFromEvents([], 'All day')).toEqual([])
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas-add-card.test`
Expected: FAIL — `candidatesFromEvents` is not exported.

- [x] **Step 3: Implement the mapper**

In `canvas-add-card.ts`, add `CalendarEventSearchItem` to the type import from `@memry/contracts/calendar-api` and append:

```ts
/**
 * Events from `calendar:search-events`. Main already filtered by title,
 * excluded archived rows and ordered by distance from now (#869), so this is a
 * pure mapping — no client-side filter, no occurrence dedup (one row per event).
 */
export function candidatesFromEvents(
  items: readonly CalendarEventSearchItem[],
  allDayLabel: string
): AddCardCandidate[] {
  return items.map((item) => ({
    entityType: 'calendar_event' as const,
    entityId: item.id,
    title: item.title,
    subtitle: formatEventTime(item.startAt, item.isAllDay, allDayLabel),
    onCanvas: false
  }))
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas-add-card.test`
Expected: PASS — new tests green, existing `candidatesFromProjections` and `eventRange` tests still green.

- [x] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.ts apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.test.ts
git commit -m "feat(canvas): map search-events results to card candidates (#869)"
```

---

### Task 5: Swap the picker's event source

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/canvas/use-canvas-add-search.ts`
- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card-dialog.tsx:46,55-61`
- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.ts` (delete dead exports)
- Test: `apps/desktop/src/renderer/src/pages/canvas/use-canvas-add-search.test.ts`
- Test: `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card-dialog.test.tsx`
- Test: `apps/desktop/src/renderer/src/pages/canvas/canvas-add-card.test.ts` (delete dead tests)

**Interfaces:**

- Consumes: `calendarService.searchEvents` (Task 1), `candidatesFromEvents` (Task 4).
- Produces: `CanvasAddSources { results: SearchResultItem[]; events: CalendarEventSearchItem[]; loading: boolean }`.

The hook, the dialog and the dead exports must move together — they are one compile unit.

- [x] **Step 1: Rewrite the hook's tests**

Replace the whole body of `use-canvas-add-search.test.ts`:

```tsx
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  quick: vi.fn(),
  searchEvents: vi.fn()
}))

vi.mock('@/services/search-service', () => ({
  searchService: { quick: (text: string) => mocks.quick(text) }
}))
vi.mock('@/services/calendar-service', () => ({
  calendarService: { searchEvents: (input: unknown) => mocks.searchEvents(input) }
}))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() })
}))

import { useCanvasAddSearch } from './use-canvas-add-search'

describe('useCanvasAddSearch', () => {
  beforeEach(() => {
    mocks.quick.mockReset().mockResolvedValue({ results: [{ id: 'n1' }], queryTimeMs: 1 })
    mocks.searchEvents.mockReset().mockResolvedValue({ events: [{ id: 'e1' }] })
  })

  it('does not query anything while closed', async () => {
    // #given / #when — a closed dialog with a query
    renderHook(() => useCanvasAddSearch(false, 'abc'))

    // #then — neither source is hit
    await waitFor(() => expect(mocks.searchEvents).not.toHaveBeenCalled())
    expect(mocks.quick).not.toHaveBeenCalled()
  })

  it('queries neither source for a blank query, keeping the create row highlighted', async () => {
    // #given / #when — an open dialog with a whitespace-only query
    const { result } = renderHook(() => useCanvasAddSearch(true, '   '))

    // #then — no calls, both lists empty
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mocks.quick).not.toHaveBeenCalled()
    expect(mocks.searchEvents).not.toHaveBeenCalled()
    expect(result.current.results).toEqual([])
    expect(result.current.events).toEqual([])
  })

  it('queries both sources for the same query (#869)', async () => {
    // #given / #when — a real query
    const { result } = renderHook(() => useCanvasAddSearch(true, 'alpha'))

    // #then — search and event search both run, both results land
    await waitFor(() => expect(result.current.results).toEqual([{ id: 'n1' }]))
    expect(result.current.events).toEqual([{ id: 'e1' }])
    expect(mocks.quick).toHaveBeenCalledWith('alpha')
    expect(mocks.searchEvents).toHaveBeenCalledWith({ query: 'alpha' })
    expect(result.current.loading).toBe(false)
  })

  it('re-queries events per keystroke, unlike the old once-per-open range fetch', async () => {
    // #given — an open dialog
    const { rerender } = renderHook(({ q }) => useCanvasAddSearch(true, q), {
      initialProps: { q: 'alpha' }
    })
    await waitFor(() => expect(mocks.searchEvents).toHaveBeenCalledTimes(1))

    // #when — the query changes and settles
    rerender({ q: 'alphabet' })

    // #then — events are fetched again for the new query
    await waitFor(() => expect(mocks.searchEvents).toHaveBeenCalledTimes(2))
    expect(mocks.searchEvents).toHaveBeenLastCalledWith({ query: 'alphabet' })
  })

  it('debounces rapid typing into a single pair of calls for the final query', async () => {
    // #given — an open dialog
    const { rerender } = renderHook(({ q }) => useCanvasAddSearch(true, q), {
      initialProps: { q: 'a' }
    })

    // #when — three keystrokes inside the debounce window
    rerender({ q: 'al' })
    rerender({ q: 'alp' })

    // #then — one call each, for the last query only
    await waitFor(() => expect(mocks.quick).toHaveBeenCalledTimes(1))
    expect(mocks.quick).toHaveBeenCalledWith('alp')
    expect(mocks.searchEvents).toHaveBeenCalledTimes(1)
    expect(mocks.searchEvents).toHaveBeenCalledWith({ query: 'alp' })
  })

  it('keeps events when search rejects', async () => {
    // #given — a failing search but a healthy event query
    mocks.quick.mockRejectedValue(new Error('boom'))

    // #when — we query
    const { result } = renderHook(() => useCanvasAddSearch(true, 'alpha'))

    // #then — one source failing does not blank the other
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.results).toEqual([])
    expect(result.current.events).toEqual([{ id: 'e1' }])
  })

  it('keeps search results when the event query rejects', async () => {
    // #given — a failing event query but a healthy search
    mocks.searchEvents.mockRejectedValue(new Error('boom'))

    // #when — we query
    const { result } = renderHook(() => useCanvasAddSearch(true, 'alpha'))

    // #then — the reverse direction holds too
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.events).toEqual([])
    expect(result.current.results).toEqual([{ id: 'n1' }])
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:renderer -- use-canvas-add-search`
Expected: FAIL — the hook still calls `calendarService.getRange`, which the new mock does not define, and `result.current.events` is undefined.

- [x] **Step 3: Rewrite the hook**

Replace the whole of `use-canvas-add-search.ts`:

```ts
/**
 * The two async sources behind the canvas "Add card" picker.
 *
 * Notes and tasks come from quick-search; events come from
 * calendar:search-events (#869). Both are query-driven and share one debounce,
 * so every event is reachable — the old ±90-day getRange window is gone.
 */

import { useEffect, useState } from 'react'
import type { CalendarEventSearchItem } from '@memry/contracts/calendar-api'
import type { SearchResultItem } from '@memry/contracts/search-api'
import { calendarService } from '@/services/calendar-service'
import { searchService } from '@/services/search-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('SpatialCanvas')

// The dialog's own highlight effect (canvas-add-card-dialog.tsx) relies on
// results landing in a LATER render commit than the query change: cmdk resets
// its highlight to the first mounted item whenever the search value changes,
// and the dialog's effect then re-highlights the first real match, winning
// because it runs after. Dropping this debounce (or making it 0) would let
// results commit in the same tick as the query change and the highlight
// would flicker to the create row on every keystroke.
const SEARCH_DEBOUNCE_MS = 150

export interface CanvasAddSources {
  results: SearchResultItem[]
  events: CalendarEventSearchItem[]
  loading: boolean
}

export function useCanvasAddSearch(open: boolean, query: string): CanvasAddSources {
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [events, setEvents] = useState<CalendarEventSearchItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const trimmed = query.trim()
    if (!open || trimmed === '') {
      setResults([])
      setEvents([])
      setLoading(false)
      return
    }
    setLoading(true)
    let cancelled = false
    const timer = setTimeout(() => {
      // Settled independently: one source failing must not blank the other.
      const searching = searchService.quick(query).then(
        (response) => {
          if (!cancelled) setResults(response.results)
        },
        (err) => {
          if (!cancelled) {
            log.error('Canvas add-card: search failed', err)
            setResults([])
          }
        }
      )
      const searchingEvents = calendarService.searchEvents({ query: trimmed }).then(
        (response) => {
          if (!cancelled) setEvents(response.events)
        },
        (err) => {
          if (!cancelled) {
            log.error('Canvas add-card: event search failed', err)
            setEvents([])
          }
        }
      )
      void Promise.all([searching, searchingEvents]).then(() => {
        if (!cancelled) setLoading(false)
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query])

  return { results, events, loading }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- use-canvas-add-search`
Expected: PASS, all seven tests.

- [x] **Step 5: Update the dialog**

In `canvas-add-card-dialog.tsx`, change the import on line 14 from `candidatesFromProjections` to `candidatesFromEvents`, then replace lines 46 and 55-61:

```tsx
const { results, events, loading } = useCanvasAddSearch(open, query)
```

```tsx
const groups = useMemo(() => {
  const merged = [
    ...candidatesFromSearch(results),
    ...candidatesFromEvents(events, t('canvas.card.allDay'))
  ]
  return groupCandidates(markOnCanvas(merged, onCanvasKeys))
}, [results, events, onCanvasKeys, t])
```

`query` leaves the dependency array — the memo no longer filters by it.

- [x] **Step 6: Update the dialog's test fixture**

In `canvas-add-card-dialog.test.tsx`, rename the mock field and the fixture. Replace the `mocks` hoist (lines 9-15):

```tsx
const mocks = vi.hoisted(() => ({
  sources: {
    results: [] as unknown[],
    events: [] as unknown[],
    loading: false
  }
}))
```

Replace `eventProjection` (lines 36-44) with:

```tsx
function eventItem(id: string, title: string) {
  return { id, title, startAt: '2026-07-22T09:00:00.000Z', endAt: null, isAllDay: false }
}
```

Then replace every remaining `projections:` key with `events:` and every `eventProjection(` call with `eventItem(` — occurrences at lines 63, 75, 86, 96, 107, 127, 137, 148, 163.

- [x] **Step 7: Delete the dead exports and their tests**

In `canvas-add-card.ts`, delete `EVENT_RANGE_DAYS` (lines 13-14), `candidatesFromProjections` (lines 71-113) and `eventRange` (lines 157-164). Drop the now-unused `CalendarProjectionItem` type import. Update the file's top docblock, which still describes the two-source merge:

```ts
/**
 * Pure candidate + geometry helpers for the canvas "Add card" picker.
 *
 * React- and Excalidraw-free (types only), mirroring canvas-cards.ts, so the
 * merge/dedup/scroll logic unit-tests without either library.
 */
```

In `canvas-add-card.test.ts`, delete the `describe('candidatesFromProjections', …)` block (lines 121-175), the `describe('eventRange', …)` block (lines 213-221), the `projection` helper (lines 58-79), and drop `candidatesFromProjections`, `eventRange` and the `CalendarProjectionItem` type import.

- [x] **Step 8: Run the full canvas suite**

Run: `pnpm --filter @memry/desktop test:renderer -- canvas`
Expected: PASS. Then confirm nothing still references the deleted exports:

Run: `rtk proxy grep -rn "candidatesFromProjections\|eventRange\|EVENT_RANGE_DAYS" apps/desktop/src`
Expected: no output.

- [x] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/canvas/
git commit -m "feat(canvas): source Add-card events from search-events (#869)"
```

---

### Task 6: Docs and full verification

**Files:**

- Modify: `apps/docs/src/user-guide/canvas/sync-and-limits.md:40-41`

**Interfaces:**

- Consumes: everything above.
- Produces: a shippable branch.

- [x] **Step 1: Remove the limitation**

Delete these two lines from the "Known limitations" list:

```markdown
- The **Add card** picker searches events within 90 days either side of today.
  Events outside that window are not listed.
```

Leave every other bullet untouched — the drag-in, filed-binaries, palm-rejection and toolbar-language limitations all still hold.

- [x] **Step 2: Verify no other page repeats the claim**

Run: `rtk proxy grep -rn "90 days\|90-day" apps/docs/src/user-guide/canvas/`
Expected: no output.

- [x] **Step 3: Run the full gate**

Run each and confirm green before moving on:

```bash
pnpm ipc:generate && pnpm ipc:check
```

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm test:desktop
```

```bash
git diff --check
```

`pnpm ipc:generate` must produce no new diff at this point — if it does, an earlier task committed a stale generated file; commit the regenerated one.

- [x] **Step 4: Run the docs gate**

```bash
pnpm docs:impact --base origin/main --strict
```

If it reports `missing-docs`, update real pages under `apps/docs/src/**` (or run `pnpm docs:ai-update --base origin/main`), then re-run until green, followed by:

```bash
pnpm docs:build
```

- [x] **Step 5: Commit**

```bash
git add apps/docs/src/user-guide/canvas/sync-and-limits.md
git commit -m "docs(canvas): drop the Add-card 90-day event window limit (#869)"
```

---

## Manual verification

Automated tests cover the units; this confirms the seam end-to-end in the real app.

- [x] **Step 1: Launch**

```bash
pnpm dev
```

- [x] **Step 2: Seed an out-of-window event**

On the Calendar page, create an event dated more than 90 days from today — e.g. two years out — titled `Reachability check`.

- [x] **Step 3: Confirm it is now reachable**

Open a canvas, click **Add card**, type `reach`. The event appears under the Events group with a formatted date subtitle. Before this change it could not appear at all. Pick it and confirm a calendar-event card lands on the canvas.

- [x] **Step 4: Confirm the create row still wins on an empty query**

Reopen **Add card** and press Enter without typing. A new note is created — the blank-query short-circuit still leaves "Create note …" highlighted.

- [x] **Step 5: Confirm the Calendar page is unaffected**

Return to the Calendar page and page through a month. Events still render — `calendar:get-range` was not touched.
