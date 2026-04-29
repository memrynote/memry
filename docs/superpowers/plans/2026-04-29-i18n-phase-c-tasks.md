# i18n Phase C — Tasks Namespace Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate representative Tasks feature UI strings to the `tasks.json` namespace, with English populated and Turkish/Arabic falling back to English.

**Architecture:** Add a `tasks` namespace to `@memry/i18n`, register it in the shared namespace list, resource map, and typed resource augmentation, then migrate task UI at component render boundaries with `useT('tasks')`. Use `useT('common')` only for Phase B common verbs already present, such as `button.cancel`, `button.save`, `button.create`, `button.delete`, `button.apply`, and `button.continue`. Keep user-authored task titles, project names, status names, note titles, and saved filter names untranslated.

**Tech Stack:** TypeScript, React 19, Electron 39, `react-i18next`, `@memry/i18n`, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`

**Depends on:** Phase A infrastructure and Phase B common namespace:
- `packages/i18n/src/renderer/use-t.ts`
- `packages/i18n/src/shared/config.ts`
- `packages/i18n/src/locales/en/common.json`
- `packages/i18n/src/locales/tr/common.json`
- `packages/i18n/src/locales/ar/common.json`

**Out of scope:**
- Phase D `errors.json`, native menu, and main-process copy.
- Phase E lint/codemod and `pnpm i18n:check`.
- Full task-folder string sweep. This plan uses representative exact files and a bounded final audit.
- Settings -> Tasks panel copy. That belongs to `docs/superpowers/plans/2026-04-29-i18n-phase-c-settings.md` and the `settings.json` namespace.
- Translating `tr/tasks.json` or `ar/tasks.json`; both remain literal `{}`.
- RTL Tailwind codemod.
- User content stored in the DB.

---

## Files

### Inspect

- `docs/superpowers/specs/2026-04-29-i18n-multi-language-support-design.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-a-infrastructure.md`
- `docs/superpowers/plans/2026-04-29-i18n-phase-b-common-namespace.md`
- `packages/i18n/src/shared/config.ts`
- `packages/i18n/src/shared/types.ts`
- `packages/i18n/src/locales/index.ts`
- `apps/desktop/src/renderer/src/pages/tasks.tsx`
- `apps/desktop/src/renderer/src/components/tasks/add-task-modal.tsx`
- `apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.tsx`
- `apps/desktop/src/renderer/src/components/tasks/tasks-tab-bar.tsx`
- `apps/desktop/src/renderer/src/components/tasks/filters/filter-empty-state.tsx`
- `apps/desktop/src/renderer/src/components/tasks/filters/group-by-dropdown.tsx`
- `apps/desktop/src/renderer/src/components/tasks/quick-add-input.tsx`
- `apps/desktop/src/renderer/src/components/tasks/kanban/kanban-board.tsx`

### Create

- `packages/i18n/src/locales/en/tasks.json`
- `packages/i18n/src/locales/tr/tasks.json`
- `packages/i18n/src/locales/ar/tasks.json`

### Modify

- `packages/i18n/src/shared/config.ts`
- `packages/i18n/src/shared/types.ts`
- `packages/i18n/src/locales/index.ts`
- `packages/i18n/src/renderer/index.test.ts`
- `packages/i18n/src/main/index.test.ts`
- `apps/desktop/src/renderer/src/pages/tasks.tsx`
- `apps/desktop/src/renderer/src/components/tasks/add-task-modal.tsx`
- `apps/desktop/src/renderer/src/components/tasks/add-task-modal.test.tsx`
- `apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.tsx`
- `apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.test.tsx`
- `apps/desktop/src/renderer/src/components/tasks/tasks-tab-bar.tsx`
- `apps/desktop/src/renderer/src/components/tasks/tasks-tab-bar.test.tsx`
- `apps/desktop/src/renderer/src/components/tasks/filters/filter-empty-state.tsx`
- `apps/desktop/src/renderer/src/components/tasks/filters/group-by-dropdown.tsx`
- `apps/desktop/src/renderer/src/components/tasks/filters/group-by-dropdown.test.tsx`
- `apps/desktop/src/renderer/src/components/tasks/quick-add-input.tsx`
- `apps/desktop/src/renderer/src/components/tasks/quick-add-input.test.tsx`
- `apps/desktop/src/renderer/src/components/tasks/kanban/kanban-board.tsx`

---

## Task 1: Add And Register `tasks.json`

- [ ] **Step 1: Verify Phase A/B files exist**

Run:

```bash
test -f packages/i18n/src/renderer/use-t.ts
test -f packages/i18n/src/locales/en/common.json
test -f packages/i18n/src/locales/tr/common.json
test -f packages/i18n/src/locales/ar/common.json
```

Expected: no output, exit 0. If any command fails, stop and rebase onto the Phase A/B branch.

- [ ] **Step 2: Create `packages/i18n/src/locales/en/tasks.json`**

Use this initial bounded English namespace. Add more keys only when one of this plan's exact files needs them.

```json
{
  "page": {
    "tabs": {
      "today": "Today",
      "all": "All"
    },
    "viewMode": {
      "label": "View mode",
      "list": "List view",
      "kanban": "Kanban view"
    },
    "projectScope": {
      "allProjects": "All projects",
      "searchProjects": "Search projects…",
      "editProject": "Edit {name}",
      "unstarSavedFilter": "Unstar {name}"
    }
  },
  "task": {
    "add": "Add Task",
    "title": "Title",
    "titleRequired": "Title is required",
    "titlePlaceholder": "What needs to be done?",
    "namePlaceholder": "Task name",
    "description": "Description",
    "descriptionPlaceholder": "Add a description…",
    "details": "Task details",
    "status": "Status",
    "priority": "Priority",
    "dueDate": "Due Date",
    "project": "Project",
    "repeat": "Repeat",
    "createAnother": "Create another",
    "delete": "Delete task",
    "created": "Created {date}"
  },
  "project": {
    "create": "Create Project",
    "edit": "Edit Project",
    "delete": "Delete Project",
    "iconAndName": "Icon & Name",
    "namePlaceholder": "Project name",
    "select": "Select project",
    "selectIcon": "Select icon",
    "clickIconToChange": "Click icon to change",
    "color": "Color",
    "descriptionOptional": "Description (optional)",
    "descriptionPlaceholder": "Brief description of this project…",
    "statuses": "Statuses",
    "statusesHelp": "Configure the workflow stages for this project.",
    "createDescription": "Create a new project with a name, icon, color, and workflow statuses.",
    "editDescription": "Edit the project name, icon, color, and workflow statuses."
  },
  "status": {
    "select": "Select status",
    "todo": "To Do",
    "inProgress": "In Progress",
    "done": "Done"
  },
  "priority": {
    "select": "Select priority",
    "none": "No Priority",
    "noneShort": "None",
    "low": "Low",
    "medium": "Medium",
    "high": "High",
    "urgent": "Urgent"
  },
  "filters": {
    "filter": "Filter",
    "emptyTitle": "No tasks match your filters",
    "emptyHelp": "Try adjusting your filters or",
    "groupBy": "Group by",
    "groupByOptions": "Group by options",
    "sortAscending": "Sort ascending",
    "sortDescending": "Sort descending"
  },
  "quickAdd": {
    "label": "Quick add task",
    "focusDescription": "Focus quick add input"
  },
  "drawer": {
    "close": "Close task details",
    "subIssues": "Sub-issues",
    "addSubIssue": "Add sub-issue",
    "subIssuePlaceholder": "Add sub-issue…",
    "noSubIssues": "No sub-issues yet",
    "linkedNotes": "Linked Notes",
    "linkNote": "Link a note",
    "loading": "Loading…",
    "searchNotes": "Search notes…",
    "noMatchingNotes": "No matching notes",
    "noNotesAvailable": "No notes available",
    "noLinkedNotes": "No linked notes yet",
    "removeLinkTo": "Remove link to {title}",
    "removeLinkFallback": "note"
  },
  "kanban": {
    "board": "Kanban board"
  },
  "toasts": {
    "projectUpdated": "Project updated",
    "projectCreated": "Project created",
    "projectSaveError": "Failed to save project",
    "projectArchived": "Project archived",
    "projectArchiveError": "Failed to archive project",
    "projectDeleted": "Project deleted",
    "projectDeleteError": "Failed to delete project",
    "filtersCleared": "Filters cleared",
    "filterSaved": "Filter saved",
    "filterDeleted": "Filter deleted",
    "filterApplied": "Applied \"{name}\""
  }
}
```

- [ ] **Step 3: Create empty fallback files**

Write exactly `{}` to:

```bash
packages/i18n/src/locales/tr/tasks.json
packages/i18n/src/locales/ar/tasks.json
```

Expected: both files are literal empty objects. Do not add Turkish or Arabic task strings in Phase C.

- [ ] **Step 4: Register namespace**

Modify `packages/i18n/src/shared/config.ts`:

```ts
export const I18N_NAMESPACES = [
  'common',
  'inbox',
  'notes',
  'journal',
  'calendar',
  'tasks',
  'settings',
  'errors',
  'menu'
] as const
```

Modify `packages/i18n/src/locales/index.ts`:

```ts
import enTasks from './en/tasks.json'
import trTasks from './tr/tasks.json'
import arTasks from './ar/tasks.json'
```

Add `tasks: enTasks`, `tasks: trTasks`, and `tasks: arTasks` in the matching locale objects.

Modify `packages/i18n/src/shared/types.ts`:

```ts
import type tasks from '../locales/en/tasks.json'

export interface Resources {
  common: typeof common
  inbox: typeof inbox
  notes: typeof notes
  journal: typeof journal
  calendar: typeof calendar
  tasks: typeof tasks
  settings: typeof settings
  errors: typeof errors
  menu: typeof menu
}
```

- [ ] **Step 5: Add namespace tests**

In `packages/i18n/src/renderer/index.test.ts`, add:

```ts
it('translates a tasks namespace string', async () => {
  const i18n = await createRendererI18n({ locale: 'en' })
  expect(i18n.t('tasks:task.add')).toBe('Add Task')
})

it('falls back to English for empty Turkish tasks namespace', async () => {
  const i18n = await createRendererI18n({ locale: 'tr' })
  expect(i18n.t('tasks:task.add')).toBe('Add Task')
})
```

In `packages/i18n/src/main/index.test.ts`, add:

```ts
it('loads the tasks namespace in the main i18n instance', async () => {
  const i18n = await createMainI18n({ locale: 'ar' })
  expect(i18n.t('tasks:page.tabs.today')).toBe('Today')
})
```

- [ ] **Step 6: Verify**

Run:

```bash
node -e "for (const f of ['packages/i18n/src/locales/en/tasks.json','packages/i18n/src/locales/tr/tasks.json','packages/i18n/src/locales/ar/tasks.json']) JSON.parse(require('fs').readFileSync(f, 'utf8')); console.log('OK')"
pnpm --filter @memry/i18n typecheck
pnpm --filter @memry/i18n test
```

Expected:
- JSON command prints `OK`.
- i18n typecheck passes.
- i18n tests pass and prove TR/AR fallback.

- [ ] **Step 7: Commit**

```bash
git add packages/i18n/src/shared/config.ts packages/i18n/src/shared/types.ts packages/i18n/src/locales/index.ts packages/i18n/src/locales/en/tasks.json packages/i18n/src/locales/tr/tasks.json packages/i18n/src/locales/ar/tasks.json packages/i18n/src/renderer/index.test.ts packages/i18n/src/main/index.test.ts
git commit -m "feat(i18n): add tasks namespace"
```

---

## Task 2: Migrate Representative Tasks Page

- [ ] **Step 1: Migrate `apps/desktop/src/renderer/src/pages/tasks.tsx`**

Add:

```ts
import { useT } from '@memry/i18n/renderer'
```

Inside `TasksPage`:

```ts
const { t } = useT('tasks')
```

Replace representative page copy:
- `Project updated` -> `t('toasts.projectUpdated')`
- `Project created` -> `t('toasts.projectCreated')`
- `Failed to save project` -> `t('toasts.projectSaveError')`
- `Project archived` -> `t('toasts.projectArchived')`
- `Failed to archive project` -> `t('toasts.projectArchiveError')`
- `Project deleted` -> `t('toasts.projectDeleted')`
- `Failed to delete project` -> `t('toasts.projectDeleteError')`
- `Filters cleared` -> `t('toasts.filtersCleared')`
- `Filter saved` -> `t('toasts.filterSaved')`
- `Filter deleted` -> `t('toasts.filterDeleted')`
- ``Applied "${savedFilter.name}"`` -> `t('toasts.filterApplied', { name: savedFilter.name })`
- visible `Filter` label -> `t('filters.filter')`
- `View mode`, `List view`, `Kanban view` ARIA labels -> `t('page.viewMode.*')`

Do not translate logger strings.

- [ ] **Step 2: Verify**

Run:

```bash
pnpm --filter @memry/desktop typecheck:web
```

Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/tasks.tsx
git commit -m "feat(i18n): migrate tasks page copy"
```

---

## Task 3: Migrate Representative Task Components

- [ ] **Step 1: Migrate `apps/desktop/src/renderer/src/components/tasks/add-task-modal.tsx`**

Use:

```ts
const { t } = useT('tasks')
const { t: tCommon } = useT('common')
```

Replace:
- Dialog title/button `Add Task` -> `t('task.add')`
- Labels `Title`, `Description`, `Project`, `Status`, `Due Date`, `Priority`, `Repeat`
- `Title is required`
- `What needs to be done?`
- `Add details, notes, or links...`
- `Create another`
- `Cancel` -> `tCommon('button.cancel')`

- [ ] **Step 2: Migrate `apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.tsx`**

Use `useT('tasks')`.

Replace:
- `Task details`
- `Task name`
- `Close task details`
- Property labels `Status`, `Priority`, `Due date`, `Project`
- `Description` and description placeholder
- `Sub-issues`, add sub-issue labels/placeholders/empty copy
- `Linked Notes`, note loading/search/empty copy
- ``Remove link to ${title}`` with `t('drawer.removeLinkTo', { title })`
- `Delete task`
- `Created ...` by formatting date via `Intl.DateTimeFormat(i18n.language, ...)` and passing it to `t('task.created', { date })`

- [ ] **Step 3: Migrate `apps/desktop/src/renderer/src/components/tasks/tasks-tab-bar.tsx`**

Use `useT('tasks')`.

Replace:
- `Today`, `All`
- `Task views`
- `All projects`
- `Search projects...`
- ``Unstar ${sf.name}``
- ``Edit ${p.name}``

Keep saved filter names and project names unchanged.

- [ ] **Step 4: Migrate representative filter/quick-add/kanban files**

Use `useT('tasks')` in:
- `apps/desktop/src/renderer/src/components/tasks/filters/filter-empty-state.tsx`
- `apps/desktop/src/renderer/src/components/tasks/filters/group-by-dropdown.tsx`
- `apps/desktop/src/renderer/src/components/tasks/quick-add-input.tsx`
- `apps/desktop/src/renderer/src/components/tasks/kanban/kanban-board.tsx`

Replace only the strings covered by `en/tasks.json`. Do not expand into a full folder sweep in this phase.

- [ ] **Step 5: Update representative tests**

Wrap with `I18nextProvider` where needed:
- `apps/desktop/src/renderer/src/components/tasks/add-task-modal.test.tsx`
- `apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.test.tsx`
- `apps/desktop/src/renderer/src/components/tasks/tasks-tab-bar.test.tsx`
- `apps/desktop/src/renderer/src/components/tasks/filters/group-by-dropdown.test.tsx`
- `apps/desktop/src/renderer/src/components/tasks/quick-add-input.test.tsx`

Keep English assertions. Add one fallback assertion in the smallest component test:

```ts
const i18nTr = await createRendererI18n({ locale: 'tr' })
render(
  <I18nextProvider i18n={i18nTr}>
    <AddTaskModal ... />
  </I18nextProvider>
)
expect(screen.getByText('Add Task')).toBeInTheDocument()
```

- [ ] **Step 6: Verify**

Run:

```bash
pnpm --filter @memry/desktop test:renderer -- src/components/tasks/add-task-modal.test.tsx src/components/tasks/task-detail-drawer.test.tsx src/components/tasks/tasks-tab-bar.test.tsx src/components/tasks/filters/group-by-dropdown.test.tsx src/components/tasks/quick-add-input.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/add-task-modal.tsx apps/desktop/src/renderer/src/components/tasks/add-task-modal.test.tsx apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.tsx apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.test.tsx apps/desktop/src/renderer/src/components/tasks/tasks-tab-bar.tsx apps/desktop/src/renderer/src/components/tasks/tasks-tab-bar.test.tsx apps/desktop/src/renderer/src/components/tasks/filters/filter-empty-state.tsx apps/desktop/src/renderer/src/components/tasks/filters/group-by-dropdown.tsx apps/desktop/src/renderer/src/components/tasks/filters/group-by-dropdown.test.tsx apps/desktop/src/renderer/src/components/tasks/quick-add-input.tsx apps/desktop/src/renderer/src/components/tasks/quick-add-input.test.tsx apps/desktop/src/renderer/src/components/tasks/kanban/kanban-board.tsx
git commit -m "feat(i18n): migrate representative task components"
```

---

## Task 4: Bounded Audit And Final Verification

- [ ] **Step 1: Confirm TR/AR tasks files are empty**

Run:

```bash
node -e "const fs=require('fs'); for (const f of ['packages/i18n/src/locales/tr/tasks.json','packages/i18n/src/locales/ar/tasks.json']) { if (fs.readFileSync(f,'utf8').trim() !== '{}') throw new Error(`${f} must be {}`) } console.log('OK')"
```

Expected: `OK`.

- [ ] **Step 2: Timeboxed representative string audit**

Run this only against assigned representative files, not the full folder:

```bash
rg -n --glob '!**/*.test.*' --pcre2 '(>[^<>{}]*[A-Z][^<>{}]*<|aria-label="[^"]*[A-Z][^"]*"|placeholder="[^"]*[A-Z][^"]*"|toast\.(success|error|info|warning)\()' apps/desktop/src/renderer/src/pages/tasks.tsx apps/desktop/src/renderer/src/components/tasks/add-task-modal.tsx apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.tsx apps/desktop/src/renderer/src/components/tasks/tasks-tab-bar.tsx apps/desktop/src/renderer/src/components/tasks/filters/filter-empty-state.tsx apps/desktop/src/renderer/src/components/tasks/filters/group-by-dropdown.tsx apps/desktop/src/renderer/src/components/tasks/quick-add-input.tsx apps/desktop/src/renderer/src/components/tasks/kanban/kanban-board.tsx
```

Expected: any remaining hits are either user content, non-user-facing values, logger copy, or explicitly deferred strings outside the representative slice.

- [ ] **Step 3: Run final focused gate**

Run:

```bash
pnpm --filter @memry/i18n typecheck
pnpm --filter @memry/i18n test
pnpm --filter @memry/desktop test:renderer -- src/components/tasks/add-task-modal.test.tsx src/components/tasks/task-detail-drawer.test.tsx src/components/tasks/tasks-tab-bar.test.tsx src/components/tasks/filters/group-by-dropdown.test.tsx src/components/tasks/quick-add-input.test.tsx
pnpm lint
pnpm typecheck
pnpm ipc:check
```

Expected:
- i18n package checks pass.
- Focused renderer tests pass.
- `pnpm lint` passes.
- `pnpm typecheck` passes, except known pre-existing unrelated test-file type errors if still present; report exact failures if they appear.
- `pnpm ipc:check` passes.

- [ ] **Step 4: Optional smoke**

Run:

```bash
pnpm dev
```

Expected manual checks:
- Tasks page representative UI still shows English.
- Add Task modal, task detail drawer, tabs, filter empty state, group-by dropdown, quick add, and kanban board render without raw `tasks:*` keys.
- Switching to Turkish or Arabic keeps this migrated copy visible in English fallback.

- [ ] **Step 5: Final commit if audit changed anything**

```bash
git add packages/i18n/src/locales/en/tasks.json packages/i18n/src/locales/tr/tasks.json packages/i18n/src/locales/ar/tasks.json packages/i18n/src/shared/config.ts packages/i18n/src/shared/types.ts packages/i18n/src/locales/index.ts packages/i18n/src/renderer/index.test.ts packages/i18n/src/main/index.test.ts apps/desktop/src/renderer/src/pages/tasks.tsx apps/desktop/src/renderer/src/components/tasks/add-task-modal.tsx apps/desktop/src/renderer/src/components/tasks/add-task-modal.test.tsx apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.tsx apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.test.tsx apps/desktop/src/renderer/src/components/tasks/tasks-tab-bar.tsx apps/desktop/src/renderer/src/components/tasks/tasks-tab-bar.test.tsx apps/desktop/src/renderer/src/components/tasks/filters/filter-empty-state.tsx apps/desktop/src/renderer/src/components/tasks/filters/group-by-dropdown.tsx apps/desktop/src/renderer/src/components/tasks/filters/group-by-dropdown.test.tsx apps/desktop/src/renderer/src/components/tasks/quick-add-input.tsx apps/desktop/src/renderer/src/components/tasks/quick-add-input.test.tsx apps/desktop/src/renderer/src/components/tasks/kanban/kanban-board.tsx
git commit -m "test(i18n): verify representative tasks migration"
```

Expected: commit only if final audit/test fixes changed files. Otherwise skip.

---

## Acceptance Criteria

- `tasks` is registered in `I18N_NAMESPACES`, `RESOURCES`, and typed i18n `Resources`.
- `packages/i18n/src/locales/en/tasks.json` exists and covers the representative migrated files.
- `packages/i18n/src/locales/tr/tasks.json` is exactly `{}`.
- `packages/i18n/src/locales/ar/tasks.json` is exactly `{}`.
- Representative task page/settings/component copy uses `useT('tasks')`.
- Generic Phase B verbs use `useT('common')` only where the common key already exists.
- Tests prove English rendering and TR/AR fallback.
- Final audit is bounded to the representative files in this plan.
