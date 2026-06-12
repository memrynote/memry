# Inbox Upcoming/Past Reminders Panel

Date: 2026-06-12
Branch: task-reminders
Status: design approved, pending spec review

## Problem

A reminder set on a note or task lives in the `reminders` table and is
invisible until it fires. When it fires, `createReminderInboxItem`
(`apps/desktop/src/main/lib/reminders.ts`) inserts an inbox item of type
`reminder`, which is the first time the user sees it in the inbox.

The inbox toolbar already has an AlarmClock button (`pages/inbox.tsx`
lines ~285-317) that toggles `showSnoozedItems`. Today that filter shows
only **snoozed inbox items** (`snoozedUntil` set) plus **already-fired
reminders** (`type === 'reminder'`), as a flat list
(`pages/inbox/inbox-list-view.tsx` lines ~95-96:
`backendItems.filter((item) => item.snoozedUntil || item.type === 'reminder')`).

Gap: there is no way to see a reminder you scheduled before it fires, and
no separation between what is coming up and what already happened. The
user wants the alarm icon to list **Upcoming** and **Past** across all
sources (note, task, journal, highlight, snoozed inbox item).

## Goal

When the alarm icon is toggled on, replace the flat snoozed view with two
collapsible sections — **Upcoming** and **Past** — that merge scheduled
reminders and snoozed inbox items into one chronological timeline, each
row click-through to its source. This is additive to the existing alarm
button; the off state (normal inbox triage list) is unchanged.

## Approach

Renderer-side merge that reuses existing wiring. No new IPC.

- `useReminders(options)` (`hooks/use-reminders.ts`) already calls
  `reminderService.list({ status, targetType, ... })` →
  `window.api.reminders.list`, and already invalidates on reminder
  create/update/delete/dismiss/snooze events.
- `useInboxSnoozed` (`hooks/use-inbox.ts`) already returns snoozed inbox
  items.
- `reminders.list` returns `ReminderWithTarget[]` with `targetTitle` and
  `projectId` already resolved for every target type, including `task`
  (`reminders.ts` `resolveReminderTarget`).

Alternative considered and rejected (YAGNI): a new main-process
`reminders.listUpcoming` aggregation IPC that joins reminders + inbox
items server-side. Rejected because both data sources are already exposed
to the renderer with caching/invalidation; a merge hook is simpler and
keeps the change surgical.

## Data model

Two groups, built in the merge hook.

**Upcoming** (ascending by trigger time):

- Reminders from `reminders.list({ status: ['pending', 'snoozed'] })`,
  keyed/sorted by `remindAt`.
- Inbox items where `snoozedUntil > now`, sorted by `snoozedUntil`.
- Merge both into one list sorted ascending by time.

**Past** (descending by trigger time):

- Inbox items where `type === 'reminder'` and not future-snoozed
  (`!snoozedUntil || snoozedUntil <= now`), sorted by `remindAt` (fall
  back to `createdAt`) descending.

**De-dup rule (avoid double-counting a fired reminder):**

- Triggered reminders are never pulled from the reminders table directly.
  Once a reminder fires, the reminders row flips to `triggered` AND an
  inbox `reminder` item is created. Upcoming reads the reminders table
  only for `pending`/`snoozed` (which have no inbox item yet); Past reads
  the inbox `reminder` items. So a given reminder appears in exactly one
  group.
- Safety net: when merging Upcoming, dedupe by
  `(targetType, targetId, remindAt)` in case both a reminders-table
  `snoozed` row and a future-snoozed inbox item describe the same event
  (possible only if two snooze paths are exercised). Keep the inbox item
  when a collision occurs (it carries the user-facing actions).

**Badge count:** number of Upcoming items only (per decision). Replaces
the current `snoozedViewCount = snoozedItems.length + reminderCount`.

## UI

- Alarm icon unchanged in placement; still toggles `showSnoozedItems`.
- Badge shows Upcoming count; hidden when 0.
- When toggled on, `inbox-list-view` renders `<InboxRemindersList>`
  instead of the current flat filtered list. When off, the normal triage
  list renders unchanged.
- `<InboxRemindersList>` renders two `InboxListSection`s (reuse the
  existing collapsible section component from
  `components/inbox/inbox-list.tsx`):
  - **UPCOMING** — count badge, collapsible, default expanded.
  - **PAST** — count badge, collapsible, default expanded.
- Row anatomy: source-type icon + target title + relative-time pill.
  - Icon by target/source type: task → `CheckSquare`, note/highlight →
    `FileText`, journal → `Calendar`, snoozed inbox item → that item's
    existing type icon (`TypeIcon`).
  - Time pill: Upcoming shows relative future ("in 2h", "tomorrow 9am");
    Past shows relative past ("2d ago").
- Row click opens the source via a shared `openReminderTarget` helper
  (see below). No checkboxes, no bulk actions in this view (v1).
- Empty states: if Upcoming empty, show "No upcoming reminders." in that
  section; if Past empty, hide the Past section entirely. If both empty,
  show the single "No upcoming reminders." message and no Past section.

## Components and units

- `hooks/use-inbox-reminders-panel.ts` — new. Combines `useReminders`
  (pending+snoozed) and `useInboxSnoozed`, plus the inbox list's fired
  `reminder` items, into `{ upcoming, past }`. Single responsibility:
  aggregate, sort, dedupe. Pure of rendering. Each entry normalized to a
  small view shape `{ key, kind, targetType, targetId, title, time,
projectId?, highlight? }` so the list component does not branch on raw
  reminder vs inbox-item shapes.
- `components/inbox/inbox-reminders-list.tsx` — new. Pure presentation of
  `{ upcoming, past }` as two sections; takes an `onOpen(entry)` callback.
- `lib/open-reminder-target.ts` — new. Extracted from
  `inbox-detail/reminder-detail.tsx` `handleNavigateToSource`. Maps
  `(targetType, targetId, targetTitle, projectId, highlight?)` to an
  `openTab(...)` payload for note / highlight / journal / task. Shared by
  `ReminderDetail` and the new list so navigation stays identical.
- `pages/inbox/inbox-list-view.tsx` — when `showSnoozedItems` is true,
  render `<InboxRemindersList>` (driven by the panel hook) instead of the
  current flat `snoozedUntil || reminder` filter branch.
- `pages/inbox.tsx` — badge count switches from `snoozedViewCount` to the
  Upcoming count. The panel hook exposes an `upcomingCount`; the toolbar
  reads it from the same hook so badge and panel cannot disagree.
- `i18n/en/inbox.json` — new keys: section titles (upcoming/past), empty
  states, and any new aria labels. English-only gate (other locales are
  non-fatal warnings).

## Data flow

1. User clicks alarm icon → `showSnoozedItems` true.
2. `inbox-list-view` mounts `<InboxRemindersList>`; the panel hook fires
   `reminders.list({status:['pending','snoozed']})` and reads snoozed +
   fired inbox items already in renderer state.
3. Hook returns `{ upcoming, past }`; list renders two sections.
4. Reminder/inbox events invalidate the underlying queries (already wired
   in `use-reminders` and inbox hooks) → panel re-derives.
5. Row click → `openReminderTarget(entry)` → `openTab(...)`; for fired
   reminder inbox items, also mark viewed (preserve current behavior).

## Error handling

- `reminders.list` failure: panel hook surfaces loading/error; list shows
  a muted error row, Past (from already-loaded inbox items) still renders.
- Missing target (deleted note/task): `targetExists` is false from the
  resolver; row still lists with its stored `targetTitle`, click is a
  no-op or shows a toast. Reuse whatever `ReminderDetail` does today.

## Testing (TDD)

Write tests first for each unit.

1. `use-inbox-reminders-panel` — fixtures covering pending reminder,
   snoozed reminder, future-snoozed inbox item, fired reminder inbox
   item, and a pending+future-snoozed collision. Assert: correct group
   membership, ascending Upcoming / descending Past ordering, dedupe.
2. `inbox-reminders-list` — render with mocked picker per the repo
   convention; assert both sections, counts, row labels per kind, and
   that `onOpen` fires with the right entry on click.
3. `open-reminder-target` — one case per `targetType` (note, highlight,
   journal, task) asserting the `openTab` payload shape, including task
   `openTaskId` + `selectedProjectId` and highlight viewState.
4. Regression: existing `reminder-detail` tests stay green after the
   navigation extraction.

## Verification

- `pnpm --filter @memry/desktop test:renderer` (new + existing green)
- `pnpm typecheck`
- `pnpm lint`
- `pnpm --filter @memry/desktop i18n:check`
- Manual: set a reminder on a task and a note (future), snooze an inbox
  item, let one reminder fire; open alarm panel → scheduled ones in
  Upcoming, fired one in Past, badge = Upcoming count; click each row →
  opens the right note/task/journal.

## Scope / non-goals (v1)

- Click-through only. No inline reschedule, cancel, or re-snooze from the
  panel.
- No new IPC, no server-side aggregation.
- Past has no time cap and does not surface `dismissed` reminders.
- No bulk select / no checkboxes in this view.
- No change to the off (triage) state of the inbox list.
