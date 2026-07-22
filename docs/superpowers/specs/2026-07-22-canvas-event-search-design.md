# Canvas "Add card": reach every calendar event

Issue: [#869](https://github.com/memrynote/memry/issues/869) (epic #878, follow-up to PR #868)
Date: 2026-07-22

## Problem

The canvas "Add card" picker loads events from one `calendar:get-range` call
spanning ±90 days around today (`EVENT_RANGE_DAYS`), then filters client-side by
title. An event outside that window cannot be placed on a canvas at all, and
there is no other entry path — the Calendar page has no drag-in to canvas.

The window was a deliberate trade in PR #868: events are not in the search index
(`search-api.ts` `ContentType` is `note | journal | task | inbox`), and
`calendar:list-events` accepts only `{ includeArchived }` — no query, no range,
no limit — so it ships every event row on every picker open.

## Decision

Add a bounded, query-driven IPC channel: **`calendar:search-events`**.

Rejected alternatives:

- **Index events into global search** (`calendar_event` as a `ContentType`) —
  best long-term UX, but events are data-DB rows, not vault files, so the
  indexer has no ingestion path for them. It needs a new writer wired into event
  CRUD _and_ sync pulls, an index-DB migration, and widening `ContentType` leaks
  events into the global search palette — a product decision beyond this issue.
  Worth its own epic item.
- **Widen the window** — one line, still arbitrary, grows the payload, and
  leaves events outside the new window unreachable. Does not close the issue.

## Facts this design rests on

Verified in the worktree, not assumed:

- `calendar_events.title` is a **plaintext column** in the data DB. The at-rest
  cost of `list-events` is IPC payload size, not decryption.
- `loadMemryEvents` (`apps/desktop/src/main/calendar/projection.ts:131`) filters
  native events on `archivedAt IS NULL` and the range only. Source selection
  (`includeUnselectedSources`) applies to _external_ Google events, never to
  Memry events — so a title search over `calendar_events` is a strict
  simplification of the semantics the picker sees today.
- Adding an RPC method is mechanical: contracts schema → channel constant →
  `defineMethod` in `packages/rpc/src/calendar.ts` → main handler →
  `pnpm ipc:generate`.

## Contract

Additive only. A new channel changes no existing shape, and renderer and main
ship in the same build, so there is no cross-version compatibility surface.

`packages/contracts/src/calendar-api.ts`:

```ts
export const SearchCalendarEventsSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(100).default(20)
})
export type SearchCalendarEventsInput = z.infer<typeof SearchCalendarEventsSchema>

/** Lean projection for pickers: exactly what an AddCardCandidate needs. */
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

`endAt` is unused by today's subtitle (`formatEventTime` takes `startAt` and
`isAllDay` only). It is included because omitting it is the single most likely
cause of a second contract change later; it costs one string per hit.

`packages/contracts/src/ipc-channels.ts` — `CalendarChannels.invoke`:

```ts
/** #869: query-driven event lookup for the canvas Add-card picker */
SEARCH_EVENTS: 'calendar:search-events',
```

`packages/rpc/src/calendar.ts` — new method beside `listEvents`. Follow the
file's existing convention: it re-declares its own input type as
`z.input<typeof SearchCalendarEventsSchema>`, which keeps `limit` optional for
callers while the handler still receives the defaulted value.

```ts
searchEvents: defineMethod<
  (input: SearchCalendarEventsInput) => Promise<CalendarEventSearchResponse>
>({
  channel: CalendarChannels.invoke.SEARCH_EVENTS,
  params: ['input']
}),
```

Then `pnpm ipc:generate` (regenerates `generated-ipc-invoke-map.ts` and
`generated-rpc.ts`) and `pnpm ipc:check`.

## Main process

The query lives in `apps/desktop/src/main/calendar/repositories/calendar-events-repository.ts`,
beside `listActiveCalendarEvents`. `calendar-handlers.ts` is already 885 lines
and holds no SQL of its own for this table.

```ts
export function searchCalendarEventsByTitle(
  db: DataDb,
  options: { query: string; limit: number; now: string }
): CalendarEvent[]
```

Two queries, merged:

```
upcoming: archived_at IS NULL AND ulower(title) LIKE ulower(%q%) AND start_at >= now
          ORDER BY start_at ASC  LIMIT n
past:     archived_at IS NULL AND ulower(title) LIKE ulower(%q%) AND start_at <  now
          ORDER BY start_at DESC LIMIT n
merge → sort by |start_at − now| → take n
```

Two string-comparison queries rather than `ORDER BY abs(julianday(...))`: they
use the existing `start_at` index and avoid SQLite date parsing on all-day rows.
Nearest-to-now ordering means a search with more matches than `limit` returns
the ones a user is most likely to want, in both directions.

Matching goes through `ulower()`, a deterministic user-defined function
registered in `apps/desktop/src/main/database/sqlite-functions.ts` from both
data-DB connection paths (`initDatabase` and the `createTestDataDb` test
helper). SQLite's `LIKE` folds case for ASCII only, so bare `LIKE` would have
made `ödeme` miss "Ödeme Toplantısı", `münchen` miss "MÜNCHEN Trip" and
`лекция` miss "ЛЕКЦИЯ" — a regression against the client-side
`toLowerCase().includes()` filter this design replaces. `ulower()` is
JavaScript's `toLowerCase`, which folds the full Unicode range.

`toLowerCase` still has one documented gap: it maps the Turkish dotted capital
İ to `i` followed by a combining dot above (U+0069 U+0307), not to plain `i`,
so a query of `istanbul` will not match a title of `İstanbul`. This is not a
regression — the client-side filter it replaces used the same `toLowerCase`
and had the identical gap — but it is worth naming here since it is exactly
the kind of thing a Turkish-locale bug report would surface.

The predicate is opaque to any index on `title`, so it full-scans non-archived
rows. No such index exists, and `LIKE` with a leading wildcard could not have
used one anyway.

`%` and `_` in the user's query pass through unescaped, matching the existing
precedent at `apps/desktop/src/main/inbox/queries.ts:254`. For a picker the
effect is a mildly surprising match, never an error.

Handler in `calendar-handlers.ts`, beside `LIST_EVENTS`:

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

`toEventSearchItem` is a local row → `CalendarEventSearchItem` mapper in
`calendar-handlers.ts`, picking the five fields; it is not `mapCalendarEvent`,
whose whole point here is that it ships too much.

Register the `removeHandler` line in the teardown block alongside the others.

## Renderer

### `use-canvas-add-search.ts`

The two effects collapse into one debounced effect that fires
`searchService.quick(trimmed, NOTE_FILE_TYPES)` and
`calendarService.searchEvents({ query: trimmed })` in parallel, behind a single
`loading` flag. `NOTE_FILE_TYPES` is `['markdown']`, a constant carried over
from PR #887, which landed on main while this branch was in flight: quick-search
caps results at 5 per type, and a filed binary is a "note" hit the picker can
never place (#800), so without the filter a query matching several PDFs could
fill the note cap with unplaceable rows and leave the Notes group empty.

```ts
export interface CanvasAddSources {
  results: SearchResultItem[]
  events: CalendarEventSearchItem[]
  loading: boolean
}
```

Constraints to preserve:

- The 150ms `SEARCH_DEBOUNCE_MS` and its comment stay. The dialog's highlight
  effect depends on results landing in a _later_ render commit than the query
  change; removing the debounce flickers the highlight to the create row on
  every keystroke.
- A blank query issues neither call and clears both arrays, so an empty picker
  still leaves "Create note …" highlighted for one-click note creation.
- Each source fails independently: a rejected search must not blank the events,
  and vice versa. Log through the existing `SpatialCanvas` logger.

Events now refetch per keystroke instead of once per open. That is the point of
the change, and it is cheaper than today: at most `limit` lean rows per call
versus every projection in a 180-day window.

### `canvas-add-card.ts`

`candidatesFromProjections` → `candidatesFromEvents(items, allDayLabel)`:

```ts
export function candidatesFromEvents(
  items: readonly CalendarEventSearchItem[],
  allDayLabel: string
): AddCardCandidate[]
```

The client-side title filter, the blank-query guard and the
`sourceType === 'event'` check all go away — main returns one row per event,
already filtered and ordered. Subtitle stays
`formatEventTime(startAt, isAllDay, allDayLabel)`.

`candidatesFromProjections` also carried an occurrence-collapse map keyed by
event id. That code was unreachable: `projection.ts` emits exactly one
projection per `calendar_events` row and never expands `recurrenceRule`, so a
native recurring event was always a single row and the map never collapsed
anything. It goes away with the rest of the function; no behaviour depended
on it.

`EVENT_RANGE_DAYS` and `eventRange` are deleted; this change is what orphans
them. Their tests go with them.

`canvas-add-card-dialog.tsx` swaps `projections`/`candidatesFromProjections(projections, query, …)`
for `events`/`candidatesFromEvents(events, …)`; the `groups` memo drops `query`
from its own dependency array because main now does the filtering, not the
client.

That drop has a knock-on effect on the highlight useEffect below it. Today
that effect reads `[groups]` only, relying on `groups` itself changing
whenever the query changes (it used to be a memo input) to catch the moment
the query is cleared and re-highlight the create row. With `query` out of the
`groups` deps, clearing the input no longer forces `groups` to recompute — for
one frame the stale groups from the last non-empty query are still standing —
so the effect gains an explicit `query.trim() === ''` guard that always wins
the create row, and `query` moves into its dependency array so the effect
re-runs on that transition even when `groups` does not.

## Behavior deltas

|                 | Before                       | After                           |
| --------------- | ---------------------------- | ------------------------------- |
| Reach           | ±90 days                     | every non-archived event        |
| Fetch           | once per open, whole window  | per keystroke, ≤20 lean rows    |
| Ordering        | earliest first within window | nearest to now, both directions |
| Blank query     | no events                    | no events (unchanged)           |
| Archived events | excluded                     | excluded (unchanged)            |

Recurring events are deliberately absent from this table: nothing changes for
them. One `calendar_events` row is one candidate before and after, because
`projection.ts` never expanded `recurrenceRule` in the first place.

## Testing

- `calendar-events-repository.test.ts` — matches by title substring;
  case-insensitivity across the full Unicode range (Turkish, German, Cyrillic),
  via the `ulower()` UDF rather than bare `LIKE`, which folds ASCII only;
  archived rows excluded; `limit` respected;
  proximity ordering across the now boundary (a past event 1 day back outranks a
  future event 30 days out); empty result for no match.
- `calendar-handlers.test.ts` — channel registered, validation rejects an empty
  query, response maps to the lean shape and drops `attendees`/`conferenceData`.
- `canvas-add-card.test.ts` — `candidatesFromEvents` mapping and subtitle;
  `EVENT_RANGE_DAYS`/`eventRange` cases deleted.
- `use-canvas-add-search.test.ts` — both calls fire once after the debounce,
  `searchService.quick` called with `NOTE_FILE_TYPES`; blank query issues
  neither; one source failing leaves the other populated.
- `canvas-add-card-dialog.test.tsx` — update the hook mock to `events`.

Gates: `pnpm ipc:generate` then `pnpm ipc:check`, `pnpm typecheck`,
`pnpm test:desktop`, `pnpm lint`, and the docs impact gate.

## Docs

`apps/docs/src/user-guide/canvas/sync-and-limits.md:40-41` — delete the
"searches events within 90 days either side of today" limitation. No other page
repeats the claim; `cards-and-links.md` describes the picker without a window.

## Out of scope

- Indexing events into global search (`calendar_event` ContentType).
- An add-to-canvas path from the Calendar page — tracked separately; the picker
  is the supported entry point.
- Searching event description or location. Title only, matching what the picker
  filtered on before.
- External Google events. They are not `calendar_event` entities and have never
  been placeable as cards.
