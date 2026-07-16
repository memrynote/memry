# Calendar Task Drag-to-Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user schedule and reschedule tasks by dragging them onto the calendar — from a new unscheduled-tasks tab, from a Tasks pane in split view, and from task chips already on the grid.

**Architecture:** Drag responsibility splits by _granularity_, not by source. dnd-kit owns date-granular drags (rail, cross-pane, all-day chips, month chips) landing on `type: 'date'` droppables; the existing bespoke `useEventDrag` owns time-granular moves on the week/day time grid. Both converge on `handleDateDrop` in `use-drag-handlers.ts`, which already exists and already handles undo, multi-task, and toasts.

**Tech Stack:** Electron + React 19, TypeScript, `@dnd-kit/core` 6.3.1, Drizzle ORM + better-sqlite3, Zod contracts, Vitest, Tailwind.

## Global Constraints

- **Backward compatibility is MANDATORY** (production, real users). No schema change, no migration, no sync-protocol change in this plan. The only contract change is one additive optional field.
- **Never write task fields through the repository directly.** Go through `tasksService.update` → domain `updateTask`, which computes `changedFields`. `task-sync.ts:81-86` falls back to `?? TASK_SYNCABLE_FIELDS` when `changedFields` is absent, bumping all 15 field clocks and clobbering concurrent remote edits. In the renderer this means: always call `onUpdateTask`, never invent a new write path.
- **Tailwind logical properties only** in new code: `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`, `border-s`/`border-e`, `rounded-s-*`/`rounded-e-*`. Never `ml-*`, `pl-*`, `left-*`, `text-left`, `border-l`, `rounded-l-*`.
- **Date keys:** use `formatDateKey` / `parseDateKey` from `@/lib/task-utils`. Never `new Date('YYYY-MM-DD')` — it parses as UTC midnight and rolls back a day in negative-offset zones.
- **Logging:** `createLogger('Scope')`, never raw `console.*`.
- **User-facing errors:** `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **`'date'` droppable data contract (already established):** `drag-context.tsx:577` calls `overData?.date?.toDateString()` and `use-drag-handlers.ts:968` reads `overData?.date as Date`. **`date` MUST be a `Date` object, not a string.** Passing a string silently degrades the screen-reader announcement to "Unknown".
- **dnd-kit draggable `id` for task chips MUST be the task id** (`item.sourceId`), not `projectionId`. `drag-context.tsx:394-399` looks up multi-select and `draggedTasks` by `active.id` against the task list.
- After editing anything under `packages/contracts`: run `pnpm ipc:generate` then `pnpm ipc:check`.
- i18n: new renderer keys need only `en/common.json` (`i18n:check` gates English only).

## Reference: what already exists (do not rebuild)

| Thing                                                                      | Where                                 | State                |
| -------------------------------------------------------------------------- | ------------------------------------- | -------------------- |
| `handleDateDrop(taskIds, targetDate)` — undo + toast + preserves `dueTime` | `use-drag-handlers.ts:425-464`        | Working              |
| `case 'date':` routing in `handleDragEnd`                                  | `use-drag-handlers.ts:967-973`        | Working              |
| Collision detection prioritizing `type: 'date'`                            | `drag-context.tsx:200-208`            | Working, unreachable |
| `'calendar-task'` drag type recognized                                     | `drag-context.tsx:386,407`            | Working, unreachable |
| a11y announcements for `type: 'date'`                                      | `drag-context.tsx:576,607`            | Working, unreachable |
| Tasks projected onto calendar w/ `canMove: true`                           | `main/calendar/projection.ts:185-227` | Working              |
| `DragProvider tasks` populated app-wide                                    | `App.tsx:404,587`                     | Working              |
| `isNull` already imported in tasks query                                   | `main/database/queries/tasks.ts:8`    | Working              |

The `'date'` droppable was scaffolded and never wired to a droppable. This plan completes it.

---

### Task 1: `unscheduled` filter through contracts → domain → query

**Files:**

- Modify: `packages/contracts/src/tasks-api.ts:113-127`
- Modify: `packages/domain-tasks/src/types.ts:100-114`
- Modify: `apps/desktop/src/main/database/queries/tasks.ts:74-88`, `:93-107`, `:139-145`
- Test: `apps/desktop/src/main/database/queries/tasks.test.ts`

**Interfaces:**

- Consumes: nothing (first task).
- Produces: `listTasks(db, { unscheduled: true })` returns only tasks where `due_date IS NULL`. `TaskListInput.unscheduled?: boolean` reaches the renderer as `tasksService.list({ unscheduled: true })`.

- [ ] **Step 1: Write the failing test**

Add this `describe` block to `apps/desktop/src/main/database/queries/tasks.test.ts`. It uses the file's existing `createTask(id, overrides)` helper and `db` from the existing `beforeEach`.

```ts
describe('listTasks unscheduled filter', () => {
  it('returns only tasks with no due date when unscheduled is true', () => {
    createTask('task-no-due')
    createTask('task-due', { dueDate: '2026-07-20' })

    const result = listTasks(db, { unscheduled: true })

    expect(result.map((t) => t.id)).toEqual(['task-no-due'])
  })

  it('does not filter by due date when unscheduled is false', () => {
    createTask('task-no-due')
    createTask('task-due', { dueDate: '2026-07-20' })

    const result = listTasks(db, { unscheduled: false })

    expect(result).toHaveLength(2)
  })

  it('still excludes completed tasks when unscheduled is true', () => {
    createTask('task-no-due')
    createTask('task-done', { completedAt: new Date().toISOString() })

    const result = listTasks(db, { unscheduled: true })

    expect(result.map((t) => t.id)).toEqual(['task-no-due'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:main -- src/main/database/queries/tasks.test.ts -t "unscheduled"`
Expected: FAIL — the first test returns 2 tasks instead of 1 (the option is ignored today). TypeScript will also flag `unscheduled` as not existing on `ListTasksOptions`.

- [ ] **Step 3: Add the option to the main query**

In `apps/desktop/src/main/database/queries/tasks.ts`, add the field to `ListTasksOptions` (after `dueAfter?: string` at :81):

```ts
  dueBefore?: string
  dueAfter?: string
  /** When true, return only tasks with no due date. */
  unscheduled?: boolean
```

Add it to the destructure in `listTasks` (after `dueAfter,` at :101):

```ts
    dueBefore,
    dueAfter,
    unscheduled,
```

Add the condition immediately after the `dueAfter` block (after :145):

```ts
if (unscheduled) {
  conditions.push(isNull(tasks.dueDate))
}
```

`isNull` is already imported at line 8 — do not add an import.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:main -- src/main/database/queries/tasks.test.ts -t "unscheduled"`
Expected: PASS (3 tests).

- [ ] **Step 5: Thread the option through the contract and domain types**

In `packages/contracts/src/tasks-api.ts`, in `TaskListSchema` (after `dueAfter` at :120):

```ts
  dueBefore: z.string().optional(),
  dueAfter: z.string().optional(),
  unscheduled: z.boolean().optional(),
```

In `packages/domain-tasks/src/types.ts`, in `TaskListOptions` (after `dueAfter?: string` at :107):

```ts
  dueBefore?: string
  dueAfter?: string
  unscheduled?: boolean
```

- [ ] **Step 6: Regenerate and verify the IPC boundary**

Run: `pnpm ipc:generate && pnpm ipc:check`
Expected: `ipc:check` passes. If it reports the invoke map is out of date, `ipc:generate` did not run — run it again before proceeding.

Run: `pnpm typecheck`
Expected: PASS (ignore the known pre-existing errors in `websocket.test.ts` and `folders.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/tasks-api.ts packages/domain-tasks/src/types.ts apps/desktop/src/main/database/queries/tasks.ts apps/desktop/src/main/database/queries/tasks.test.ts apps/desktop/src/main/ipc/generated-ipc-invoke-map.ts apps/desktop/src/preload/generated-rpc.ts
git commit -m "feat(tasks): add unscheduled filter to task list query"
```

---

### Task 2: `handleDateDrop` accepts an explicit time, and undo restores it

Today `handleDateDrop` sets `dueDate` and preserves whatever `dueTime` the task had. Drops onto the all-day strip must _clear_ `dueTime`; drops onto a timed slot must _set_ it. Undo must restore the previous time, or dragging an all-day task to a timed slot and undoing would restore the date but leave the time set.

This task handles `preserve` (omit the key) and `clear` (`dueTime: null`), both of which the droppable can state statically. Timed slots need the pointer position and are wired in Task 6, once `timeFromOffset` exists.

**Files:**

- Modify: `apps/desktop/src/renderer/src/hooks/use-drag-handlers.ts:18-39` (`UndoAction`), `:223-229` (undo case), `:425-464` (`handleDateDrop`), `:967-973` (`case 'date'`)
- Test: `apps/desktop/src/renderer/src/hooks/use-drag-handlers.test.tsx`

**Interfaces:**

- Consumes: nothing from Task 1.
- Produces: `handleDateDrop(taskIds: string[], targetDate: Date, options?: DateDropOptions)` where `interface DateDropOptions { dueTime?: string | null }`. Omitting `dueTime` preserves the task's existing time (today's behavior, unchanged). `dueTime: null` clears it. `dueTime: '14:30'` sets it. The `case 'date'` branch forwards `overData.dueTime` when the droppable supplies the key. Export `DateDropOptions` — Task 6 imports it.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/renderer/src/hooks/use-drag-handlers.test.tsx`. Match the file's existing harness for rendering the hook and asserting on `onUpdateTask`; the assertions below are what matters.

```ts
describe('handleDateDrop time handling', () => {
  it('leaves dueTime untouched when no time option is given', () => {
    const { result, onUpdateTask } = renderDragHandlers({
      tasks: [
        makeTask({ id: 'task-1', dueDate: new Date('2026-07-10T00:00:00'), dueTime: '09:00' })
      ]
    })

    act(() => {
      result.current.handleDateDrop(['task-1'], new Date('2026-07-15T00:00:00'))
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
      dueDate: new Date('2026-07-15T09:00:00')
    })
  })

  it('clears dueTime when the option is null', () => {
    const { result, onUpdateTask } = renderDragHandlers({
      tasks: [
        makeTask({ id: 'task-1', dueDate: new Date('2026-07-10T00:00:00'), dueTime: '09:00' })
      ]
    })

    act(() => {
      result.current.handleDateDrop(['task-1'], new Date('2026-07-15T00:00:00'), { dueTime: null })
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
      dueDate: new Date('2026-07-15T00:00:00'),
      dueTime: null
    })
  })

  it('sets dueTime when the option is a time string', () => {
    const { result, onUpdateTask } = renderDragHandlers({
      tasks: [makeTask({ id: 'task-1', dueDate: null, dueTime: null })]
    })

    act(() => {
      result.current.handleDateDrop(['task-1'], new Date('2026-07-15T00:00:00'), {
        dueTime: '14:30'
      })
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
      dueDate: new Date('2026-07-15T14:30:00'),
      dueTime: '14:30'
    })
  })

  it('restores both date and time on undo of a time-changing drop', () => {
    const { result, onUpdateTask } = renderDragHandlers({
      tasks: [
        makeTask({ id: 'task-1', dueDate: new Date('2026-07-10T00:00:00'), dueTime: '09:00' })
      ]
    })

    act(() => {
      result.current.handleDateDrop(['task-1'], new Date('2026-07-15T00:00:00'), { dueTime: null })
    })
    onUpdateTask.mockClear()
    act(() => {
      result.current.handleUndo()
    })

    expect(onUpdateTask).toHaveBeenCalledWith('task-1', {
      dueDate: new Date('2026-07-10T00:00:00'),
      dueTime: '09:00'
    })
  })
})
```

If the existing test file exposes the undo trigger under a different name than `handleUndo`, use whatever the file already uses — read the file first and match it.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- use-drag-handlers.test.tsx -t "handleDateDrop time handling"`
Expected: FAIL — TypeScript rejects the third argument; the clear/set tests fail because `dueTime` is never passed to `onUpdateTask`.

- [ ] **Step 3: Add `previousTimes` to the undo action**

In `use-drag-handlers.ts`, add the field to `UndoAction` (after `previousDates?: Map<string, Date | null>` at :33):

```ts
  previousDates?: Map<string, Date | null>
  previousTimes?: Map<string, string | null>
```

Replace the `reschedule` undo case at :223-229 with:

```ts
      case 'reschedule':
        if (lastAction.previousDates) {
          lastAction.previousDates.forEach((date, taskId) => {
            // previousTimes is only recorded for drops that changed the time.
            // Without it, restore the date alone and leave dueTime as-is.
            if (lastAction.previousTimes) {
              onUpdateTask(taskId, {
                dueDate: date,
                dueTime: lastAction.previousTimes.get(taskId) ?? null
              })
            } else {
              onUpdateTask(taskId, { dueDate: date })
            }
          })
        }
        break
```

- [ ] **Step 4: Add the time option to `handleDateDrop`**

Add the exported options interface near the top of the file, after the `UndoAction` interface (after :39):

```ts
export interface DateDropOptions {
  /** Omit to keep the task's current time; null clears it; 'HH:MM' sets it. */
  dueTime?: string | null
}
```

Replace `handleDateDrop` at :425-464 with:

```ts
const handleDateDrop = useCallback(
  (taskIds: string[], targetDate: Date, options: DateDropOptions = {}) => {
    const changesTime = 'dueTime' in options

    // Store previous dates (and times, when the drop changes them) for undo
    const previousDates = new Map<string, Date | null>()
    const previousTimes = new Map<string, string | null>()
    taskIds.forEach((id) => {
      const task = tasks.find((t) => t.id === id)
      previousDates.set(id, task?.dueDate || null)
      previousTimes.set(id, task?.dueTime ?? null)
    })

    // Update all tasks
    taskIds.forEach((id) => {
      const task = tasks.find((t) => t.id === id)
      const nextDueTime = changesTime ? (options.dueTime ?? null) : (task?.dueTime ?? null)

      let newDueDate = startOfDay(targetDate)
      if (nextDueTime) {
        const [hours, minutes] = nextDueTime.split(':').map(Number)
        newDueDate = new Date(newDueDate)
        newDueDate.setHours(hours, minutes)
      }

      onUpdateTask(
        id,
        changesTime ? { dueDate: newDueDate, dueTime: nextDueTime } : { dueDate: newDueDate }
      )
    })

    // Record for undo
    recordAction(
      {
        type: 'reschedule',
        taskIds,
        previousDates,
        ...(changesTime ? { previousTimes } : {})
      },
      `Rescheduled to ${formatDateShort(targetDate)}`
    )

    toast.success(
      taskIds.length === 1
        ? `Rescheduled to ${formatDateShort(targetDate)}`
        : `${taskIds.length} tasks rescheduled to ${formatDateShort(targetDate)}`
    )
  },
  [tasks, onUpdateTask, recordAction]
)
```

- [ ] **Step 5: Forward the droppable's time in the `date` case**

Replace the `case 'date':` block at :967-973 with:

```ts
        case 'date': {
          const targetDate = overData?.date as Date
          if (targetDate) {
            // Droppables that represent a specific slot supply dueTime; month
            // cells omit the key entirely so the task keeps its current time.
            handleDateDrop(
              taskIds,
              targetDate,
              'dueTime' in (overData ?? {})
                ? { dueTime: overData?.dueTime as string | null }
                : undefined
            )
          }
          break
        }
```

Add `handleDateDrop` to the `handleDragEnd` dependency array (it is currently absent; the array starts at :994).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- use-drag-handlers.test.tsx`
Expected: PASS — the 4 new tests plus every pre-existing test in the file (the `previousTimes`-absent branch keeps section drops behaving exactly as before).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-drag-handlers.ts apps/desktop/src/renderer/src/hooks/use-drag-handlers.test.tsx
git commit -m "feat(tasks): let date drops set or clear dueTime, with undo"
```

---

### Task 3: Calendar drop primitives — `timeFromOffset` + `useCalendarDateDroppable`

**Files:**

- Create: `apps/desktop/src/renderer/src/components/calendar/drop-time.ts`
- Create: `apps/desktop/src/renderer/src/components/calendar/use-calendar-date-droppable.ts`
- Test: `apps/desktop/src/renderer/src/components/calendar/drop-time.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `timeFromOffset(offsetY: number, hourHeight: number): string` — returns `'HH:MM'`, snapped to 15 minutes, clamped to `00:00`–`23:45`.
  - `useCalendarDateDroppable(args: { date: string; timeBehavior: 'preserve' | 'clear' | 'slot' }): { setNodeRef: (el: HTMLElement | null) => void; isOver: boolean }` — registers a `type: 'date'` droppable. `'preserve'` (month cell) omits `dueTime` from the data entirely; `'clear'` (all-day cell) sets it to `null`. `'slot'` is declared by the timed column in Task 6, which resolves the time at drop.

Reuses `SNAP_MINUTES = 15` semantics from `use-event-drag.ts`. Do not import the private constant; `drop-time.ts` declares its own snap.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/components/calendar/drop-time.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { timeFromOffset } from './drop-time'

describe('timeFromOffset', () => {
  const HOUR_HEIGHT = 48

  it('returns midnight at the top of the grid', () => {
    expect(timeFromOffset(0, HOUR_HEIGHT)).toBe('00:00')
  })

  it('converts a whole-hour offset', () => {
    expect(timeFromOffset(HOUR_HEIGHT * 9, HOUR_HEIGHT)).toBe('09:00')
  })

  it('snaps to the nearest 15 minutes', () => {
    // 9h + 20min -> 09:15 (20 rounds down to 15)
    expect(timeFromOffset(HOUR_HEIGHT * 9 + HOUR_HEIGHT / 3, HOUR_HEIGHT)).toBe('09:15')
    // 9h + 24min -> 09:30 (24 rounds up to 30)
    expect(timeFromOffset(HOUR_HEIGHT * 9 + HOUR_HEIGHT * 0.4, HOUR_HEIGHT)).toBe('09:30')
  })

  it('pads single-digit hours and minutes', () => {
    expect(timeFromOffset(HOUR_HEIGHT * 5 + HOUR_HEIGHT / 4, HOUR_HEIGHT)).toBe('05:15')
  })

  it('clamps a negative offset to midnight', () => {
    expect(timeFromOffset(-500, HOUR_HEIGHT)).toBe('00:00')
  })

  it('clamps past the end of the day to 23:45', () => {
    expect(timeFromOffset(HOUR_HEIGHT * 30, HOUR_HEIGHT)).toBe('23:45')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- drop-time.test.ts`
Expected: FAIL — "Failed to resolve import './drop-time'".

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/renderer/src/components/calendar/drop-time.ts`:

```ts
const SNAP_MINUTES = 15
const MINUTES_IN_DAY = 1440
const LAST_SLOT_MINUTES = MINUTES_IN_DAY - SNAP_MINUTES

/**
 * Convert a pixel offset from the top of a day column into a wall-clock time,
 * snapped to 15 minutes and clamped inside the day.
 */
export function timeFromOffset(offsetY: number, hourHeight: number): string {
  const rawMinutes = (offsetY / hourHeight) * 60
  const snapped = Math.round(rawMinutes / SNAP_MINUTES) * SNAP_MINUTES
  const clamped = Math.max(0, Math.min(snapped, LAST_SLOT_MINUTES))
  const hours = Math.floor(clamped / 60)
  const minutes = clamped % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- drop-time.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the droppable hook**

Create `apps/desktop/src/renderer/src/components/calendar/use-calendar-date-droppable.ts`:

```ts
import { useDroppable } from '@dnd-kit/core'
import { parseDateKey } from '@/lib/task-utils'

export interface CalendarDateDroppableArgs {
  /** Local date key, 'YYYY-MM-DD'. */
  date: string
  /**
   * 'preserve' — month cell: keep the task's existing dueTime.
   * 'clear'    — all-day cell: drop the time.
   * 'slot'     — timed column: the time is resolved from the pointer at drop time.
   */
  timeBehavior: 'preserve' | 'clear' | 'slot'
}

export interface CalendarDateDroppableResult {
  setNodeRef: (element: HTMLElement | null) => void
  isOver: boolean
}

/**
 * Registers a calendar cell as a `type: 'date'` drop target.
 *
 * `date` is carried as a Date object because the established droppable contract
 * expects one: drag-context announces `overData.date.toDateString()` and
 * use-drag-handlers reads `overData.date as Date`.
 */
export function useCalendarDateDroppable({
  date,
  timeBehavior
}: CalendarDateDroppableArgs): CalendarDateDroppableResult {
  const { setNodeRef, isOver } = useDroppable({
    id: `calendar-date:${date}:${timeBehavior}`,
    data: {
      type: 'date',
      date: parseDateKey(date),
      dateKey: date,
      // Omitting the key entirely means "preserve the task's time".
      ...(timeBehavior === 'clear' ? { dueTime: null } : {})
    }
  })

  return { setNodeRef, isOver }
}
```

`timeBehavior: 'slot'` intentionally omits `dueTime` here — Task 6 supplies it dynamically from the pointer position.

- [ ] **Step 6: Verify types**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/drop-time.ts apps/desktop/src/renderer/src/components/calendar/drop-time.test.ts apps/desktop/src/renderer/src/components/calendar/use-calendar-date-droppable.ts
git commit -m "feat(calendar): add date droppable + drop-time primitives"
```

---

### Task 4: Draggable task chip wrapper

**Files:**

- Create: `apps/desktop/src/renderer/src/components/calendar/draggable-task-chip.tsx`
- Test: `apps/desktop/src/renderer/src/components/calendar/draggable-task-chip.test.tsx`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `<DraggableTaskChip item={...} isSelected={...} onClick={...} onDeleteItem={...} />` — renders `CalendarItemChip` unchanged for non-task items, and wraps it in a dnd-kit draggable when `item.sourceType === 'task'` and `item.editability?.canMove` is true. The draggable id is `item.sourceId` (the task id) and its data is `{ type: 'calendar-task', sourceType: 'calendar', taskId: item.sourceId }`.

Only task chips become draggable. All-day and month **event** chips stay non-draggable — see the plan's non-goals.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/components/calendar/draggable-task-chip.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { DraggableTaskChip } from './draggable-task-chip'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const makeItem = (overrides: Partial<CalendarProjectionItem> = {}): CalendarProjectionItem =>
  ({
    projectionId: 'task:task-1',
    sourceType: 'task',
    sourceId: 'task-1',
    title: 'Write the spec',
    startAt: '2026-07-15T00:00:00.000Z',
    endAt: null,
    isAllDay: true,
    visualType: 'task',
    editability: { canMove: true, canResize: false, canEditText: true, canDelete: true },
    ...overrides
  }) as CalendarProjectionItem

const renderChip = (item: CalendarProjectionItem) =>
  render(
    <DndContext>
      <DraggableTaskChip item={item} isSelected={false} />
    </DndContext>
  )

describe('DraggableTaskChip', () => {
  it('marks a movable task chip as draggable', () => {
    renderChip(makeItem())

    expect(screen.getByTestId('draggable-task-chip')).toHaveAttribute('data-task-id', 'task-1')
  })

  it('does not wrap an event chip', () => {
    renderChip(makeItem({ sourceType: 'event', sourceId: 'event-1', visualType: 'event' }))

    expect(screen.queryByTestId('draggable-task-chip')).toBeNull()
  })

  it('does not wrap a task chip that cannot move', () => {
    renderChip(
      makeItem({
        editability: { canMove: false, canResize: false, canEditText: false, canDelete: false }
      })
    )

    expect(screen.queryByTestId('draggable-task-chip')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- draggable-task-chip.test.tsx`
Expected: FAIL — "Failed to resolve import './draggable-task-chip'".

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/renderer/src/components/calendar/draggable-task-chip.tsx`:

```tsx
import { useDraggable } from '@dnd-kit/core'
import { CalendarItemChip } from './calendar-item-chip'
import { cn } from '@/lib/utils'
import type { AnchorRect } from './types'
import type { CalendarProjectionItem } from '@/services/calendar-service'

interface DraggableTaskChipProps {
  item: CalendarProjectionItem
  isSelected: boolean
  onClick?: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onDeleteItem?: (item: CalendarProjectionItem) => void
}

/** Task chips are date-draggable via dnd-kit; every other chip renders untouched. */
export function DraggableTaskChip({
  item,
  isSelected,
  onClick,
  onDeleteItem
}: DraggableTaskChipProps): React.JSX.Element {
  const isDraggableTask = item.sourceType === 'task' && Boolean(item.editability?.canMove)

  if (!isDraggableTask) {
    return (
      <CalendarItemChip
        item={item}
        isSelected={isSelected}
        onClick={onClick}
        onDeleteItem={onDeleteItem}
      />
    )
  }

  return (
    <DraggableTaskChipInner
      item={item}
      isSelected={isSelected}
      onClick={onClick}
      onDeleteItem={onDeleteItem}
    />
  )
}

function DraggableTaskChipInner({
  item,
  isSelected,
  onClick,
  onDeleteItem
}: DraggableTaskChipProps): React.JSX.Element {
  // dnd-kit requires the task id here: drag-context resolves multi-select and
  // draggedTasks by matching active.id against the task list.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: item.sourceId,
    data: {
      type: 'calendar-task',
      sourceType: 'calendar',
      taskId: item.sourceId
    }
  })

  return (
    <div
      ref={setNodeRef}
      data-testid="draggable-task-chip"
      data-task-id={item.sourceId}
      className={cn('touch-none', isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <CalendarItemChip
        item={item}
        isSelected={isSelected}
        onClick={onClick}
        onDeleteItem={onDeleteItem}
      />
    </div>
  )
}
```

The hook lives in an inner component because `useDraggable` cannot be called conditionally.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- draggable-task-chip.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/draggable-task-chip.tsx apps/desktop/src/renderer/src/components/calendar/draggable-task-chip.test.tsx
git commit -m "feat(calendar): add draggable task chip wrapper"
```

---

### Task 5: Month view — droppable cells and draggable task chips

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-month-view.tsx:73-129`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-month-day-cell.tsx`
- Test: `apps/desktop/src/renderer/src/components/calendar/calendar-month-view.test.tsx` (create if absent)

**Interfaces:**

- Consumes: `useCalendarDateDroppable` (Task 3), `DraggableTaskChip` (Task 4).
- Produces: month cells register as `type: 'date'` droppables with `timeBehavior: 'preserve'`, and month task chips drag.

The day cell moves into its own component because `useCalendarDateDroppable` is a hook and cannot be called inside the `gridDays.map` callback.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/components/calendar/calendar-month-view.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { CalendarMonthView } from './calendar-month-view'
import type { CalendarProjectionItem } from '@/services/calendar-service'

const taskItem = {
  projectionId: 'task:task-1',
  sourceType: 'task',
  sourceId: 'task-1',
  title: 'Write the spec',
  startAt: '2026-07-15T09:00:00.000Z',
  endAt: null,
  isAllDay: true,
  visualType: 'task',
  editability: { canMove: true, canResize: false, canEditText: true, canDelete: true }
} as CalendarProjectionItem

describe('CalendarMonthView drag targets', () => {
  it('renders a droppable day cell for each day and makes task chips draggable', () => {
    render(
      <DndContext>
        <CalendarMonthView anchorDate="2026-07-15" items={[taskItem]} selectedItemId={null} />
      </DndContext>
    )

    const cell = document.querySelector('[data-date="2026-07-15"]')
    expect(cell).not.toBeNull()
    expect(screen.getByTestId('draggable-task-chip')).toHaveAttribute('data-task-id', 'task-1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- calendar-month-view.test.tsx`
Expected: FAIL — `getByTestId('draggable-task-chip')` finds nothing; month view still renders a plain `CalendarItemChip`.

- [ ] **Step 3: Extract the day cell into a droppable component**

Create `apps/desktop/src/renderer/src/components/calendar/calendar-month-day-cell.tsx`:

```tsx
import { useT } from '@memry/i18n/renderer'
import { DraggableTaskChip } from './draggable-task-chip'
import { useCalendarDateDroppable } from './use-calendar-date-droppable'
import { cn } from '@/lib/utils'
import type { AnchorRect } from './types'
import type { CalendarProjectionItem } from '@/services/calendar-service'

interface CalendarMonthDayCellProps {
  day: string
  dayNum: number
  inMonth: boolean
  today: boolean
  weekend: boolean
  highlighted: boolean
  items: CalendarProjectionItem[]
  maxVisibleEvents: number
  selectedItemId: string | null
  onSelectItem?: (item: CalendarProjectionItem, rect: AnchorRect) => void
  onDeleteItem?: (item: CalendarProjectionItem) => void
}

export function CalendarMonthDayCell({
  day,
  dayNum,
  inMonth,
  today,
  weekend,
  highlighted,
  items,
  maxVisibleEvents,
  selectedItemId,
  onSelectItem,
  onDeleteItem
}: CalendarMonthDayCellProps): React.JSX.Element {
  const { t } = useT('calendar')
  // Month cells are date-only: a dropped task keeps whatever time it had.
  const { setNodeRef, isOver } = useCalendarDateDroppable({ date: day, timeBehavior: 'preserve' })

  return (
    <div
      ref={setNodeRef}
      data-date={day}
      className={cn(
        'flex flex-col gap-1 border-b border-e border-border p-1 @xl:p-2',
        inMonth ? (weekend ? 'bg-muted/30' : 'bg-background') : 'bg-muted/50',
        highlighted && 'ring-2 ring-inset ring-tint/40 bg-tint/10',
        isOver && 'ring-2 ring-inset ring-tint bg-tint/15'
      )}
    >
      <div className="mb-0.5">
        {today ? (
          <span className="inline-flex size-6 items-center justify-center rounded-full bg-tint text-xs font-semibold text-tint-foreground">
            {dayNum}
          </span>
        ) : (
          <span
            className={cn(
              'inline-block text-xs font-medium leading-6',
              inMonth ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {dayNum}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1">
        {items.slice(0, maxVisibleEvents).map((item) => (
          <DraggableTaskChip
            key={item.projectionId}
            item={item}
            isSelected={item.sourceType === 'event' && item.sourceId === selectedItemId}
            onClick={onSelectItem}
            onDeleteItem={onDeleteItem}
          />
        ))}
        {items.length > maxVisibleEvents && (
          <span className="text-xs font-semibold text-muted-foreground">
            {t('time.more-events', { count: items.length - maxVisibleEvents })}
          </span>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Use the cell component in the month view**

In `calendar-month-view.tsx`, replace the entire `gridDays.map(...)` body (:73-129) with:

```tsx
{
  gridDays.map((day) => {
    const inMonth = isSameMonth(day, anchorDate)
    const today = isToday(day)
    const weekend = isWeekend(day)
    const dayNum = parseInt(day.slice(-2), 10)
    const dayItems = items.filter((item) => toLocalDateKey(item.startAt) === day)
    const isSelected =
      selection && !isDragging && day >= selection.startDate && day <= selection.endDate
    const isDragSelected =
      isDragging && selection && day >= selection.startDate && day <= selection.endDate

    return (
      <CalendarMonthDayCell
        key={day}
        day={day}
        dayNum={dayNum}
        inMonth={inMonth}
        today={today}
        weekend={weekend}
        highlighted={Boolean(isSelected || isDragSelected)}
        items={dayItems}
        maxVisibleEvents={maxVisibleEvents}
        selectedItemId={selectedItemId}
        onSelectItem={onSelectItem}
        onDeleteItem={onDeleteItem}
      />
    )
  })
}
```

Add the import at the top:

```tsx
import { CalendarMonthDayCell } from './calendar-month-day-cell'
```

Remove the now-unused `CalendarItemChip` import if nothing else in the file uses it, and remove `useT`/`t` only if the file no longer references them (the quick-create dialog block may still). Do not delete anything the file still uses.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- calendar-month-view.test.tsx`
Expected: PASS.

Run: `pnpm --filter @memry/desktop test:renderer -- calendar`
Expected: PASS — no regression in the existing calendar suite (notably `calendar-page.test.tsx`, `calendar-item-chip.test.tsx`).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-month-day-cell.tsx apps/desktop/src/renderer/src/components/calendar/calendar-month-view.tsx apps/desktop/src/renderer/src/components/calendar/calendar-month-view.test.tsx
git commit -m "feat(calendar): make month cells droppable and task chips draggable"
```

---

### Task 6: Week/day views — all-day cells and timed columns as drop targets

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-week-view.tsx:290-338` (all-day strip), `:378-420` (timed columns)
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-day-view.tsx` (same two regions, single column)
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-allday-cell.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-timed-column-droppable.tsx`
- Test: `apps/desktop/src/renderer/src/components/calendar/calendar-timed-column-droppable.test.tsx`
- Modify: `apps/desktop/src/renderer/src/hooks/use-drag-handlers.ts` (`case 'date'` + a `resolveDropOptions` helper)
- Test: `apps/desktop/src/renderer/src/hooks/use-drag-handlers.test.tsx`

**Interfaces:**

- Consumes: `useCalendarDateDroppable`, `timeFromOffset` (Task 3), `DateDropOptions` + `handleDateDrop` (Task 2), `DraggableTaskChip` (Task 4).
- Produces: all-day cells are `type: 'date'` droppables carrying `dueTime: null`; timed day columns are `type: 'date'` droppables carrying `timeBehavior: 'slot'` + `hourHeight`, which `handleDragEnd` turns into a concrete `dueTime` at drop.

Read `calendar-week-view.tsx` and `calendar-day-view.tsx` in full before editing — the week grid is virtualized (TanStack Virtual) and columns are addressed by `data-day-index`, so column identity is index-based, not DOM-order-based.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/components/calendar/calendar-timed-column-droppable.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { CalendarTimedColumnDroppable } from './calendar-timed-column-droppable'

describe('CalendarTimedColumnDroppable', () => {
  it('renders a droppable wrapper carrying its date', () => {
    render(
      <DndContext>
        <CalendarTimedColumnDroppable date="2026-07-15" hourHeight={48}>
          <div data-testid="column-body" />
        </CalendarTimedColumnDroppable>
      </DndContext>
    )

    const wrapper = document.querySelector('[data-drop-date="2026-07-15"]')
    expect(wrapper).not.toBeNull()
    expect(document.querySelector('[data-testid="column-body"]')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- calendar-timed-column-droppable.test.tsx`
Expected: FAIL — "Failed to resolve import './calendar-timed-column-droppable'".

- [ ] **Step 3: Write the timed column droppable**

Create `apps/desktop/src/renderer/src/components/calendar/calendar-timed-column-droppable.tsx`:

The column declares only _that_ it is a timed slot and how tall an hour is. It does **not** compute the time: the drop time depends on pointer position, which is only known at drop, and `handleDragEnd` already receives both rects. A droppable that tried to compute its own time would have to read the live pointer during render.

```tsx
import { useDroppable } from '@dnd-kit/core'
import { type ReactNode } from 'react'
import { parseDateKey } from '@/lib/task-utils'
import { cn } from '@/lib/utils'

interface CalendarTimedColumnDroppableProps {
  date: string
  hourHeight: number
  children: ReactNode
}

/**
 * One droppable per day column rather than per 15-minute slot (96 slots/day
 * would mean 672 droppables in a week). `timeBehavior: 'slot'` tells
 * handleDragEnd to derive the time from where the chip landed.
 */
export function CalendarTimedColumnDroppable({
  date,
  hourHeight,
  children
}: CalendarTimedColumnDroppableProps): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: `calendar-timed-column:${date}`,
    data: {
      type: 'date',
      date: parseDateKey(date),
      dateKey: date,
      timeBehavior: 'slot',
      hourHeight
    }
  })

  return (
    <div
      ref={setNodeRef}
      data-drop-date={date}
      className={cn('relative h-full', isOver && 'bg-tint/10')}
    >
      {children}
    </div>
  )
}
```

- [ ] **Step 3b: Resolve the slot time in `handleDragEnd`**

`timeFromOffset` exists from Task 3, and Task 2 left `case 'date'` forwarding `overData.dueTime` only when the key is present. Extend that branch in `apps/desktop/src/renderer/src/hooks/use-drag-handlers.ts` so `timeBehavior: 'slot'` resolves a time from the drop position:

```ts
        case 'date': {
          const targetDate = overData?.date as Date
          if (targetDate) {
            handleDateDrop(taskIds, targetDate, resolveDropOptions(overData, event))
          }
          break
        }
```

Add this module-level helper to the same file, above the hook:

```ts
/**
 * Month cells preserve the task's time (no key), all-day cells clear it
 * (dueTime: null), timed columns derive it from where the chip landed.
 */
function resolveDropOptions(
  overData: Record<string, unknown> | undefined,
  event: DragEndEvent
): DateDropOptions | undefined {
  if (overData?.timeBehavior === 'slot') {
    const overTop = event.over?.rect.top
    const activeTop = event.active.rect.current.translated?.top
    const hourHeight = overData.hourHeight as number | undefined
    if (overTop === undefined || activeTop === undefined || !hourHeight) return undefined
    return { dueTime: timeFromOffset(activeTop - overTop, hourHeight) }
  }
  if (overData && 'dueTime' in overData) {
    return { dueTime: overData.dueTime as string | null }
  }
  return undefined
}
```

Import `timeFromOffset` from `@/components/calendar/drop-time` and `DragEndEvent` from `@dnd-kit/core` (the file already imports dnd-kit types — match its existing import style).

Returning `undefined` when the rects are unavailable is deliberate: preserving the task's existing time is the safe fallback, versus silently scheduling it at midnight.

- [ ] **Step 3c: Test the slot resolution**

Add to `apps/desktop/src/renderer/src/hooks/use-drag-handlers.test.tsx`, exercising `handleDragEnd` with a `timeBehavior: 'slot'` droppable. Build the event so the chip's top sits 9 hours down a column whose top is at 0, with `hourHeight: 48`, and assert `onUpdateTask` received `dueTime: '09:00'`. Match the file's existing helpers for constructing `DragEndEvent` fixtures; if none exist, construct the minimal object the handler reads: `{ over: { id, data: { current: overData }, rect }, active: { id, rect: { current: { translated } } } }`.

Run: `pnpm --filter @memry/desktop test:renderer -- use-drag-handlers.test.tsx`
Expected: PASS.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- calendar-timed-column-droppable.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the all-day cell**

Create `apps/desktop/src/renderer/src/components/calendar/calendar-allday-cell.tsx`:

```tsx
import { type ReactNode } from 'react'
import { useCalendarDateDroppable } from './use-calendar-date-droppable'
import { cn } from '@/lib/utils'

interface CalendarAllDayCellProps {
  date: string
  children: ReactNode
  className?: string
}

/** All-day cells clear dueTime: a task dropped here is due on the day, at no time. */
export function CalendarAllDayCell({
  date,
  children,
  className
}: CalendarAllDayCellProps): React.JSX.Element {
  const { setNodeRef, isOver } = useCalendarDateDroppable({ date, timeBehavior: 'clear' })

  return (
    <div ref={setNodeRef} data-date={date} className={cn(className, isOver && 'bg-tint/15')}>
      {children}
    </div>
  )
}
```

- [ ] **Step 6: Wire both into the week and day views**

In `calendar-week-view.tsx`:

- Wrap each all-day cell (the elements carrying `data-date` at :312-315) in `<CalendarAllDayCell date={date}>`, keeping the existing classes on the inner element. Render all-day chips through `DraggableTaskChip` instead of `CalendarItemChip`.
- Wrap each timed day column's inner content (:378-381 region) in `<CalendarTimedColumnDroppable date={date} hourHeight={HOUR_HEIGHT}>`, preserving the existing `data-day-index` and `data-date` attributes on the existing element — `columnIndexAtClientX` hit-tests `data-day-index` via `getColumnElement` (:145-149) and must keep working.

Apply the same two changes in `calendar-day-view.tsx`, whose single column's date is `anchorDate`.

Use the same `HOUR_HEIGHT` the view already uses for its grid; do not introduce a second constant.

- [ ] **Step 7: Run tests to verify no regression**

Run: `pnpm --filter @memry/desktop test:renderer -- calendar`
Expected: PASS — the whole calendar suite, including `calendar-day-view.test.tsx` and `use-event-drag.test.ts`.

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/
git commit -m "feat(calendar): make all-day cells and timed columns drop targets"
```

---

### Task 7: Admit tasks to the on-grid time drag

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/calendar/use-event-drag.ts:78-85`
- Modify: `apps/desktop/src/renderer/src/pages/calendar.tsx:676-700` (`commitEventTimes` / `handleMoveEvent`)
- Test: `apps/desktop/src/renderer/src/components/calendar/use-event-drag.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks (the commit branch calls `tasksService.update` directly).
- Produces: `isEventMovable` returns true for timed task chips; `handleMoveEvent` routes task commits to `tasksService.update({ id, dueDate, dueTime })` and event commits to `calendarService.updateEvent` as before.

Only **timed** task chips are affected here — `!item.isAllDay` stays in the gate, because all-day task chips are handled by dnd-kit (Task 6), not by this hook.

- [ ] **Step 1: Write the failing test**

Add to `apps/desktop/src/renderer/src/components/calendar/use-event-drag.test.ts`:

```ts
describe('isEventMovable with tasks', () => {
  const base = {
    projectionId: 'task:task-1',
    sourceId: 'task-1',
    title: 'Write the spec',
    startAt: '2026-07-15T09:00:00.000Z',
    endAt: '2026-07-15T10:00:00.000Z',
    isAllDay: false,
    visualType: 'task',
    editability: { canMove: true, canResize: false, canEditText: true, canDelete: true }
  }

  it('allows moving a timed task chip', () => {
    expect(isEventMovable({ ...base, sourceType: 'task' } as CalendarProjectionItem)).toBe(true)
  })

  it('does not allow moving an all-day task chip (dnd-kit owns those)', () => {
    expect(
      isEventMovable({ ...base, sourceType: 'task', isAllDay: true } as CalendarProjectionItem)
    ).toBe(false)
  })

  it('still refuses read-only projections such as notes', () => {
    expect(
      isEventMovable({
        ...base,
        sourceType: 'note_date',
        editability: { canMove: false, canResize: false, canEditText: false, canDelete: false }
      } as CalendarProjectionItem)
    ).toBe(false)
  })

  it('does not make tasks resizable', () => {
    expect(isEventResizable({ ...base, sourceType: 'task' } as CalendarProjectionItem)).toBe(false)
  })
})
```

Import `isEventResizable` alongside the existing imports if the file does not already import it.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- use-event-drag.test.ts -t "isEventMovable with tasks"`
Expected: FAIL — "allows moving a timed task chip" returns false.

- [ ] **Step 3: Widen the gate**

Replace `use-event-drag.ts:78-81` with:

```ts
/**
 * Time-grid dragging covers native events and timed tasks. All-day chips are
 * date-granular and handled by dnd-kit; notes, reminders and imports are
 * read-only (main sets canMove: false on those projections).
 */
export function isEventMovable(item: CalendarProjectionItem): boolean {
  const isDraggableSource = item.sourceType === 'event' || item.sourceType === 'task'
  return isDraggableSource && Boolean(item.editability?.canMove) && !item.isAllDay
}
```

`isEventResizable` (:83-85) is unchanged: it already requires `editability.canResize`, which main sets to `false` for tasks (`projection.ts:227`), so tasks stay non-resizable.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- use-event-drag.test.ts`
Expected: PASS — the new block plus all pre-existing tests.

- [ ] **Step 5: Branch the commit by source type**

Read `pages/calendar.tsx:668-700` first. `commitEventTimes` currently hard-routes every commit to `calendarService.updateEvent`. Branch `handleMoveEvent` so task items commit through the tasks service instead:

```ts
const handleMoveEvent = useCallback(
  async (item: CalendarProjectionItem, startAt: string, endAt: string) => {
    if (item.sourceType === 'task') {
      const start = new Date(startAt)
      const dueDate = formatDateKey(start)
      const dueTime = `${String(start.getHours()).padStart(2, '0')}:${String(
        start.getMinutes()
      ).padStart(2, '0')}`
      const previousDueDate = item.startAt
      try {
        await tasksService.update({ id: item.sourceId, dueDate, dueTime })
        registerUndo(async () => {
          const previous = new Date(previousDueDate)
          await tasksService.update({
            id: item.sourceId,
            dueDate: formatDateKey(previous),
            dueTime: item.isAllDay
              ? null
              : `${String(previous.getHours()).padStart(2, '0')}:${String(
                  previous.getMinutes()
                ).padStart(2, '0')}`
          })
        })
      } catch (err) {
        toast.error(extractErrorMessage(err, 'Failed to reschedule task'))
      }
      return
    }

    await commitEventTimes(item, startAt, endAt)
    registerUndo(/* keep the existing event undo registration verbatim */)
  },
  [commitEventTimes, registerUndo]
)
```

Match the file's existing `registerUndo` signature and its existing event-undo body exactly — read them before writing, and do not change event behavior. Import `formatDateKey` from `@/lib/task-utils`, `tasksService` from `@/services/tasks-service`, and `extractErrorMessage` from `@/lib/ipc-error` if not already imported.

After the mutation, invalidate the calendar range query the same way the existing event path does (`['calendar', 'range']`).

- [ ] **Step 6: Verify**

Run: `pnpm --filter @memry/desktop test:renderer -- calendar`
Expected: PASS.

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/use-event-drag.ts apps/desktop/src/renderer/src/components/calendar/use-event-drag.test.ts apps/desktop/src/renderer/src/pages/calendar.tsx
git commit -m "feat(calendar): allow dragging timed task chips on the time grid"
```

---

### Task 8: Unscheduled tasks tab in the day panel

**Files:**

- Modify: `apps/desktop/src/renderer/src/agent-chat/sidebar-tabs.tsx:20-31`, `:43-58`, `:82-121`, `:163`
- Modify: `apps/desktop/src/renderer/src/components/day-panel/global-day-panel.tsx:285-315`
- Create: `apps/desktop/src/renderer/src/components/day-panel/unscheduled-tasks-tab.tsx`
- Modify: `apps/desktop/src/renderer/src/../../resources/locales/en/common.json` (locate the real path with `rtk grep -rl "agentChat" --include=common.json .` before editing)
- Test: `apps/desktop/src/renderer/src/components/day-panel/unscheduled-tasks-tab.test.tsx`
- Test: `apps/desktop/src/renderer/src/agent-chat/__tests__/sidebar-tabs.test.tsx`

**Interfaces:**

- Consumes: `tasksService.list({ unscheduled: true })` (Task 1).
- Produces: `<UnscheduledTasksTab />` — a list of draggable rows for tasks with no due date. Each row is a dnd-kit draggable with `id = task.id` and `data: { type: 'calendar-task', sourceType: 'list', taskId }`, so `handleDragEnd`'s existing `case 'date'` (Task 2) schedules it on drop.

`RightSidebarTab` becomes `'day' | 'unscheduled' | 'agent'`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/components/day-panel/unscheduled-tasks-tab.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DndContext } from '@dnd-kit/core'
import { UnscheduledTasksTab } from './unscheduled-tasks-tab'

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    list: vi.fn().mockResolvedValue({
      tasks: [{ id: 'task-1', title: 'Write the spec', priority: 0, projectId: 'project-1' }],
      total: 1,
      hasMore: false
    })
  }
}))

describe('UnscheduledTasksTab', () => {
  it('lists unscheduled tasks as draggable rows', async () => {
    render(
      <DndContext>
        <UnscheduledTasksTab />
      </DndContext>
    )

    const row = await screen.findByTestId('unscheduled-task-row')
    expect(row).toHaveAttribute('data-task-id', 'task-1')
    expect(screen.getByText('Write the spec')).toBeInTheDocument()
  })

  it('requests only tasks without a due date', async () => {
    const { tasksService } = await import('@/services/tasks-service')
    render(
      <DndContext>
        <UnscheduledTasksTab />
      </DndContext>
    )

    await screen.findByTestId('unscheduled-task-row')
    expect(tasksService.list).toHaveBeenCalledWith(expect.objectContaining({ unscheduled: true }))
  })
})
```

Wrap in whatever QueryClient provider the sibling day-panel tests use if the component fetches via TanStack Query — read `journal-day-panel`'s test (or the component itself, `components/journal/journal-day-panel.tsx:288-299`) and follow the same data-fetching pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- unscheduled-tasks-tab.test.tsx`
Expected: FAIL — "Failed to resolve import './unscheduled-tasks-tab'".

- [ ] **Step 3: Write the tab content**

Create `apps/desktop/src/renderer/src/components/day-panel/unscheduled-tasks-tab.tsx`. Mirror the query style used by `components/journal/journal-day-panel.tsx:288-299` (same hook, same error handling), substituting `{ unscheduled: true, includeCompleted: false, includeArchived: false, limit: 200 }` for its date-window options. Each row:

```tsx
function UnscheduledTaskRow({ task }: { task: TaskListItem }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { type: 'calendar-task', sourceType: 'list', taskId: task.id }
  })

  return (
    <div
      ref={setNodeRef}
      data-testid="unscheduled-task-row"
      data-task-id={task.id}
      className={cn(
        'flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-sm touch-none',
        'hover:bg-sidebar-accent',
        isDragging && 'opacity-40'
      )}
      {...attributes}
      {...listeners}
    >
      <span className="min-w-0 truncate text-foreground">{task.title}</span>
    </div>
  )
}
```

Render an empty state when the list is empty, using an existing empty-state component if the day panel already has one; otherwise a muted single line. Keep it restrained — this panel is calm chrome, not a second task manager.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- unscheduled-tasks-tab.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the tab to SidebarTabs**

In `agent-chat/sidebar-tabs.tsx`:

```ts
export type RightSidebarTab = 'day' | 'unscheduled' | 'agent'

const RIGHT_SIDEBAR_TAB_KEY = ['right', 'sidebar', 'tab'].join('-')
const RIGHT_SIDEBAR_TABS: RightSidebarTab[] = ['day', 'unscheduled', 'agent']

interface SidebarTabsProps {
  children: { day: ReactNode; unscheduled: ReactNode; agent: ReactNode }
  defaultTab?: RightSidebarTab
  dayLabel?: string
  agentLabel?: string
  endAccessory?: ReactNode
}
```

Add a tab button after the day button (:90-97), using an existing icon from `@/lib/icons`:

```tsx
<SidebarTabButton
  active={resolvedActive === 'unscheduled'}
  dataTour="rsb-unscheduled"
  label={unscheduledTabLabel}
  onClick={() => setActive('unscheduled')}
>
  <ListTodo className="size-4" aria-hidden="true" />
</SidebarTabButton>
```

with `const unscheduledTabLabel = t('agentChat.sidebar.unscheduled')`. Import `ListTodo` from `@/lib/icons`; if that export does not exist, pick one that does — do not import from `lucide-react` directly unless the file already does (it imports `History` that way, so that fallback is acceptable and consistent).

Update the label resolution (:56-58) and the content switch (:163):

```tsx
const resolvedActive = aiEnabled ? active : active === 'agent' ? 'day' : active
const activeLabel =
  resolvedActive === 'day'
    ? (dayLabel ?? dayTabLabel)
    : resolvedActive === 'unscheduled'
      ? unscheduledTabLabel
      : (agentLabel ?? agentTabLabel)
```

```tsx
{
  resolvedActive === 'day'
    ? children.day
    : resolvedActive === 'unscheduled'
      ? children.unscheduled
      : children.agent
}
```

The `resolvedActive` change matters: the old expression forced _any_ tab to `'day'` when AI was disabled, which would make the new tab unreachable for users without AI enabled.

Also update the header block at :127 — it currently renders the day label only when `resolvedActive === 'day'`; make it cover `'unscheduled'` too so the panel keeps a title:

```tsx
            {resolvedActive !== 'agent' ? (
```

- [ ] **Step 6: Mount it in the day panel**

In `components/day-panel/global-day-panel.tsx`, add to the `SidebarTabs` children object (after the `day:` entry, :287-308):

```tsx
          unscheduled: (
            <div className="h-full overflow-y-auto p-4">
              <UnscheduledTasksTab />
            </div>
          ),
```

Import it at the top:

```tsx
import { UnscheduledTasksTab } from './unscheduled-tasks-tab'
```

- [ ] **Step 7: Add the i18n key**

Add `"unscheduled": "Unscheduled"` to the `agentChat.sidebar` object in the English `common.json`. Find it first:

```bash
rtk grep -rn "\"agentChat\"" --include=common.json .
```

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: PASS (English is the only gated locale).

- [ ] **Step 8: Verify**

Run: `pnpm --filter @memry/desktop test:renderer -- sidebar-tabs`
Expected: PASS. The existing `sidebar-tabs.test.tsx` passes a `children` object — it must be updated to include `unscheduled`, or it will not typecheck.

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/renderer/src/agent-chat/sidebar-tabs.tsx apps/desktop/src/renderer/src/agent-chat/__tests__/sidebar-tabs.test.tsx apps/desktop/src/renderer/src/components/day-panel/
git commit -m "feat(day-panel): add unscheduled tasks tab with draggable rows"
```

---

### Task 9: Full verification and docs gate

**Files:**

- Possibly modify: `apps/docs/src/**` (only if `docs:impact` reports `missing-docs`)

- [ ] **Step 1: Run the full verification suite**

```bash
pnpm lint
pnpm typecheck
pnpm test:desktop
pnpm ipc:check
pnpm check:architecture
pnpm check:contracts
git diff --check
```

Expected: all pass. Known exceptions: pre-existing type errors in `websocket.test.ts` and `folders.test.ts`; a full-run desktop vitest SIGSEGV is a known parallel flake — re-run the affected file alone to confirm before treating it as a real failure.

- [ ] **Step 2: Run the docs gate**

```bash
base_commit=$(git merge-base origin/main HEAD)
pnpm docs:impact --base "$base_commit" --strict
```

If it reports `missing-docs`, update real docs under `apps/docs/src/**` (or run `pnpm docs:ai-update --base "$base_commit"`), then re-run the gate and `pnpm docs:build`.

- [ ] **Step 3: Verify by driving the real app**

Run: `pnpm dev`

Confirm each of the three sources the spec promises:

1. Day panel → Unscheduled tab → drag a task onto a month cell. Chip appears; task keeps no time.
2. Drag an unscheduled task onto a week-view 2pm slot. Chip lands at 2pm; the task now has `dueTime`.
3. Drag an all-day task chip to a different day in week view; drag a timed task chip to a new time. Both persist across a restart.
4. Split view: Calendar ‖ Tasks. Drag a task row from the Tasks pane onto a calendar cell.
5. Multi-select two tasks, drag both onto a date — one toast, one undo step (`Cmd+Z` restores both).

- [ ] **Step 4: Commit any docs changes**

```bash
git add apps/docs/src
git commit -m "docs: document calendar task drag-to-schedule"
```

---

## Self-review notes

**Spec coverage:** unscheduled query → Task 1. Shared commit seam → Task 2 (realized as an extension of the existing `handleDateDrop` rather than a new `commitTaskSchedule`, since that function already exists with undo, multi-task, and toasts — the spec's seam requirement is met more cheaply). Drop targets → Tasks 3, 5, 6. Rail → Task 8. Cross-pane → free once Task 5/6 droppables exist, verified in Task 9. On-grid chips → Tasks 4 (date-granular) and 7 (time-granular). Drop-semantics table → Task 2 tests (preserve/clear/set) + Task 3 `timeBehavior`.

**Deviations from the spec, resolved here:**

1. Spec said droppable data carries `date: 'YYYY-MM-DD'`. The established contract requires `date: Date` (`drag-context.tsx:577`, `use-drag-handlers.ts:968`). Both are carried: `date` (Date) and `dateKey` (string). **Update the spec.**
2. Spec proposed a new `commitTaskSchedule`. `handleDateDrop` already is it. Extended instead of duplicated.
3. Undo of a time-changing drop needed `previousTimes` on the undo action — not anticipated in the spec, added in Task 2.

**Risks:**

- `useTaskWorkspaceData` feeds `DragProvider.tasks`; `listTasks` defaults to `limit: 100`. If a vault has more than 100 tasks and the workspace query does not raise the limit, `handleDateDrop`'s `tasks.find` may miss a task and lose `dueTime` preservation. Pre-existing across all drag handlers, not introduced here. Check the limit during Task 2 and report if it bites.
- The week grid is virtualized; a droppable on a column that unmounts while dragging will drop out of collision detection. Verify horizontal scroll during a drag in Task 9.
