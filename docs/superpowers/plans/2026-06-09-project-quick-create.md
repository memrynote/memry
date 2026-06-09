# Inline "New project" in task project dropdowns — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Create project" entry to the bottom of the project dropdown in the Add Task modal and the Task Detail drawer; it opens the existing `ProjectModal`, creates the project, and auto-selects it.

**Architecture:** One shared hook `useProjectQuickCreate(onCreated)` owns the existing `ProjectModal` (create mode) and the create→select flow via the Tasks context's optimistic `addProject`. A `ProjectCreateFooter` component renders a `Picker.Footer` button that closes the popover and opens the modal. `ProjectSelect` always shows it (when context present); `InteractiveProjectBadge` shows it only behind an opt-in `allowCreate` prop, enabled solely at the drawer call site.

**Tech Stack:** React 19, TypeScript, Vitest + Testing Library, react-i18next, existing `Picker` compound component.

Spec: `docs/superpowers/specs/2026-06-09-project-quick-create-design.md`

---

## File Structure

- **Create** `apps/desktop/src/renderer/src/components/tasks/use-project-quick-create.tsx` — the `useProjectQuickCreate` hook + `ProjectCreateFooter` component. Single responsibility: own the create-project dialog + footer trigger.
- **Create** `apps/desktop/src/renderer/src/components/tasks/project-select.test.tsx` — tests for the footer in `ProjectSelect`.
- **Modify** `apps/desktop/src/renderer/src/components/tasks/project-select.tsx` — render footer + dialog.
- **Modify** `apps/desktop/src/renderer/src/components/tasks/interactive-project-badge.tsx` — add `allowCreate` prop; render footer + dialog when set.
- **Modify** `apps/desktop/src/renderer/src/components/tasks/interactive-project-badge.test.tsx` — add create-flow tests (existing tests untouched).
- **Modify** `apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.tsx:346` — pass `allowCreate`.

Verified facts the implementation relies on:

- `useTasksOptional()` (`@/contexts/tasks`) returns `null` when no `TasksProvider` is mounted — never throws. Existing badge tests rely on this.
- `addProject` (Tasks context) is optimistic: it runs `setProjects((prev) => [...prev, project])` synchronously, then awaits IPC.
- `ProjectModal` create mode (no `project` prop): builds a full `Project` via `generateId('project')` + `createDefaultProject()` statuses (`To Do`/`In Progress`/`Done`, valid), then calls `onSave(project)` followed by `onClose()`.
- `createDefaultProject().name === ''` → the modal's **Create** button is disabled until a name is typed; statuses are valid by default.
- i18n key `phaseF.componentsTasksProjectsProjectSelector.createProject` already exists in all locales → English `"Create project"`. No new keys.
- `Picker.Footer` = a `div` with `border-t border-border` (no padding). `Picker.List` uses `p-1`. `usePickerContext()` and `Picker.Footer` are exported from `@/components/ui/picker`.

---

## Task 1: Shared hook + footer, wired into `ProjectSelect`

**Files:**

- Create: `apps/desktop/src/renderer/src/components/tasks/use-project-quick-create.tsx`
- Create: `apps/desktop/src/renderer/src/components/tasks/project-select.test.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tasks/project-select.tsx`

- [ ] **Step 1: Write the failing test** (`project-select.test.tsx`)

```tsx
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import type { ReactElement } from 'react'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { ProjectSelect } from './project-select'
import { useTasksOptional } from '@/contexts/tasks'
import type { Project } from '@/data/tasks-data'

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: vi.fn(),
  useTasksContext: vi.fn()
}))

const projects: Project[] = [
  {
    id: 'proj-1',
    name: 'Personal',
    description: '',
    icon: 'inbox',
    color: '#6366F1',
    statuses: [],
    isDefault: true,
    isArchived: false,
    createdAt: new Date(),
    taskCount: 0
  },
  {
    id: 'proj-2',
    name: 'Work',
    description: '',
    icon: 'briefcase',
    color: '#EF4444',
    statuses: [],
    isDefault: false,
    isArchived: false,
    createdAt: new Date(),
    taskCount: 0
  }
]

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

function renderWithI18n(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18nEn}>{ui}</I18nextProvider>)
}

describe('ProjectSelect create-project footer', () => {
  const onChange = vi.fn()
  const addProject = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useTasksOptional).mockReturnValue({ addProject } as never)
  })

  it('shows the "Create project" footer when tasks context is available', async () => {
    const user = userEvent.setup()
    renderWithI18n(<ProjectSelect value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('button'))

    expect(screen.getByRole('button', { name: 'Create project' })).toBeInTheDocument()
  })

  it('hides the footer when there is no tasks context', async () => {
    vi.mocked(useTasksOptional).mockReturnValue(null)
    const user = userEvent.setup()
    renderWithI18n(<ProjectSelect value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('button'))

    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument()
  })

  it('opens the Create Project dialog when the footer is clicked', async () => {
    const user = userEvent.setup()
    renderWithI18n(<ProjectSelect value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('button'))
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    expect(screen.getByRole('heading', { name: 'Create Project' })).toBeInTheDocument()
  })

  it('creates the project and auto-selects it', async () => {
    const user = userEvent.setup()
    renderWithI18n(<ProjectSelect value="proj-1" onChange={onChange} projects={projects} />)

    await user.click(screen.getByRole('button'))
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    await user.type(screen.getAllByRole('textbox')[0], 'Roadmap')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(addProject).toHaveBeenCalledTimes(1))
    const created = addProject.mock.calls[0][0] as Project
    expect(created.name).toBe('Roadmap')
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(created.id))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @memry/desktop test:renderer -- project-select`
Expected: FAIL — `useProjectQuickCreate` not implemented / no "Create project" button rendered.

- [ ] **Step 3: Create the hook + footer** (`use-project-quick-create.tsx`)

```tsx
import { useCallback, useState } from 'react'
import { Plus } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Picker, usePickerContext } from '@/components/ui/picker'
import { ProjectModal } from '@/components/tasks/project-modal'
import { useTasksOptional } from '@/contexts/tasks'
import { useT } from '@memry/i18n/renderer'
import type { Project } from '@/data/tasks-data'

interface ProjectQuickCreate {
  canCreate: boolean
  openCreate: () => void
  dialog: React.ReactNode
}

export function useProjectQuickCreate(onCreated: (projectId: string) => void): ProjectQuickCreate {
  const tasks = useTasksOptional()
  const [isOpen, setIsOpen] = useState(false)

  const openCreate = useCallback(() => setIsOpen(true), [])

  const handleSave = useCallback(
    async (project: Project): Promise<void> => {
      await tasks?.addProject(project)
      onCreated(project.id)
    },
    [tasks, onCreated]
  )

  const dialog = tasks ? (
    <ProjectModal isOpen={isOpen} onClose={() => setIsOpen(false)} onSave={handleSave} />
  ) : null

  return { canCreate: !!tasks, openCreate, dialog }
}

export function ProjectCreateFooter({ onStart }: { onStart: () => void }): React.JSX.Element {
  const { t: tTasks } = useT('tasks')
  const { onOpenChange } = usePickerContext()

  return (
    <Picker.Footer className="p-1">
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-2 rounded-[5px] py-1.5 px-2 text-muted-foreground transition-colors',
          'hover:bg-accent focus:outline-none'
        )}
        onClick={() => {
          onOpenChange(false)
          onStart()
        }}
      >
        <Plus className="size-4 shrink-0" />
        {tTasks('phaseF.componentsTasksProjectsProjectSelector.createProject')}
      </button>
    </Picker.Footer>
  )
}
```

- [ ] **Step 4: Wire into `ProjectSelect`** (`project-select.tsx`)

Add imports after the existing `Picker` import:

```tsx
import { Picker } from '@/components/ui/picker'
import { ProjectCreateFooter, useProjectQuickCreate } from './use-project-quick-create'
```

Inside `ProjectSelect`, after the `currentProject` line, add:

```tsx
const { canCreate, openCreate, dialog } = useProjectQuickCreate(onChange)
```

Replace the `return (...)` body so the footer renders inside `Picker.Content` and the dialog renders alongside:

```tsx
return (
  <>
    <Picker value={value} onValueChange={onChange}>
      <Picker.Trigger
        variant="button"
        chevron
        className={cn('w-full', className)}
        aria-label={tPhaseF('phaseF.componentsTasksProjectSelect.selectProject')}
      >
        {currentProject ? (
          <span className="flex items-center gap-2 min-w-0">
            <ProjectIndicator project={currentProject} />
            <span className="truncate">{currentProject.name}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">
            {tPhaseF('phaseF.componentsTasksProjectSelect.selectProject2')}
          </span>
        )}
      </Picker.Trigger>
      <Picker.Content width="trigger" align="start">
        <Picker.List>
          {availableProjects.map((project) => (
            <Picker.Item
              key={project.id}
              value={project.id}
              label={project.name}
              icon={<ProjectIndicator project={project} />}
              indicator="check"
              indicatorColor={project.color}
            />
          ))}
        </Picker.List>
        {canCreate && <ProjectCreateFooter onStart={openCreate} />}
      </Picker.Content>
    </Picker>
    {dialog}
  </>
)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @memry/desktop test:renderer -- project-select`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/h4yfans/workspace/memry/.worktrees/task-project-quick-create
git add apps/desktop/src/renderer/src/components/tasks/use-project-quick-create.tsx \
        apps/desktop/src/renderer/src/components/tasks/project-select.tsx \
        apps/desktop/src/renderer/src/components/tasks/project-select.test.tsx
git commit -m "feat(tasks): add inline create-project footer to ProjectSelect"
```

---

## Task 2: `allowCreate` on `InteractiveProjectBadge`

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/tasks/interactive-project-badge.tsx`
- Modify: `apps/desktop/src/renderer/src/components/tasks/interactive-project-badge.test.tsx`

- [ ] **Step 1: Write the failing tests** — append to `interactive-project-badge.test.tsx`

At the **top** of the file, add the i18n + context-mock imports and helper (existing imports stay):

```tsx
import { beforeAll } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import type { ReactElement } from 'react'
import type { i18n as I18nInstance } from 'i18next'
import { createRendererI18n } from '@memry/i18n/renderer'
import { useTasksOptional } from '@/contexts/tasks'

vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: vi.fn(),
  useTasksContext: vi.fn()
}))

let i18nEn: I18nInstance

beforeAll(async () => {
  i18nEn = await createRendererI18n({ locale: 'en' })
})

function renderWithI18n(ui: ReactElement) {
  return render(<I18nextProvider i18n={i18nEn}>{ui}</I18nextProvider>)
}
```

Add this `describe` block at the **end** of the file:

```tsx
describe('InteractiveProjectBadge create-project footer', () => {
  const onProjectChange = vi.fn()
  const addProject = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(useTasksOptional).mockReturnValue({ addProject } as never)
  })

  it('does not show the footer without allowCreate', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <InteractiveProjectBadge
        projectId="proj-1"
        projects={projects}
        onProjectChange={onProjectChange}
      />
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))

    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument()
  })

  it('shows the footer and opens the dialog when allowCreate is set', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <InteractiveProjectBadge
        projectId="proj-1"
        projects={projects}
        onProjectChange={onProjectChange}
        allowCreate
      />
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    expect(screen.getByRole('heading', { name: 'Create Project' })).toBeInTheDocument()
  })

  it('creates the project and selects it when allowCreate is set', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <InteractiveProjectBadge
        projectId="proj-1"
        projects={projects}
        onProjectChange={onProjectChange}
        allowCreate
      />
    )

    await user.click(screen.getByRole('button', { name: /project:.*click to change/i }))
    await user.click(screen.getByRole('button', { name: 'Create project' }))
    await user.type(screen.getAllByRole('textbox')[0], 'Roadmap')
    await user.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(addProject).toHaveBeenCalledTimes(1))
    const created = addProject.mock.calls[0][0] as Project
    await waitFor(() => expect(onProjectChange).toHaveBeenCalledWith(created.id))
  })
})
```

Also add `waitFor` to the existing top `@testing-library/react` import:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
```

> The existing tests render without a provider; `useTasksOptional` mock returns `undefined` there → `canCreate` false and `allowCreate` defaults false, so they remain unchanged.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @memry/desktop test:renderer -- interactive-project-badge`
Expected: the 3 new tests FAIL (`allowCreate` prop unknown / no footer); existing 8 tests still PASS.

- [ ] **Step 3: Implement `allowCreate`** (`interactive-project-badge.tsx`)

Add imports:

```tsx
import { ProjectCreateFooter, useProjectQuickCreate } from './use-project-quick-create'
```

Add `allowCreate` to the props interface:

```tsx
interface InteractiveProjectBadgeProps {
  projectId: string
  projects: Project[]
  onProjectChange: (projectId: string) => void
  allowCreate?: boolean
  className?: string
}
```

Update the component signature + body. Add `allowCreate` to the destructured params and call the hook after `availableProjects`:

```tsx
export const InteractiveProjectBadge = ({
  projectId,
  projects,
  onProjectChange,
  allowCreate = false,
  className
}: InteractiveProjectBadgeProps): React.JSX.Element => {
  const currentProject = projects.find((p) => p.id === projectId)
  const projectColor = currentProject?.color || '#6B7280'
  const projectName = currentProject?.name || 'No project'

  const availableProjects = React.useMemo(() => projects.filter((p) => !p.isArchived), [projects])

  const { canCreate, openCreate, dialog } = useProjectQuickCreate(onProjectChange)

  return (
    <>
      <Picker
        value={projectId}
        onValueChange={(val) => {
          if (val !== projectId) onProjectChange(val)
        }}
      >
        <Picker.Trigger asChild>
          <button
            type="button"
            className={cn(
              'flex items-center rounded-sm py-0.5 px-2 gap-1.5 cursor-pointer transition-opacity',
              'hover:opacity-80 focus-visible:outline-none',
              className
            )}
            style={{ backgroundColor: `${projectColor}14` }}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Project: ${projectName}. Click to change.`}
          >
            <div className="rounded-xs shrink-0 size-2" style={{ backgroundColor: projectColor }} />
            <div className="text-[11px] font-medium leading-3.5" style={{ color: projectColor }}>
              {projectName}
            </div>
          </button>
        </Picker.Trigger>
        <Picker.Content width="auto" align="start" sideOffset={4}>
          <Picker.List>
            {availableProjects.map((proj) => (
              <Picker.Item
                key={proj.id}
                value={proj.id}
                label={proj.name}
                icon={
                  <div
                    className="rounded-xs shrink-0 size-2"
                    style={{ backgroundColor: proj.color }}
                  />
                }
                indicator="check"
                indicatorColor={proj.color}
              />
            ))}
          </Picker.List>
          {allowCreate && canCreate && <ProjectCreateFooter onStart={openCreate} />}
        </Picker.Content>
      </Picker>
      {allowCreate && dialog}
    </>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @memry/desktop test:renderer -- interactive-project-badge`
Expected: PASS (11 tests — 8 existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/interactive-project-badge.tsx \
        apps/desktop/src/renderer/src/components/tasks/interactive-project-badge.test.tsx
git commit -m "feat(tasks): add opt-in create-project footer to InteractiveProjectBadge"
```

---

## Task 3: Enable in the Task Detail drawer + full verification

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.tsx:346`

- [ ] **Step 1: Enable `allowCreate` at the drawer call site**

Change the `InteractiveProjectBadge` usage (around line 346) from:

```tsx
<InteractiveProjectBadge
  projectId={task.projectId}
  projects={projects}
  onProjectChange={handleProjectChange}
/>
```

to:

```tsx
<InteractiveProjectBadge
  projectId={task.projectId}
  projects={projects}
  onProjectChange={handleProjectChange}
  allowCreate
/>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS (no new errors; pre-existing test-file errors per CLAUDE.md may remain).

- [ ] **Step 3: i18n check**

Run: `pnpm --filter @memry/desktop i18n:check`
Expected: PASS — reused key `phaseF.componentsTasksProjectsProjectSelector.createProject`, no new keys.

- [ ] **Step 4: Lint + full renderer tests**

Run:

```bash
pnpm lint
pnpm --filter @memry/desktop test:renderer
```

Expected: lint clean; all renderer tests pass.

- [ ] **Step 5: Manual QA**

Run: `pnpm dev`

- Add Task modal → open Project dropdown → "Create project" at the bottom → modal opens → fill + Create → new project is selected in the dropdown, Add Task modal stays open.
- Open a task's detail drawer → Project badge dropdown → "Create project" → same flow; new project selected.
- Confirm inline task-row project badges (`task-row`, `today-task-row`) do **not** show "Create project".
- Confirm Esc/focus behave on the stacked dialog.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/task-detail-drawer.tsx
git commit -m "feat(tasks): enable create-project footer in task detail drawer"
```

---

## Notes for the implementer

- `ProjectModal.onSave` is typed `(project: Project) => void`; passing an `async` handler is fine (the modal does not await it, and `addProject` is optimistic so the new project is in `projects` before `onCreated` selects it).
- The footer button is a plain `<button>` (implicit role `button`); `Picker.Item`s carry `role="option"`, so `getByRole('button', { name: 'Create project' })` targets only the footer.
- Do not add a new i18n key. If `i18n:check` complains, re-check that you reused the existing key path verbatim.
- Push/PR is out of scope for this plan — run the docs gate (`pnpm docs:impact --base origin/main --strict`) at ship time.
