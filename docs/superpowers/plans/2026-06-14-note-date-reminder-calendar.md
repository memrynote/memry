# Note-date Reminders on the Calendar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface `/date`-with-reminder pills on the calendar as a new, read-only `note_date` type (timed at the reminder instant, violet, labeled with the note title).

**Architecture:** Add `note_date` to the calendar projection source/visual enums and the renderer's color + legend maps (Task 1, pure type plumbing that keeps the build green). Then add a dedicated `loadNoteDateReminderItems` read path in the main-process projection that reads existing `note_date` reminder rows and joins note titles from the index DB, wired into `getCalendarRangeProjection` (Task 2, TDD). The existing `ne(reminders.targetType, 'note_date')` guard in `loadReminderItems` is left untouched so these never leak in as editable generic "Reminder" chips.

**Tech Stack:** TypeScript, Zod (contracts), Drizzle ORM (better-sqlite3), React 19 renderer, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-14-note-date-reminder-calendar-design.md`

---

## File Structure

- `packages/contracts/src/calendar-api.ts` — add `'note_date'` to the two projection enums.
- `apps/desktop/src/renderer/src/lib/event-type-colors.ts` — add the `note_date` color.
- `apps/desktop/src/renderer/src/components/calendar/visual-type-meta.ts` — add the `note_date` legend entry, order, and labelKey union member.
- `packages/i18n/src/locales/en/calendar.json` — add the `note-date` label.
- `apps/desktop/src/main/calendar/projection.ts` — add `loadNoteDateReminderItems` + wire into `getCalendarRangeProjection`.
- `apps/desktop/src/main/calendar/projection.test.ts` — tests for the new loader.

**Note:** `apps/desktop/src/renderer/src/pages/calendar.tsx` initializes `selectedVisualTypes` to `VISUAL_TYPE_ORDER` (line 188), so appending `'note_date'` to that array auto-includes it in the default filter. No change needed there. All chip/click consumers use non-exhaustive `if (item.sourceType === '...')` guards, so a `note_date` chip falls through as a read-only no-op — no typecheck break.

---

## Task 1: Type plumbing for the `note_date` calendar type

Adds the new enum member and every exhaustive map keyed by it, in one green commit. No behavior change yet — verified by typecheck + i18n:check.

**Files:**

- Modify: `packages/contracts/src/calendar-api.ts:10-25`
- Modify: `apps/desktop/src/renderer/src/lib/event-type-colors.ts`
- Modify: `apps/desktop/src/renderer/src/components/calendar/visual-type-meta.ts`
- Modify: `packages/i18n/src/locales/en/calendar.json:25-32`

- [ ] **Step 1: Add `note_date` to both projection enums**

In `packages/contracts/src/calendar-api.ts`, replace the two schema definitions (lines 10-25) with:

```ts
export const CalendarProjectionSourceTypeSchema = z.enum([
  'event',
  'task',
  'reminder',
  'inbox_snooze',
  'external_event',
  'note',
  'note_date'
])
export const CalendarProjectionVisualTypeSchema = z.enum([
  'event',
  'task',
  'reminder',
  'snooze',
  'external_event',
  'note',
  'note_date'
])
```

- [ ] **Step 2: Add the `note_date` color**

In `apps/desktop/src/renderer/src/lib/event-type-colors.ts`, replace the `EVENT_TYPE_COLORS` object with:

```ts
export const EVENT_TYPE_COLORS: Record<VisualType, string> = {
  event: '#92CED4',
  task: '#1EB06D',
  reminder: '#1BADF8',
  snooze: '#7BD148',
  external_event: '#9A9CFF',
  note: '#E0A458',
  note_date: '#B57BD6'
}
```

- [ ] **Step 3: Add the legend entry, order, and labelKey**

In `apps/desktop/src/renderer/src/components/calendar/visual-type-meta.ts`:

Extend the `labelKey` union in the `VisualTypeMeta` interface to include the new key:

```ts
interface VisualTypeMeta {
  labelKey:
    | 'visual-type.event'
    | 'visual-type.imported-event'
    | 'visual-type.task'
    | 'visual-type.reminder'
    | 'visual-type.snooze'
    | 'visual-type.note'
    | 'visual-type.note-date'
  swatchColor: string
  dotColor: string
}
```

Add the `note_date` entry to `VISUAL_TYPE_META` (after the `note` entry):

```ts
  note: {
    labelKey: 'visual-type.note',
    swatchColor: EVENT_TYPE_COLORS.note,
    dotColor: EVENT_TYPE_COLORS.note
  },
  note_date: {
    labelKey: 'visual-type.note-date',
    swatchColor: EVENT_TYPE_COLORS.note_date,
    dotColor: EVENT_TYPE_COLORS.note_date
  }
```

Append `'note_date'` to `VISUAL_TYPE_ORDER`:

```ts
export const VISUAL_TYPE_ORDER: CalendarProjectionVisualType[] = [
  'event',
  'external_event',
  'task',
  'reminder',
  'snooze',
  'note',
  'note_date'
]
```

- [ ] **Step 4: Add the English label**

In `packages/i18n/src/locales/en/calendar.json`, replace the `visual-type` block (lines 25-32) with:

```json
  "visual-type": {
    "event": "Event",
    "imported-event": "Imported event",
    "note": "Note",
    "note-date": "Date reminder",
    "task": "Task",
    "reminder": "Reminder",
    "snooze": "Snooze"
  },
```

- [ ] **Step 5: Verify typecheck and i18n stay green**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS (the two `Record<VisualType, …>` maps are now exhaustive again).

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: PASS.

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: PASS (en `visual-type.note-date` added; other locales fall back).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/calendar-api.ts \
  apps/desktop/src/renderer/src/lib/event-type-colors.ts \
  apps/desktop/src/renderer/src/components/calendar/visual-type-meta.ts \
  packages/i18n/src/locales/en/calendar.json
git commit -m "feat(calendar): add note_date visual type plumbing"
```

---

## Task 2: Project `note_date` reminders onto the calendar

Read-only loader that turns existing `note_date` reminder rows into calendar items. TDD.

**Files:**

- Modify: `apps/desktop/src/main/calendar/projection.ts` (add loader + wire into `getCalendarRangeProjection`)
- Test: `apps/desktop/src/main/calendar/projection.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these two tests inside the `describe('getCalendarRangeProjection', ...)` block in `apps/desktop/src/main/calendar/projection.test.ts` (before its closing `})`):

```ts
it('projects a note_date reminder as a read-only note_date item with the note title', () => {
  const range = getLocalDayRange({ year: 2026, monthIndex: 3, day: 14 })

  indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'note-7'}, ${'notes/launch.md'}, ${'Launch Plan'}, ${'markdown'}, ${'2026-04-12T08:00:00.000Z'}, ${'2026-04-12T08:00:00.000Z'})
    `)
  db.run(sql`
      INSERT INTO reminders (
        id, target_type, target_id, remind_at, anchor_id, status, created_at, modified_at
      )
      VALUES (
        ${'rem-nd-1'}, ${'note_date'}, ${'note-7'}, ${'2026-04-14T11:00:00.000Z'}, ${'anchor-1'}, ${'pending'}, ${'2026-04-12T08:20:00.000Z'}, ${'2026-04-12T08:20:00.000Z'}
      )
    `)

  const { items } = getCalendarRangeProjection(
    db as unknown as DataDb,
    indexDb,
    { ...range, includeUnselectedSources: false },
    []
  )

  const item = items.find((i) => i.sourceType === 'note_date')
  expect(item).toBeDefined()
  expect(item!.visualType).toBe('note_date')
  expect(item!.title).toBe('Launch Plan')
  expect(item!.startAt).toBe('2026-04-14T11:00:00.000Z')
  expect(item!.isAllDay).toBe(false)
  expect(item!.projectionId).toBe('note_date:rem-nd-1')
  expect(item!.editability).toEqual({
    canMove: false,
    canResize: false,
    canEditText: false,
    canDelete: false
  })
  // Must NOT leak in as a generic editable reminder chip.
  expect(items.some((i) => i.visualType === 'reminder')).toBe(false)
})

it('positions a snoozed note_date reminder at its snoozedUntil', () => {
  const range = getLocalDayRange({ year: 2026, monthIndex: 3, day: 14 })

  indexDbResult.db.run(sql`
      INSERT INTO note_cache (id, path, title, file_type, created_at, modified_at)
      VALUES (${'note-8'}, ${'notes/review.md'}, ${'Review'}, ${'markdown'}, ${'2026-04-12T08:00:00.000Z'}, ${'2026-04-12T08:00:00.000Z'})
    `)
  db.run(sql`
      INSERT INTO reminders (
        id, target_type, target_id, remind_at, anchor_id, status, snoozed_until, created_at, modified_at
      )
      VALUES (
        ${'rem-nd-2'}, ${'note_date'}, ${'note-8'}, ${'2026-04-13T09:00:00.000Z'}, ${'anchor-2'}, ${'snoozed'}, ${'2026-04-14T12:00:00.000Z'}, ${'2026-04-12T08:20:00.000Z'}, ${'2026-04-12T08:20:00.000Z'}
      )
    `)

  const { items } = getCalendarRangeProjection(
    db as unknown as DataDb,
    indexDb,
    { ...range, includeUnselectedSources: false },
    []
  )

  const item = items.find((i) => i.sourceType === 'note_date')
  expect(item).toBeDefined()
  expect(item!.startAt).toBe('2026-04-14T12:00:00.000Z')
  expect(item!.snoozeOffsetMinutes).toBe(
    Math.round(
      (new Date('2026-04-14T12:00:00.000Z').getTime() -
        new Date('2026-04-13T09:00:00.000Z').getTime()) /
        60000
    )
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main src/main/calendar/projection.test.ts`
Expected: FAIL — the two new tests find no item with `sourceType === 'note_date'` (`item` is `undefined`, so `expect(item).toBeDefined()` fails).

- [ ] **Step 3: Add the `loadNoteDateReminderItems` loader**

In `apps/desktop/src/main/calendar/projection.ts`, add this function immediately after `loadReminderItems` (after its closing `}` near line 298). All imports it needs (`and`, `or`, `eq`, `gte`, `lt`, `isNotNull`, `asc`, `inArray`, `reminders`, `noteCache`, `getDescriptionPreview`, `nativeSource`, `LOCAL_TIMEZONE`, `CalendarProjectionEditability`, `IndexDb`, `DataDb`) are already imported in this file:

```ts
function loadNoteDateReminderItems(
  db: DataDb,
  indexDb: IndexDb,
  input: GetCalendarRangeInput
): CalendarProjectionItem[] {
  const rows = db
    .select()
    .from(reminders)
    .where(
      and(
        eq(reminders.targetType, 'note_date'),
        or(
          and(
            eq(reminders.status, 'pending'),
            gte(reminders.remindAt, input.startAt),
            lt(reminders.remindAt, input.endAt)
          ),
          and(
            eq(reminders.status, 'snoozed'),
            isNotNull(reminders.snoozedUntil),
            gte(reminders.snoozedUntil, input.startAt),
            lt(reminders.snoozedUntil, input.endAt)
          )
        )
      )
    )
    .orderBy(asc(reminders.remindAt))
    .all()

  if (rows.length === 0) return []

  const noteIds = [...new Set(rows.map((row) => row.targetId))]
  const titleRows = indexDb
    .select({ id: noteCache.id, title: noteCache.title })
    .from(noteCache)
    .where(inArray(noteCache.id, noteIds))
    .all()
  const titleById = new Map(titleRows.map((row) => [row.id, row.title]))

  const editability: CalendarProjectionEditability = {
    canMove: false,
    canResize: false,
    canEditText: false,
    canDelete: false
  }

  return rows.map((row) => {
    const isSnoozed = row.status === 'snoozed' && !!row.snoozedUntil
    const effectiveStartAt = isSnoozed ? row.snoozedUntil! : row.remindAt
    const snoozeOffsetMinutes = isSnoozed
      ? Math.round(
          (new Date(row.snoozedUntil!).getTime() - new Date(row.remindAt).getTime()) / 60000
        )
      : null

    return {
      projectionId: `note_date:${row.id}`,
      sourceType: 'note_date',
      sourceId: row.id,
      title: titleById.get(row.targetId)?.trim() || 'Untitled',
      descriptionPreview: getDescriptionPreview(row.note),
      startAt: effectiveStartAt,
      endAt: null,
      isAllDay: false,
      timezone: LOCAL_TIMEZONE,
      visualType: 'note_date',
      editability,
      source: nativeSource('memrynote Notes'),
      binding: null,
      snoozeOffsetMinutes
    }
  })
}
```

- [ ] **Step 4: Wire the loader into `getCalendarRangeProjection`**

In `apps/desktop/src/main/calendar/projection.ts`, update the `sortProjectionItems([...])` array in `getCalendarRangeProjection` (lines 471-478) to include the new loader right after `loadReminderItems`:

```ts
const items = sortProjectionItems([
  ...loadMemryEvents(db, input),
  ...loadTaskItems(db, input),
  ...loadReminderItems(db, input),
  ...loadNoteDateReminderItems(db, indexDb, input),
  ...loadInboxSnoozeItems(db, input),
  ...loadExternalEvents(db, input),
  ...loadNoteDatePropertyItems(indexDb, enabledNames, input)
])
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project main src/main/calendar/projection.test.ts`
Expected: PASS — both new tests, plus all pre-existing tests in the file.

- [ ] **Step 6: Typecheck the main process**

Run: `pnpm --filter @memry/desktop typecheck:node`
Expected: PASS (the `'note_date'` literals satisfy the enums extended in Task 1).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/calendar/projection.ts \
  apps/desktop/src/main/calendar/projection.test.ts
git commit -m "feat(calendar): project note_date reminders as read-only items"
```

---

## Final Verification

- [ ] **Run the full desktop main test suite**

Run: `pnpm --filter @memry/desktop test:main`
Expected: PASS (no regression in the broader calendar/reminder suites).

- [ ] **Run both desktop typechecks**

Run: `pnpm --filter @memry/desktop typecheck:web && pnpm --filter @memry/desktop typecheck:node`
Expected: PASS.

- [ ] **Confirm working tree is clean**

Run: `git status --porcelain && git diff --check`
Expected: empty output (all changes committed, no whitespace errors).
