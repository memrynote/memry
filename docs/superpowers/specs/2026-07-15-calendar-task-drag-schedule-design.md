# Calendar: drag tasks to schedule them

**Date:** 2026-07-15
**Branch:** `calendar-task-drag-schedule`
**Status:** Design approved, ready for implementation plan

## Problem

Tasks already appear on the calendar as chips, projected from `dueDate` in
`main/calendar/projection.ts:176-228`. But they cannot be dragged. The only way to
schedule or reschedule a task from the calendar is the click-driven popover
(`components/calendar/calendar-task-popover.tsx:94`).

Worse, there is no surface anywhere in the app that shows _unscheduled_ tasks. No query
selects `dueDate IS NULL` — `dueBefore`/`dueAfter` (`main/database/queries/tasks.ts:139-144`)
silently exclude NULL rows. So a task with no due date is invisible on the calendar page
and cannot be scheduled by direct manipulation at all.

## Goal

Schedule and reschedule tasks by dragging, from three sources:

1. An unscheduled-tasks rail (new).
2. A Tasks pane sitting beside the Calendar pane in split view.
3. Task chips already rendered on the calendar grid.

## Existing infrastructure

Much of this is already built or half-built. The design leans on it rather than
inventing parallel machinery.

| Piece                                            | State                | Location                                             |
| ------------------------------------------------ | -------------------- | ---------------------------------------------------- |
| Tasks projected onto calendar, `canMove: true`   | Working              | `main/calendar/projection.ts:185-227`                |
| dnd-kit wrapping the whole app                   | Working              | `contexts/drag-context.tsx`, mounted `App.tsx:586`   |
| `DropTargetType` includes `'date'`               | Declared, unused     | `contexts/drag-context.tsx:34-43`                    |
| Collision detection prioritizes date cells       | Written, unreachable | `contexts/drag-context.tsx:200-208`                  |
| `'calendar-task'` drag type recognized           | Written, unreachable | `contexts/drag-context.tsx:386,407`                  |
| a11y strings ("Release to reschedule")           | Written, unreachable | `contexts/drag-context.tsx:576,607`                  |
| Task rows draggable (list + kanban)              | Working              | `components/tasks/drag-drop/`                        |
| Multi-select + `MultiDragOverlay`                | Working              | `components/tasks/drag-drop/`                        |
| `handleSectionDrop(taskIds, targetDate)` w/ undo | Working              | `hooks/use-drag-handlers.ts:259-289`                 |
| Event move/resize on time grid                   | Working, tested      | `components/calendar/use-event-drag.ts`              |
| `data-date="YYYY-MM-DD"` on cells                | Working              | month `:85-87`, week `:378-381`, all-day `:312-315`  |
| Split view (Calendar ‖ Tasks)                    | Working              | `components/split-view/`                             |
| `GlobalDayPanel`, open by default                | Working              | `App.tsx:344`, `DayPanelProvider defaultOpen={true}` |

The dormant `'date'` droppable scaffolding indicates this feature was already anticipated.
This design completes it rather than routing around it.

## Key design decision: split by granularity, not by source

The calendar drags events with bespoke `document` mousemove handlers
(`use-event-drag.ts`, 15-min snap, live ghost, covered by `use-event-drag.test.ts`).
Tasks drag with dnd-kit. Rather than unify (which would mean rewriting shipped, tested
event move/resize for no user-visible gain), each system keeps a lane defined by
granularity:

- **dnd-kit owns date-granular drags** — rail → any cell, cross-pane row → any cell,
  all-day _task_ chip → date cell, month _task_ chip → month cell.
- **`useEventDrag` owns time-granular drags** — moves within the week/day time grid,
  where 15-min snapping and the live ghost matter.

Only **task** chips gain date-granular dragging. All-day _event_ chips and month-view
_event_ chips stay non-draggable, exactly as today — consistent with the month-view
non-goal below, and for the same reason (multi-day spans and recurrence).

The two systems never contend for the same gesture: dnd-kit handles drags _originating
outside_ the time grid, `useEventDrag` handles drags _originating on_ it.

The consequence that makes full coverage affordable: the all-day strip and month cells
are date-granular, so they need **no new bespoke drag system**. They become dnd-kit
draggables landing on the droppables the rail already requires. `useEventDrag`'s only
change is admitting tasks through its gate.

### Why this matters for the common case

`projection.ts:227` sets `isAllDay: !row.dueTime`. A task with a due date but no time —
the majority — projects as all-day and renders in the all-day strip. `useEventDrag`
gates on both `sourceType === 'event'` **and** `!item.isAllDay`
(`use-event-drag.ts:78-85`), and the all-day strip has no drag wiring at all. Without
covering all-day, the most common task would be the one that cannot be dragged.

## Architecture

### Data layer (additive — no migration)

1. **`packages/contracts/src/tasks-api.ts`** — `TaskListSchema` gains optional
   `unscheduled?: boolean`. Additive and optional, so older clients are unaffected.
   Requires `pnpm ipc:generate` then `pnpm ipc:check`.
2. **`main/database/queries/tasks.ts`** — `unscheduled: true` maps to
   `isNull(tasks.dueDate)`, composed with the existing completed/archived exclusions.

No schema change. No new sync fields. `dueDate` + nullable `dueTime` is already the
model for "due on a day" vs "scheduled at a time".

### Shared commit seam

3. **`handleDateDrop(taskIds, targetDate, options?)`** — the single point both drag
   systems converge on. **It already exists** (`use-drag-handlers.ts:425-464`) and already
   calls `onUpdateTask` per id, records one undo entry for the whole drop, preserves
   `dueTime`, and toasts single vs. multi. `handleDragEnd` already routes `case 'date':`
   to it (`:967-973`).

   Rather than add a parallel `commitTaskSchedule`, extend it with an optional
   `{ dueTime?: string | null }` — omitted preserves the current time (today's behavior,
   unchanged), `null` clears it, `'HH:MM'` sets it.

   One gap this opens: the undo action records only `previousDates`, so a drop that
   changes the time would undo the date but leave the time wrong. The `reschedule` undo
   action therefore also gains `previousTimes`, recorded only for time-changing drops so
   existing section drops keep their exact current behavior.

   Routing through `tasksService.update` is load-bearing for sync correctness. The domain
   path computes `changedFields` via `computeChangedFields`
   (`packages/domain-tasks/src/commands.ts:210-238`) and passes it to
   `publisher.taskUpdated` → `syncTaskUpdate(id, changedFields)`. A direct repository
   write would omit `changedFields`, and `task-sync.ts:81-86` falls back to
   `?? TASK_SYNCABLE_FIELDS` — bumping all 15 field clocks and clobbering concurrent
   remote edits to unrelated fields. Always go through the domain.

### Drop targets

4. **`use-calendar-date-droppable.ts`** (new) — one `useDroppable` per month cell, per
   all-day cell, and **per day column** in the time grid.

   Per-column, not per-slot: 15-min slots would mean 96 droppables per day, 672 per week.
   Time is instead derived from `active.rect.current.translated.top` relative to
   `over.rect.top` and snapped through a pure `timeFromOffset(offsetY, pxPerHour)` helper
   (15-min increments, matching `useEventDrag`'s existing snap).

   Droppable data shape: `{ type: 'date', date: Date, dateKey: 'YYYY-MM-DD', dueTime?: string | null }`.
   `type: 'date'` is what `drag-context.tsx:200-208` already prioritizes.

   **`date` must be a `Date` object, not a string.** The established contract already
   depends on it: `drag-context.tsx:577` announces `overData?.date?.toDateString()` and
   `use-drag-handlers.ts:968` reads `overData?.date as Date`. Passing a string would
   silently degrade the screen-reader announcement to "Unknown". `dateKey` rides along
   as the exact local key for the write.

   Omitting `dueTime` from the data means "preserve the task's existing time" (month
   cells); `dueTime: null` clears it (all-day cells); timed columns resolve it from the
   pointer at drop time.

### Sources

5. **`unscheduled-tasks-tab.tsx`** (new) — an "Unscheduled" tab in `GlobalDayPanel`,
   beside the existing day tab (`components/day-panel/global-day-panel.tsx:285-307`).
   Chosen over a calendar-only rail because the day panel is already on screen and open
   by default: no new chrome, no toggle to discover, no calendar layout change, and no
   second rail competing for space. Cost: the tab appears on every page, which is
   harmless and arguably useful.

   Rows are dnd-kit draggables tagged `data: { type: 'calendar-task', taskId }` — the
   type `drag-context.tsx:386,407` already recognizes. Excludes completed and archived.

6. **`hooks/use-drag-handlers.ts`** — `handleDragEnd` already routes
   `over.data.type === 'date'` to `handleDateDrop`; it only needs to forward the
   droppable's `dueTime` when present. This existing route makes cross-pane work for
   free: task rows are already draggable and a single `DndContext` spans both split panes.

7. **`components/calendar/use-event-drag.ts`** — `isEventMovable` admits
   `sourceType === 'task'` alongside `'event'` (keeping `!item.isAllDay`, since all-day
   task chips belong to dnd-kit); the calendar page's move commit branches to
   `tasksService.update({ id, dueDate, dueTime })` for tasks vs `calendarService.updateEvent`
   for events.

## Drop semantics

| Target                     | Result                                               |
| -------------------------- | ---------------------------------------------------- |
| Month cell                 | `dueDate` = cell date; existing `dueTime` preserved  |
| All-day cell               | `dueDate` = cell date, `dueTime` = `null`            |
| Timed slot (week/day grid) | `dueDate` = column date, `dueTime` = snapped `HH:MM` |

Dragging from the rail (no existing time) onto a month cell leaves the task all-day.

Use `formatDateKey` / `parseDateKey` from `lib/task-utils/task-date-utils.ts` for all
date-key conversion. Never `new Date(dateOnlyString)` — it parses as UTC midnight and
rolls back a day in negative-offset zones (`task-date-utils.ts:139`, regression-tested at
`task-utils.test.ts:2210-2230`).

## Data flow

```
drag start (rail row | tasks-pane row | month chip | all-day chip)
  → DndContext
  → over = date droppable { date, dateKey, dueTime? }
  → handleDragEnd  (case 'date')
  → resolve taskIds (multi-select aware)
  → handleDateDrop → onUpdateTask x N
  → tasksService.update x N  (IPC 'tasks:update')
  → domain updateTask → publisher.taskUpdated({ changedFields })
  → sync (dueDate/dueTime clocks only) + 'calendar:changed'
  → invalidate ['calendar','range'] + task queries
  → chip re-renders on grid
```

Time grid (separate path, same destination):

```
mousedown on timed task chip → useEventDrag → 15-min snap → onCommit
  → branch on sourceType → tasksService.update (task) | calendarService.updateEvent (event)
```

## Multi-drag

The tasks page already has multi-select and `MultiDragOverlay`, and `handleSectionDrop`
already accepts a `taskIds` array. Dropping N selected tasks on a date schedules all N as
a single undo step.

## Error handling

- Update failure → toast via `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`,
  revert optimistic state, register no undo entry.
- Multi-drag runs sequentially and collects failures: report "N of M scheduled"; undo
  covers only the successes.
- Drop outside any droppable → no-op, no toast.
- Rail excludes completed and archived tasks.

## Testing

**Unit**

- `handleDateDrop`: `dueTime` preserved when unspecified, cleared on `null`, set on
  `'HH:MM'`; undo restores both date and time for time-changing drops.
- `timeFromOffset`: 15-min snapping, column bounds, top/bottom clamping.
- `unscheduled: true` → `isNull(tasks.dueDate)`, composed with completed/archived filters.
- `use-event-drag.test.ts` extended for `sourceType: 'task'`: timed task movable, all-day
  task not movable (dnd-kit owns it), tasks never resizable, notes still read-only.
- `DraggableTaskChip`: wraps task chips, leaves event chips untouched.
- `UnscheduledTasksTab`: queries with `unscheduled: true`, renders draggable rows.

**E2E** — one happy path (drag rail task → week grid slot → chip appears), keyed off the
existing `data-date` attributes.

**Known gotcha:** jsdom lacks `Element.scrollTo`; assign `scrollTop` directly in tests
that touch scroll containers.

## Constraints

- **Backward compatibility (production, real users):** no schema change, no migration, no
  sync-protocol change. The only contract change is one additive optional field, so older
  clients are unaffected and no server deploy ordering is required.
- **RTL:** new components use logical Tailwind classes (`ms-*`/`me-*`, `ps-*`/`pe-*`,
  `start-*`/`end-*`), never physical.
- **A11y:** the existing reschedule popover remains the keyboard path. dnd-kit's
  announcer strings already exist in `drag-context.tsx:576,607`. Honor reduced-motion.
- **Logging:** `createLogger('Scope')`, never raw `console.*`.

## Non-goals (v1)

- **Events do not drag in month view or the all-day strip.** After this change tasks will
  drag there and events will not. This inconsistency is accepted knowingly: including
  events means handling time-of-day preservation across day changes, multi-day spans, and
  recurrence. The droppables built here make it cheap to add later.
- **Timed chip → all-day strip** (dragging to clear `dueTime`) crosses the two drag
  systems. The popover already does this.
- **No settings toggle.** The feature is simply on. Notes-on-calendar warranted a toggle
  because it added chips to the grid; this adds a gesture, not noise.
- No new schema, no new sync fields, no `scheduledDate` field — `dueTime` already carries
  "scheduled at a specific time".

## Verification

```
pnpm ipc:generate && pnpm ipc:check
pnpm lint && pnpm typecheck
pnpm test:desktop
pnpm docs:impact --base <base_commit> --strict
```
