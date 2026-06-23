# Home Tasks Widget — Saved Filter Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the home dashboard tasks widget render any saved Tasks-page filter, chosen from a dropdown in the widget's gear/config panel.

**Architecture:** Reuse the existing widget `ConfigEditor` mechanism (the folder widget is the precedent). Add a saved-filter `<select>` that writes `config.savedFilterId`; the `TasksWidget` applies the chosen filter via the same `applyFiltersAndSort` the Tasks page uses, falling back to today/project view when no filter is selected or the filter is missing.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react, i18next (`useT`), Electron renderer.

## Global Constraints

- Prettier: single quotes, no semicolons, 100 char width, no trailing commas.
- Logical Tailwind classes only in new code (`ms-*`/`me-*`/`ps-*`/`pe-*`/`start-*`/`end-*`, `text-start`/`text-end`). The renderer guard scans whole staged files.
- User-facing strings go through `useT('common')` + i18n keys, never hardcoded JSX text.
- `config` is `Record<string, unknown>` — narrow every read with a `typeof` guard.
- Renderer tests run with: `pnpm --filter @memry/desktop test:renderer` (vitest `renderer` project). A bare `vitest run <file>` fails the `@tests` alias.
- No new dependencies. No DB/IPC/contract changes (saved filters already have full IPC + sync).
- `defaultConfig` for the tasks widget stays `{ dateRange: 'today' }` — `savedFilterId` is additive, no migration.

---

### Task 1: TasksWidget applies a selected saved filter

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/home/widgets/tasks-widget.tsx`
- Test: `apps/desktop/src/renderer/src/components/home/widgets/tasks-widget.test.tsx`

**Interfaces:**

- Consumes (existing, verified):
  - `useSavedFilters(): { savedFilters: SavedFilter[]; ... }` from `@/hooks/use-task-filters` — `savedFilters` is coalesced to `[]` (never `undefined`).
  - `SavedFilter = { id: string; name: string; filters: TaskFilters; sort?: TaskSort; starred: boolean; createdAt: Date }` from `@/data/tasks-data`.
  - `applyFiltersAndSort(tasks, filters, sort, projects): Task[]` from `@/lib/task-utils/task-filters`.
  - `defaultSort: TaskSort` from `@/data/tasks-data`.
  - `getFilteredTasks(tasks, selectedId, selectedType, projects): Task[]` from `@/lib/task-utils/task-view-helpers` (existing fallback).
- Produces: `config.savedFilterId?: string` is now honored by `TasksWidget`.

- [ ] **Step 1: Add the failing tests**

Replace the two module mocks and the `describe` block in `tasks-widget.test.tsx`. Add a `useSavedFilters` mock and an `applyFiltersAndSort` spy, then three new assertions. Final file:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TasksWidget } from './tasks-widget'
import { defaultSort } from '@/data/tasks-data'

const makeTask = (id: string, title: string) => ({
  id,
  title,
  description: '',
  projectId: 'p1',
  statusId: 's1',
  priority: 'none' as const,
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  parentId: null,
  subtaskIds: [],
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null
})

const tasks = [
  makeTask('t1', 'Alpha'),
  makeTask('t2', 'Beta'),
  makeTask('t3', 'Gamma'),
  makeTask('t4', 'Delta')
]

let mockTasks = tasks
let mockSavedFilters: Array<{ id: string; name: string; filters: unknown; sort?: unknown }> = []

vi.mock('@/features/tasks/use-task-queries', () => ({
  useTaskWorkspaceData: () => ({
    tasks: mockTasks,
    projects: [],
    isLoading: false,
    error: null
  }),
  useTaskWorkspaceMutations: () => ({ updateTask: vi.fn() })
}))

vi.mock('@/hooks/use-task-filters', () => ({
  useSavedFilters: () => ({ savedFilters: mockSavedFilters })
}))

const applyFiltersAndSort = vi.fn((input: typeof tasks) => input)
vi.mock('@/lib/task-utils/task-filters', () => ({
  applyFiltersAndSort: (...args: unknown[]) => applyFiltersAndSort(...(args as [typeof tasks]))
}))

vi.mock('@/lib/task-utils/task-view-helpers', () => ({
  getFilteredTasks: (input: typeof tasks) => input
}))

vi.mock('@/contexts/tabs/context', () => ({
  useTabActions: () => ({ openTab: vi.fn() })
}))

describe('TasksWidget', () => {
  beforeEach(() => {
    mockTasks = tasks
    mockSavedFilters = []
    applyFiltersAndSort.mockClear()
    applyFiltersAndSort.mockImplementation((input: typeof tasks) => input)
  })

  it('lists tasks', () => {
    render(<TasksWidget config={{}} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('respects the size limit', () => {
    render(<TasksWidget config={{}} size="S" />)
    expect(screen.getAllByTestId('task-item')).toHaveLength(3)
  })

  it('renders an empty state when there are no tasks', () => {
    mockTasks = []
    render(<TasksWidget config={{}} size="M" />)
    expect(screen.getByText('No tasks yet.')).toBeInTheDocument()
  })

  it('renders the selected saved filter via applyFiltersAndSort', () => {
    mockSavedFilters = [{ id: 'sf1', name: 'Mine', filters: { search: 'beta' } }]
    applyFiltersAndSort.mockImplementation(() => [makeTask('t2', 'Beta')])
    render(<TasksWidget config={{ savedFilterId: 'sf1' }} size="M" />)
    expect(screen.getByText('Beta')).toBeInTheDocument()
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
    expect(applyFiltersAndSort).toHaveBeenCalledWith(tasks, { search: 'beta' }, defaultSort, [])
  })

  it('falls back to the today view when the saved filter is missing', () => {
    mockSavedFilters = []
    render(<TasksWidget config={{ savedFilterId: 'gone' }} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(applyFiltersAndSort).not.toHaveBeenCalled()
  })

  it('ignores the saved-filter path when no savedFilterId is set', () => {
    mockSavedFilters = [{ id: 'sf1', name: 'Mine', filters: { search: 'beta' } }]
    render(<TasksWidget config={{}} size="M" />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(applyFiltersAndSort).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify the 3 new ones fail**

Run: `pnpm --filter @memry/desktop test:renderer tasks-widget.test.tsx`
Expected: the first three pass; "renders the selected saved filter…" FAILS (Beta path not taken — Alpha still shown / `applyFiltersAndSort` not called), and "ignores the saved-filter path…" may pass already. The "missing filter" test passes already. The key red is the "renders the selected saved filter" case.

- [ ] **Step 3: Implement the selection branch in `tasks-widget.tsx`**

Update the imports (top of file) — add three:

```tsx
import { useSavedFilters } from '@/hooks/use-task-filters'
import { applyFiltersAndSort } from '@/lib/task-utils/task-filters'
import { defaultSort } from '@/data/tasks-data'
```

Replace the body block from `const { tasks, projects, ... }` through the `const filtered = useMemo(...)` (currently lines ~16-28) with:

```tsx
const { tasks, projects, isLoading, error } = useTaskWorkspaceData({ enabled: true })
const { updateTask } = useTaskWorkspaceMutations()
const { openTab } = useTabActions()
const { savedFilters } = useSavedFilters()

const dateRange = typeof config.dateRange === 'string' ? config.dateRange : 'today'
const projectId = typeof config.projectId === 'string' ? config.projectId : null
const selectedId = projectId ?? dateRange
const selectedType = projectId ? 'project' : 'view'

const savedFilterId = typeof config.savedFilterId === 'string' ? config.savedFilterId : null
const savedFilter = savedFilterId ? savedFilters.find((f) => f.id === savedFilterId) : null

const filtered = useMemo(() => {
  if (savedFilter) {
    return applyFiltersAndSort(
      tasks,
      savedFilter.filters,
      savedFilter.sort ?? defaultSort,
      projects
    ).slice(0, limit)
  }
  return getFilteredTasks(tasks, selectedId, selectedType, projects).slice(0, limit)
}, [savedFilter, tasks, projects, selectedId, selectedType, limit])
```

Leave the existing `import { Project } from '@/data/tasks-data'` (type import) — merge the `defaultSort` value import into the same statement if it already imports from `@/data/tasks-data`, e.g. `import { defaultSort } from '@/data/tasks-data'` plus the existing `import type { Project } from '@/data/tasks-data'` stay as two lines (one type-only, one value). Do not collapse a `type` import into a value import.

- [ ] **Step 4: Run the tests to verify all pass**

Run: `pnpm --filter @memry/desktop test:renderer tasks-widget.test.tsx`
Expected: all 6 PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/home/widgets/tasks-widget.tsx \
        apps/desktop/src/renderer/src/components/home/widgets/tasks-widget.test.tsx
git commit -m "feat(home): tasks widget applies a selected saved filter"
```

---

### Task 2: Saved-filter config editor + registration + i18n

**Files:**

- Create: `apps/desktop/src/renderer/src/components/home/widgets/tasks-widget-config-editor.tsx`
- Create (test): `apps/desktop/src/renderer/src/components/home/widgets/tasks-widget-config-editor.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/home/widgets/index.ts`
- Modify: `packages/i18n/src/locales/en/common.json`

**Interfaces:**

- Consumes: `WidgetConfigEditorProps = { config: Record<string, unknown>; onChange: (config: Record<string, unknown>) => void }` from `@/lib/home/widget-registry`; `useSavedFilters()` from `@/hooks/use-task-filters`.
- Produces: `TasksWidgetConfigEditor: FC<WidgetConfigEditorProps>`, wired into the `tasks` widget registration so the gear panel renders it.

- [ ] **Step 1: Write the failing config-editor test**

Create `tasks-widget-config-editor.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TasksWidgetConfigEditor } from './tasks-widget-config-editor'

let mockSavedFilters: Array<{ id: string; name: string }> = []

vi.mock('@/hooks/use-task-filters', () => ({
  useSavedFilters: () => ({ savedFilters: mockSavedFilters })
}))

describe('TasksWidgetConfigEditor', () => {
  beforeEach(() => {
    mockSavedFilters = [
      { id: 'sf1', name: 'This week' },
      { id: 'sf2', name: 'Overdue' }
    ]
  })

  it('renders the Today default plus one option per saved filter', () => {
    render(<TasksWidgetConfigEditor config={{}} onChange={vi.fn()} />)
    expect(screen.getByRole('option', { name: 'Today' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'This week' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Overdue' })).toBeInTheDocument()
  })

  it('writes savedFilterId on change and clears it for the Today option', () => {
    const onChange = vi.fn()
    render(<TasksWidgetConfigEditor config={{ dateRange: 'today' }} onChange={onChange} />)
    const select = screen.getByRole('combobox')
    fireEvent.change(select, { target: { value: 'sf2' } })
    expect(onChange).toHaveBeenCalledWith({ dateRange: 'today', savedFilterId: 'sf2' })
    fireEvent.change(select, { target: { value: '' } })
    expect(onChange).toHaveBeenCalledWith({ dateRange: 'today', savedFilterId: undefined })
  })

  it('shows the hint when there are no saved filters', () => {
    mockSavedFilters = []
    render(<TasksWidgetConfigEditor config={{}} onChange={vi.fn()} />)
    expect(screen.getByText('Star filters on the Tasks page to use them here')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer tasks-widget-config-editor.test.tsx`
Expected: FAIL — `Cannot find module './tasks-widget-config-editor'`.

- [ ] **Step 3: Add the i18n keys**

In `packages/i18n/src/locales/en/common.json`, inside the `home.widget` object, after the `"unknown": "Unknown widget"` line add a comma and the three keys (match the existing 6-space indentation):

```json
      "unknown": "Unknown widget",
      "savedFilterLabel": "Saved filter",
      "savedFilterDefault": "Today",
      "savedFilterHint": "Star filters on the Tasks page to use them here"
```

- [ ] **Step 4: Create the config editor component**

Create `tasks-widget-config-editor.tsx` (mirrors `folder-widget-config-editor.tsx`):

```tsx
import type React from 'react'
import { useSavedFilters } from '@/hooks/use-task-filters'
import type { WidgetConfigEditorProps } from '@/lib/home/widget-registry'
import { useT } from '@memry/i18n/renderer'

export function TasksWidgetConfigEditor({
  config,
  onChange
}: WidgetConfigEditorProps): React.JSX.Element {
  const { t } = useT('common')
  const { savedFilters } = useSavedFilters()

  const savedFilterId = typeof config.savedFilterId === 'string' ? config.savedFilterId : ''

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {t('home.widget.savedFilterLabel')}
      </span>
      <select
        value={savedFilterId}
        onChange={(e) => onChange({ ...config, savedFilterId: e.target.value || undefined })}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
      >
        <option value="">{t('home.widget.savedFilterDefault')}</option>
        {savedFilters.map((filter) => (
          <option key={filter.id} value={filter.id}>
            {filter.name}
          </option>
        ))}
      </select>
      {savedFilters.length === 0 && (
        <span className="text-xs text-muted-foreground">{t('home.widget.savedFilterHint')}</span>
      )}
    </label>
  )
}
```

- [ ] **Step 5: Register the config editor**

In `apps/desktop/src/renderer/src/components/home/widgets/index.ts`, add the import after the `FolderWidgetConfigEditor` import:

```ts
import { TasksWidgetConfigEditor } from './tasks-widget-config-editor'
```

Then add `ConfigEditor` to the existing `tasks` registration so it reads:

```ts
registerWidget({
  type: 'tasks',
  titleKey: 'home.widget.tasks',
  icon: 'check-square',
  sizes: ['S', 'M', 'L'],
  defaultSize: 'M',
  defaultConfig: { dateRange: 'today' },
  Component: TasksWidget,
  ConfigEditor: TasksWidgetConfigEditor
})
```

- [ ] **Step 6: Run the config-editor test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer tasks-widget-config-editor.test.tsx`
Expected: all 3 PASS.

- [ ] **Step 7: Run i18n check + typecheck**

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: passes (no missing-key errors for the new keys).
Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/components/home/widgets/tasks-widget-config-editor.tsx \
        apps/desktop/src/renderer/src/components/home/widgets/tasks-widget-config-editor.test.tsx \
        apps/desktop/src/renderer/src/components/home/widgets/index.ts \
        packages/i18n/src/locales/en/common.json
git commit -m "feat(home): saved-filter dropdown in tasks widget config panel"
```

---

### Task 3: Full-gate verification

**Files:** none (verification only).

- [ ] **Step 1: Renderer tests (full)**

Run: `pnpm --filter @memry/desktop test:renderer`
Expected: all pass (no regressions from the two new files).

- [ ] **Step 2: Lint + renderer guard**

Run: `pnpm lint`
Expected: 0 errors. (Confirms the new files use logical Tailwind classes and code style.)

- [ ] **Step 3: Typecheck (web)**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: 0 errors.

- [ ] **Step 4: Whitespace check**

Run: `git diff --check`
Expected: no output.

- [ ] **Step 5: Manual GUI QA (human)**

1. `pnpm dev` → open the Home board, enter edit mode, add/locate a Tasks widget.
2. On the Tasks page, create + star at least one saved filter (e.g. "Overdue").
3. Back on Home: open the Tasks widget gear → the "Saved filter" select lists "Today" + your saved filters.
4. Pick a saved filter → the widget list updates to that filter's tasks. Pick "Today" → reverts.
5. Delete the saved filter on the Tasks page → the widget gracefully falls back to the Today view (no crash).

---

## Self-Review

**Spec coverage:**

- Config shape (`savedFilterId`) → Task 1 Step 3. ✓
- Config editor `<select>` with Today default + per-filter options + empty hint → Task 2 Steps 1/4. ✓
- Widget selection logic (apply found filter / fallback when missing or unset) → Task 1 Steps 1/3. ✓
- Registration of `ConfigEditor` → Task 2 Step 5. ✓
- i18n keys → Task 2 Step 3. ✓
- Tests (found / missing / unset) → Task 1 Step 1; editor tests → Task 2 Step 1. ✓
- Gates (`test:renderer`, `typecheck:web`, `lint`, `i18n:check`) → Tasks 1–3. ✓

**Placeholder scan:** none — all steps contain concrete code and exact commands.

**Type consistency:** `savedFilter.filters` / `savedFilter.sort` match `SavedFilter`; `applyFiltersAndSort(tasks, filters, sort, projects)` arg order matches `@/lib/task-utils/task-filters`; `defaultSort` is the `sort` fallback; `WidgetConfigEditorProps` (`config`, `onChange`) matches the registry. The test's `applyFiltersAndSort` assertion args `(tasks, { search: 'beta' }, defaultSort, [])` match the call site (projects mocked to `[]`, saved filter has no `sort` → `defaultSort`). ✓

**i18n scope:** verified only `en/common.json` carries `home.widget` keys today (other locales have 0), so adding to `en` only keeps `i18n:check` green. ✓
