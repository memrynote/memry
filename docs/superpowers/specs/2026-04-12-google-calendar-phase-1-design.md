# Google Calendar Phase 1 Design

## Goal

Add a first-class calendar experience to Memry with:

- a new top-level `Calendar` workspace
- day, week, month, and year views
- first-class Memry events
- calendar data synchronized across Memry devices
- Google Calendar import and two-way sync
- task, reminder, and inbox snooze items visible and editable from calendar

Phase 1 starts with Google Calendar only, but the design should not trap the product in a Google-specific model.

## Product Decisions

The following decisions were validated during brainstorming:

- Use a new top-level `Calendar` workspace. Journal keeps compact schedule panels, but it is not the primary calendar surface.
- Add a first-class Memry `event` entity instead of treating imported Google records as the only event model.
- Sync Memry calendar data across Memry devices in phase 1.
- Import one or more user-selected Google calendars for normal events.
- Create and manage a dedicated Google `Memry` calendar for Memry-owned items.
- Google edits should write back broadly where supported.
- Task calendar presence is canonical, not a separate planning-slot model.
- A task with only `dueDate` appears on calendar on that date.
- A task with `dueDate` but no `dueTime` appears as an all-day item.
- Dragging a task in calendar changes the task’s real due datetime.
- Moving a reminder or snoozed inbox item in calendar updates `remindAt` or `snoozedUntil`.
- Deleting a task-backed/reminder-backed/snooze-backed Google event clears calendar-driving schedule data in Memry rather than deleting the underlying source record.
- If a task moves from an all-day due marker to a timed calendar position, the timed due datetime replaces the all-day representation.

## Current Codebase Context

The design fits the current repository shape instead of replacing it:

- Tasks are already a mature native domain with SQLite storage, IPC contracts, and record sync.
  - `packages/db-schema/src/schema/tasks.ts`
  - `packages/contracts/src/tasks-api.ts`
  - `apps/desktop/src/main/sync/task-sync.ts`
  - `apps/desktop/src/main/sync/item-handlers/task-handler.ts`
- Reminders are a separate native domain with their own schema, scheduler, IPC surface, and notification flow.
  - `packages/db-schema/src/schema/reminders.ts`
  - `packages/contracts/src/reminders-api.ts`
  - `apps/desktop/src/main/lib/reminders.ts`
- Inbox snooze is a separate native capability backed by inbox storage and a dedicated scheduler.
  - `apps/desktop/src/main/inbox/snooze.ts`
- Google OAuth and token refresh infrastructure already exist for Memry sync.
  - `apps/desktop/src/main/ipc/sync-handlers.ts`
  - `apps/desktop/src/main/sync/token-manager.ts`
- The current “schedule” UX in journal is not yet backed by real calendar data.
  - `apps/desktop/src/renderer/src/components/journal/journal-day-panel.tsx`
  - `apps/desktop/src/renderer/src/components/journal/day-context-sidebar.tsx`
  - `apps/desktop/src/renderer/src/components/journal/floating-day-context.tsx`
- There is no first-class calendar workspace and no week view today.

This means phase 1 should add a calendar system that composes existing domains rather than flattening them into a single rewritten model.

## Recommended Architecture

Use a unified calendar projection layer.

Memry should have one calendar engine that reads from multiple source domains:

- Memry events
- tasks
- reminders
- snoozed inbox items
- imported Google events

Those sources are normalized into one shared calendar item shape for the UI, but the native source records remain authoritative in their own domains.

### Why this architecture

This is the best fit for the codebase because:

- tasks, reminders, and inbox snooze already have distinct behavior and sync semantics
- the renderer needs one consistent source for day/week/month/year rendering
- Google should be a provider binding, not the source of truth for calendar UX
- future Apple/Outlook support becomes an adapter problem rather than a product-model rewrite

### What we are not doing

- We are not making Google the canonical store for normal events.
- We are not rewriting tasks, reminders, and snoozes into one physical event table.
- We are not introducing a separate “task planning slot” object in phase 1.
- We are not making journal an equal full-featured calendar surface in phase 1.

## Domain Model

### 1. First-class Memry events

Add a new native `calendar_events` entity for true events created or primarily owned inside Memry.

Expected fields:

- `id`
- `title`
- `description`
- `location`
- `startAt`
- `endAt`
- `timezone`
- `isAllDay`
- `recurrenceRule` or equivalent recurring config
- `recurrenceExceptions` or equivalent occurrence override storage
- `createdAt`
- `modifiedAt`
- `archivedAt`
- sync clock metadata because Memry calendar data participates in encrypted record sync in phase 1

This entity exists so Memry can create and manage real events offline-first, independent of Google.

### 2. Provider account and calendar-source metadata

Add provider metadata to represent:

- connected Google account(s)
- selected imported Google calendars
- the dedicated Google `Memry` calendar id
- per-calendar sync status and cursors

This should not be embedded into tasks, reminders, or events directly.
The shareable provider-link metadata should sync across Memry devices, but Google access/refresh
tokens should remain device-local in the OS keychain.

### 3. External event cache

Add storage for imported provider events so Memry can:

- render imported Google calendars offline
- track remote ids, etags, and updated timestamps
- normalize remote data for projection and conflict handling
- sync imported calendar visibility across Memry devices even if only one device is currently
  connected to Google

Imported Google events stay imported event records. They do not become tasks automatically.

### 4. Generic sync binding table

Add a generic binding model linking one Memry source record to one remote provider event.

Required concepts:

- `sourceType`
  - `event`
  - `task`
  - `reminder`
  - `inbox_snooze`
- `sourceId`
- `provider`
- `remoteCalendarId`
- `remoteEventId`
- ownership/write-back mode
- last synced remote version metadata
- last local snapshot metadata needed for conflict handling

This binding layer is what enables Google to edit native Memry records without duplicating those records into a fake event table.

## Cross-Device Sync Boundary

Phase 1 calendar data should sync across Memry devices through the existing encrypted record-sync
pipeline.

Sync through Memry:

- `calendar_events`
- shareable provider-link and selected-calendar metadata
- imported external event cache
- calendar bindings that link native Memry records to provider events

Remain device-local:

- Google access tokens
- Google refresh tokens
- loopback OAuth session state
- transient provider job state that is only meaningful to one running device

Implications:

- any device can render the latest synced calendar state, even if that device has not completed
  Google Calendar auth yet
- any device with Google auth can refresh imported calendars and push/write back changes using the
  shared synced bindings and source metadata
- Memry events created on one device appear on other devices through Memry sync, not only after a
  Google roundtrip

## Projection Model

Create a projection layer that converts native records plus imported provider records into one renderer-facing calendar item shape.

Each projected item should include:

- stable projection id
- source type
- source id
- title
- description preview
- `startAt`
- `endAt`
- `isAllDay`
- timezone
- editability flags
- ownership/source metadata
- provider binding info
- visual classification for UI styling

Example source classifications:

- imported Google event
- Memry event
- task
- reminder
- snoozed inbox item

The projection layer is the shared source for:

- Calendar day view
- Calendar week view
- Calendar month view
- Calendar year summaries
- Journal compact schedule surfaces

## UX Design

### Top-level Calendar workspace

Add a new primary `Calendar` workspace in the desktop app.

This becomes the main editing surface for:

- events
- task due scheduling
- reminders
- snoozed inbox items
- imported Google events

### Views

#### Day view

Primary detail surface for:

- all-day lane
- hourly timeline
- drag/drop and resize
- quick event creation

#### Week view

Primary planning surface for cross-day scheduling and movement.

Behavior should closely match day view, but expanded across the week.

#### Month view

Density and overview surface.

It should show:

- all-day and due-only items clearly
- summarized timed-item density
- enough affordance to create, inspect, and reposition dates

#### Year view

Navigation and density surface rather than a full editing surface.

It should help users:

- jump quickly between months/days
- understand event/task/reminder density
- preserve the useful long-range scan behavior already present in journal year UX

### Journal reuse

Journal day context should reuse the same projection layer in compact form.

That replaces current dummy schedule behavior with real data while avoiding two competing full calendar products in phase 1.

## Source Behavior Rules

### Events

Memry events can be created directly in Memry and sync to the dedicated Google `Memry` calendar.

Imported Google events appear in Memry and remain associated with their original Google calendar.

### Tasks

Tasks remain tasks. They do not get replaced by event records.

Rules:

- `dueDate` with no `dueTime` -> all-day calendar item
- `dueDate` + `dueTime` -> timed calendar item
- dragging/moving a task in calendar edits `dueDate`/`dueTime`
- deleting the Google mirror clears the task’s calendar-driving due scheduling fields

Phase 1 intentionally uses the due datetime as the task’s canonical calendar meaning.

### Reminders

Reminders remain reminders.

Rules:

- `remindAt` becomes the calendar datetime
- moving the item in Memry or Google updates `remindAt`
- deleting the Google mirror clears reminder calendar presence rather than deleting the reminder target itself

### Snoozed inbox items

Snoozed inbox items remain inbox items.

Rules:

- `snoozedUntil` becomes the calendar datetime
- moving the item updates `snoozedUntil`
- deleting the Google mirror clears snooze scheduling rather than deleting the inbox item

## Google Calendar Integration Boundary

### Import side

Users can choose one or more Google calendars to import into Memry.

Imported events:

- are visible in Memry calendar
- participate in filtering/toggling by source calendar
- can be edited from Memry where supported
- remain external provider events rather than becoming Memry tasks or reminders

### Publish side

Memry creates and manages a dedicated Google `Memry` calendar for Memry-owned items:

- Memry events
- task-derived items
- reminder-derived items
- snooze-derived items

This avoids polluting a user’s main calendar while keeping Memry-authored items visible in Google.

### Write-back policy

Phase 1 should support broad write-back where supported:

- schedule changes
- all-day/timed conversion
- title
- description
- recurrence for event-capable sources

Not every field maps to every source type. For non-event sources, only fields that have a meaningful home in the native record should be written back.

## Deletion Semantics

Deletion must respect the native source record.

### Imported Google event deleted

- Remove or tombstone the imported provider event in Memry.

### Memry event deleted in Google

- Archive/remove the linked Memry event according to final product decision during implementation.

### Task/reminder/snooze mirror deleted in Google

- Clear the native schedule-driving datetime in Memry.
- Do not delete the underlying task/reminder/inbox item.

This preserves user intent: removing calendar presence is not equivalent to deleting the source object.

## Sync and Conflict Handling

### Sync directions

There are three flows:

1. Import Google calendars into cached external event storage
2. Publish Memry-owned items to the dedicated Google `Memry` calendar
3. Write Google edits back to the authoritative Memry source record
4. Sync Memry calendar events, shared provider metadata, imported event cache, and bindings across
   Memry devices through encrypted record sync

### Conflict policy

Phase 1 should use a pragmatic conflict model:

- track remote version metadata such as etag / updated timestamp
- track enough local sync metadata to know what changed since last sync
- use last-write-wins for schedule fields when concurrent edits occur
- use existing Memry record clocks for device-to-device merges of syncable calendar records
- log conflict details for diagnostics

Do not build a human conflict resolution UX in phase 1.

### Recurrence policy

Memry events should support recurrence in phase 1 because users can create and edit events directly in Memry and Google.

Tasks should keep their existing repeating-task behavior rather than inventing a second recurrence engine inside calendar.

Calendar should mirror the active task occurrence rather than redefining the task system.

## Error Handling Expectations

The calendar feature must degrade gracefully when Google is unavailable.

Key expectations:

- Calendar workspace still renders local Memry items offline
- Imported Google events render from cached provider state when possible
- devices without local Google auth still render the latest synced calendar cache
- provider sync failures do not corrupt native tasks/reminders/snoozes/events
- failed write-backs are retried through a durable job/sync mechanism
- UI clearly distinguishes local edits pending remote sync from fully synced state

## Testing Requirements

Phase 1 needs explicit coverage across main process, renderer, and provider roundtrips.

### Backend / main-process tests

- event schema and repository behavior
- record-sync handlers/services for `calendar_event`, `calendar_source`, `calendar_binding`, and
  `calendar_external_event`
- projection query logic across day/week/month/year ranges
- Google import mapping
- Google publish mapping
- write-back mapping for:
  - event
  - task
  - reminder
  - inbox snooze
- delete semantics per source type
- conflict handling and remote version tracking

### Renderer tests

- Calendar workspace rendering
- day/week/month/year behavior
- drag/drop updates the correct native source fields
- all-day vs timed task rendering
- source toggles and calendar filters
- journal compact schedule uses real projected data

### End-to-end tests

- connect Google calendar account
- import selected calendars
- create Memry event and verify Google appearance
- verify a second Memry device receives synced calendar events/source selections/import cache
- move task in Memry and verify Google update
- move Google reminder mirror and verify local `remindAt` update
- delete Google mirror of snoozed item and verify local schedule clearing

## Scope Exclusions for Phase 1

- non-Google providers
- separate task planning-slot model
- full year-view editing
- journal as an equal full calendar workspace
- advanced human conflict-resolution UX

## Open Implementation Questions

These do not block the design, but implementation planning must settle them:

- how much provider progress metadata should be shared across devices versus kept per-device
- whether provider sync runs through the existing sync queue or a dedicated calendar job pipeline
- the exact recurrence representation shared between Memry events and Google mappings
- how much of Google event metadata beyond title/description/location is surfaced in phase 1

## Recommendation

Proceed with the unified calendar projection architecture:

- add first-class Memry events
- keep tasks/reminders/snoozes native
- bind all calendar-capable native records to Google through a generic sync-binding layer
- sync calendar events, imported cache, and shared provider metadata through the existing encrypted
  Memry record pipeline
- build one shared calendar projection that powers Calendar and journal compact schedule surfaces

This is the cleanest path that matches the current Memry architecture while leaving room for more providers later.
