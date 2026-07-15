# Task Tags UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose task tags in the tasks UI — picker in the drawer and add-modal, chips on rows, filter by tag, and a Tasks section in the tag drill-down.

**Architecture:** Renderer-only. Tags are already persisted, synced, and hydrated on every read (`tasks-repository.ts:158` → `enrichTask:125` → `getTaskTags`); the renderer's UI `Task` type simply has no `tags` field, so they are discarded on read and hardcoded to `[]` on write. Adding that one field is the keystone — it break-compiles every drop site. Filtering is client-side with OR semantics (tasks are already fully loaded), reusing the existing `TagChip` and `TagAutocomplete` components.

**Tech Stack:** Electron, React, TypeScript, Vitest (jsdom), TanStack Query, Tailwind, Drizzle/SQLite.

**Spec:** `docs/superpowers/specs/2026-07-16-task-tags-ui-design.md`

## Global Constraints

- **Backward compatibility is mandatory.** Production app, real user data. This change is additive only: no DB migration, no sync payload change, no IPC contract change to task create/update.
- **No main-process changes.** Hydration already works. If you find yourself editing `main/database/queries/tasks.ts`, stop — you are off-plan.
- **Logging:** `createLogger('Scope')` from `electron-log`, never raw `console.*`.
- **User-facing errors:** `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **Tailwind logical properties (RTL):** new code uses `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`, `border-s`/`border-e`, `rounded-s-*`/`rounded-e-*`. Never `ml-*`/`mr-*`/`left-*`/`right-*`. The pre-commit hook rejects physical classes in any file you stage.
- **i18n:** new renderer strings need an English key in `packages/i18n/src/locales/en/tasks.json`. `i18n:check` gates English only.
- **Tag identity is case-insensitive, case-preserving.** Compare with `.toLowerCase()`; store and display what the user typed.
- **Read before editing.** Several tasks below name files this plan has not quoted in full. Open them first.

**Verify commands:**

```bash
pnpm --filter @memry/desktop test:renderer          # all renderer tests
pnpm --filter @memry/desktop typecheck:web          # renderer typecheck
pnpm --filter @memry/desktop i18n:check
pnpm lint
```

Single renderer test file:

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer <path>
```

---

## File Structure

**Modified:**

- `apps/desktop/src/renderer/src/data/task-model.ts` — add `tags` to UI `Task` (keystone)
- `apps/desktop/src/renderer/src/features/tasks/use-task-queries.ts` — map/forward tags on read, create, update
- `apps/desktop/src/renderer/src/components/tasks/task-badges.tsx` — `TaskTagsBadge`
- `apps/desktop/src/renderer/src/components/tasks/task-row.tsx` — render chips
- `apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.tsx` — Tags row
- `apps/desktop/src/renderer/src/components/tasks/add-task-modal.tsx` — tag input
- `apps/desktop/src/renderer/src/data/tasks-data.ts` — `TaskFilters.tags` + `defaultFilters`
- `apps/desktop/src/renderer/src/lib/task-utils/task-filters.ts` — `filterByTags` + apply + counters
- `apps/desktop/src/renderer/src/hooks/use-task-filters.ts` — both saved-filter mappers
- `apps/desktop/src/renderer/src/services/saved-filters-service.ts` — `TaskFiltersConfig`
- `apps/desktop/src/preload/index.d.ts` — mirror
- `packages/contracts/src/saved-filters-api.ts` — `TaskFilters` + `TaskFiltersSchema`
- `apps/desktop/src/renderer/src/components/tasks/filters/filter-dropdown.tsx` — panel wiring
- `apps/desktop/src/renderer/src/components/tasks/filters/active-filters-bar.tsx` — pill
- `apps/desktop/src/renderer/src/components/sidebar/tag-detail-view.tsx` — Tasks section
- `packages/i18n/src/locales/en/tasks.json` — new keys

**Created:**

- `apps/desktop/src/renderer/src/components/tasks/filters/filter-panels/tag-panel.tsx`
- `apps/desktop/src/renderer/src/components/tasks/task-tags-badge.test.tsx`

**Test literals that will break-compile in Task 5** (this is the intended forcing function — each must gain `tags: []`):

- `lib/task-utils/task-utils.test.ts:166` — `createDefaultFilters()`
- `components/tasks/filters/task-filters-extra.test.tsx:49` — `richFilters`
- `components/tasks/filters/active-filters-bar.test.tsx:20` — `filtersWithPriority`
- `medium-gap-extra.test.tsx:92` — `makeFilters()`

---

## Task 1: Tags round-trip through the UI task model

**Files:**

- Modify: `apps/desktop/src/renderer/src/data/task-model.ts:39-68`
- Modify: `apps/desktop/src/renderer/src/features/tasks/use-task-queries.ts:87` (`dbTaskToUiTask`), `:319` (`addTask`), `:330` (`updateTask`)
- Test: `apps/desktop/src/renderer/src/features/tasks/use-task-queries.test.ts` (create if absent)

**Interfaces:**

- Consumes: `Task` from `@memry/rpc/tasks` — already declares `tags?: string[]` (`packages/rpc/src/tasks.ts:50`), populated by the main process on every read.
- Produces: UI `Task.tags: string[]` (always an array, never undefined). Every later task depends on this field.

- [ ] **Step 1: Write the failing test**

Open `use-task-queries.ts` first and match the existing test file's mocking style if one exists. Add to `apps/desktop/src/renderer/src/features/tasks/use-task-queries.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { dbTaskToUiTask } from './use-task-queries'

const baseDbTask = {
  id: 't1',
  projectId: 'p1',
  statusId: 's1',
  parentId: null,
  title: 'Write spec',
  description: null,
  priority: 0 as const,
  position: 0,
  dueDate: null,
  dueTime: null,
  startDate: null,
  repeatConfig: null,
  repeatFrom: null,
  sourceNoteId: null,
  completedAt: null,
  archivedAt: null,
  createdAt: '2026-07-16T00:00:00.000Z',
  modifiedAt: '2026-07-16T00:00:00.000Z'
}

describe('dbTaskToUiTask tags', () => {
  it('maps tags from the db task', () => {
    const result = dbTaskToUiTask({ ...baseDbTask, tags: ['MIT', 'work'] })
    expect(result.tags).toEqual(['MIT', 'work'])
  })

  it('defaults to an empty array when tags are absent', () => {
    const result = dbTaskToUiTask(baseDbTask)
    expect(result.tags).toEqual([])
  })

  it('preserves the case the user typed', () => {
    const result = dbTaskToUiTask({ ...baseDbTask, tags: ['MIT'] })
    expect(result.tags).toEqual(['MIT'])
  })
})
```

`dbTaskToUiTask` is currently module-private. Export it for this test — it is a pure mapper and exporting it is the least invasive way to pin the behavior.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/features/tasks/use-task-queries.test.ts
```

Expected: FAIL — `dbTaskToUiTask` is not exported, or `result.tags` is `undefined`.

- [ ] **Step 3: Add `tags` to the UI Task model**

In `data/task-model.ts`, inside `export interface Task`, after the `Linking` block:

```ts
  // Linking
  linkedNoteIds: string[] // connections to notes
  sourceNoteId: string | null // if extracted from a note

  // Tags — case-preserving, case-insensitive identity. Shared with notes/inbox
  // via the global tag_definitions store.
  tags: string[]
```

- [ ] **Step 4: Map and forward tags in `use-task-queries.ts`**

Export the mapper and map the field (`:87`):

```ts
export function dbTaskToUiTask(dbTask: Task): UiTask {
```

Add to the returned object, next to `linkedNoteIds`:

```ts
    linkedNoteIds: dbTask.linkedNoteIds ?? [],
    tags: dbTask.tags ?? [],
```

In `addTask` (`:319`), replace the hardcoded empty array:

```ts
          repeatFrom: null,
          tags: task.tags,
          linkedNoteIds: task.linkedNoteIds
```

In `updateTask` (`:330`), forward tags. Read the function first and match how it builds its update payload — it currently does not mention tags at all. Tags must only be sent when the caller changed them, mirroring how the other optional fields in that function are handled.

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/features/tasks/use-task-queries.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Fix the fallout**

Adding a required `tags` field break-compiles every place that constructs a UI `Task`.

```bash
pnpm --filter @memry/desktop typecheck:web
```

Add `tags: []` (or the real value where one exists) at each error site. This is the forcing function working — visit each site rather than loosening the type to `tags?: string[]`.

- [ ] **Step 7: Verify the full renderer suite is green**

```bash
pnpm --filter @memry/desktop test:renderer
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(tasks): carry tags through the UI task model"
```

---

## Task 2: Tag chips on task rows

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/tasks/task-badges.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tasks/task-row.tsx:156` (near `InlinePriorityPopover`)
- Test: `apps/desktop/src/renderer/src/components/tasks/task-tags-badge.test.tsx`

**Interfaces:**

- Consumes: UI `Task.tags` (Task 1). `TagChip` and `Tag` from `@/components/note/tags-row`. `useTags` from `@/hooks/use-tags` → `TagWithCount { name, count, color?, icon? }`.
- Produces: `TaskTagsBadge({ tags, maxVisible? })`, used by `task-row.tsx`.

`TagChip`'s exact API (verified, `components/note/tags-row/TagChip.tsx:8-23`):

```ts
export interface Tag {
  id: string
  name: string
  color: string
  icon?: string | null
}

interface TagChipProps {
  tag: Tag
  onRemove?: (tagId: string) => void
  onClick?: () => void
  isSelected?: boolean
  isFocused?: boolean
  disabled?: boolean
}
```

With no `onClick`, `TagChip` renders an `<li>` — so it needs a list parent. Pass `color: ''` on a definition miss; `getTagColors` then falls back to a stable per-name hash rather than grey.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TaskTagsBadge } from './task-badges'

vi.mock('@/hooks/use-tags', () => ({
  useTags: () => ({
    tags: [{ name: 'mit', count: 3, color: 'red', icon: null }]
  })
}))

describe('TaskTagsBadge', () => {
  it('renders a chip per tag', () => {
    render(<TaskTagsBadge tags={['MIT', 'work']} />)
    expect(screen.getByText('MIT')).toBeInTheDocument()
    expect(screen.getByText('work')).toBeInTheDocument()
  })

  it('renders nothing when there are no tags', () => {
    const { container } = render(<TaskTagsBadge tags={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a +N overflow badge past maxVisible', () => {
    render(<TaskTagsBadge tags={['a', 'b', 'c', 'd']} maxVisible={2} />)
    expect(screen.getByText('a')).toBeInTheDocument()
    expect(screen.getByText('b')).toBeInTheDocument()
    expect(screen.queryByText('c')).not.toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('matches tag definitions case-insensitively', () => {
    render(<TaskTagsBadge tags={['MIT']} />)
    // definition is stored lowercase ('mit'); display keeps the typed case
    expect(screen.getByText('MIT')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/components/tasks/task-tags-badge.test.tsx
```

Expected: FAIL — `TaskTagsBadge` is not exported from `task-badges.tsx`.

- [ ] **Step 3: Implement `TaskTagsBadge`**

Read `task-badges.tsx` first; follow the `ProjectBadge` pattern (`:25-49`). Append:

```tsx
const DEFAULT_MAX_VISIBLE_TAGS = 3

interface TaskTagsBadgeProps {
  tags: string[]
  maxVisible?: number
  className?: string
}

export const TaskTagsBadge = ({
  tags,
  maxVisible = DEFAULT_MAX_VISIBLE_TAGS,
  className
}: TaskTagsBadgeProps): React.JSX.Element | null => {
  const { tags: tagDefs } = useTags()

  const metaByName = useMemo(
    () => new Map(tagDefs.map((d) => [d.name.toLowerCase(), d])),
    [tagDefs]
  )

  const chips: Tag[] = useMemo(
    () =>
      tags.map((name) => {
        const meta = metaByName.get(name.toLowerCase())
        return {
          id: name,
          name,
          color: meta?.color ?? '',
          icon: meta?.icon ?? null
        }
      }),
    [tags, metaByName]
  )

  if (chips.length === 0) return null

  const visible = chips.slice(0, maxVisible)
  const overflowCount = chips.length - visible.length

  return (
    <ul className={cn('flex items-center gap-1.5 flex-wrap list-none p-0 m-0', className)}>
      {visible.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
      {overflowCount > 0 && (
        <li className="text-xs text-text-tertiary tabular-nums">+{overflowCount}</li>
      )}
    </ul>
  )
}
```

Imports to add at the top of `task-badges.tsx`:

```ts
import { useMemo } from 'react'
import { TagChip, type Tag } from '@/components/note/tags-row'
import { useTags } from '@/hooks/use-tags'
```

Note `color: meta?.color ?? ''` — the empty string is deliberate, not a bug. `getTagColors('', name)` hashes the name for a stable color.

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/components/tasks/task-tags-badge.test.tsx
```

Expected: PASS (4 tests).

- [ ] **Step 5: Render chips on the task row**

Read `task-row.tsx` around `:156` and place `<TaskTagsBadge tags={task.tags} />` alongside the existing badges, matching their layout and spacing. Keep it read-only here — editing happens in the drawer.

- [ ] **Step 6: Verify**

```bash
pnpm --filter @memry/desktop test:renderer && pnpm --filter @memry/desktop typecheck:web
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(tasks): show tag chips on task rows"
```

---

## Task 3: Tag picker in the task detail drawer

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.tsx:381` (beside the Priority row)
- Modify: `packages/i18n/src/locales/en/tasks.json`

**Interfaces:**

- Consumes: UI `Task.tags` (Task 1); `TagAutocomplete` from `@/components/filing/tag-autocomplete`.
- Produces: tag edits persisted via the drawer's existing update handler.

`TagAutocomplete`'s API (verified, `components/filing/tag-autocomplete.tsx:56-66`):

```ts
interface TagAutocompleteProps {
  tags: string[]
  onTagsChange: (tags: string[]) => void
  placeholder?: string
  showSections?: boolean
  maxSuggestions?: number
  autoFocus?: boolean
  aiSuggestedTags?: string[]
  className?: string
  dropdownPlacement?: 'top' | 'bottom'
}
```

Two known caveats — do not fight them, work around them:

- It hardcodes `flex flex-col gap-2 py-4 px-5 border-b border-border` plus an always-rendered "TAGS" label. `className` only appends, it cannot remove these. If that chrome clashes with the drawer, wrap it or lift the inner control rather than restyling via `className`.
- `showSections` is destructured as `_showSections` — accepted but ignored. Do not rely on it.

- [ ] **Step 1: Read the drawer**

Read `task-detail-drawer.tsx`, focusing on the Priority row at `:381` and the `handlePriorityChange` handler it uses. Mirror that handler's shape exactly for tags — same update path, same optimistic/invalidate behavior.

- [ ] **Step 2: Add the i18n key**

In `packages/i18n/src/locales/en/tasks.json`, add a `task.tags` key next to the existing `task.priority`. Match the surrounding nesting exactly — open the file and place it by structure, not by guessing the path.

- [ ] **Step 3: Add the Tags row**

Following the Priority row's markup, add a Tags row rendering `TagAutocomplete` with `tags={task.tags}` and an `onTagsChange` that routes through the drawer's existing task-update handler.

- [ ] **Step 4: Verify tags round-trip in the drawer**

```bash
pnpm --filter @memry/desktop test:renderer
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop i18n:check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tasks): add tag picker to the task detail drawer"
```

---

## Task 4: Tag input in the add-task modal

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/tasks/add-task-modal.tsx:292` (beside `PrioritySelect`)

**Interfaces:**

- Consumes: `TagAutocomplete` (same API and caveats as Task 3).
- Produces: `tags` on the created task, forwarded by `addTask` (Task 1, Step 4).

- [ ] **Step 1: Read the modal**

Read `add-task-modal.tsx`, focusing on `formData`, the `PrioritySelect` at `:292`, and the submit handler.

- [ ] **Step 2: Add tags to form state**

Add `tags: string[]` to `formData`, initialized to `[]`, and reset with the rest of the form on close.

- [ ] **Step 3: Render the tag input**

Add `TagAutocomplete` next to `PrioritySelect`, wired to `formData.tags`.

- [ ] **Step 4: Include tags on submit**

Ensure the submit handler passes `tags: formData.tags` into the created task. Task 1 already made `addTask` forward `task.tags`, so no change is needed in `use-task-queries.ts`.

- [ ] **Step 5: Verify**

```bash
pnpm --filter @memry/desktop test:renderer && pnpm --filter @memry/desktop typecheck:web
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(tasks): add tag input to the add-task modal"
```

---

## Task 5: Filter model, OR semantics, and persistence

**Files:**

- Modify: `apps/desktop/src/renderer/src/data/tasks-data.ts:277` (`TaskFilters`), `:346` (`defaultFilters`)
- Modify: `apps/desktop/src/renderer/src/lib/task-utils/task-filters.ts:50`, `:279`, `:303`, `:316`
- Modify: `packages/contracts/src/saved-filters-api.ts:35`, `:94`
- Modify: `apps/desktop/src/renderer/src/hooks/use-task-filters.ts:304`, `:343`
- Modify: `apps/desktop/src/renderer/src/services/saved-filters-service.ts:27`
- Modify: `apps/desktop/src/preload/index.d.ts:274`
- Test: `apps/desktop/src/renderer/src/lib/task-utils/task-utils.test.ts`

**Interfaces:**

- Consumes: UI `Task.tags` (Task 1).
- Produces: `TaskFilters.tags: string[]`, `filterByTags(tasks, tags): Task[]` — exported from `lib/task-utils/task-filters.ts`, consumed by Task 6.

**Semantics: OR, not AND.** A task matches if it carries **any** selected tag, mirroring `filterByPriorities`. The backend filter at `main/database/queries/tasks.ts:147` is AND (`tagCount === tags.length`) and is deliberately left unused — do not route through it.

- [ ] **Step 1: Write the failing test**

Add to `lib/task-utils/task-utils.test.ts` (reuse the file's existing task factory rather than inventing one):

```ts
describe('filterByTags', () => {
  const taskA = makeTask({ id: 'a', tags: ['MIT'] })
  const taskB = makeTask({ id: 'b', tags: ['work', 'urgent'] })
  const taskC = makeTask({ id: 'c', tags: [] })

  it('returns all tasks when no tags are selected', () => {
    expect(filterByTags([taskA, taskB, taskC], [])).toHaveLength(3)
  })

  it('matches any selected tag (OR, not AND)', () => {
    const result = filterByTags([taskA, taskB, taskC], ['MIT', 'work'])
    expect(result.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('matches case-insensitively', () => {
    expect(filterByTags([taskA], ['mit']).map((t) => t.id)).toEqual(['a'])
  })

  it('excludes untagged tasks when a tag is selected', () => {
    expect(filterByTags([taskA, taskC], ['MIT']).map((t) => t.id)).toEqual(['a'])
  })
})

describe('active filter counters include tags', () => {
  it('hasActiveFilters is true when tags are set', () => {
    expect(hasActiveFilters({ ...createDefaultFilters(), tags: ['MIT'] })).toBe(true)
  })

  it('countActiveFilters counts tags', () => {
    expect(countActiveFilters({ ...createDefaultFilters(), tags: ['MIT'] })).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/lib/task-utils/task-utils.test.ts
```

Expected: FAIL — `filterByTags` is not exported.

- [ ] **Step 3: Add `tags` to `TaskFilters` and `defaultFilters`**

In `data/tasks-data.ts`, inside `TaskFilters` after the priority block:

```ts
  // Priority filter (multi-select)
  priorities: Priority[] // empty = all priorities

  // Tag filter (multi-select, OR semantics)
  tags: string[] // empty = all tags
```

And in `defaultFilters`:

```ts
export const defaultFilters: TaskFilters = {
  search: '',
  projectIds: [],
  priorities: [],
  tags: [],
  dueDate: defaultDueDateFilter,
  statusIds: [],
  completion: 'active',
  repeatType: 'all',
  hasTime: 'all'
}
```

Make `tags` **required**, not optional. The break-compile is the point.

- [ ] **Step 4: Implement `filterByTags` and wire it in**

In `lib/task-utils/task-filters.ts`, after `filterByPriorities` (`:50`):

```ts
export const filterByTags = (tasks: Task[], tags: string[]): Task[] => {
  if (tags.length === 0) return tasks
  const selected = new Set(tags.map((t) => t.toLowerCase()))
  return tasks.filter((task) => task.tags.some((tag) => selected.has(tag.toLowerCase())))
}
```

In `applyFiltersAndSort`, after the priorities block:

```ts
if (filters.priorities.length > 0) {
  result = filterByPriorities(result, filters.priorities)
}

if (filters.tags.length > 0) {
  result = filterByTags(result, filters.tags)
}
```

In `hasActiveFilters`:

```ts
    filters.priorities.length > 0 ||
    filters.tags.length > 0 ||
```

In `countActiveFilters`:

```ts
if (filters.priorities.length > 0) count++
if (filters.tags.length > 0) count++
```

Both counters enumerate keys by hand — miss either and the filter chip and its count silently disagree with reality.

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/lib/task-utils/task-utils.test.ts
```

Expected: PASS.

- [ ] **Step 6: Add `tags` to the saved-filter contract**

In `packages/contracts/src/saved-filters-api.ts`, add to the `TaskFilters` interface (`:35`) and to `TaskFiltersSchema` (`:94`):

```ts
  tags: z.array(z.string()).default([]),
```

The `.default([])` is what makes this backward compatible: saved-filter rows written by older builds have no `tags` key and will parse cleanly to `tags: []`. No migration, no version bump — the config is an opaque JSON column.

- [ ] **Step 7: Update both saved-filter mappers**

In `hooks/use-task-filters.ts`, add `tags` to **both** directions — `dbToFrontendFilter` (`:304`) and `frontendToDbConfig` (`:343`):

```ts
      priorities: config.filters.priorities as Priority[],
      tags: config.filters.tags,
```

Both build object literals, so TypeScript cannot catch a missing field in `frontendToDbConfig`. Miss it and tags vanish silently on save/reload. Mirror the field in `services/saved-filters-service.ts:27` (`TaskFiltersConfig`) and `preload/index.d.ts:274`.

- [ ] **Step 8: Write the persistence round-trip test**

Add to `hooks/use-task-filters.test.ts`, matching the file's existing style:

```ts
it('round-trips tags through the saved-filter mappers', () => {
  const filters = { ...defaultFilters, tags: ['MIT'] }
  const config = frontendToDbConfig(filters)
  expect(dbToFrontendFilter({ id: 'f1', name: 'n', config }).filters.tags).toEqual(['MIT'])
})

it('parses a saved filter written without tags', () => {
  const parsed = TaskFiltersSchema.parse({ search: '', projectIds: [], priorities: [] })
  expect(parsed.tags).toEqual([])
})
```

Export the mappers if they are module-private. The second test is the backward-compatibility guarantee — it must pass.

- [ ] **Step 9: Fix the break-compiled test literals**

```bash
pnpm --filter @memry/desktop typecheck:web
```

Add `tags: []` to each: `createDefaultFilters()` (`task-utils.test.ts:166`), `richFilters` (`task-filters-extra.test.tsx:49`), `filtersWithPriority` (`active-filters-bar.test.tsx:20`), `makeFilters()` (`medium-gap-extra.test.tsx:92`).

- [ ] **Step 10: Guard the localStorage read**

`use-task-filters.ts:69` blind-spreads filters into localStorage, so entries written by older builds lack `tags`. Confirm the read path merges over `defaultFilters` — if it does not, `filters.tags.length` throws on `undefined` for any user with a persisted filter. Add the merge if missing, and cover it:

```ts
it('backfills tags when reading a persisted filter written without them', () => {
  localStorage.setItem(
    FILTERS_STORAGE_KEY,
    JSON.stringify({ all: { filters: { search: '', projectIds: [], priorities: [] } } })
  )
  expect(readPersistedFilterState('all').tags).toEqual([])
})
```

- [ ] **Step 11: Verify**

```bash
pnpm --filter @memry/desktop test:renderer && pnpm --filter @memry/desktop typecheck:web && pnpm check:contracts
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat(tasks): filter tasks by tag with OR semantics"
```

---

## Task 6: Tag filter panel UI

**Files:**

- Create: `apps/desktop/src/renderer/src/components/tasks/filters/filter-panels/tag-panel.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tasks/filters/filter-dropdown.tsx:37`, `:39`, `:46`, `:138`, `:245`
- Modify: `apps/desktop/src/renderer/src/components/tasks/filters/active-filters-bar.tsx:86`, `:269`
- Modify: `packages/i18n/src/locales/en/tasks.json`

**Interfaces:**

- Consumes: `TaskFilters.tags` and `filterByTags` (Task 5); `useTags` for the tag list; `TagChip`/`getTagColors` for swatches.
- Produces: user-facing tag filtering.

- [ ] **Step 1: Read the template**

Read `filter-panels/priority-panel.tsx` in full — it is the exact template, including its `FilterSearchHeader` / `FilterFooter` / `CheckMark` composition and the `BackButton` it defines and re-exports (other panels import `BackButton` from it).

- [ ] **Step 2: Create `tag-panel.tsx`**

Mirror `priority-panel.tsx` structurally. Differences:

- The option list is dynamic — source it from `useTags()` rather than a fixed `PRIORITY_ORDER`.
- Counts come from the passed `tasks`, counted case-insensitively:
  ```ts
  const countsByTag = useMemo(() => {
    const counts = new Map<string, number>()
    for (const task of tasks) {
      for (const tag of task.tags) {
        const key = tag.toLowerCase()
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    return counts
  }, [tasks])
  ```
- Render a color swatch per tag via `getTagColors(def.color ?? '', def.name)` instead of `PriorityIcon`.
- Selection compares case-insensitively; the selected value stores the definition's display name.
- Search filters on the tag name.

Props, mirroring `PriorityPanelProps`:

```ts
interface TagPanelProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  selectedTags: string[]
  onToggleTag: (tag: string) => void
  onClose: () => void
  onGoBack: () => void
  tasks: Task[]
}
```

- [ ] **Step 3: Wire into `filter-dropdown.tsx`**

Four lockstep edits — miss one and the panel is unreachable or crashes:

1. `:37` — add `'tags'` to the `ActivePanel` union
2. `:39` — add `{ key: 'tags', label: 'Tags' }` to `FILTER_CATEGORIES`
3. `:46` — add a `tags` entry to `CATEGORY_ICONS` (inline SVG, matching the others' size and `text-muted-foreground`)
4. `:138` + `:245` — add `toggleTag`, mirroring `togglePriority`, and the render block:

```tsx
const toggleTag = useCallback(
  (tag: string) => {
    const next = filters.tags.some((x) => x.toLowerCase() === tag.toLowerCase())
      ? filters.tags.filter((x) => x.toLowerCase() !== tag.toLowerCase())
      : [...filters.tags, tag]
    onUpdateFilters({ tags: next })
  },
  [filters.tags, onUpdateFilters]
)
```

```tsx
{
  activePanel === 'tags' && (
    <TagPanel
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      selectedTags={filters.tags}
      onToggleTag={toggleTag}
      onClose={() => handleOpenChange(false)}
      onGoBack={goBack}
      tasks={tasks}
    />
  )
}
```

- [ ] **Step 4: Add the active-filter pill**

In `active-filters-bar.tsx`, follow the priority pill pattern (`:86-117`), clearing via `onUpdateFilters({ tags: [] })`.

**Then add `filters.tags` to the `useMemo` dep array at `:269`** — it enumerates fields individually, so without this the pill will not re-render when tags change.

- [ ] **Step 5: Add i18n keys**

Add the panel's keys to `packages/i18n/src/locales/en/tasks.json`, matching the `phaseF.componentsTasksFilters*` naming used by the neighbouring panels.

- [ ] **Step 6: Write the panel test**

Add to `components/tasks/filters/active-filters-bar.test.tsx`, mirroring the priority chip test:

```tsx
it('renders a tag pill and clears it', async () => {
  const onUpdateFilters = vi.fn()
  render(
    <ActiveFiltersBar
      filters={{ ...defaultFilters, tags: ['MIT'] }}
      onUpdateFilters={onUpdateFilters}
    />
  )
  expect(screen.getByText('MIT')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: /tag/i }))
  expect(onUpdateFilters).toHaveBeenCalledWith({ tags: [] })
})
```

Match the file's existing render props — read it first; `ActiveFiltersBar` may take more props than shown.

- [ ] **Step 7: Verify**

```bash
pnpm --filter @memry/desktop test:renderer && pnpm --filter @memry/desktop typecheck:web && pnpm --filter @memry/desktop i18n:check && pnpm lint
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(tasks): add tag filter panel"
```

---

## Task 7: Tasks section in the tag detail view

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/sidebar/tag-detail-view.tsx:250-317`
- Modify: `packages/i18n/src/locales/en/tasks.json` (or the sidebar's namespace — match the file's existing `useT` call)

**Interfaces:**

- Consumes: UI `Task.tags` (Task 1); the tasks query layer for the task list.
- Produces: closes the existing dead-end where `calendar-task-popover.tsx:167` links a task's tag into a notes-only view.

**Why this exists:** clicking a tag on a task in the calendar popover already calls `openTag(...)` → this view, which today can only show notes. The task you clicked from cannot appear. This task fixes that.

**Semantics — match the notes sections.** `useTagDetail` defaults `includeDescendants = true`, so tag `work` lists `work/urgent` notes. The backend task filter is exact-match with no hierarchy, so using it would put two different behaviors under one header. Match tags client-side including descendants:

```ts
const matchesTagOrDescendant = (taskTag: string, tag: string): boolean => {
  const a = taskTag.toLowerCase()
  const b = tag.toLowerCase()
  return a === b || a.startsWith(`${b}/`)
}
```

- [ ] **Step 1: Read the view**

Read `tag-detail-view.tsx` — specifically the `useTagDetail` call (`:75-87`), the section structure (`:250-317`), the section-header markup (`:273`), and the `onTagRenamed` / `onTagDeleted` subscriptions (`:163-180`).

- [ ] **Step 2: Write the failing test**

```ts
describe('matchesTagOrDescendant', () => {
  it('matches the exact tag', () => {
    expect(matchesTagOrDescendant('work', 'work')).toBe(true)
  })

  it('matches descendants', () => {
    expect(matchesTagOrDescendant('work/urgent', 'work')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(matchesTagOrDescendant('Work/Urgent', 'work')).toBe(true)
  })

  it('does not match an unrelated prefix', () => {
    expect(matchesTagOrDescendant('workshop', 'work')).toBe(false)
  })
})
```

The `workshop` / `work` case is the one that matters — a naive `startsWith(b)` without the `/` passes the first three tests and fails this one.

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @memry/desktop exec vitest run --config config/vitest.config.ts --project renderer src/renderer/src/components/sidebar
```

Expected: FAIL — helper not defined.

- [ ] **Step 4: Implement the Tasks section**

Add a Tasks section after "All notes", reusing the exact section-header markup at `:273` (swap `Pin` for a task icon). Source tasks from the tasks query layer and filter with `matchesTagOrDescendant`. Do **not** pass a `tags` option to the backend list call.

- [ ] **Step 5: Refresh on tag rename and delete**

The view already subscribes to `onTagRenamed` / `onTagDeleted` (`:163-180`). Ensure the Tasks section refreshes on both — otherwise a renamed tag leaves stale task rows behind.

- [ ] **Step 6: Verify**

```bash
pnpm --filter @memry/desktop test:renderer && pnpm --filter @memry/desktop typecheck:web && pnpm --filter @memry/desktop i18n:check
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(tags): show tagged tasks in the tag detail view"
```

---

## Task 8: Full verification

- [ ] **Step 1: Run the full gate**

```bash
pnpm lint
pnpm typecheck
pnpm --filter @memry/desktop test:renderer
pnpm --filter @memry/desktop i18n:check
pnpm check:contracts
pnpm check:architecture
git diff --check
```

Expected: all PASS.

- [ ] **Step 2: Drive the real app**

Renderer tests do not prove this works. Run `pnpm dev` and confirm end-to-end:

1. Create a task via the add-modal with tag `MIT` → chip appears on the row
2. Open the drawer → `MIT` shows in the Tags row; add `work` → chip appears on the row
3. Filter by tag `MIT` → only MIT tasks show
4. Select `MIT` **and** `work` → tasks with **either** show (OR, not AND — this is the semantics check)
5. Save the filter, restart the app → the tag filter survives
6. Click a tag chip in the calendar task popover → the tag detail view opens **and lists the task**
7. Tag `work/urgent` on a task → the `work` tag detail view lists it (descendant match)
8. Restart → tags persist

- [ ] **Step 3: Docs gate**

```bash
base_commit=$(git merge-base origin/main HEAD)
pnpm docs:impact --base "$base_commit" --strict
```

If it reports `missing-docs`, update `apps/docs/src/**` or run `pnpm docs:ai-update --base "$base_commit"`, then re-run and `pnpm docs:build`.

- [ ] **Step 4: Push and open a draft PR**

```bash
git push -u origin task-tags-ui
gh pr create --draft --title "feat(tasks): tag tasks from the UI" --body "..."
```

Draft is the default. Do not mention agent tooling in the PR body.

---

## Self-Review Notes

**Spec coverage:** §1 model → Task 1. §2 main process (no-op) → no task, correctly. §3 surfaces → Tasks 2/3/4/6. §4 reuse → Tasks 2/3. §5 data source → Task 2. §6 OR semantics → Task 5. §7 filter wiring → Tasks 5/6. §8 persistence → Task 5. §9 tag detail view → Task 7.

**Deliberately not covered** (spec "Out of scope"): quick-add sigil, backend AND filter, task-specific tag colors, bulk tagging, the pre-existing `enrichTask` N+1.

**Type consistency:** `Task.tags: string[]` (Task 1) is used unchanged by Tasks 2/5/6/7. `filterByTags(tasks, tags)` (Task 5) matches its Task 6 call. `TaskTagsBadge({ tags, maxVisible?, className? })` (Task 2) matches its `task-row.tsx` usage. `TagChip`'s `Tag` shape is quoted verbatim from source.

**Known softness:** Tasks 3, 4, 6 (step 2), and 7 (step 4) describe changes to files this plan did not quote in full — each opens with a "read the file first" step and names the exact pattern to mirror. This is deliberate: inventing code for unread files produces confident, wrong plans.
