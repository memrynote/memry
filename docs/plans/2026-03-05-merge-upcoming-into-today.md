# Merge Upcoming Into Today View — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the Upcoming tab and fold its per-day weekly view into Today as a collapsible "This Week" accordion section.

**Architecture:** Today view gains a third section (Overdue → Today → This Week). "This Week" is collapsed by default, shows 6 per-day sub-sections (tomorrow through +6 days, skipping today since it has its own section) with droppable zones for drag-and-drop date reassignment. Includes a "Show empty days" toggle (off by default when no empty days exist). The Upcoming tab, view component, and all tab-switching references are removed.

**Tech Stack:** React, @tanstack/react-virtual, @dnd-kit/sortable, existing task-utils + virtual-list-utils

---

## Important Distinctions

- `TaskGroupByDate.upcoming` (the "2-7 days" bucket in All view) — **KEEP untouched**
- `TasksInternalTab = 'upcoming'` (the tab) — **REMOVE**
- `UpcomingView` component — **DELETE** (both legacy and virtualized)
- `onViewUpcoming` prop chain — **REMOVE** (no longer needed; week is inline)
- `getUpcomingTasks()` in task-utils — **REUSE** inside Today view for the week data

---

### Task 1: Extend `flattenTodayTasks` to support "This Week" section

**Why:** The flattening utility is the data backbone of the virtualized Today view. We need it to emit day-header items and per-day task items for the "This Week" accordion.

**Files:**

- Modify: `src/renderer/src/lib/virtual-list-utils.ts`
- Modify: `src/renderer/src/lib/task-utils.ts` (new combined data function)

**Step 1: Add new virtual item types**

In `virtual-list-utils.ts`, extend `VirtualItemType` to include `'week-accordion-header'` and `'day-header'`:

```typescript
export type VirtualItemType =
  | 'section-header'
  | 'status-header'
  | 'week-accordion-header' // NEW: "This Week" collapsible header
  | 'day-header' // NEW: Per-day header (Tomorrow, Wednesday, etc.)
  | 'task'
  | 'parent-task'
  | 'empty-state'
  | 'add-task-button'
```

Add corresponding interfaces:

```typescript
export interface WeekAccordionHeaderItem extends VirtualItemBase {
  type: 'week-accordion-header'
  totalCount: number
  isCollapsed: boolean
}

export interface DayHeaderItem extends VirtualItemBase {
  type: 'day-header'
  date: Date
  dateKey: string
  taskCount: number
  isTomorrow: boolean
}
```

Add them to the `VirtualItem` union type.

Add height constants:

```typescript
export const ITEM_HEIGHTS = {
  ...existing,
  'week-accordion-header': 48,
  'day-header': 40,
  'empty-day': 56
}
```

Update `estimateItemHeight` to handle the new types.

**Step 2: Create `getTodayWithWeekTasks` in task-utils.ts**

```typescript
export interface TodayWithWeekTasks {
  overdue: Task[]
  today: Task[]
  weekByDay: Map<string, Task[]> // tomorrow through day 7
}

export const getTodayWithWeekTasks = (
  tasks: Task[],
  projects: Project[],
  weekDays: number = 6
): TodayWithWeekTasks => {
  // Combine getTodayTasks + getUpcomingTasks logic
  // overdue + today (same as getTodayTasks)
  // weekByDay: days 1-6 (tomorrow through +6), skip today (day 0)
}
```

**Step 3: Extend `flattenTodayTasks` signature**

Add optional `weekByDay` parameter. After the Today section, if `weekByDay` is provided, emit:

1. A `week-accordion-header` item (collapsible via `collapsedSections.has('this-week')`)
2. If expanded: for each day in weekByDay, emit a `day-header` + task items + `add-task-button` (or `empty-day` empty state)

The `sectionId` for week tasks should be the `dateKey` (e.g., `2026-03-06`) so drag-and-drop can map section → date.

**Step 4: Run existing tests**

Run: `pnpm test src/renderer/src/lib/virtual-list-utils.test.ts`
Expected: All existing tests pass (we only added, didn't change existing behavior)

**Step 5: Write tests for new flattening**

Add test cases in `virtual-list-utils.test.ts`:

- `flattenTodayTasks` with weekByDay data emits week-accordion-header
- Collapsed "this-week" section hides day items
- Empty days emit empty-day items
- sectionId on week tasks matches dateKey

**Step 6: Commit**

```bash
git add src/renderer/src/lib/virtual-list-utils.ts src/renderer/src/lib/task-utils.ts src/renderer/src/lib/virtual-list-utils.test.ts
git commit -m "feat(tasks): extend virtual-list-utils with week accordion support"
```

---

### Task 2: Add week rendering to `VirtualizedTodayView`

**Why:** The Today view component needs to fetch week data, pass it to the flattener, and render the new item types (week header, day headers, day tasks).

**Files:**

- Modify: `src/renderer/src/components/tasks/today/virtualized-today-view.tsx`

**Step 1: Import new data function and types**

Replace `getTodayTasks` import with `getTodayWithWeekTasks`. Import new virtual item types (`WeekAccordionHeaderItem`, `DayHeaderItem`).

**Step 2: Update data fetching**

Change:

```typescript
const todayData = useMemo(() => getTodayTasks(tasks, projects), [tasks, projects])
```

To:

```typescript
const todayData = useMemo(() => getTodayWithWeekTasks(tasks, projects), [tasks, projects])
```

**Step 3: Pass weekByDay to flattener**

Update the `flattenTodayTasks` call to pass `todayData.weekByDay`.

**Step 4: Add new cases to `VirtualItemRenderer`**

Handle `'week-accordion-header'`:

- Render a collapsible header similar to overdue/today but with neutral styling
- Label: "THIS WEEK"
- Show total count badge
- Click toggles `'this-week'` section via `onToggleCollapse`
- Collapsed by default (add `'this-week'` to initial collapsed state)

Handle `'day-header'`:

- Reuse existing `DaySectionHeader` component from `src/renderer/src/components/tasks/day-section-header.tsx`
- Wrap in a droppable zone so tasks can be dropped onto day headers

Handle `'empty-day'`:

- Show a simple "No tasks" row with an "Add task" button for that date

**Step 5: Add `onAddTaskWithDate` prop**

The Today view needs to accept `onAddTaskWithDate?: (date: Date) => void` so per-day "Add task" buttons work (same prop the Upcoming view had).

**Step 6: Remove `onViewUpcoming` prop**

Remove `onViewUpcoming` from props interface and all internal references. Remove the "View upcoming" button from the celebration empty state entirely — keep only the celebration message and "Add task for today" button.

**Step 7: Verify visually**

Run the app and confirm:

- Overdue and Today sections render as before
- "This Week" appears collapsed by default with correct count
- Expanding shows per-day sections with tasks
- Drag from Today to a day section updates the task's due date
- Per-day "Add task" buttons create tasks with correct date
- Empty days show placeholder

**Step 8: Commit**

```bash
git add src/renderer/src/components/tasks/today/
git commit -m "feat(tasks): add This Week accordion to Today view"
```

---

### Task 3: Remove Upcoming tab from navigation

**Why:** With week planning merged into Today, the Upcoming tab is redundant.

**Files:**

- Modify: `src/renderer/src/components/tasks/tasks-tab-bar.tsx`
- Modify: `src/renderer/src/pages/tasks.tsx`
- Modify: `src/renderer/src/data/tasks-data.ts`
- Modify: `src/renderer/src/App.tsx`

**Step 1: Update `TasksInternalTab` type**

In `tasks-tab-bar.tsx`, change:

```typescript
export type TasksInternalTab = 'all' | 'today' | 'projects'
```

Remove `CalendarDays` from lucide imports.

**Step 2: Remove upcoming from tabs array**

```typescript
const tabs: TabConfig[] = [
  { id: 'all', label: 'All', icon: List },
  { id: 'today', label: 'Today', icon: Star },
  { id: 'projects', label: 'Projects', icon: FolderKanban }
]
```

**Step 3: Remove upcoming from counts interface**

```typescript
counts: {
  all: number
  today: number
  projects: number
}
```

**Step 4: Update tasks.tsx**

- Remove `import { UpcomingView }` (line 14)
- Remove the `activeInternalTab === 'upcoming'` rendering block (lines 1229-1243)
- Remove `upcoming` from `tabCounts` calculation (lines 355, 360)
- Remove `activeInternalTab === 'upcoming'` from list-only view check (line 208) — just check `'today'`
- Remove `onViewUpcoming` prop from `<TodayView>` (line 1223)
- Add `onAddTaskWithDate={handleAddTaskWithDate}` to `<TodayView>` (reuse existing handler)
- Remove upcoming-related filtering in the `selectedId === 'upcoming'` blocks (lines 553, 587)
- Clean up any remaining 'upcoming' tab references in drag-and-drop handlers

**Step 5: Update data/tasks-data.ts**

- Remove `'upcoming'` from `LIST_ONLY_VIEWS` (line 58)
- Remove the upcoming entry from sidebar items (line 121)

**Step 6: Update App.tsx**

- Remove `'upcoming'` from `TaskViewId` type (line 51)

**Step 7: TypeScript check**

Run: `pnpm typecheck`
Expected: No new errors related to 'upcoming' removal

**Step 8: Commit**

```bash
git add src/renderer/src/components/tasks/tasks-tab-bar.tsx src/renderer/src/pages/tasks.tsx src/renderer/src/data/tasks-data.ts src/renderer/src/App.tsx
git commit -m "feat(tasks): remove Upcoming tab from navigation"
```

---

### Task 4: Clean up Upcoming view files and remaining references

**Why:** Dead code removal. The Upcoming view components are no longer imported.

**Files:**

- Delete: `src/renderer/src/components/tasks/upcoming/virtualized-upcoming-view.tsx`
- Delete: `src/renderer/src/components/tasks/upcoming/upcoming-view.tsx`
- Delete: `src/renderer/src/components/tasks/upcoming/index.ts`
- Delete: `src/renderer/src/components/tasks/upcoming/` (directory)
- Modify: `src/renderer/src/components/tasks/empty-states/section-empty-states.tsx` (remove `onViewUpcoming` prop)
- Modify: `src/renderer/src/components/tasks/today-empty-state.tsx` (remove `onViewUpcoming` prop)
- Modify: `src/renderer/src/components/tasks/today/today-view.tsx` (legacy: remove `onViewUpcoming`)
- Modify: `src/renderer/src/contexts/tabs/types.ts` (remove 'upcoming' from legacy types)
- Modify: `src/renderer/src/contexts/tabs/helpers.ts` (remove 'upcoming' entries)
- Modify: `src/renderer/src/components/split-view/tab-content.tsx` (remove 'upcoming' case)
- Modify: `src/renderer/src/components/tabs/tab-icon.tsx` (remove 'upcoming' entry)
- Modify: `src/renderer/src/components/tasks/task-empty-state.tsx` (remove 'upcoming' variant)

**Step 1: Delete the upcoming directory**

```bash
rm -rf src/renderer/src/components/tasks/upcoming/
```

**Step 2: Remove `onViewUpcoming` from empty state components**

In `section-empty-states.tsx` and `today-empty-state.tsx`: remove the prop, the "View upcoming tasks" button, and related imports.

**Step 3: Clean up tab/context references**

Remove `'upcoming'` entries from:

- `contexts/tabs/types.ts` (lines 19, 43)
- `contexts/tabs/helpers.ts` (lines 100, 133)
- `components/split-view/tab-content.tsx` (line 100)
- `components/tabs/tab-icon.tsx` (line 77)
- `components/tasks/task-empty-state.tsx` (lines 43-46)

**Step 4: TypeScript check**

Run: `pnpm typecheck`
Expected: Clean (no 'upcoming' references causing errors)

**Step 5: Run full test suite**

Run: `pnpm test`
Expected: All passing. Some upcoming-specific test assertions in `task-utils.test.ts` and `section-visibility.test.ts` still pass because they test `getUpcomingTasks()` and the "upcoming" date group in All view — these are still valid utilities.

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor(tasks): remove Upcoming view files and dead references"
```

---

### Task 5: Droppable day sections for drag-and-drop

**Why:** Users need to drag tasks between Today and specific days in the "This Week" section (the core UX win of this change).

**Files:**

- Modify: `src/renderer/src/components/tasks/today/virtualized-today-view.tsx`
- Modify: `src/renderer/src/pages/tasks.tsx` (DnD onDragEnd handler)

**Step 1: Wrap day-header items in `useDroppable`**

Create a `DroppableDayHeader` wrapper (similar to existing `DroppableSectionHeader`):

```typescript
const DroppableDayHeader = memo(({ item }: { item: DayHeaderItem }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: item.dateKey,
    data: {
      type: 'section',
      sectionId: item.dateKey,
      label: getDayHeaderText(item.date).primary,
      date: item.date
    }
  })

  return (
    <div ref={setNodeRef}>
      <DaySectionHeader
        date={item.date}
        taskCount={item.taskCount}
        className={isOver ? 'ring-2 ring-primary/50 ring-inset rounded-md' : undefined}
      />
    </div>
  )
})
```

**Step 2: Update DnD `onDragEnd` in tasks.tsx**

The existing handler needs to recognize day-based `sectionId` values (dateKeys like `2026-03-06`) and update the task's `dueDate` accordingly:

```typescript
// In the onDragEnd handler, after detecting the target section:
if (targetSectionId && targetSectionId.match(/^\d{4}-\d{2}-\d{2}$/)) {
  const targetDate = parseDateKey(targetSectionId)
  handleUpdateTask(taskId, { dueDate: targetDate })
  return
}
```

Also handle drops on the 'today' and 'overdue' sections (set dueDate to today's date).

**Step 3: Verify drag-and-drop**

Test manually:

- Drag task from Today → Thursday day section → task dueDate becomes Thursday
- Drag task from Thursday → Today section → task dueDate becomes today
- Drag within same day → reorders (no date change)
- Drag to empty day section → task moves to that day

**Step 4: Commit**

```bash
git add src/renderer/src/components/tasks/today/ src/renderer/src/pages/tasks.tsx
git commit -m "feat(tasks): droppable day sections for cross-day drag-and-drop"
```

---

### Task 6: Default "This Week" to collapsed & persist state

**Why:** Progressive disclosure — Today should be focused by default. The week accordion is there when you need it.

**Files:**

- Modify: `src/renderer/src/hooks/use-collapsed-sections.ts`

**Step 1: Set default collapsed state**

In the `useCollapsedSections` hook, when `viewKey === 'today'`, initialize with `'this-week'` in the collapsed set if no persisted state exists:

```typescript
const getDefaultCollapsed = (viewKey: string): Set<string> => {
  if (viewKey === 'today') return new Set(['this-week'])
  return new Set()
}
```

**Step 2: Verify persistence**

- Expand "This Week" → reload → should stay expanded (persisted in localStorage)
- Collapse → reload → should stay collapsed

**Step 3: Commit**

```bash
git add src/renderer/src/hooks/use-collapsed-sections.ts
git commit -m "feat(tasks): default This Week section to collapsed state"
```

---

## Resolved Decisions

1. **Empty day toggle:** Include a "Show empty days" toggle in the This Week section header area. Default: off if there are no empty days, on otherwise. Empty days still serve as drop targets when visible.

2. **Days ahead count:** This Week shows **6 days** (tomorrow through +6). Today is skipped since it has its own dedicated section above.

3. **Celebration empty state:** Remove the "View upcoming" button entirely from the celebration empty state. Keep the celebration message and "Add task for today" button only.
