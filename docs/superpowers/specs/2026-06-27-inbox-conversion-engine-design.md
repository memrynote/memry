# Inbox Conversion Engine + Event Entity

**Date:** 2026-06-27
**Status:** Approved design
**Branch:** inbox-conversion-engine

## Problem

The Inbox is a triage layer between raw capture and the rest of MemryNote, but today
the only durable exit is **filing into a note or folder** (`FilingAction = 'folder' |
'note' | 'linked'`). Every captured item effectively "becomes a note." Damian Newton's
feedback: captured items should be able to turn into the thing they actually represent —
a **task** (has an action / owner / priority / due date), a **calendar event** (belongs
to a specific time window), a **note** (context / reference), or a **reminder** (should
come back later but isn't a full task yet).

The Inbox must stay a **temporary processing surface**, not another permanent database.
Conversion consumes an item out of the active inbox into its right durable home, with a
provenance back-link so the user can always see what it became.

This spec is **layer 1 of 3**. Segmentation buckets (Suggested-task / Suggested-calendar
/ Suggested-note) and Agent-assisted triage are deferred to their own later specs. This
layer builds the durable destinations the other two layers route into.

## Goal

1. Introduce a first-class **Event** entity (a new synced item type) and render it on the
   calendar as a basic chip.
2. Add a **conversion engine** so a text/voice inbox item can be converted to a **task**,
   **event**, or **reminder** (note/folder already exist), consuming the item out of the
   active inbox with a provenance back-link.

A "calendar event" has no native home in Memry today — the calendar is a projection over
tasks (due date/time), reminders, and dated notes (`note_date`). Per decision, we add a
**real Event entity** rather than overloading tasks or notes, because an event is a block
of time you attend, not a to-do you complete.

## Decisions (resolved during brainstorming)

- **Single target, mutually exclusive.** Converting picks exactly one destination. An
  item does not become "both a task and an event." A task with a due date still appears on
  the calendar (task chip), but it is a task, not an event.
- **Event = new first-class entity** (chosen over timed-task or dated-note). Sade calendar
  block, no completion checkbox.
- **Event entity now + task/reminder conversion too; calendar render minimal** (basic
  chip). Drag/resize/all-day-row polish, recurrence, attendees, invites are deferred.
- **Reminder conversion = note + reminder** (option A). A reminder has no standalone
  existence in Memry (`reminders.create` requires a `targetType`/`targetId`), so converting
  to a reminder creates a note to hold the content and attaches a time-based reminder to it.
- **Binary captures (image/pdf/video/clip) → Note / Folder / Archive only.** Task / Event
  / Reminder are disabled for binary items — a raw file has no action or time semantics.
  The existing binary filing path (`linkBinaryToNotes`) already embeds the file into a vault
  note; that note can then have a task/reminder attached by hand. "Keep as reference" is not
  a new action here — it is the existing leave-in-inbox / file-to-folder behavior. **Voice**
  items use their `transcription` as the text source and get the full menu.
- **No automatic date parsing.** Conversion forms pre-fill title + content; the user fills
  dates/times. NLP date extraction is layer-3 (Agent) work.
- **Architecture: conversion = new filing actions** (reuse `markItemAsFiled` +
  `recordFilingHistory` + `FILED` emit), not a parallel subsystem and not a generic
  destination registry (YAGNI for three known targets).

## Non-Goals (YAGNI / deferred)

- Segmentation buckets (Unprocessed / Suggested-task / Suggested-calendar / Suggested-note
  / Snoozed / Done) — **layer 2**.
- Agent triage: auto-classification, destination suggestion + reason, title/date
  extraction, batch approve/edit/ignore, resurfacing — **layer 3**.
- Date/time NLP parsing from capture text.
- Calendar event drag / resize / all-day-row polish.
- Event recurrence, attendees, invitations, built-in reminders on events.
- File attachments directly on tasks/events (binaries go through a note).
- Reverse provenance (`sourceInboxItemId` on the durable artifact) — the inbox row's
  `filedTo` is enough until layer-3 "resurface" needs the reverse link.

## Existing pieces this reuses

- `main/inbox/filing.ts` — `markItemAsFiled(itemId, filedTo, filedAction)` (updates the
  row, clears snooze, publishes `inbox.upserted`, emits `FILED`; never deletes),
  `recordFilingHistory(...)` (feeds AI suggestions), `linkBinaryToNotes(...)`,
  `isBinaryType(...)`.
- `main/tasks/domain.ts` — `createDesktopTasksDomain(db, publisher, generateId)`; task
  model has `title, description, priority, projectId, dueDate, dueTime, sourceNoteId`.
- `main/vault/notes-crud.ts` — `createNote({ title, content, folder?, tags?, properties? })`.
- Reminders IPC — `reminders.create({ targetType, targetId, remindAt, title?, note? })`.
- Calendar projection + `CalendarProjectionItem` and its exhaustive visual-type Records
  (colors, visual-type-meta, `VISUAL_TYPE_ICONS` in `calendar-item-chip.tsx`).
- Sync handler registry — `getHandler(type)` in `main/sync/item-handlers/`, field-level
  vector-clock pattern (same as tasks/projects). Follow the `adding-sync-item-type` skill.
- IPC contract flow — `packages/contracts`, `packages/rpc`, preload `index.d.ts`; run
  `pnpm ipc:generate` then `pnpm ipc:check` (see `ipc-contract-change` skill).

## Design

### Part A — Event entity (new synced type)

Follow the `adding-sync-item-type` skill end-to-end.

**Schema** (`packages/db-schema`, data DB):

```ts
// events table
{
  id: string // pk
  title: string
  description: string | null
  startAt: string // ISO datetime
  endAt: string | null // ISO datetime; null = open-ended
  allDay: boolean // default false
  location: string | null
  color: string | null // null → default event color
  createdAt: string
  modifiedAt: string
  // + field-level vector-clock sync columns, same pattern as tasks/projects
}
```

- Migration via `pnpm --filter @memry/desktop db:generate`. Known gotcha (from prior
  importer/tag work): a malformed Drizzle snapshot can block generation — hand-write the
  migration + journal entry if `db:generate` chokes.
- `SyncItemType` union `+= 'event'`. Add the handler in `main/sync/item-handlers/` and
  register it. Resolve every non-exhaustive switch/array the typecheck surfaces.

**Main module** (`main/events/`): thin `create / update / delete / listInRange` over
queries + a sync publisher. No separate domain package unless the sync handler pattern
forces one — keep it minimal (events have no sub-entities or status machine).

**Calendar projection:** a `loadEventItems(range)` source mapping each event to a
`CalendarProjectionItem` with a new `visualType: 'event'`. Update the three exhaustive
Records (colors, visual-type-meta, `VISUAL_TYPE_ICONS`) and the `'event'` i18n key. Render
= basic chip (timed at `startAt`; all-day events in the all-day row if present). Defer
drag/resize.

**Contracts / preload / IPC:** `events:create | update | delete | listInRange` channels,
typed in contracts + rpc, exposed on `window.api.events`. Regenerate the IPC invoke map.

**Minimal UI:** a small create/edit Event dialog (title, start, end, all-day, location,
notes) reachable from the calendar, so events are creatable directly and not only via
inbox conversion.

### Part B — Conversion engine

**Extend `FilingAction`:** `'folder' | 'note' | 'linked' | 'task' | 'event' | 'reminder'`
across `packages/contracts`, `packages/rpc`, `packages/domain-inbox`, and the inbox schema
column type. Widen `markItemAsFiled` and `recordFilingHistory` action params to match.

**New module `main/inbox/convert.ts`** — each function: build the durable record, then
reuse `markItemAsFiled` + `recordFilingHistory` + `FILED` emit. No new consume/emit
plumbing.

```
convertToTask(itemId, { title, projectId, dueDate?, dueTime?, priority? })
  → tasksDomain.createTask({ title, description: content, projectId, dueDate?, dueTime?, priority? })
  → markItemAsFiled(itemId, taskId, 'task')

convertToEvent(itemId, { title, startAt, endAt?, allDay, location? })
  → events.create({ title, description: content, startAt, endAt?, allDay, location? })
  → markItemAsFiled(itemId, eventId, 'event')

convertToReminder(itemId, { title, remindAt })          // option A
  → createNote({ title, content })
  → reminders.create({ targetType: 'note', targetId: noteId, remindAt, title })
  → markItemAsFiled(itemId, noteId, 'reminder')
```

- `content` = `item.content`, or `item.transcription` for voice items.
- **Guard:** if `isBinaryType(item.type)`, reject task/event/reminder with a clear error;
  only note/folder filing is valid for binaries. The UI gates the buttons accordingly.
- Reject if the item is already filed (mirror `linkToNotes`).

**IPC:** one channel `inbox:convert` with a discriminated-union payload
`{ itemId, target: 'task' | 'event' | 'reminder', payload }`, dispatched to the matching
`convertTo*`. One handler, three shapes. Regenerate + `ipc:check`.

### Part C — Inbox UI

- **Detail panel** (filing section): a "Convert to" row above the existing file-to
  note/folder controls — buttons **Task / Event / Reminder / Note**. For binary items only
  **Note** is enabled; the others are disabled with a tooltip ("Only text & voice can
  become a task/event/reminder").
- Each button opens a **compact, pre-filled inline form** (popover/sheet): title from the
  item, content carried into description/notes. Task reuses add-task field components
  (lite); Event uses the new minimal event form; Reminder = note title + datetime picker.
- On success: the item leaves the active list (now `filed`), toast
  **"Converted to {target} · [Open]"** linking the new artifact.
- **Filed/Done view:** each filed item shows a badge (→ Task / Event / Reminder / Note);
  clicking opens the target.

## Data flow (convert to event)

```
user edits inbox capture "Thu 15:00 budget meeting with Ayşe"
  → clicks Convert → Event → fills start/end → Create
  → renderer: window.api.inbox.convert({ itemId, target: 'event', payload })
  → main inbox:convert handler → convertToEvent(itemId, payload)
      → events.create(...)                         // new synced row, propagates to devices
      → markItemAsFiled(itemId, eventId, 'event')  // clears snooze, emits FILED, projection event
      → recordFilingHistory('note'|item.type, content, eventId, 'event', tags)
  → calendar projection picks up the event → basic chip at Thu 15:00
  → inbox list removes the item from active → appears in Done with "→ Event" badge
```

## Components / boundaries

- `packages/db-schema/src/schema/events.ts` — table + types.
- `main/events/` — `create / update / delete / listInRange` + sync publisher.
- `main/sync/item-handlers/event-handler.ts` — registered sync handler.
- Calendar projection source for events + visual-type wiring.
- `main/inbox/convert.ts` — the three `convertTo*` functions (the only inbox-side
  behavior change; filing.ts gains only the widened action enum).
- Contracts/rpc/preload type changes for `FilingAction`, `inbox:convert`, and the events
  channels.
- Renderer: convert row + three forms in the inbox detail panel; minimal event
  create/edit dialog on the calendar; filed-badge rendering.

## Testing

- **convert.ts (main):** each `convertTo*` creates the right durable record, marks the
  item filed with the correct action + target id, records filing history, and is idempotent
  against already-filed items. Binary guard rejects task/event/reminder.
- **events (main):** create/update/delete/listInRange round-trip; range query returns
  events overlapping the window.
- **sync handler:** event encode/decode + field-level merge follows the tasks/projects
  handler tests; harness stays green.
- **calendar projection:** an event maps to a `CalendarProjectionItem` with
  `visualType: 'event'` at the right time.
- **renderer:** the convert row gates binary items to Note only; converting emits the IPC
  call with the right discriminated payload.
- Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test:desktop`, `pnpm ipc:check`,
  `pnpm check:architecture`, `pnpm docs:impact --base <base> --strict`, `pnpm docs:build`.

## Open questions

None blocking. Resolved: event target (new entity), sequencing (entity + conversions now,
calendar polish later), reminder mapping (note + reminder), binary handling (note-only),
single-target semantics, no auto date parsing.
