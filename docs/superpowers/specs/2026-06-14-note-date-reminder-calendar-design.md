# Note-date reminders on the calendar (Phase 2)

**Date:** 2026-06-14
**Branch:** feat/inline-reminder
**Status:** Approved design

## Problem

An inline `/date` pill _with a reminder_ derives a `note_date` reminder row
(via `syncNoteDateReminders`, keyed by the pill's stable `anchorId`,
`targetId = noteId`, `remindAt` = computed instant). These rows currently fire
into the inbox only. The calendar projection deliberately excludes them:

```ts
// apps/desktop/src/main/calendar/projection.ts — loadReminderItems
ne(reminders.targetType, 'note_date'),
```

with the comment noting this is "Phase 2 (read-only, own source type)". This
spec is that Phase 2: surface `/date`-with-reminder pills on the calendar as a
new, read-only `note_date` type.

Out of scope: a plain `/date` pill with `remind === 'none'` produces **no**
`note_date` reminder row, so it never appears on the calendar. That behavior is
unchanged.

## Approach

Add a dedicated read path and a distinct source/visual type rather than
removing the existing exclusion. The `loadReminderItems` guard stays, so these
never leak in as editable generic "Reminder" chips. A new loader + new
`sourceType`/`visualType` give them their own color, legend entry, and
read-only semantics.

### Decisions

- **Placement:** timed at the reminder instant (`isAllDay: false`,
  `startAt = effective instant`), mirroring the existing `reminder` visualType.
  Honors pills carrying a time (e.g. `@today 23:20`).
- **Color:** violet `#B57BD6`, distinct from the six existing calendar colors.
- **Label:** the note's title, joined from `noteCache` by `targetId`; fallback
  `'Untitled'`. (`note_date` reminder rows carry no title of their own.)
- **Editability:** fully read-only (`canMove/canResize/canEditText/canDelete`
  all `false`). No write-back, no editing from the calendar.

## Changes

### 1. `packages/contracts/src/calendar-api.ts`

Add `'note_date'` to both enums:

- `CalendarProjectionSourceTypeSchema`
- `CalendarProjectionVisualTypeSchema`

### 2. `apps/desktop/src/main/calendar/projection.ts`

New `loadNoteDateReminderItems(db, indexDb, input)`:

- Select `reminders` where `targetType = 'note_date'` and either
  `status = 'pending'` with `remindAt` in `[startAt, endAt)`, **or**
  `status = 'snoozed'` with non-null `snoozedUntil` in `[startAt, endAt)` —
  same window logic as `loadReminderItems`.
- Resolve note titles from `noteCache` (index DB) keyed by `targetId`
  (the noteId); fallback `'Untitled'`.
- For each row emit a `CalendarProjectionItem`:
  - `projectionId: \`note_date:${row.id}\``
  - `sourceType: 'note_date'`, `visualType: 'note_date'`
  - `sourceId: row.id`
  - `title`: resolved note title
  - `descriptionPreview`: `getDescriptionPreview(row.note)`
  - `startAt`: `snoozedUntil` when snoozed, else `remindAt`
  - `endAt: null`, `isAllDay: false`, `timezone: LOCAL_TIMEZONE`
  - `editability`: all `false`
  - `source: nativeSource('memrynote Notes')`
  - `binding: null`
  - `snoozeOffsetMinutes`: computed as in `loadReminderItems`
- Keep the `ne(reminders.targetType, 'note_date')` guard in
  `loadReminderItems` unchanged.
- Add `...loadNoteDateReminderItems(db, indexDb, input)` to the
  `getCalendarRangeProjection` spread.

### 3. `apps/desktop/src/renderer/src/lib/event-type-colors.ts`

Add `note_date: '#B57BD6'` to `EVENT_TYPE_COLORS` (the `Record<VisualType, …>`
becomes exhaustive again — TS enforces).

### 4. `apps/desktop/src/renderer/src/components/calendar/visual-type-meta.ts`

- Extend the `labelKey` union with `'visual-type.note-date'`.
- Add a `note_date` entry to `VISUAL_TYPE_META` (swatch/dot = `#B57BD6`).
- Append `'note_date'` to `VISUAL_TYPE_ORDER`.

The legend + filter (`calendar-shell.tsx`) and `day-dots.ts` iterate
`VISUAL_TYPE_ORDER` / `VISUAL_TYPE_META`, so they pick up the new type
automatically.

### 5. `packages/i18n/src/locales/en/calendar.json`

Add under `visual-type`:

```json
"note-date": "Date reminder"
```

English-only is sufficient for the i18n:check gate; other locales fall back.

### 6. Default visual-type filter — verify in implementation

`apps/desktop/src/renderer/src/pages/calendar.tsx` initializes
`selectedVisualTypes`. If that default is derived from `VISUAL_TYPE_ORDER`, the
new type is included automatically. If it is a hardcoded list, add `'note_date'`
so the type is visible by default. Confirm and handle during implementation.

## Testing

`apps/desktop/src/main/calendar/projection.test.ts`:

- A `note_date` reminder whose `remindAt` is in range → exactly one item with
  `visualType: 'note_date'`, the joined note title, and all-false editability.
- A snoozed `note_date` reminder → positioned at `snoozedUntil`, with the
  expected `snoozeOffsetMinutes`.
- A note carrying a `date` property still emits its `note` item; the two paths
  do not overlap or double-count.
- Generic reminders (`note` / `highlight` / `task` target types) still exclude
  `note_date` from `loadReminderItems`.

## Verification

- `pnpm --filter @memry/desktop test:main` (projection tests)
- `pnpm --filter @memry/desktop typecheck:web` and `typecheck:node`
  (exhaustive `Record<CalendarProjectionVisualType, …>` updates)
- `pnpm ipc:check` is not required — no IPC contract surface changes beyond the
  two enum additions, which are validated by typecheck.
- `pnpm --filter @memry/desktop i18n:check` (en key added).
