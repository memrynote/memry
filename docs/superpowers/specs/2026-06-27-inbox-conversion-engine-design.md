# Inbox Conversion Engine

**Date:** 2026-06-27
**Status:** Approved design (corrected — supersedes the original "new Event entity" draft)
**Branch:** inbox-conversion-engine

## Correction notice

The first draft of this spec proposed building a new first-class Event entity. That was
based on a wrong reading of the codebase. In reality:

- A full **`calendar_events`** entity already exists — synced (own sync handler, in every
  sync array), with a repository (`upsertCalendarEvent`), calendar projection/render, a
  quick-create dialog, and Google Calendar two-way sync.
- Inbox **`convertToNote`** and **`convertToTask`** already exist (IPC `CONVERT_TO_NOTE` /
  `CONVERT_TO_TASK`, wired in `inbox-handlers.ts`, tested in `filing.test.ts`).

So there is **no new entity, no sync wiring, and no calendar build** in this work. The
feature is purely the missing inbox conversions plus a provenance cleanup and UI.

## Problem

The Inbox is the triage layer between raw capture and the rest of MemryNote. Damian
Newton's feedback: a captured item should turn into the thing it represents — a **task**,
a **calendar event**, a **note**, or a **reminder** — consuming it out of the active inbox
into its right durable home, with a provenance back-link. The Inbox must stay a temporary
processing surface, not a permanent database.

Today the inbox can convert to **note** and **task** only, and `convertToTask` is minimal
(always the Inbox project, priority 0, no due date) and fakes provenance (files as
`filedAction:'note'` with `filedTo:'task:<id>'` because the `task` filing action was never
added).

This is **layer 1 of 3**. Segmentation buckets and Agent-assisted triage are separate
later specs.

## Goal

1. **`convertToEvent`** — turn a text/voice inbox item into a calendar event by calling the
   existing `calendar_events` create path.
2. **`convertToReminder`** — turn an item into a note with a time-based reminder attached
   (a reminder has no standalone existence; it needs a target).
3. **Richer `convertToTask`** — accept optional target project / due date / due time /
   priority instead of always Inbox-project / priority-0.
4. **Real provenance** — extend `FilingAction` with `task | event | reminder`, store the
   real target id in `filedTo`, and replace the `task:<id>` hack. Filed items show the
   correct "→ Task / Event / Reminder / Note" badge.
5. **UI** — Event + Reminder buttons (and the task options) in the inbox convert surface,
   with minimal forms; binary items gated to Note only.

## Decisions (resolved during brainstorming)

- **Single target, mutually exclusive.** One destination per conversion. A due-dated task
  still appears on the calendar as a task chip, but it is a task, not an event.
- **Reminder = note + reminder** (option A). `convertToReminder` creates a note to hold the
  content, then `remindersService.n({ targetType:'note', targetId:noteId, remindAt })`.
- **Binary captures (image/pdf/video/clip) → Note only.** Task/Event/Reminder are disabled
  for binaries — a raw file has no action or time semantics. **Voice** items use their
  `transcription` as the text source and get the full menu.
- **No automatic date parsing.** Forms pre-fill title + content; the user fills dates/times.
  NLP extraction is layer-3 (Agent) work.
- **Architecture: conversion stays in the existing filing module** — new `convertToEvent` /
  `convertToReminder` sit beside `convertToNote` / `convertToTask` in `main/inbox/filing.ts`
  and reuse `markItemAsFiled` + `recordFilingHistory` + emit. No parallel subsystem, no
  generic registry (YAGNI).
- **Local events.** `convertToEvent` creates a local calendar event (no `targetCalendarId`).
  Google push only happens if the user already has a calendar binding — unchanged behavior.

## Non-Goals (YAGNI / deferred)

- Any new entity, table, sync handler, or calendar rendering — all already exist.
- Segmentation buckets (Unprocessed / Suggested-task / Suggested-calendar / Suggested-note
  / Snoozed / Done) — **layer 2**.
- Agent triage: auto-classification, suggestion + reason, title/date extraction, batch
  approve/edit/ignore, resurfacing — **layer 3**.
- Date/time NLP parsing from capture text.
- Recurrence / attendees / Google push UI on converted events (the `calendar_events` schema
  supports them, but conversion sets only the basic fields).
- Reverse provenance (`sourceInboxItemId` on the artifact) — the inbox row's `filedTo` is
  enough until layer-3 "resurface".

## Existing pieces this reuses

- `main/inbox/filing.ts` — `convertToNote`, `convertToTask`, `markItemAsFiled(itemId,
filedTo, filedAction)`, `recordFilingHistory(...)`, `getInboxItem`, `getItemTags`,
  `generateNoteTitle`, `generateNoteContent`, `extractItemProperties`, `isBinaryType`,
  `createNote`.
- `main/calendar/repositories/calendar-events-repository.ts` — `upsertCalendarEvent(db,
NewCalendarEvent): CalendarEvent`.
- `main/calendar/runtime-effects.ts` — `syncCalendarEventCreate(eventId)`.
- `CalendarChannels.events.CHANGED` — calendar refresh event.
- Reminders (main) — `remindersService.n({ targetType, targetId, remindAt, title?, note? })`
  (the create used in `reminder-handlers.ts`; throws on past `remindAt`, so guard/skip).
- Tasks queries — `insertTask`, `getNextTaskPosition`, `setTaskTags`, `getInboxProject`
  (already used by `convertToTask`); `syncTaskCreate`; `TasksChannels.events.CREATED`.
- `packages/contracts/src/ipc-channels.ts` `InboxChannels` + the `ipc-contract-change` skill.

## Design

### Part A — `FilingAction` extension (provenance)

Widen the union in all three definitions to
`'folder' | 'note' | 'linked' | 'task' | 'event' | 'reminder'`:

- `packages/contracts/src/inbox-api.ts:32`
- `packages/rpc/src/inbox.ts:22`
- `packages/domain-inbox/src/types.ts:13`

Widen the `filedAction` parameter type on `markItemAsFiled` and `recordFilingHistory` in
`main/inbox/filing.ts` to the same union. Update `convertToTask` to call
`markItemAsFiled(itemId, taskId, 'task')` and `recordFilingHistory(item.type, item.content,
taskId, 'task', mergedTags)` — `filedTo` is now the bare `taskId`, not `task:<id>`.

The inbox DB column is free-text, so no migration. The renderer reads `filedAction` to pick
the badge (Part D).

### Part B — `convertToEvent`

```ts
// main/inbox/filing.ts
export async function convertToEvent(
  itemId: string,
  input: { startAt: string; endAt?: string | null; isAllDay?: boolean; location?: string | null }
): Promise<{ success: boolean; eventId: string | null; error?: string }>
```

- Reject if item not found, already filed, or `isBinaryType(item.type)`.
- `content` = `item.content` (or `item.transcription` for voice).
- Build a `NewCalendarEvent`: `{ id: generateId(), title: generateNoteTitle(item),
description: content, location: input.location ?? null, startAt: input.startAt,
endAt: input.endAt ?? null, timezone: 'UTC', isAllDay: input.isAllDay ?? false,
createdAt: now, modifiedAt: now }`.
- `upsertCalendarEvent(db, row)` → `syncCalendarEventCreate(id)` (guard in try/catch like
  the IPC handler) → emit `CalendarChannels.events.CHANGED`.
- `markItemAsFiled(itemId, id, 'event')` + `recordFilingHistory(item.type, item.content, id,
'event', mergedTags)`.

### Part C — `convertToReminder`

```ts
// main/inbox/filing.ts
export async function convertToReminder(
  itemId: string,
  input: { remindAt: string }
): Promise<{ success: boolean; noteId: string | null; error?: string }>
```

- Reject if item not found, already filed, or binary.
- Create the note exactly as `convertToNote` does (`createNote({ title, content, tags:
mergedTags, properties })`).
- `remindersService.n({ targetType: 'note', targetId: note.id, remindAt: input.remindAt,
title })`. Guard: if `remindAt` is in the past, return an error (the service throws on
  past times).
- `markItemAsFiled(itemId, note.path, 'reminder')` + `recordFilingHistory(..., note.path,
'reminder', mergedTags)`.

### Part D — richer `convertToTask`

Change the signature to accept options; keep current behavior as the default:

```ts
export async function convertToTask(
  itemId: string,
  input?: {
    projectId?: string
    dueDate?: string | null
    dueTime?: string | null
    priority?: number
  }
): Promise<{ success: boolean; taskId: string | null; error?: string }>
```

- `projectId` defaults to `getInboxProject(db).id`; `priority` defaults to `0`; `dueDate`/
  `dueTime` default to `null`. Pass them into `insertTask`.
- Provenance fixed per Part A (`'task'`, bare `taskId`).

### Part E — IPC

- `InboxChannels.invoke`: add `CONVERT_TO_EVENT = 'inbox:convert-to-event'`,
  `CONVERT_TO_REMINDER = 'inbox:convert-to-reminder'`. `CONVERT_TO_TASK` now passes the
  options object.
- `inbox-handlers.ts`: register the two new handlers (and pass options through to
  `convertToTask`); add the matching `removeHandler` calls in teardown.
- Expose `convertToEvent` / `convertToReminder` (and the new `convertToTask` arg) on the
  inbox domain (`main/inbox/domain.ts`) and `window.api.inbox` (preload). Run
  `pnpm ipc:generate` then `pnpm ipc:check`.

### Part F — Inbox UI

In the inbox detail panel's convert/filing surface:

- Add **Event** and **Reminder** buttons next to the existing Note/Task actions, and a small
  options form per target:
  - **Task:** target project select · due date · due time · priority (all optional).
  - **Event:** start (required) · end · all-day · location.
  - **Reminder:** datetime (required, must be future).
- For binary items (`isBinaryType`), enable **Note** only; disable Task/Event/Reminder with
  a tooltip ("Only text & voice can become a task/event/reminder").
- On success: toast "Converted to {target} · [Open]" (Open routes to the task / calendar /
  note). The item leaves the active list (filed).
- Filed/Done view: badge from `filedAction` (→ Task / Event / Reminder / Note); clicking
  opens the target.

## File map

- Modify `packages/contracts/src/inbox-api.ts`, `packages/rpc/src/inbox.ts`,
  `packages/domain-inbox/src/types.ts` — `FilingAction` union.
- Modify `packages/contracts/src/ipc-channels.ts` — two new `InboxChannels.invoke` ids.
- Modify `apps/desktop/src/main/inbox/filing.ts` — `convertToEvent`, `convertToReminder`,
  richer `convertToTask`, widened `markItemAsFiled` / `recordFilingHistory` action types.
- Modify `apps/desktop/src/main/inbox/domain.ts` + `index.ts` — export the new functions.
- Modify `apps/desktop/src/main/ipc/inbox-handlers.ts` — register/unregister handlers.
- Modify the inbox preload api + regenerate the IPC invoke map.
- Modify the inbox detail panel renderer + add the per-target forms + filed badges.
- Tests: extend `apps/desktop/src/main/inbox/filing.test.ts`.

## Testing

- **filing.test.ts (main):**
  - `convertToEvent` creates a `calendar_events` row with the right fields, marks the item
    filed as `'event'` with `filedTo = eventId`, records history, is idempotent against
    already-filed items, and rejects binary items.
  - `convertToReminder` creates a note + a `note`-target reminder, files as `'reminder'`,
    rejects a past `remindAt` and binary items.
  - `convertToTask` honours `projectId` / `dueDate` / `dueTime` / `priority`, defaults to
    Inbox project / 0 / null, and now files as `'task'` with bare `taskId`.
- **renderer:** the convert surface gates binary items to Note; each button fires the right
  IPC with the right payload; filed badge reflects `filedAction`.
- Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test:desktop`, `pnpm ipc:check`,
  `pnpm check:contracts`, `pnpm check:architecture`,
  `pnpm docs:impact --base origin/main --strict`, `pnpm docs:build`.

## Open questions

None blocking. Resolved: reuse existing `calendar_events` (no new entity), reminder = note +
reminder, binary → note-only, single-target, richer task, no auto date parsing.
