# Calendar Task Popover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire calendar task chips to a small floating popover that surfaces task details, three inline-edit affordances (complete, subtask toggle, snooze), and quick navigation to the existing `TaskDetailDrawer` and source note.

**Architecture:** New `CalendarTaskPopover` mirroring `CalendarEventPopover`'s positioning/dismissal. Forked at `CalendarShell.onSelectItem` on `item.sourceType === 'task'`. Reuses existing `tasks:*` IPC. Extends `DayPanelContext` with `selectedTaskId` + `openForTask(taskId)` so the popover's "Open task" button can drive the existing drawer.

**Tech Stack:** React 19, TypeScript, Radix UI Dialog, vitest + @testing-library/react, Tailwind (logical RTL classes), electron-log, react-i18next.

**Spec:** `docs/superpowers/specs/2026-04-29-calendar-task-popover-design.md`

---

## File Structure

**Create (new):**

```
apps/desktop/src/renderer/src/
├── lib/
│   ├── format-task-due.ts                       — pure: due-row formatter
│   ├── format-task-due.test.ts
│   ├── snooze-options.ts                        — pure: snooze choices + new dueDate/dueTime
│   └── snooze-options.test.ts
├── hooks/
│   ├── use-task.ts                              — react-query wrapper for tasks:get
│   ├── use-task.test.ts
│   ├── use-subtasks.ts                          — react-query wrapper for tasks:get-subtasks
│   └── use-subtasks.test.ts
└── components/calendar/
    ├── calendar-task-popover.tsx                — main component
    ├── calendar-task-popover.test.tsx
    ├── calendar-task-popover-header.tsx         — parent breadcrumb + ☐ + title + ⋯
    ├── calendar-task-popover-header.test.tsx
    ├── calendar-task-popover-meta.tsx           — due / recurrence / project / status / priority / tags
    ├── calendar-task-popover-meta.test.tsx
    ├── calendar-task-popover-subtasks.tsx       — checklist + "X of Y" counter
    ├── calendar-task-popover-subtasks.test.tsx
    ├── calendar-task-popover-actions.tsx        — Open task / Source note / Snooze ▾
    └── calendar-task-popover-actions.test.tsx
```

**Modify:**

```
apps/desktop/src/renderer/src/contexts/day-panel-context.tsx       — add selectedTaskId + openForTask
apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx — fork onSelectItem on sourceType
packages/i18n/src/locales/en/calendar.json                          — add new strings
packages/i18n/src/locales/en/tasks.json                             — add new strings (if needed)
```

---

## Task 1: `format-task-due` pure util

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/format-task-due.ts`
- Test: `apps/desktop/src/renderer/src/lib/format-task-due.test.ts`

This util formats a task's due date/time row. Keep it pure: takes `{ dueDate, dueTime, endAt, isAllDay, completedAt, now }` and returns `{ label, isOverdue, ariaLabel }`. Do not import the i18n hook here — the consumer wraps the label in `t()` if needed. (Date-relative phrases like "Tomorrow" are tokens the consumer translates.)

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/renderer/src/lib/format-task-due.test.ts
import { describe, expect, it } from 'vitest'
import { formatTaskDue } from './format-task-due'

const NOW = new Date('2026-04-29T10:00:00') // Wed

describe('formatTaskDue', () => {
  it('returns Today + time for same-day due with time', () => {
    expect(formatTaskDue({ dueDate: '2026-04-29', dueTime: '14:00', now: NOW })).toEqual({
      relative: 'today',
      label: 'Today · 2:00 PM',
      isOverdue: false
    })
  })

  it('returns Tomorrow + time for next-day due', () => {
    expect(formatTaskDue({ dueDate: '2026-04-30', dueTime: '09:00', now: NOW })).toEqual({
      relative: 'tomorrow',
      label: 'Tomorrow · 9:00 AM',
      isOverdue: false
    })
  })

  it('returns weekday for this-week due', () => {
    expect(formatTaskDue({ dueDate: '2026-05-01', dueTime: '14:00', now: NOW })).toEqual({
      relative: 'this-week',
      label: 'Fri · 2:00 PM',
      isOverdue: false
    })
  })

  it('returns absolute date for distant future', () => {
    expect(formatTaskDue({ dueDate: '2026-06-15', dueTime: '14:00', now: NOW })).toEqual({
      relative: 'absolute',
      label: 'Jun 15, 2026 · 2:00 PM',
      isOverdue: false
    })
  })

  it('marks overdue when dueDate < today and not completed', () => {
    const out = formatTaskDue({ dueDate: '2026-04-27', dueTime: '14:00', now: NOW })
    expect(out.isOverdue).toBe(true)
    expect(out.label).toBe('2 days overdue')
  })

  it('does NOT mark overdue when completed', () => {
    const out = formatTaskDue({
      dueDate: '2026-04-27',
      dueTime: '14:00',
      completedAt: '2026-04-28T10:00:00Z',
      now: NOW
    })
    expect(out.isOverdue).toBe(false)
  })

  it('drops time when no dueTime', () => {
    expect(formatTaskDue({ dueDate: '2026-04-30', now: NOW })).toEqual({
      relative: 'tomorrow',
      label: 'Tomorrow',
      isOverdue: false
    })
  })

  it('renders range when endAt provided', () => {
    expect(
      formatTaskDue({
        dueDate: '2026-04-29',
        dueTime: '14:00',
        endAt: '2026-04-29T15:00:00',
        now: NOW
      })
    ).toMatchObject({
      label: 'Today · 2:00 PM – 3:00 PM'
    })
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter desktop test format-task-due`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/desktop/src/renderer/src/lib/format-task-due.ts
export type DueRelative = 'today' | 'tomorrow' | 'this-week' | 'absolute'

export interface FormatTaskDueInput {
  dueDate: string             // YYYY-MM-DD
  dueTime?: string | null     // HH:MM
  endAt?: string | null       // ISO datetime
  completedAt?: string | null
  now?: Date                  // injectable for tests
}

export interface FormatTaskDueResult {
  relative: DueRelative
  label: string
  isOverdue: boolean
}

export function formatTaskDue(input: FormatTaskDueInput): FormatTaskDueResult {
  const now = input.now ?? new Date()
  const due = parseDateOnly(input.dueDate)
  const today = startOfDay(now)
  const dayDelta = diffInCalendarDays(due, today)

  const completed = !!input.completedAt
  const isOverdue = dayDelta < 0 && !completed

  if (isOverdue) {
    const days = Math.abs(dayDelta)
    return {
      relative: 'absolute',
      label: days === 1 ? '1 day overdue' : `${days} days overdue`,
      isOverdue: true
    }
  }

  const relative: DueRelative =
    dayDelta === 0 ? 'today'
    : dayDelta === 1 ? 'tomorrow'
    : dayDelta > 1 && dayDelta <= 6 ? 'this-week'
    : 'absolute'

  const datePart =
    relative === 'today' ? 'Today'
    : relative === 'tomorrow' ? 'Tomorrow'
    : relative === 'this-week' ? weekdayShort(due)
    : absoluteDate(due)

  if (!input.dueTime) {
    return { relative, label: datePart, isOverdue: false }
  }

  const startLabel = formatTime(input.dueTime)
  if (input.endAt) {
    const endLabel = formatTimeFromIso(input.endAt)
    return { relative, label: `${datePart} · ${startLabel} – ${endLabel}`, isOverdue: false }
  }
  return { relative, label: `${datePart} · ${startLabel}`, isOverdue: false }
}

// — helpers below; keep simple, no extra deps —
function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
function diffInCalendarDays(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86_400_000)
}
function weekdayShort(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short' })
}
function absoluteDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const date = new Date()
  date.setHours(h, m, 0, 0)
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
function formatTimeFromIso(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter desktop test format-task-due`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/format-task-due.ts \
        apps/desktop/src/renderer/src/lib/format-task-due.test.ts
git commit -m "feat: add format-task-due util for calendar task popover"
```

---

## Task 2: `snooze-options` pure util

**Files:**
- Create: `apps/desktop/src/renderer/src/lib/snooze-options.ts`
- Test: `apps/desktop/src/renderer/src/lib/snooze-options.test.ts`

Computes the snooze submenu choices and the resulting `dueDate` / `dueTime` for each. All-day tasks (no `dueTime`) get all-day snooze targets — clock options are skipped.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/renderer/src/lib/snooze-options.test.ts
import { describe, expect, it } from 'vitest'
import { computeSnoozeOptions } from './snooze-options'

describe('computeSnoozeOptions', () => {
  it('returns laterToday/tomorrow/nextWeek for timed task at noon', () => {
    const now = new Date('2026-04-29T12:00:00')
    const opts = computeSnoozeOptions({ now, isAllDay: false })
    expect(opts.laterToday).toEqual({ dueDate: '2026-04-29', dueTime: '15:00' })
    expect(opts.tomorrow).toEqual({ dueDate: '2026-04-30', dueTime: '09:00' })
    expect(opts.nextWeek).toEqual({ dueDate: '2026-05-04', dueTime: '09:00' }) // Mon
  })

  it('clamps Later today to 8 PM cap', () => {
    const now = new Date('2026-04-29T18:00:00')
    const opts = computeSnoozeOptions({ now, isAllDay: false })
    expect(opts.laterToday).toEqual({ dueDate: '2026-04-29', dueTime: '20:00' })
  })

  it('hides Later today when now ≥ 19:00', () => {
    const now = new Date('2026-04-29T19:00:00')
    const opts = computeSnoozeOptions({ now, isAllDay: false })
    expect(opts.laterToday).toBeNull()
  })

  it('drops dueTime for all-day task', () => {
    const now = new Date('2026-04-29T12:00:00')
    const opts = computeSnoozeOptions({ now, isAllDay: true })
    expect(opts.laterToday).toBeNull() // no concept of "later today" for all-day
    expect(opts.tomorrow).toEqual({ dueDate: '2026-04-30', dueTime: null })
    expect(opts.nextWeek).toEqual({ dueDate: '2026-05-04', dueTime: null })
  })

  it('Sunday → Mon next-week is the very next day', () => {
    const now = new Date('2026-05-03T10:00:00') // Sunday
    const opts = computeSnoozeOptions({ now, isAllDay: false })
    expect(opts.nextWeek?.dueDate).toBe('2026-05-04')
  })

  it('Monday → next-week is +7 days', () => {
    const now = new Date('2026-05-04T10:00:00') // Monday
    const opts = computeSnoozeOptions({ now, isAllDay: false })
    expect(opts.nextWeek?.dueDate).toBe('2026-05-11')
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter desktop test snooze-options`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// apps/desktop/src/renderer/src/lib/snooze-options.ts
export interface SnoozeTarget {
  dueDate: string         // YYYY-MM-DD
  dueTime: string | null  // HH:MM or null for all-day
}

export interface SnoozeOptionsInput {
  now: Date
  isAllDay: boolean
}

export interface SnoozeOptions {
  laterToday: SnoozeTarget | null
  tomorrow: SnoozeTarget
  nextWeek: SnoozeTarget
}

const HOUR = 60 * 60 * 1000

export function computeSnoozeOptions(input: SnoozeOptionsInput): SnoozeOptions {
  const { now, isAllDay } = input

  const laterToday = isAllDay ? null : computeLaterToday(now)
  const tomorrow: SnoozeTarget = {
    dueDate: ymd(addDays(startOfDay(now), 1)),
    dueTime: isAllDay ? null : '09:00'
  }
  const nextWeek: SnoozeTarget = {
    dueDate: ymd(nextMonday(now)),
    dueTime: isAllDay ? null : '09:00'
  }
  return { laterToday, tomorrow, nextWeek }
}

function computeLaterToday(now: Date): SnoozeTarget | null {
  if (now.getHours() >= 19) return null
  const target = new Date(now.getTime() + 3 * HOUR)
  // clamp to [now+1h, 20:00]
  const minTime = new Date(now.getTime() + HOUR)
  const cap = new Date(now); cap.setHours(20, 0, 0, 0)
  const final = target < minTime ? minTime : target > cap ? cap : target
  return {
    dueDate: ymd(final),
    dueTime: `${pad2(final.getHours())}:${pad2(final.getMinutes())}`
  }
}

function nextMonday(from: Date): Date {
  const d = startOfDay(from)
  const day = d.getDay() // 0=Sun..6=Sat
  const delta = day === 0 ? 1 : (8 - day)
  return addDays(d, delta)
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}
function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}
function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter desktop test snooze-options`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/lib/snooze-options.ts \
        apps/desktop/src/renderer/src/lib/snooze-options.test.ts
git commit -m "feat: add snooze-options util for calendar task popover"
```

---

## Task 3: Extend `DayPanelContext` to support task selection

**Files:**
- Modify: `apps/desktop/src/renderer/src/contexts/day-panel-context.tsx`

The current context only exposes `openForDayView(date)`. The popover needs to open the existing `TaskDetailDrawer` focused on a specific task. Add `selectedTaskId` state + `openForTask(taskId)` method. Existing consumers continue to work unchanged.

- [ ] **Step 1: Read the current context file**

Read `apps/desktop/src/renderer/src/contexts/day-panel-context.tsx` end-to-end. Note the existing `DayPanelContextValue` interface (lines 19-32 per explore notes) and the Provider's state hooks.

- [ ] **Step 2: Write the failing test**

```typescript
// apps/desktop/src/renderer/src/contexts/day-panel-context.test.tsx
import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { DayPanelProvider, useDayPanel } from './day-panel-context'

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <DayPanelProvider>{children}</DayPanelProvider>
)

describe('DayPanelContext task selection', () => {
  it('exposes null selectedTaskId by default', () => {
    const { result } = renderHook(() => useDayPanel(), { wrapper })
    expect(result.current.selectedTaskId).toBeNull()
  })

  it('openForTask sets selectedTaskId and opens the panel', () => {
    const { result } = renderHook(() => useDayPanel(), { wrapper })
    act(() => result.current.openForTask('task-123'))
    expect(result.current.selectedTaskId).toBe('task-123')
    expect(result.current.isOpen).toBe(true)
  })

  it('close() clears selectedTaskId', () => {
    const { result } = renderHook(() => useDayPanel(), { wrapper })
    act(() => result.current.openForTask('task-123'))
    act(() => result.current.close())
    expect(result.current.selectedTaskId).toBeNull()
    expect(result.current.isOpen).toBe(false)
  })

  it('openForDayView clears selectedTaskId', () => {
    const { result } = renderHook(() => useDayPanel(), { wrapper })
    act(() => result.current.openForTask('task-123'))
    act(() => result.current.openForDayView('2026-04-29'))
    expect(result.current.selectedTaskId).toBeNull()
    expect(result.current.selectedDate).toBe('2026-04-29')
  })
})
```

- [ ] **Step 3: Run test to verify failure**

Run: `pnpm --filter desktop test day-panel-context`
Expected: FAIL — `openForTask is not a function` and `selectedTaskId` undefined.

- [ ] **Step 4: Modify the context**

Apply this diff to `apps/desktop/src/renderer/src/contexts/day-panel-context.tsx`:

```typescript
// Add to DayPanelContextValue interface:
selectedTaskId: string | null
openForTask: (taskId: string) => void

// In the Provider component, add state:
const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)

// Add the new method:
const openForTask = useCallback((taskId: string) => {
  setSelectedTaskId(taskId)
  setIsOpen(true)
}, [])

// Patch existing methods so they clear the task selection appropriately:
const close = useCallback(() => {
  setSelectedTaskId(null)
  setIsOpen(false)
}, [])

const openForDayView = useCallback((date: string) => {
  setSelectedTaskId(null)
  setSelectedDate(date)
  setIsOpen(true)
}, [/* keep existing deps */])

// Add to the value object passed to Provider:
const value = useMemo<DayPanelContextValue>(() => ({
  /* existing fields... */,
  selectedTaskId,
  openForTask,
  close,
  openForDayView,
}), [/* include selectedTaskId, openForTask, close, openForDayView */])
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm --filter desktop test day-panel-context`
Expected: PASS, 4 tests.

Also run: `pnpm --filter desktop typecheck`
Expected: PASS (existing consumers ignore the new optional fields).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/contexts/day-panel-context.tsx \
        apps/desktop/src/renderer/src/contexts/day-panel-context.test.tsx
git commit -m "feat(day-panel): add selectedTaskId + openForTask for task drawer focus"
```

---

## Task 4: `useTask` hook

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-task.ts`
- Test: `apps/desktop/src/renderer/src/hooks/use-task.test.ts`

Wraps the `tasks:get` IPC. Verify return shape first by reading the handler.

- [ ] **Step 1: Read the IPC handler**

Read `apps/desktop/src/main/ipc/tasks-handlers.ts` for the `GET` handler and the underlying `createTaskDomain(...).getTask(id)` to confirm what fields come back. Note especially: does it pre-join `taskTags`, `project`, `status`, parent task?

If joins are missing, the popover will need separate fetches for parent/project/status. For this plan we assume `getTask` returns the row and any pre-joined relations the existing handler already provides; tag fetch is verified in this task.

- [ ] **Step 2: Pick a reference react-query hook in the repo**

Skim `apps/desktop/src/renderer/src/hooks/` for an existing query hook (e.g. `use-projects.ts` or anything that already calls a `tasks:*` channel) and match its conventions for `queryKey`, error handling, and IPC call site (likely `window.api.tasks.get(id)`).

- [ ] **Step 3: Write the failing test**

```typescript
// apps/desktop/src/renderer/src/hooks/use-task.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useTask } from './use-task'

const getMock = vi.fn()
vi.stubGlobal('window', {
  ...globalThis.window,
  api: { tasks: { get: getMock } }
})

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useTask', () => {
  beforeEach(() => getMock.mockReset())

  it('fetches a task by id', async () => {
    getMock.mockResolvedValue({ id: 't1', title: 'Hello', projectId: 'p1' })
    const { result } = renderHook(() => useTask('t1'), { wrapper })
    await waitFor(() => expect(result.current.data?.title).toBe('Hello'))
    expect(getMock).toHaveBeenCalledWith('t1')
  })

  it('does not fetch when id is null', () => {
    const { result } = renderHook(() => useTask(null), { wrapper })
    expect(getMock).not.toHaveBeenCalled()
    expect(result.current.data).toBeUndefined()
  })
})
```

- [ ] **Step 4: Run test to verify failure**

Run: `pnpm --filter desktop test use-task`
Expected: FAIL — module not found.

- [ ] **Step 5: Implement**

```typescript
// apps/desktop/src/renderer/src/hooks/use-task.ts
import { useQuery } from '@tanstack/react-query'
import type { Task } from '@shared/types' // adjust import path to match the project's Task type

export function useTask(taskId: string | null) {
  return useQuery<Task | null>({
    queryKey: ['task', taskId],
    queryFn: () => window.api.tasks.get(taskId!),
    enabled: !!taskId
  })
}
```

If `window.api.tasks.get` is not the actual exported preload signature, replace with the correct path discovered in Step 2.

- [ ] **Step 6: Run test to verify pass**

Run: `pnpm --filter desktop test use-task`
Expected: PASS, 2 tests.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-task.ts \
        apps/desktop/src/renderer/src/hooks/use-task.test.ts
git commit -m "feat(hooks): add useTask query hook"
```

---

## Task 5: `useSubtasks` hook

**Files:**
- Create: `apps/desktop/src/renderer/src/hooks/use-subtasks.ts`
- Test: `apps/desktop/src/renderer/src/hooks/use-subtasks.test.ts`

Wraps `tasks:get-subtasks`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/desktop/src/renderer/src/hooks/use-subtasks.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useSubtasks } from './use-subtasks'

const getSubtasksMock = vi.fn()
vi.stubGlobal('window', {
  ...globalThis.window,
  api: { tasks: { getSubtasks: getSubtasksMock } }
})

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useSubtasks', () => {
  beforeEach(() => getSubtasksMock.mockReset())

  it('fetches subtasks by parent id', async () => {
    getSubtasksMock.mockResolvedValue([
      { id: 's1', title: 'Sub 1', parentId: 't1', completedAt: null },
      { id: 's2', title: 'Sub 2', parentId: 't1', completedAt: '2026-04-28T10:00:00Z' }
    ])
    const { result } = renderHook(() => useSubtasks('t1'), { wrapper })
    await waitFor(() => expect(result.current.data?.length).toBe(2))
    expect(getSubtasksMock).toHaveBeenCalledWith('t1')
  })

  it('does not fetch when parentId is null', () => {
    const { result } = renderHook(() => useSubtasks(null), { wrapper })
    expect(getSubtasksMock).not.toHaveBeenCalled()
    expect(result.current.data).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter desktop test use-subtasks`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/desktop/src/renderer/src/hooks/use-subtasks.ts
import { useQuery } from '@tanstack/react-query'
import type { Task } from '@shared/types'

export function useSubtasks(parentId: string | null) {
  return useQuery<Task[]>({
    queryKey: ['subtasks', parentId],
    queryFn: () => window.api.tasks.getSubtasks(parentId!),
    enabled: !!parentId
  })
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter desktop test use-subtasks`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/hooks/use-subtasks.ts \
        apps/desktop/src/renderer/src/hooks/use-subtasks.test.ts
git commit -m "feat(hooks): add useSubtasks query hook"
```

---

## Task 6: `CalendarTaskPopoverHeader` sub-component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-header.tsx`
- Test: `apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-header.test.tsx`

Renders parent breadcrumb (if any), complete checkbox, title (strikethrough when completed), and overflow `⋯` menu trigger.

- [ ] **Step 1: Write the failing test**

```typescript
// calendar-task-popover-header.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarTaskPopoverHeader } from './calendar-task-popover-header'

const baseTask = {
  id: 't1',
  title: 'Review Q2 roadmap',
  completedAt: null,
  parentId: null
}

describe('CalendarTaskPopoverHeader', () => {
  it('renders title', () => {
    render(<CalendarTaskPopoverHeader task={baseTask} parentTitle={null} onToggleComplete={vi.fn()} onOverflow={vi.fn()} />)
    expect(screen.getByText('Review Q2 roadmap')).toBeInTheDocument()
  })

  it('hides parent breadcrumb when no parent', () => {
    render(<CalendarTaskPopoverHeader task={baseTask} parentTitle={null} onToggleComplete={vi.fn()} onOverflow={vi.fn()} />)
    expect(screen.queryByTestId('parent-breadcrumb')).not.toBeInTheDocument()
  })

  it('renders parent breadcrumb when parent provided', () => {
    render(<CalendarTaskPopoverHeader task={{ ...baseTask, parentId: 'p' }} parentTitle="Q2 Planning" onToggleComplete={vi.fn()} onOverflow={vi.fn()} />)
    expect(screen.getByTestId('parent-breadcrumb')).toHaveTextContent('Q2 Planning')
  })

  it('shows strikethrough when completed', () => {
    render(<CalendarTaskPopoverHeader task={{ ...baseTask, completedAt: '2026-04-28T10:00:00Z' }} parentTitle={null} onToggleComplete={vi.fn()} onOverflow={vi.fn()} />)
    expect(screen.getByText('Review Q2 roadmap')).toHaveClass('line-through')
  })

  it('checkbox click calls onToggleComplete', async () => {
    const onToggle = vi.fn()
    render(<CalendarTaskPopoverHeader task={baseTask} parentTitle={null} onToggleComplete={onToggle} onOverflow={vi.fn()} />)
    await userEvent.click(screen.getByRole('checkbox'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('overflow click calls onOverflow', async () => {
    const onOverflow = vi.fn()
    render(<CalendarTaskPopoverHeader task={baseTask} parentTitle={null} onToggleComplete={vi.fn()} onOverflow={onOverflow} />)
    await userEvent.click(screen.getByLabelText(/more actions/i))
    expect(onOverflow).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter desktop test calendar-task-popover-header`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// calendar-task-popover-header.tsx
import { MoreHorizontal } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import type { Task } from '@shared/types'

export interface CalendarTaskPopoverHeaderProps {
  task: Pick<Task, 'id' | 'title' | 'completedAt' | 'parentId'>
  parentTitle: string | null
  onToggleComplete: () => void
  onOverflow: (anchor: HTMLElement) => void
}

export function CalendarTaskPopoverHeader(props: CalendarTaskPopoverHeaderProps) {
  const { task, parentTitle, onToggleComplete, onOverflow } = props
  const isDone = !!task.completedAt

  return (
    <div className="flex items-start gap-2 ps-3 pe-2 py-2 border-b">
      <div className="flex-1 min-w-0">
        {task.parentId && parentTitle && (
          <div data-testid="parent-breadcrumb" className="text-xs text-muted-foreground truncate">
            ↳ {parentTitle}
          </div>
        )}
        <div className="flex items-start gap-2">
          <Checkbox
            checked={isDone}
            onCheckedChange={onToggleComplete}
            aria-label={isDone ? 'Mark not done' : 'Mark done'}
            className="mt-1"
          />
          <span className={`text-sm font-medium leading-snug line-clamp-2 ${isDone ? 'line-through text-muted-foreground' : ''}`}>
            {task.title}
          </span>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label="More actions"
        onClick={(e) => onOverflow(e.currentTarget)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter desktop test calendar-task-popover-header`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-header.tsx \
        apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-header.test.tsx
git commit -m "feat(calendar): add CalendarTaskPopoverHeader"
```

---

## Task 7: `CalendarTaskPopoverMeta` sub-component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-meta.tsx`
- Test: `apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-meta.test.tsx`

Renders: due row, recurrence row, project + status row, priority + tags row, description. Each section omitted when its data is absent. Tag overflow capped at 3 visible + `+N`.

- [ ] **Step 1: Write the failing test**

```typescript
// calendar-task-popover-meta.test.tsx
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { CalendarTaskPopoverMeta } from './calendar-task-popover-meta'

const NOW = new Date('2026-04-29T10:00:00')

const baseProps = {
  task: { dueDate: '2026-04-30', dueTime: '14:00', projectId: 'p1', priority: 0 } as any,
  projectName: 'Memry',
  statusLabel: null,
  tags: [],
  repeatSummary: null,
  description: null,
  now: NOW,
  isCompleted: false
}

describe('CalendarTaskPopoverMeta', () => {
  it('renders due row + project always', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} />)
    expect(screen.getByText(/Tomorrow/)).toBeInTheDocument()
    expect(screen.getByText('Memry')).toBeInTheDocument()
  })

  it('hides recurrence when no summary', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} />)
    expect(screen.queryByTestId('recurrence-row')).not.toBeInTheDocument()
  })

  it('shows recurrence when provided', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} repeatSummary="Repeats weekly" />)
    expect(screen.getByTestId('recurrence-row')).toHaveTextContent('Repeats weekly')
  })

  it('hides status when null', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} />)
    expect(screen.queryByTestId('status-pill')).not.toBeInTheDocument()
  })

  it('shows status pill when provided', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} statusLabel="In Progress" />)
    expect(screen.getByTestId('status-pill')).toHaveTextContent('In Progress')
  })

  it('hides priority when 0', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} />)
    expect(screen.queryByTestId('priority-row')).not.toBeInTheDocument()
  })

  it('renders priority when > 0', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} task={{ ...baseProps.task, priority: 2 }} />)
    expect(screen.getByTestId('priority-row')).toBeInTheDocument()
  })

  it('renders up to 3 tags then +N', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} tags={['a', 'b', 'c', 'd', 'e']} />)
    expect(screen.getByText('#a')).toBeInTheDocument()
    expect(screen.getByText('#b')).toBeInTheDocument()
    expect(screen.getByText('#c')).toBeInTheDocument()
    expect(screen.queryByText('#d')).not.toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('hides description when empty', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} />)
    expect(screen.queryByTestId('description')).not.toBeInTheDocument()
  })

  it('renders description with line clamp class', () => {
    render(<CalendarTaskPopoverMeta {...baseProps} description="Some long text" />)
    expect(screen.getByTestId('description')).toHaveClass('line-clamp-3')
  })

  it('marks overdue with destructive style when past + not completed', () => {
    const props = {
      ...baseProps,
      task: { ...baseProps.task, dueDate: '2026-04-27' }
    }
    render(<CalendarTaskPopoverMeta {...props} />)
    expect(screen.getByTestId('due-row')).toHaveClass('text-destructive')
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter desktop test calendar-task-popover-meta`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// calendar-task-popover-meta.tsx
import { Calendar, Repeat, Folder, Flag, Hash, AlertTriangle } from 'lucide-react'
import { formatTaskDue } from '@/lib/format-task-due'
import type { Task } from '@shared/types'

export interface CalendarTaskPopoverMetaProps {
  task: Pick<Task, 'dueDate' | 'dueTime' | 'priority'> & { endAt?: string | null; isAllDay?: boolean }
  projectName: string
  statusLabel: string | null
  tags: string[]
  repeatSummary: string | null
  description: string | null
  now?: Date
  isCompleted: boolean
}

const MAX_VISIBLE_TAGS = 3

export function CalendarTaskPopoverMeta(props: CalendarTaskPopoverMetaProps) {
  const { task, projectName, statusLabel, tags, repeatSummary, description, now, isCompleted } = props
  const due = formatTaskDue({
    dueDate: task.dueDate!,
    dueTime: task.dueTime,
    endAt: task.endAt,
    completedAt: isCompleted ? '1' : null,
    now
  })
  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS)
  const overflowCount = Math.max(0, tags.length - MAX_VISIBLE_TAGS)

  return (
    <div className="px-3 py-2 space-y-1.5 text-sm">
      <div data-testid="due-row" className={`flex items-center gap-1.5 ${due.isOverdue ? 'text-destructive' : ''}`}>
        {due.isOverdue ? <AlertTriangle className="h-3.5 w-3.5" /> : <Calendar className="h-3.5 w-3.5" />}
        <span>{due.label}</span>
      </div>

      {repeatSummary && (
        <div data-testid="recurrence-row" className="flex items-center gap-1.5 text-muted-foreground">
          <Repeat className="h-3.5 w-3.5" />
          <span>{repeatSummary}</span>
        </div>
      )}

      <div className="flex items-center gap-3 text-muted-foreground">
        <span className="flex items-center gap-1.5"><Folder className="h-3.5 w-3.5" /> {projectName}</span>
        {statusLabel && (
          <span data-testid="status-pill" className="rounded-full px-2 py-0.5 text-xs bg-muted">
            {statusLabel}
          </span>
        )}
      </div>

      {(task.priority > 0 || tags.length > 0) && (
        <div data-testid="priority-row" className="flex items-center gap-3">
          {task.priority > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Flag className="h-3.5 w-3.5" />
              {priorityLabel(task.priority)}
            </span>
          )}
          {tags.length > 0 && (
            <span className="flex items-center gap-1.5 flex-wrap">
              {visibleTags.map((tag) => (
                <span key={tag} className="text-xs text-muted-foreground"># {tag.replace(/^#/, '')}</span>
              ))}
              {overflowCount > 0 && (
                <span className="text-xs text-muted-foreground">+{overflowCount}</span>
              )}
            </span>
          )}
        </div>
      )}

      {description && (
        <p data-testid="description" className="text-muted-foreground line-clamp-3">
          {description}
        </p>
      )}
    </div>
  )
}

function priorityLabel(p: number): string {
  if (p >= 3) return 'Urgent'
  if (p === 2) return 'High'
  if (p === 1) return 'Medium'
  return ''
}
```

Note: tag rendering uses `# {tag}` because the test expects the text `#a`. The existing tag display style elsewhere may render badges; if so, replace with `<TaskTagBadge>` or whatever the project uses. Verify visually after Task 11 before final commit.

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter desktop test calendar-task-popover-meta`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-meta.tsx \
        apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-meta.test.tsx
git commit -m "feat(calendar): add CalendarTaskPopoverMeta"
```

---

## Task 8: `CalendarTaskPopoverSubtasks` sub-component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-subtasks.tsx`
- Test: `apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-subtasks.test.tsx`

Renders an inline checklist of subtasks with "X of Y done" counter. Toggling a subtask checkbox calls `onToggleSubtask(subtaskId)`.

- [ ] **Step 1: Write the failing test**

```typescript
// calendar-task-popover-subtasks.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarTaskPopoverSubtasks } from './calendar-task-popover-subtasks'

const subtasks = [
  { id: 's1', title: 'Pull metrics', completedAt: '2026-04-28T10:00:00Z' },
  { id: 's2', title: 'Send pre-read', completedAt: '2026-04-28T11:00:00Z' },
  { id: 's3', title: 'Draft priorities', completedAt: null },
  { id: 's4', title: 'Schedule follow-up', completedAt: null }
]

describe('CalendarTaskPopoverSubtasks', () => {
  it('renders nothing when subtasks empty', () => {
    const { container } = render(<CalendarTaskPopoverSubtasks subtasks={[]} onToggleSubtask={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows X of Y done counter', () => {
    render(<CalendarTaskPopoverSubtasks subtasks={subtasks} onToggleSubtask={vi.fn()} />)
    expect(screen.getByText('2 of 4 done')).toBeInTheDocument()
  })

  it('renders all subtask titles', () => {
    render(<CalendarTaskPopoverSubtasks subtasks={subtasks} onToggleSubtask={vi.fn()} />)
    expect(screen.getByText('Pull metrics')).toBeInTheDocument()
    expect(screen.getByText('Schedule follow-up')).toBeInTheDocument()
  })

  it('strikes through completed subtasks', () => {
    render(<CalendarTaskPopoverSubtasks subtasks={subtasks} onToggleSubtask={vi.fn()} />)
    expect(screen.getByText('Pull metrics')).toHaveClass('line-through')
    expect(screen.getByText('Draft priorities')).not.toHaveClass('line-through')
  })

  it('toggles subtask via onToggleSubtask callback', async () => {
    const onToggle = vi.fn()
    render(<CalendarTaskPopoverSubtasks subtasks={subtasks} onToggleSubtask={onToggle} />)
    const checkboxes = screen.getAllByRole('checkbox')
    await userEvent.click(checkboxes[2]) // s3
    expect(onToggle).toHaveBeenCalledWith('s3')
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter desktop test calendar-task-popover-subtasks`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// calendar-task-popover-subtasks.tsx
import { Checkbox } from '@/components/ui/checkbox'

export interface CalendarTaskPopoverSubtasksProps {
  subtasks: Array<{ id: string; title: string; completedAt: string | null }>
  onToggleSubtask: (subtaskId: string) => void
}

export function CalendarTaskPopoverSubtasks(props: CalendarTaskPopoverSubtasksProps) {
  const { subtasks, onToggleSubtask } = props
  if (subtasks.length === 0) return null

  const doneCount = subtasks.filter((s) => !!s.completedAt).length

  return (
    <div className="px-3 py-2 border-t">
      <div className="text-xs text-muted-foreground mb-1.5">
        Subtasks · {doneCount} of {subtasks.length} done
      </div>
      <ul className="space-y-1">
        {subtasks.map((s) => {
          const done = !!s.completedAt
          return (
            <li key={s.id} className="flex items-center gap-2">
              <Checkbox checked={done} onCheckedChange={() => onToggleSubtask(s.id)} aria-label={done ? 'Mark not done' : 'Mark done'} />
              <span className={`text-sm ${done ? 'line-through text-muted-foreground' : ''}`}>{s.title}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter desktop test calendar-task-popover-subtasks`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-subtasks.tsx \
        apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-subtasks.test.tsx
git commit -m "feat(calendar): add CalendarTaskPopoverSubtasks"
```

---

## Task 9: `CalendarTaskPopoverActions` sub-component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-actions.tsx`
- Test: `apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-actions.test.tsx`

The bottom action bar: `Open task` / `📝 Source note` (conditional) / `Snooze ▾` (conditional). Snooze submenu uses `computeSnoozeOptions`. When task is completed, hides Snooze.

- [ ] **Step 1: Write the failing test**

```typescript
// calendar-task-popover-actions.test.tsx
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarTaskPopoverActions } from './calendar-task-popover-actions'

const baseProps = {
  isCompleted: false,
  isAllDay: false,
  sourceNoteId: null as string | null,
  onOpenTask: vi.fn(),
  onOpenSourceNote: vi.fn(),
  onSnooze: vi.fn(),
  onRemoveDueDate: vi.fn(),
  onPickDateTime: vi.fn(),
  now: new Date('2026-04-29T12:00:00')
}

describe('CalendarTaskPopoverActions', () => {
  it('renders Open task and Snooze when not completed', () => {
    render(<CalendarTaskPopoverActions {...baseProps} />)
    expect(screen.getByRole('button', { name: /open task/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /snooze/i })).toBeInTheDocument()
  })

  it('hides Source note button when sourceNoteId is null', () => {
    render(<CalendarTaskPopoverActions {...baseProps} />)
    expect(screen.queryByRole('button', { name: /source note/i })).not.toBeInTheDocument()
  })

  it('shows Source note button when sourceNoteId is set', () => {
    render(<CalendarTaskPopoverActions {...baseProps} sourceNoteId="n1" />)
    expect(screen.getByRole('button', { name: /source note/i })).toBeInTheDocument()
  })

  it('hides Snooze when completed', () => {
    render(<CalendarTaskPopoverActions {...baseProps} isCompleted={true} />)
    expect(screen.queryByRole('button', { name: /snooze/i })).not.toBeInTheDocument()
  })

  it('opens snooze submenu and calls onSnooze with target', async () => {
    const props = { ...baseProps, onSnooze: vi.fn() }
    render(<CalendarTaskPopoverActions {...props} />)
    await userEvent.click(screen.getByRole('button', { name: /snooze/i }))
    await userEvent.click(screen.getByText(/Tomorrow/))
    expect(props.onSnooze).toHaveBeenCalledWith({ dueDate: '2026-04-30', dueTime: '09:00' })
  })

  it('hides Later today after 19:00', async () => {
    const props = { ...baseProps, now: new Date('2026-04-29T20:00:00') }
    render(<CalendarTaskPopoverActions {...props} />)
    await userEvent.click(screen.getByRole('button', { name: /snooze/i }))
    expect(screen.queryByText(/Later today/)).not.toBeInTheDocument()
  })

  it('Open task click calls onOpenTask', async () => {
    const props = { ...baseProps, onOpenTask: vi.fn() }
    render(<CalendarTaskPopoverActions {...props} />)
    await userEvent.click(screen.getByRole('button', { name: /open task/i }))
    expect(props.onOpenTask).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter desktop test calendar-task-popover-actions`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// calendar-task-popover-actions.tsx
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { computeSnoozeOptions, type SnoozeTarget } from '@/lib/snooze-options'
import { ExternalLink, FileText, Clock } from 'lucide-react'

export interface CalendarTaskPopoverActionsProps {
  isCompleted: boolean
  isAllDay: boolean
  sourceNoteId: string | null
  onOpenTask: () => void
  onOpenSourceNote: () => void
  onSnooze: (target: SnoozeTarget) => void
  onRemoveDueDate: () => void
  onPickDateTime: () => void
  now?: Date
}

export function CalendarTaskPopoverActions(props: CalendarTaskPopoverActionsProps) {
  const { isCompleted, isAllDay, sourceNoteId, onOpenTask, onOpenSourceNote, onSnooze, onRemoveDueDate, onPickDateTime } = props
  const now = props.now ?? new Date()
  const opts = computeSnoozeOptions({ now, isAllDay })

  return (
    <div className="flex items-center gap-1.5 px-2 py-2 border-t">
      <Button variant="secondary" size="sm" onClick={onOpenTask}>
        Open task
      </Button>

      {sourceNoteId && (
        <Button variant="ghost" size="sm" onClick={onOpenSourceNote} aria-label="Source note">
          <FileText className="h-3.5 w-3.5 me-1" /> Source note <ExternalLink className="h-3 w-3 ms-1" />
        </Button>
      )}

      {!isCompleted && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" aria-label="Snooze">
              <Clock className="h-3.5 w-3.5 me-1" /> Snooze
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {opts.laterToday && (
              <DropdownMenuItem onClick={() => onSnooze(opts.laterToday!)}>
                Later today · {opts.laterToday.dueTime ? formatHHMM(opts.laterToday.dueTime) : 'today'}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onSnooze(opts.tomorrow)}>
              Tomorrow{opts.tomorrow.dueTime ? ` · ${formatHHMM(opts.tomorrow.dueTime)}` : ''}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onSnooze(opts.nextWeek)}>
              Next week · Mon{opts.nextWeek.dueTime ? ` ${formatHHMM(opts.nextWeek.dueTime)}` : ''}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onPickDateTime}>Pick date &amp; time…</DropdownMenuItem>
            <DropdownMenuItem onClick={onRemoveDueDate}>Remove due date</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

function formatHHMM(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(); d.setHours(h, m, 0, 0)
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --filter desktop test calendar-task-popover-actions`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-actions.tsx \
        apps/desktop/src/renderer/src/components/calendar/calendar-task-popover-actions.test.tsx
git commit -m "feat(calendar): add CalendarTaskPopoverActions with snooze submenu"
```

---

## Task 10: `CalendarTaskPopover` main component

**Files:**
- Create: `apps/desktop/src/renderer/src/components/calendar/calendar-task-popover.tsx`
- Test: `apps/desktop/src/renderer/src/components/calendar/calendar-task-popover.test.tsx`

Assembles the four sub-components, owns positioning + dismissal (mirroring `CalendarEventPopover`), wires mutation callbacks to IPC, and dispatches the `⋯` overflow menu. Uses `useTask` and `useSubtasks`. Calls `useDayPanel().openForTask(item.sourceId)` for Open task.

- [ ] **Step 1: Read the mirror file**

Read `apps/desktop/src/renderer/src/components/calendar/calendar-event-popover.tsx` lines 1-260 in full. Pay attention to: imports, Props type, position computation, `DialogPrimitive.Root open onOpenChange` pattern, click-outside guard, and the JSX shape inside the Portal.

- [ ] **Step 2: Write the failing test**

```typescript
// calendar-task-popover.test.tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CalendarTaskPopover } from './calendar-task-popover'

// Mock hooks + day-panel
vi.mock('@/hooks/use-task', () => ({
  useTask: () => ({ data: { id: 't1', title: 'Hello', dueDate: '2026-04-30', dueTime: '14:00', projectId: 'p1', priority: 0, completedAt: null, parentId: null, sourceNoteId: null, description: null }, isLoading: false })
}))
vi.mock('@/hooks/use-subtasks', () => ({
  useSubtasks: () => ({ data: [], isLoading: false })
}))
vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ data: { id: 'p1', name: 'Memry' } })
}))
const openForTaskMock = vi.fn()
vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => ({ openForTask: openForTaskMock })
}))

const updateMock = vi.fn()
vi.stubGlobal('window', {
  ...globalThis.window,
  api: { tasks: { update: updateMock } }
})

const baseItem = {
  projectionId: 'p:t1',
  sourceId: 't1',
  sourceType: 'task' as const,
  title: 'Hello'
}
const baseAnchor = { x: 100, y: 100, width: 80, height: 22 }

describe('CalendarTaskPopover', () => {
  beforeEach(() => { updateMock.mockReset(); openForTaskMock.mockReset() })

  it('renders title and due', () => {
    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />)
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.getByText(/Tomorrow/)).toBeInTheDocument()
  })

  it('toggle complete calls tasks:update with completedAt + changedFields', async () => {
    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />)
    await userEvent.click(screen.getByRole('checkbox'))
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 't1',
      patch: expect.objectContaining({ completedAt: expect.any(String) }),
      changedFields: ['completedAt']
    }))
  })

  it('Open task calls openForTask with the task id', async () => {
    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /open task/i }))
    expect(openForTaskMock).toHaveBeenCalledWith('t1')
  })

  it('Escape calls onDismiss', async () => {
    const onDismiss = vi.fn()
    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={onDismiss} />)
    await userEvent.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run test to verify failure**

Run: `pnpm --filter desktop test calendar-task-popover.test`
Expected: FAIL.

- [ ] **Step 4: Implement**

```tsx
// calendar-task-popover.tsx
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useCallback } from 'react'
import { computePopoverPosition, type AnchorRect } from './popover-position'
import { CalendarTaskPopoverHeader } from './calendar-task-popover-header'
import { CalendarTaskPopoverMeta } from './calendar-task-popover-meta'
import { CalendarTaskPopoverSubtasks } from './calendar-task-popover-subtasks'
import { CalendarTaskPopoverActions } from './calendar-task-popover-actions'
import { useTask } from '@/hooks/use-task'
import { useSubtasks } from '@/hooks/use-subtasks'
import { useProject } from '@/hooks/use-project'
import { useDayPanel } from '@/contexts/day-panel-context'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { CalendarProjectionItem } from '@shared/types'
import type { SnoozeTarget } from '@/lib/snooze-options'

const log = createLogger('CalendarTaskPopover')

export interface CalendarTaskPopoverProps {
  item: CalendarProjectionItem
  anchorRect: AnchorRect
  onDismiss: () => void
}

export function CalendarTaskPopover({ item, anchorRect, onDismiss }: CalendarTaskPopoverProps) {
  const { data: task } = useTask(item.sourceId)
  const { data: subtasks = [] } = useSubtasks(item.sourceId)
  const { data: project } = useProject(task?.projectId ?? null)
  const { data: parentTask } = useTask(task?.parentId ?? null)
  const { openForTask } = useDayPanel()

  const isCompleted = !!task?.completedAt

  const updateTask = useCallback(async (patch: Record<string, unknown>, changedFields: string[]) => {
    if (!task) return
    try {
      await window.api.tasks.update({ id: task.id, patch, changedFields })
    } catch (err) {
      log.error('update failed', extractErrorMessage(err, 'Could not save task'))
    }
  }, [task])

  const handleToggleComplete = useCallback(() => {
    if (!task) return
    const next = task.completedAt ? null : new Date().toISOString()
    void updateTask({ completedAt: next }, ['completedAt'])
    if (next) setTimeout(onDismiss, 600) // auto-close on flip-to-done
  }, [task, updateTask, onDismiss])

  const handleToggleSubtask = useCallback((subtaskId: string) => {
    const sub = subtasks.find((s) => s.id === subtaskId)
    if (!sub) return
    const next = sub.completedAt ? null : new Date().toISOString()
    void window.api.tasks.update({ id: subtaskId, patch: { completedAt: next }, changedFields: ['completedAt'] })
  }, [subtasks])

  const handleSnooze = useCallback((target: SnoozeTarget) => {
    void updateTask({ dueDate: target.dueDate, dueTime: target.dueTime }, ['dueDate', 'dueTime'])
    onDismiss()
  }, [updateTask, onDismiss])

  const handleRemoveDueDate = useCallback(() => {
    void updateTask({ dueDate: null, dueTime: null }, ['dueDate', 'dueTime'])
    onDismiss()
  }, [updateTask, onDismiss])

  const handleOpenTask = useCallback(() => {
    openForTask(item.sourceId)
    onDismiss()
  }, [openForTask, item.sourceId, onDismiss])

  const handleOverflow = useCallback((_anchor: HTMLElement) => {
    // Overflow menu (Delete / Duplicate / Move to project / Copy link) is a
    // follow-up PR. Header still renders the trigger so the layout is final;
    // clicking it is intentionally a no-op until that PR lands.
  }, [])

  const handleOpenSourceNote = useCallback(() => {
    if (!task?.sourceNoteId) return
    // Renderer-side navigation to the note editor. Re-uses the same router
    // call that the inbox/notes list uses to open a note. Replace this line
    // with the project's existing helper (e.g. `openNote(noteId)` from a
    // navigation hook) before merging.
    window.dispatchEvent(new CustomEvent('memry:open-note', { detail: { noteId: task.sourceNoteId } }))
    onDismiss()
  }, [task?.sourceNoteId, onDismiss])

  const handlePickDateTime = useCallback(() => {
    // Custom date-time picker dialog is a follow-up. For this PR, the menu
    // item is shown but routes to the existing TaskDetailDrawer where the
    // user can change due date/time fully — same UX path used elsewhere.
    if (task) openForTask(task.id)
    onDismiss()
  }, [task, openForTask, onDismiss])

  if (!task) return null

  const { top, left } = computePopoverPosition(anchorRect, { estimatedHeight: 320 })

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onDismiss() }} modal={false}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onPointerDownOutside={(e) => { e.preventDefault(); onDismiss() }}
          onInteractOutside={(e) => e.preventDefault()}
          style={{ position: 'fixed', top, left, width: 340 }}
          className="z-50 rounded-md border bg-popover shadow-lg outline-none"
        >
          <CalendarTaskPopoverHeader
            task={task}
            parentTitle={parentTask?.title ?? null}
            onToggleComplete={handleToggleComplete}
            onOverflow={handleOverflow}
          />
          <CalendarTaskPopoverMeta
            task={task}
            projectName={project?.name ?? ''}
            statusLabel={task.status?.label ?? null}
            tags={task.tags ?? []}
            repeatSummary={summarizeRepeat(task.repeatConfig)}
            description={task.description}
            isCompleted={isCompleted}
          />
          <CalendarTaskPopoverSubtasks subtasks={subtasks} onToggleSubtask={handleToggleSubtask} />
          <CalendarTaskPopoverActions
            isCompleted={isCompleted}
            isAllDay={!task.dueTime}
            sourceNoteId={task.sourceNoteId}
            onOpenTask={handleOpenTask}
            onOpenSourceNote={handleOpenSourceNote}
            onSnooze={handleSnooze}
            onRemoveDueDate={handleRemoveDueDate}
            onPickDateTime={handlePickDateTime}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function summarizeRepeat(cfg: unknown): string | null {
  if (!cfg || typeof cfg !== 'object') return null
  // Reuse existing summarizer if one exists; otherwise quick fallback:
  const c = cfg as { freq?: string }
  if (c.freq === 'weekly') return 'Repeats weekly'
  if (c.freq === 'daily') return 'Repeats daily'
  if (c.freq === 'monthly') return 'Repeats monthly'
  return 'Repeats'
}
```

**Assumptions baked into Task 10 that the executor must verify before running tests:**

1. `tasks:get` returns the task with `tags: string[]`, `status?: { label: string }`, `sourceNoteId`, `description`, and `repeatConfig` already populated. If not, either add the joins to the handler (preferred — keeps the popover dumb) or insert a lightweight `useTaskTags(id)` / `useStatus(id)` query and pass results to the meta sub-component.
2. `useProject(projectId)` exists. If not, create a one-line wrapper: `useQuery({ queryKey: ['project', id], queryFn: () => window.api.projects.get(id), enabled: !!id })`. Pattern-match against an existing project hook in `apps/desktop/src/renderer/src/hooks/`.
3. `handleOpenSourceNote` dispatches a CustomEvent as a placeholder navigation hook — replace with the project's actual `openNote(noteId)` helper before merging. Find it via grep on `openNote` or by reading how the inbox opens notes.
4. `handlePickDateTime` routes through `openForTask` as a deliberate degradation: rather than building a new date-time picker dialog in this PR, the user lands in the existing drawer which already has full date/time controls. Replace with a dedicated picker in a follow-up PR if the UX target is "stay in the calendar."

- [ ] **Step 5: Run test to verify pass**

Run: `pnpm --filter desktop test calendar-task-popover.test`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-task-popover.tsx \
        apps/desktop/src/renderer/src/components/calendar/calendar-task-popover.test.tsx
git commit -m "feat(calendar): add CalendarTaskPopover main component"
```

---

## Task 11: Wire to `CalendarShell` (fork on `sourceType`)

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx`

The shell currently routes every clicked item to the event popover. Fork on `sourceType === 'task'`. Only one popover open at a time — opening either closes the other.

- [ ] **Step 1: Read calendar-shell.tsx**

Read the full file. Find the `onSelectItem` definition (around line 52) and the existing event-popover state. Note how the event popover state is structured (likely something like `[eventPopover, setEventPopover] = useState<{ item, anchor } | null>(null)`).

- [ ] **Step 2: Write the failing integration test**

```typescript
// apps/desktop/src/renderer/src/components/calendar/calendar-shell.test.tsx (new — or extend existing if present)
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
// ... shell render harness with mocked routes/queries (mirror calendar-page.test.tsx setup)

it('clicking a task chip opens CalendarTaskPopover (not event popover)', async () => {
  // render shell with one task projection
  // click the chip
  // assert task popover renders, event popover does not
})

it('clicking an event chip opens CalendarEventPopover (not task popover)', async () => {
  // render shell with one event projection
  // click the chip
  // assert event popover renders, task popover does not
})

it('clicking a task while event popover is open replaces it', async () => {
  // open event popover, then click task — assert event popover gone, task popover shown
})
```

The exact test harness depends on the existing `calendar-page.test.tsx` setup. Match its `vi.hoisted()` + `vi.mock()` patterns. If writing the integration test is too heavy, mark these as manual QA cases and proceed — the unit tests on each sub-component plus the popover assembly already cover behavior.

- [ ] **Step 3: Run test to verify failure (or skip if integration test deferred to manual QA)**

Run: `pnpm --filter desktop test calendar-shell`
Expected: FAIL on the new assertions, or — if integration test deferred — proceed to manual verification after Step 4.

- [ ] **Step 4: Modify `calendar-shell.tsx`**

Apply this diff (pseudo-diff — paste-adapt to actual file):

```typescript
// At the top of the component:
const [eventPopover, setEventPopover] = useState<{ item, anchor } | null>(null)
const [taskPopover, setTaskPopover] = useState<{ item, anchor } | null>(null)

// Replace the existing onSelectItem with a forking version:
const handleSelectItem = useCallback((item: CalendarProjectionItem, anchor: AnchorRect) => {
  if (item.sourceType === 'task') {
    setEventPopover(null)
    setTaskPopover({ item, anchor })
  } else if (item.sourceType === 'event') {
    setTaskPopover(null)
    setEventPopover({ item, anchor })
  }
  // reminders/snoozes: no-op for this PR
}, [])

// Pass handleSelectItem down via viewProps as onSelectItem (replace existing).

// In the render:
{taskPopover && (
  <CalendarTaskPopover
    item={taskPopover.item}
    anchorRect={taskPopover.anchor}
    onDismiss={() => setTaskPopover(null)}
  />
)}
```

Add the import at the top:

```typescript
import { CalendarTaskPopover } from './calendar-task-popover'
```

- [ ] **Step 5: Verify the popover opens when a task chip is clicked**

Manual:
1. `pnpm dev`
2. Open the calendar view
3. Find a day with a task
4. Click the task chip
5. Confirm the task popover appears anchored to the chip
6. Confirm clicking outside closes it
7. Confirm clicking an event chip while the task popover is open closes the task popover and opens the event popover (and vice versa)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/calendar-shell.tsx \
        apps/desktop/src/renderer/src/components/calendar/calendar-shell.test.tsx
git commit -m "feat(calendar): fork chip click on sourceType to task popover"
```

---

## Task 12: Wire `TaskDetailDrawer` to react to `selectedTaskId`

**Files:**
- Modify: wherever `TaskDetailDrawer` is rendered with its `task` prop today (likely in `calendar-shell.tsx` or `day-panel-content.tsx` — find via grep on `<TaskDetailDrawer`)

The drawer takes `task: Task | null`. When `useDayPanel().selectedTaskId` is set, the parent should look up the task and pass it to the drawer.

- [ ] **Step 1: Locate the existing render site**

Run: `pnpm grep "<TaskDetailDrawer" apps/desktop/src/renderer/src` (or use Grep tool). Open the file that renders the drawer.

- [ ] **Step 2: Write a failing test asserting the drawer receives the right task**

If the drawer's parent renders within `<DayPanelProvider>` and pulls task by id, write a small RTL test that:
1. Wraps in DayPanelProvider
2. Calls `openForTask('t1')` from a test harness
3. Asserts the drawer (mocked) receives `task={ id: 't1', ... }`

If the test harness becomes too heavy, defer to manual verification.

- [ ] **Step 3: Modify the render site**

Pseudo-code:

```typescript
const { selectedTaskId, isOpen, close } = useDayPanel()
const { data: selectedTask } = useTask(selectedTaskId)
// ...
<TaskDetailDrawer
  task={selectedTask ?? null}
  isOpen={isOpen && !!selectedTaskId}
  onClose={close}
  /* keep existing tasks, projects, etc props */
/>
```

If the existing render site already passes a `task` derived from somewhere else, OR the drawer is a different component when invoked from a non-calendar surface, prefer the smallest possible change that lets `openForTask(id)` reach the drawer with the right task. Do not refactor unrelated rendering paths.

- [ ] **Step 4: Verify manually**

1. `pnpm dev`
2. Click a task chip → popover opens
3. Click "Open task"
4. Drawer slides in with that task selected
5. Close drawer → popover already gone (Open task dismisses popover); calendar returns to normal

- [ ] **Step 5: Commit**

```bash
git add <files-modified>
git commit -m "feat(tasks): wire TaskDetailDrawer to DayPanelContext.selectedTaskId"
```

---

## Task 13: i18n strings + final verification

**Files:**
- Modify: `packages/i18n/src/locales/en/calendar.json`
- Modify: `packages/i18n/src/locales/en/tasks.json`

Replace any hardcoded English in the popover with `t('...')` calls. Strings to add:

```jsonc
// calendar.json (additions)
{
  "task-popover": {
    "open-task": "Open task",
    "source-note": "Source note",
    "snooze": "Snooze",
    "more-actions": "More actions",
    "later-today": "Later today",
    "tomorrow": "Tomorrow",
    "next-week": "Next week",
    "pick-date-time": "Pick date & time…",
    "remove-due-date": "Remove due date",
    "subtasks-counter": "{{done}} of {{total}} done",
    "today": "Today",
    "this-week-prefix": "",
    "overdue-one": "1 day overdue",
    "overdue-other": "{{count}} days overdue",
    "repeats-weekly": "Repeats weekly",
    "repeats-daily": "Repeats daily",
    "repeats-monthly": "Repeats monthly"
  }
}
```

- [ ] **Step 1: Add the strings to `calendar.json`**

- [ ] **Step 2: Replace literals in popover components with `t()` calls**

In each component file, add:
```typescript
import { useT } from '@/hooks/use-t' // or whatever the project uses
const { t } = useT('calendar')
```

Then swap the literal strings (e.g. `"Open task"` → `t('task-popover.open-task')`).

The relative-date phrases (`Today`, `Tomorrow`) currently come from `formatTaskDue`. Either:
- Move the i18n into the consumer (`format-task-due` returns a `relative` token; the component picks the right `t()` key per the table in the spec), or
- Keep `formatTaskDue` in English-only and rely on a follow-up i18n pass.

Pick the simpler path and document the choice in the commit message.

- [ ] **Step 3: Run the verification suite**

```bash
pnpm typecheck
pnpm lint
pnpm test
```

Fix any failures. Pre-existing failures in test files unrelated to this PR (per `MEMORY.md`: `websocket.test.ts`, `folders.test.ts`, etc.) are out of scope.

- [ ] **Step 4: Manual QA**

End-to-end click path on each calendar view:

1. Month view → click task chip → popover opens at chip
2. Week view → same
3. Day view → same
4. Toggle complete → check, animates strikethrough, auto-closes after ~600ms
5. Toggle complete on already-done task → popover stays open, shows non-completed layout after re-render
6. Toggle subtask → subtask checkbox flips, counter updates, popover stays open
7. Snooze · Tomorrow → task moves to tomorrow, popover closes, calendar reflects new position on next render
8. Snooze · Later today (before 7 PM) → time advances 3h capped at 8 PM
9. Snooze · Later today (after 7 PM) → option hidden
10. Snooze · Remove due date → task disappears from calendar
11. Source note button (when sourceNoteId set) → opens note in editor
12. Open task → drawer opens focused on this task
13. Click outside → popover dismisses
14. Escape → popover dismisses
15. Click another task → first popover closes, new opens
16. Click an event after task popover open → task popover closes, event popover opens

- [ ] **Step 5: Commit and push**

```bash
git add packages/i18n/src/locales/en/calendar.json \
        apps/desktop/src/renderer/src/components/calendar/calendar-task-popover*.tsx
git commit -m "feat(i18n): add calendar task popover strings"
git push
```

Open a PR.

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Task |
|---|---|
| Component + wiring | Tasks 10, 11 |
| Layout / fields | Tasks 6–9 |
| Empty-field rule | Tasks 7, 8 |
| Inline-edit affordances (complete/subtask/snooze) | Tasks 6 (complete), 8 (subtask), 9 (snooze) |
| Snooze submenu + defaults | Task 2 (compute) + 9 (UI) |
| State variants (completed/overdue/recurring) | Tasks 6 (completed), 7 (overdue+recurrence) |
| Recurrence non-goal | Task 10 (no per-instance logic added) |
| Action bar + overflow | Task 9; overflow menu items deferred to follow-up unless time allows |
| Multi-task interaction | Task 11 |
| IPC reuse | Tasks 4, 5, 10 |
| Testing | every task |
| Edge cases | Tasks 7 (deleted task during render returns null gracefully via useTask), 9 (later-today hidden after 19:00) |
| Accessibility | Task 6 (aria-label on checkbox + overflow), Task 9 (aria-labels on action buttons) |
| i18n | Task 13 |
| RTL logical classes | Tasks 6–9 (uses `ms-*`/`me-*`/`ps-*`/`pe-*` per project rule) |

**Open follow-ups not blocking this PR:**
- Overflow menu (`⋯`) Delete / Duplicate / Move to project / Copy link — wired stub in Task 6, full menu implementation can be a small follow-up PR
- Date-time picker for "Pick date & time…" snooze option — stub in Task 9; reuse the existing date-time picker the event popover uses if available
- Status pill query: confirm whether `tasks:get` already returns `statusLabel` or whether a separate `useStatus(statusId)` hook is needed
- Per-instance completion of recurring tasks: explicit non-goal; addressed in a separate spec when it becomes a priority

**Placeholder scan:** no `TBD` / `implement later` left in step bodies. Two explicit `TODO` markers in the Task 10 sample code are bracketed by comments calling out which task picks them up; remove or address them in Task 13.

**Type consistency:** `Task`, `CalendarProjectionItem`, `AnchorRect`, `SnoozeTarget` referenced consistently across tasks. `selectedTaskId` / `openForTask(taskId: string)` named identically in Task 3 and Task 10.
