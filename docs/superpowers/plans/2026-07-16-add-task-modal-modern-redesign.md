# Add Task Modal — Modern Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Cmd/Ctrl+Enter "detailed task creation" modal (`add-task-modal.tsx`) from scratch in the app's modern compact style, reusing the exact primitives the task detail drawer uses, without changing the save/IPC path or the prop contract.

**Architecture:** One file is rewritten. The outer `AddTaskModal` (Dialog wrapper) + inner `AddTaskModalSession` (form body, remounted per open via `key`) structure and all save logic are preserved. The old button-style pickers and uppercase-label grid are replaced by a drawer-style full-bleed layout: a borderless title input, a compact 90px-label property grid built from the four `Interactive*Badge` components, `TagAutocomplete`, `TaskDescriptionEditor`, and `TaskRepeatSection`. The prop contract is unchanged, so no call site or page changes.

**Tech Stack:** React 19, TypeScript, Tailwind (logical properties), Radix Dialog/Popover, `@memry/i18n` renderer hooks, Vitest + Testing Library (jsdom), electron-vite renderer.

## Global Constraints

- **Backward compatibility (LIVE BETA):** No DB/contract/format changes here. This is renderer-only UI. Save path stays identical (`createDefaultTask` → `onAddTask`).
- **Prop contract UNCHANGED:** `AddTaskModalProps { isOpen, onClose, onAddTask, projects, defaultProjectId?, defaultDueDate?, prefillTitle? }`. Do not rename or add props — `pages/tasks.tsx:1258` and `pages/tasks.test.tsx:437` depend on it.
- **RTL safety (new code):** Use logical Tailwind classes only. No `ml-*`/`mr-*`/`pl-*`/`pr-*`/`left-*`/`right-*`/`text-left`/`text-right`/`border-l`/`border-r`/`rounded-l-*`/`rounded-r-*`. Use `ms/me`, `ps/pe`, `start/end`, `text-start/text-end`, `border-s/border-e`. The renderer pre-commit guard rejects any physical class in a staged rewritten file.
- **Logging/errors:** N/A for this file (no new logging or IPC calls introduced).
- **Existing test suite is the regression gate:** `add-task-modal.test.tsx` must stay green. It queries these exact strings — keep them intact:
  - Title placeholder = `t('task.titlePlaceholder')` → `"What needs to be done?"`
  - Submit button text = `t('task.add')` → `"Add Task"` (`"Görev Ekle"` in TR)
  - Validation error = `t('task.titleRequired')` → `"Title is required"`
  - "Create another" checkbox accessible name = `t('task.createAnother')` → `"Create another"`
  - `TagAutocomplete placeholder` = `t('task.tags')` → `"Tags"`
- **i18n:** Reuse existing `tasks`/`common` keys only (all confirmed present): `task.add`, `task.title`, `task.titlePlaceholder`, `task.titleRequired`, `task.status`, `task.priority`, `task.dueDate`, `task.project`, `task.description`, `task.descriptionPlaceholder`, `task.tags`, `task.createAnother`, `common:button.cancel`. Add no new keys.
- **`cn` is tailwind-merge:** later utility classes override earlier ones, so `DialogContent`'s base `p-6 gap-4 bg-background grid` is overridden by `p-0 gap-0 bg-surface` while `grid` is kept and `grid-rows-[...]` is added.

---

## File Structure

- **Rewrite:** `apps/desktop/src/renderer/src/components/tasks/add-task-modal.tsx` — the only production file changed. Single responsibility: render the create-task modal and assemble the new `Task` on submit.
- **Extend:** `apps/desktop/src/renderer/src/components/tasks/add-task-modal.test.tsx` — keep all existing tests; add render tests for the modern layout.
- **No changes:** `pages/tasks.tsx`, `pages/tasks.test.tsx`, `use-undoable-task-actions.ts`, `tasks-service.ts`, i18n JSON, `dialog.tsx`, and all reused badge/section primitives.

Primitives consumed (all already exist, value+callback APIs — no `Task` object needed):

- `InteractiveStatusBadge` — `{ statusId, statuses, onStatusChange }`
- `InteractivePriorityBadge` — `{ priority, onPriorityChange, compact }`
- `InteractiveDueDateBadge` — `{ dueDate, dueTime, onDateChange, onTimeChange, isRepeating }`
- `InteractiveProjectBadge` — `{ projectId, projects, onProjectChange, allowCreate }`
- `TaskRepeatSection` — `{ taskTitle, repeatConfig, isRepeating, dueDate, projectColor, onRepeatChange }` (renders its own `CustomRepeatDialog`/`StopRepeatingDialog` internally)
- `TagAutocomplete` — `{ tags, onTagsChange, placeholder }`
- `TaskDescriptionEditor` — `{ initialContent, onContentChange, placeholder, ariaLabel, className }`

---

## Task 1: Rebuild `add-task-modal.tsx` in the modern style

**Files:**

- Modify (full rewrite): `apps/desktop/src/renderer/src/components/tasks/add-task-modal.tsx`
- Test (gate, unchanged): `apps/desktop/src/renderer/src/components/tasks/add-task-modal.test.tsx`

**Interfaces:**

- Consumes: the primitives listed in File Structure; `createDefaultTask`, `getDefaultTodoStatus`; types `Task`, `Priority`, `RepeatConfig`, `Project`.
- Produces: `AddTaskModal` (default + named export) with the unchanged `AddTaskModalProps`. Behavior produced for later tasks/tests: on submit, `onAddTask` is called with a `Task` whose `title`, `description`, `dueTime`, `priority`, `isRepeating`, `repeatConfig`, `tags`, `projectId`, `statusId` reflect the form; "Create another" keeps the modal open and clears the title/description/tags.

- [ ] **Step 1: Establish the green baseline**

Run the existing suite for this file and confirm it passes against the current (old) component before touching anything.

Run: `pnpm --filter @memry/desktop test:renderer -- add-task-modal`
Expected: PASS (all tests in `add-task-modal.test.tsx` green). Record this as the regression baseline.

- [ ] **Step 2: Rewrite the component file**

Replace the entire contents of `apps/desktop/src/renderer/src/components/tasks/add-task-modal.tsx` with:

```tsx
import { useMemo, useRef, useState } from 'react'

import { useT } from '@memry/i18n/renderer'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'
import { InteractiveStatusBadge } from './interactive-status-badge'
import { InteractivePriorityBadge } from './interactive-priority-badge'
import { InteractiveDueDateBadge } from './interactive-due-date-badge'
import { InteractiveProjectBadge } from './interactive-project-badge'
import { TaskRepeatSection } from './task-repeat-section'
import { TaskDescriptionEditor } from './task-description-editor'
import { getDefaultTodoStatus } from '@/lib/task-utils'
import { createDefaultTask, type Task, type Priority, type RepeatConfig } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'

interface AddTaskModalProps {
  isOpen: boolean
  onClose: () => void
  onAddTask: (task: Task) => void
  projects: Project[]
  defaultProjectId?: string
  defaultDueDate?: Date | null
  prefillTitle?: string
}

interface TaskFormData {
  title: string
  description: string
  projectId: string
  statusId: string
  dueDate: Date | null
  dueTime: string | null
  priority: Priority
  repeatConfig: RepeatConfig | null
  tags: string[]
}

interface FormErrors {
  title?: string
}

function buildInitialFormData({
  defaultProjectId,
  defaultDueDate,
  prefillTitle,
  projects
}: {
  defaultProjectId: string
  defaultDueDate: Date | null
  prefillTitle: string
  projects: Project[]
}): TaskFormData {
  const project = projects.find((candidate) => candidate.id === defaultProjectId)
  const defaultStatus = project ? getDefaultTodoStatus(project) : null
  const statusId = defaultStatus?.id || project?.statuses[0]?.id || ''

  return {
    title: prefillTitle,
    description: '',
    projectId: defaultProjectId,
    statusId,
    dueDate: defaultDueDate,
    dueTime: null,
    priority: 'none',
    repeatConfig: null,
    tags: []
  }
}

// Compact property row matching the detail drawer's 90px label column.
const PropertyRow = ({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element => (
  <div className="flex items-center py-1.5">
    <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">{label}</span>
    {children}
  </div>
)

interface AddTaskModalSessionProps {
  initialFormData: TaskFormData
  onClose: () => void
  onAddTask: (task: Task) => void
  projects: Project[]
}

function AddTaskModalSession({
  initialFormData,
  onClose,
  onAddTask,
  projects
}: AddTaskModalSessionProps): React.JSX.Element {
  const { t } = useT('tasks')
  const { t: tCommon } = useT('common')
  const titleInputRef = useRef<HTMLInputElement>(null)
  const [formData, setFormData] = useState<TaskFormData>(initialFormData)
  const [errors, setErrors] = useState<FormErrors>({})
  const [createAnother, setCreateAnother] = useState(false)

  const currentProject = useMemo(() => {
    return projects.find((project) => project.id === formData.projectId)
  }, [projects, formData.projectId])

  const currentStatuses = useMemo(() => {
    return currentProject?.statuses || []
  }, [currentProject])

  const projectColor = currentProject?.color ?? 'var(--text-tertiary)'

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setFormData((prev) => ({ ...prev, title: e.target.value }))
    if (errors.title) {
      setErrors((prev) => ({ ...prev, title: undefined }))
    }
  }

  const handleDescriptionChange = (markdown: string): void => {
    setFormData((prev) => ({ ...prev, description: markdown }))
  }

  const handleProjectChange = (projectId: string): void => {
    const project = projects.find((candidate) => candidate.id === projectId)
    const defaultStatus = project ? getDefaultTodoStatus(project) : null
    const statusId = defaultStatus?.id || project?.statuses[0]?.id || ''

    setFormData((prev) => ({ ...prev, projectId, statusId }))
  }

  const handleStatusChange = (statusId: string): void => {
    setFormData((prev) => ({ ...prev, statusId }))
  }

  const handleDueDateChange = (date: Date | null): void => {
    setFormData((prev) => ({ ...prev, dueDate: date }))
  }

  const handleDueTimeChange = (time: string | null): void => {
    setFormData((prev) => ({ ...prev, dueTime: time }))
  }

  const handlePriorityChange = (priority: Priority): void => {
    setFormData((prev) => ({ ...prev, priority }))
  }

  const handleRepeatConfigChange = (repeatConfig: RepeatConfig | null): void => {
    setFormData((prev) => ({ ...prev, repeatConfig }))
  }

  const handleTagsChange = (tags: string[]): void => {
    setFormData((prev) => ({ ...prev, tags }))
  }

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {}
    if (!formData.title.trim()) {
      newErrors.title = t('task.titleRequired')
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = (): void => {
    if (!validateForm()) {
      titleInputRef.current?.focus()
      return
    }

    const newTask = createDefaultTask(
      formData.projectId,
      formData.statusId,
      formData.title.trim(),
      formData.dueDate
    )

    const finalTask: Task = {
      ...newTask,
      description: formData.description.trim(),
      dueTime: formData.dueTime,
      priority: formData.priority,
      isRepeating: formData.repeatConfig !== null,
      repeatConfig: formData.repeatConfig,
      tags: formData.tags
    }

    onAddTask(finalTask)

    if (createAnother) {
      setFormData((prev) => ({
        title: '',
        description: '',
        projectId: prev.projectId,
        statusId: currentProject
          ? getDefaultTodoStatus(currentProject)?.id || prev.statusId
          : prev.statusId,
        dueDate: prev.dueDate,
        dueTime: null,
        priority: 'none',
        repeatConfig: null,
        tags: []
      }))
      setErrors({})
      titleInputRef.current?.focus()
      return
    }

    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <DialogContent
      className="max-w-lg p-0 gap-0 grid-rows-[auto_1fr_auto] max-h-[85vh] overflow-hidden bg-surface [font-synthesis:none]"
      onKeyDown={handleKeyDown}
    >
      {/* ── Header ── */}
      <div className="flex items-center shrink-0 py-3.5 ps-5 pe-10 border-b border-border">
        <DialogTitle className="text-[14px] font-medium text-text-primary leading-none tracking-normal">
          {t('task.add')}
        </DialogTitle>
      </div>

      {/* ── Scrollable body ── */}
      <div className="min-h-0 overflow-y-auto scrollbar-thin text-[12px] leading-4">
        {/* Title */}
        <div className="px-5 pt-4 pb-1">
          <input
            ref={titleInputRef}
            autoFocus
            value={formData.title}
            onChange={handleTitleChange}
            placeholder={t('task.titlePlaceholder')}
            aria-label={t('task.title')}
            aria-invalid={!!errors.title}
            aria-describedby={errors.title ? 'title-error' : undefined}
            className="w-full text-[14px] font-medium text-text-primary bg-transparent outline-none placeholder:text-text-tertiary"
          />
          {errors.title && (
            <p id="title-error" className="mt-1 text-[12px] text-destructive leading-4">
              {errors.title}
            </p>
          )}
        </div>

        {/* Property grid */}
        <div className="flex flex-col pt-1 pb-4 px-5 border-b border-border">
          <PropertyRow label={t('task.status')}>
            <InteractiveStatusBadge
              statusId={formData.statusId}
              statuses={currentStatuses}
              onStatusChange={handleStatusChange}
            />
          </PropertyRow>
          <PropertyRow label={t('task.priority')}>
            <InteractivePriorityBadge
              priority={formData.priority}
              onPriorityChange={handlePriorityChange}
              compact
            />
          </PropertyRow>
          <PropertyRow label={t('task.dueDate')}>
            <InteractiveDueDateBadge
              dueDate={formData.dueDate}
              dueTime={formData.dueTime}
              onDateChange={handleDueDateChange}
              onTimeChange={handleDueTimeChange}
              isRepeating={formData.repeatConfig !== null}
            />
          </PropertyRow>
          <PropertyRow label={t('task.project')}>
            <InteractiveProjectBadge
              projectId={formData.projectId}
              projects={projects}
              onProjectChange={handleProjectChange}
              allowCreate
            />
          </PropertyRow>
        </div>

        {/* Tags — brings its own px-5/border chrome, sits full-bleed */}
        <TagAutocomplete
          tags={formData.tags}
          onTagsChange={handleTagsChange}
          placeholder={t('task.tags')}
        />

        {/* Description */}
        <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
          <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
            {t('task.description')}
          </span>
          <TaskDescriptionEditor
            initialContent={formData.description}
            onContentChange={handleDescriptionChange}
            placeholder={t('task.descriptionPlaceholder')}
            ariaLabel={t('task.description')}
            className="text-[13px] leading-5 text-text-secondary"
          />
        </div>

        {/* Repeat — brings its own px-5/border chrome, sits full-bleed */}
        <TaskRepeatSection
          taskTitle={formData.title}
          repeatConfig={formData.repeatConfig}
          isRepeating={formData.repeatConfig !== null}
          dueDate={formData.dueDate}
          projectColor={projectColor}
          onRepeatChange={handleRepeatConfigChange}
        />
      </div>

      {/* ── Footer ── */}
      <div className="flex items-center justify-between shrink-0 py-3 px-5 border-t border-border">
        <div className="flex items-center gap-2">
          <Checkbox
            id="create-another"
            checked={createAnother}
            onCheckedChange={(checked) => setCreateAnother(checked === true)}
          />
          <label
            htmlFor="create-another"
            className="text-[12px] text-text-secondary cursor-pointer leading-4"
          >
            {t('task.createAnother')}
          </label>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {tCommon('button.cancel')}
          </Button>
          <Button size="sm" onClick={handleSubmit}>
            {t('task.add')}
          </Button>
        </div>
      </div>
    </DialogContent>
  )
}

export const AddTaskModal = ({
  isOpen,
  onClose,
  onAddTask,
  projects,
  defaultProjectId = 'personal',
  defaultDueDate = null,
  prefillTitle = ''
}: AddTaskModalProps): React.JSX.Element => {
  const initialFormData = useMemo(
    () => buildInitialFormData({ defaultProjectId, defaultDueDate, prefillTitle, projects }),
    [defaultProjectId, defaultDueDate, prefillTitle, projects]
  )
  const formKey = `${defaultProjectId}:${defaultDueDate?.toISOString() ?? 'none'}:${prefillTitle}`

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      {isOpen ? (
        <AddTaskModalSession
          key={formKey}
          initialFormData={initialFormData}
          onClose={onClose}
          onAddTask={onAddTask}
          projects={projects}
        />
      ) : null}
    </Dialog>
  )
}

export default AddTaskModal
```

- [ ] **Step 3: Run the regression gate — existing tests must stay green**

Run: `pnpm --filter @memry/desktop test:renderer -- add-task-modal`
Expected: PASS (same as baseline). The rewrite preserves every queried string and the save contract, so all existing tests pass. If any fail, fix the component (do not weaken the tests) — the likely culprit is a changed placeholder/button/checkbox string; restore the exact i18n keys from Global Constraints.

- [ ] **Step 4: Typecheck + lint the change**

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS (no type errors).

Run: `pnpm lint`
Expected: PASS. In particular the renderer RTL guard must not flag any physical Tailwind class in the rewritten file (only logical `ps/pe/ms/me/start/end/border-s/e` are used).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/add-task-modal.tsx
git commit -m "feat(tasks): rebuild Add Task modal in the modern compact style"
```

---

## Task 2: Add render tests for the modern layout

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/tasks/add-task-modal.test.tsx`

**Interfaces:**

- Consumes: the rendered `AddTaskModal` from Task 1 (default `PROJECTS`/`PERSONAL` fixtures already defined in the test file; `PERSONAL` has statuses `[P_TODO('To Do'), P_PROGRESS, P_DONE]`, color `#6366f1`, priority default `none`, no due date).
- Produces: coverage that the four `Interactive*Badge` rows and the description section render with their default values.

- [ ] **Step 1: Add a "modern layout" describe block**

Append this block inside the top-level `describe('AddTaskModal', () => { ... })`, after the existing `describe('tags', ...)` block (before its closing `})`):

```tsx
describe('modern layout', () => {
  it('renders the four property rows with default badge values', () => {
    // #given / #when — open with the default personal project
    renderWithI18n(
      <AddTaskModal isOpen={true} onClose={onClose} onAddTask={onAddTask} projects={PROJECTS} />
    )

    // #then — each Interactive*Badge shows its default value (badges render as
    // triggers; their popovers don't open in jsdom, so only the trigger text is present)
    expect(screen.getByText('To Do')).toBeInTheDocument() // status = default todo
    expect(screen.getByText('None')).toBeInTheDocument() // priority compact label
    expect(screen.getByText('No date')).toBeInTheDocument() // due date badge, no date
    expect(screen.getByText('Personal')).toBeInTheDocument() // project badge
  })

  it('renders the description editor section', () => {
    // #given / #when
    renderWithI18n(
      <AddTaskModal isOpen={true} onClose={onClose} onAddTask={onAddTask} projects={PROJECTS} />
    )

    // #then — stubbed TaskDescriptionEditor exposes the placeholder
    expect(screen.getByPlaceholderText('Add a description…')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the new tests**

Run: `pnpm --filter @memry/desktop test:renderer -- add-task-modal`
Expected: PASS (existing tests + the two new ones). Note: `'To Do'`, `'None'`, and `'No date'` are hardcoded (non-i18n) strings inside the badges, so these assertions are locale-stable.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/components/tasks/add-task-modal.test.tsx
git commit -m "test(tasks): cover modern Add Task modal property rows"
```

---

## Task 3: Full verification, live QA, and docs gate

**Files:** none changed (verification only).

- [ ] **Step 1: Full renderer suite + typecheck + lint + whitespace**

Run: `pnpm --filter @memry/desktop test:renderer`
Expected: PASS (no regression in `tasks.test.tsx` or elsewhere — the mock in `pages/tasks.test.tsx:437` is unaffected since the prop contract is unchanged).

Run: `pnpm --filter @memry/desktop typecheck:web`
Expected: PASS.

Run: `pnpm lint`
Expected: PASS.

Run: `git diff --check`
Expected: no whitespace errors.

- [ ] **Step 2: Live QA in the running app**

Run: `pnpm dev` (or the already-running dev instance for this worktree).

Manually verify, in the Tasks page:

1. Focus the quick-add bar, type a title, press **Cmd/Ctrl+Enter** → the modal opens prefilled with that title.
2. The modal shows: borderless title input, the four compact property rows (Status / Priority / Due date / Project), Tags, Description, Repeat, and the footer (Create another · Cancel · Add).
3. Each property badge opens its picker/popover on click: Status list, Priority list (1–5 shortcuts), Due date calendar, Project picker (with create).
4. Changing Project resets Status to that project's default todo status.
5. Set priority + due + a tag + description, click **Add** (or Cmd/Ctrl+Enter) → task is created with those fields; modal closes.
6. Re-open, check **Create another**, submit → modal stays open, title/description/tags cleared, project/status/due retained.
7. Tall content scrolls inside the body while header + footer stay fixed; the `✕` close and Cancel both dismiss.
8. (If feasible) toggle RTL — layout mirrors correctly (labels/badges on the correct side), no clipped `✕`.

- [ ] **Step 3: Docs impact gate**

Determine the base commit (branch point from `origin/main`), then:

Run: `pnpm docs:impact --base <base_commit> --strict`
Expected: PASS. If it reports `missing-docs`, either run `pnpm docs:ai-update --base <base_commit>` or hand-edit only real docs under `apps/docs/src/**` (this is a UI restyle of an existing surface — most likely no docs change required), then re-run the gate and `pnpm docs:build`.

- [ ] **Step 4: Report unused primitives (do not delete)**

The rewrite drops these imports from this file: `ProjectSelect`, `StatusSelect`, `DueDatePicker`, `PrioritySelect`, `RepeatPicker`, `CustomRepeatDialog`, `Input` (for title), `DialogHeader`. Check whether any is now unused repo-wide:

Run: `for c in project-select status-select due-date-picker priority-select repeat-picker; do echo "== $c =="; grep -rl "$c" apps/desktop/src/renderer/src --include=*.tsx | grep -v "$c.tsx"; done`
Expected: report which (if any) have no remaining importers. **Do not delete** — surface the list to Kaan for a decision (per surgical-changes rule).

---

## Self-Review

**1. Spec coverage:**

- Modern compact modal in drawer style → Task 1 (full rewrite: full-bleed sections, 90px property grid, borderless title). ✓
- Reuse `Interactive*Badge` + `TaskRepeatSection` + `TagAutocomplete` + `TaskDescriptionEditor` → Task 1 imports/JSX. ✓
- Save model unchanged (`buildInitialFormData`, validation, `handleSubmit`, create-another, Cmd/Ctrl+Enter) → Task 1 preserves verbatim. ✓
- Prop contract unchanged / no page changes → Global Constraints + Task 3 Step 1 verifies `tasks.test.tsx`. ✓
- Field set = title/status/priority/due/project/tags/description/repeat; no Reminder, no sub-issues/related → Task 1 JSX matches exactly. ✓
- Removed-import handling (don't delete) → Task 3 Step 4. ✓
- jsdom picker limitation acknowledged → Task 2 tests assert only trigger text. ✓
- Verification (typecheck:web, test:renderer, lint, live dev, docs:impact) → Task 3. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Full component and test code inlined. ✓

**3. Type consistency:** `TaskFormData`, `FormErrors`, `AddTaskModalProps`, `AddTaskModalSessionProps` are self-consistent across the file. Handler signatures match each badge's callback type (`onStatusChange(statusId: string)`, `onPriorityChange(priority: Priority)`, `onDateChange(date: Date | null)`, `onTimeChange(time: string | null)`, `onProjectChange(projectId: string)`, `onRepeatChange(config: RepeatConfig | null)`, `onTagsChange(tags: string[])`). `createDefaultTask(projectId, statusId, title, dueDate)` argument order preserved from the original. `getDefaultTodoStatus(project)` returns a status with `.id`. ✓

**One correction from the spec:** the spec's layout table listed the title placeholder as `t('task.namePlaceholder')`. Corrected here to `t('task.titlePlaceholder')` ("What needs to be done?") to (a) keep the create-flow's more inviting copy and (b) keep the existing test suite green. All other spec details stand.
