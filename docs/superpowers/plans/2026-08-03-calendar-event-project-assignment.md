# Calendar Event → Project Assignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the calendar event form a project field, so a user can assign a project while creating an event and change or clear it while editing one.

**Architecture:** No data-model work — `project_links` already stores `(project_id, 'calendar_event', event_id)` and the `linkProjectItem` / `unlinkProjectItem` / `listForItem` IPC already accepts `calendar_event`. A new `EventProjectField` component wraps the existing `ProjectPicker`. In **create** mode it is fully controlled and its selection rides in the draft until the event has an id; in **edit** mode it owns its own state, loading from `listForItem` and writing link/unlink immediately (same behavior as today's right-click "Add to project" flow). `calendar.tsx` changes in exactly one place: link the draft's project after `createEvent` returns the new id.

**Tech Stack:** React 19, TypeScript, Vitest + @testing-library/react (jsdom), Tailwind, i18next, sonner (toasts), Electron IPC via `@/services/tasks-service`.

## Global Constraints

- **Backward compatibility is mandatory** — this app runs on real user data. This change adds **no** DB migration, **no** schema change, **no** IPC contract change. If you find yourself editing `packages/db-schema` or `packages/contracts`, stop: the plan has gone off the rails.
- **Single-select in the UI, many-to-many in the DB.** Never delete a link the user did not explicitly remove. If an event has more than one link (possible via the existing right-click flow), extras render as removable chips.
- **Tailwind logical properties (RTL).** New code uses `ms-*`/`me-*`, `ps-*`/`pe-*`, `start-*`/`end-*`, `text-start`/`text-end`. Never `ml-*`/`mr-*`/`left-*`/`right-*`/`text-left`/`text-right`.
- **Logging:** `createLogger('Scope')` from `@/lib/logger`, never `console.*`.
- **User-facing errors:** `extractErrorMessage(err, fallback)` from `@/lib/ipc-error`.
- **No hardcoded UI strings.** All copy goes through `useT('calendar')`. Add English keys to `packages/i18n/src/locales/en/calendar.json`; English is what `i18n:check` gates, other locales fall back to English.
- **Do not modify `ItemProjectChips`** — `note.tsx` and `file.tsx` use it and must stay read-only.
- **Commit after every task.** No `Co-Authored-By` trailer.

## File Structure

| File                                                                                 | Responsibility                                                                                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/desktop/src/renderer/src/components/calendar/event-project-field.tsx`          | **New.** The whole feature's UI + edit-mode link orchestration. Create mode = controlled; edit mode = self-loading and self-writing. |
| `apps/desktop/src/renderer/src/components/calendar/event-project-field.test.tsx`     | **New.** Unit tests for both modes, including legacy multi-link chips and error handling.                                            |
| `apps/desktop/src/renderer/src/components/calendar/types.ts`                         | Add `projectId: string \| null` to `CalendarEventDraft`.                                                                             |
| `apps/desktop/src/renderer/src/components/calendar/calendar-event-form.tsx`          | Swap `ItemProjectChips` for `EventProjectField`; drop the edit-only guard.                                                           |
| `apps/desktop/src/renderer/src/components/calendar/calendar-quick-create-dialog.tsx` | Draft literal gains `projectId: null` (field itself is **not** added here).                                                          |
| `apps/desktop/src/renderer/src/pages/calendar.tsx`                                   | Two draft constructors + one inline draft gain `projectId`; `handlePopoverSave` links after create.                                  |
| `apps/desktop/src/renderer/src/pages/canvas/canvas-event-editor.tsx`                 | `toDraft` gains `projectId: null`. No field rendered (no `eventId` is passed to the form there — see Task 4).                        |
| `packages/i18n/src/locales/en/calendar.json`                                         | Three new keys under `form`.                                                                                                         |

---

### Task 1: `EventProjectField` — create mode

The component in create mode: a labeled `ProjectPicker` whose value lives in the parent's draft. No IPC at all — there is no event row to link to yet.

**Files:**

- Create: `apps/desktop/src/renderer/src/components/calendar/event-project-field.tsx`
- Create: `apps/desktop/src/renderer/src/components/calendar/event-project-field.test.tsx`
- Modify: `packages/i18n/src/locales/en/calendar.json` (the `"form"` object, currently starting at line 60)

**Interfaces:**

- Consumes: `ProjectPicker` from `@/components/tasks/project-picker` (props `value: string | null`, `onChange: (id: string | null) => void`, `projects: Project[]`, `includeAllOption`, `allOptionLabel`, `searchable`, `allowCreate`, `className`); `useTasksOptional` from `@/contexts/tasks` (returns `{ projects: Project[] } | null`).
- Produces: `EventProjectField` (named + default export) with

```ts
export interface EventProjectFieldProps {
  mode: 'create' | 'edit'
  /** Saved event id. Required in edit mode; null while drafting a new event. */
  eventId?: string | null
  /** Create mode only: the draft's selected project id. */
  value: string | null
  /** Create mode only: writes the selection back into the draft. */
  onChange: (projectId: string | null) => void
  disabled?: boolean
}
```

- [ ] **Step 1: Add the English copy**

In `packages/i18n/src/locales/en/calendar.json`, inside the existing `"form"` object, add these three keys after `"primary-suffix": "primary"` (add a comma to that line):

```json
    "project": "Project",
    "no-project": "No project",
    "remove-from-project": "Remove from {project}"
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/src/renderer/src/components/calendar/event-project-field.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { EventProjectField } from './event-project-field'

const { mockListForItem, mockLinkProjectItem, mockUnlinkProjectItem, mockOnProjectUpdated } =
  vi.hoisted(() => ({
    mockListForItem: vi.fn(),
    mockLinkProjectItem: vi.fn(),
    mockUnlinkProjectItem: vi.fn(),
    mockOnProjectUpdated: vi.fn(() => () => {})
  }))

vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    listForItem: mockListForItem,
    linkProjectItem: mockLinkProjectItem,
    unlinkProjectItem: mockUnlinkProjectItem
  },
  onProjectUpdated: mockOnProjectUpdated
}))

// Projects come from the app-wide TasksProvider, same as calendar-task-popover.
vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => ({
    projects: [
      { id: 'p1', name: 'Launch', color: '#ff0000', icon: null, isArchived: false },
      { id: 'p2', name: 'Finance', color: '#00ff00', icon: null, isArchived: false }
    ]
  })
}))

// The real Picker is Radix Popover-based and does not open on click in jsdom
// (codebase convention: mock it). This passthrough exposes one button per
// option so the field's own orchestration is what gets tested.
vi.mock('@/components/tasks/project-picker', () => ({
  ProjectPicker: ({
    value,
    onChange,
    projects,
    allOptionLabel
  }: {
    value: string | null
    onChange: (id: string | null) => void
    projects: Array<{ id: string; name: string }>
    allOptionLabel?: string
  }) => (
    <div data-testid="project-picker" data-value={value ?? ''}>
      <button type="button" onClick={() => onChange(null)}>
        {allOptionLabel}
      </button>
      {projects.map((project) => (
        <button key={project.id} type="button" onClick={() => onChange(project.id)}>
          {`pick-${project.name}`}
        </button>
      ))}
    </div>
  )
}))

describe('EventProjectField · create mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnProjectUpdated.mockReturnValue(() => {})
  })

  it('renders the picker with the draft value and no IPC call', () => {
    render(<EventProjectField mode="create" value="p1" onChange={vi.fn()} />)

    expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    expect(screen.getByText('Project')).toBeInTheDocument()
    expect(mockListForItem).not.toHaveBeenCalled()
  })

  it('reports the selected project through onChange without writing links', () => {
    const onChange = vi.fn()
    render(<EventProjectField mode="create" value={null} onChange={onChange} />)

    fireEvent.click(screen.getByText('pick-Launch'))

    expect(onChange).toHaveBeenCalledWith('p1')
    expect(mockLinkProjectItem).not.toHaveBeenCalled()
    expect(mockUnlinkProjectItem).not.toHaveBeenCalled()
  })

  it('reports null when the user picks "No project"', () => {
    const onChange = vi.fn()
    render(<EventProjectField mode="create" value="p1" onChange={onChange} />)

    fireEvent.click(screen.getByText('No project'))

    expect(onChange).toHaveBeenCalledWith(null)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
pnpm --filter @memry/desktop test:renderer src/renderer/src/components/calendar/event-project-field.test.tsx
```

Expected: FAIL — `Failed to resolve import "./event-project-field"`.

- [ ] **Step 4: Write the minimal implementation**

Create `apps/desktop/src/renderer/src/components/calendar/event-project-field.tsx`:

```tsx
import { useT } from '@memry/i18n/renderer'

import { ProjectPicker } from '@/components/tasks/project-picker'
import { useTasksOptional } from '@/contexts/tasks'

export interface EventProjectFieldProps {
  mode: 'create' | 'edit'
  /** Saved event id. Required in edit mode; null while drafting a new event. */
  eventId?: string | null
  /** Create mode only: the draft's selected project id. */
  value: string | null
  /** Create mode only: writes the selection back into the draft. */
  onChange: (projectId: string | null) => void
  disabled?: boolean
}

/**
 * Project assignment for a calendar event, backed by `project_links`.
 *
 * Create mode is fully controlled — the selection rides in the draft until the
 * event has an id. Edit mode owns its own state and writes link/unlink
 * immediately, matching the calendar chip's "Add to project" context menu.
 */
export function EventProjectField({
  mode,
  value,
  onChange,
  disabled
}: EventProjectFieldProps): React.JSX.Element | null {
  const { t } = useT('calendar')
  const projects = useTasksOptional()?.projects ?? []

  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{t('form.project')}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <ProjectPicker
          value={value}
          onChange={onChange}
          projects={projects}
          includeAllOption
          allOptionLabel={t('form.no-project')}
          searchable
          allowCreate={false}
          className="min-w-[160px]"
        />
      </div>
    </label>
  )
}

export default EventProjectField
```

Note: `mode` and `disabled` are unused in this task — Task 2 uses them. Keep them in the props type; if lint objects to the unused `mode` binding, leave it out of the destructure for now and add it back in Task 2.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @memry/desktop test:renderer src/renderer/src/components/calendar/event-project-field.test.tsx
```

Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/event-project-field.tsx apps/desktop/src/renderer/src/components/calendar/event-project-field.test.tsx packages/i18n/src/locales/en/calendar.json
git commit -m "feat(calendar): event project field, create mode"
```

---

### Task 2: `EventProjectField` — edit mode reads and writes links

In edit mode the truth is `project_links`, not the draft. The field loads its own state and each selection writes immediately.

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/calendar/event-project-field.tsx`
- Modify: `apps/desktop/src/renderer/src/components/calendar/event-project-field.test.tsx`

**Interfaces:**

- Consumes: `tasksService.listForItem(itemType: 'calendar_event', itemId: string) => Promise<ProjectRef[]>`; `tasksService.linkProjectItem(input: { projectId: string; itemType: 'calendar_event'; itemId: string }) => Promise<{ success: boolean; error?: string }>`; `tasksService.unlinkProjectItem(input)` with the same shape; `onProjectUpdated(cb) => () => void`. `ProjectRef` is `{ id: string; name: string; color: string; icon: string | null }`.
- Produces: no new exports — the same `EventProjectField`, now handling `mode="edit"`.

**Important:** `listForItem` goes through the main-side `withDb` wrapper, which resolves an error envelope `{ success: false, error }` instead of rejecting. Guard with `Array.isArray(result)` — `ItemProjectChips` does exactly this and has a test for it.

- [ ] **Step 1: Write the failing tests**

Append this describe block to `event-project-field.test.tsx` (keep the existing mocks and the create-mode block; add `waitFor` to the `@testing-library/react` import):

```tsx
describe('EventProjectField · edit mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockOnProjectUpdated.mockReturnValue(() => {})
    mockListForItem.mockResolvedValue([])
    mockLinkProjectItem.mockResolvedValue({ success: true })
    mockUnlinkProjectItem.mockResolvedValue({ success: true })
  })

  it('loads the current links for the event on mount', async () => {
    mockListForItem.mockResolvedValue([{ id: 'p1', name: 'Launch', color: '#ff0000', icon: null }])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)

    await waitFor(() => expect(mockListForItem).toHaveBeenCalledWith('calendar_event', 'evt-1'))
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    )
  })

  it('renders nothing when edit mode has no event id yet', () => {
    const { container } = render(
      <EventProjectField mode="edit" eventId={null} value={null} onChange={vi.fn()} />
    )

    expect(container).toBeEmptyDOMElement()
    expect(mockListForItem).not.toHaveBeenCalled()
  })

  it('unlinks the previous project and links the new one when the selection changes', async () => {
    mockListForItem.mockResolvedValue([{ id: 'p1', name: 'Launch', color: '#ff0000', icon: null }])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    )

    fireEvent.click(screen.getByText('pick-Finance'))

    await waitFor(() =>
      expect(mockUnlinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'calendar_event',
        itemId: 'evt-1'
      })
    )
    expect(mockLinkProjectItem).toHaveBeenCalledWith({
      projectId: 'p2',
      itemType: 'calendar_event',
      itemId: 'evt-1'
    })
  })

  it('only links when the event had no project', async () => {
    mockListForItem.mockResolvedValue([])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() => expect(mockListForItem).toHaveBeenCalled())

    fireEvent.click(screen.getByText('pick-Launch'))

    await waitFor(() => expect(mockLinkProjectItem).toHaveBeenCalledTimes(1))
    expect(mockUnlinkProjectItem).not.toHaveBeenCalled()
  })

  it('only unlinks when the user picks "No project"', async () => {
    mockListForItem.mockResolvedValue([{ id: 'p1', name: 'Launch', color: '#ff0000', icon: null }])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
    )

    fireEvent.click(screen.getByText('No project'))

    await waitFor(() =>
      expect(mockUnlinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'calendar_event',
        itemId: 'evt-1'
      })
    )
    expect(mockLinkProjectItem).not.toHaveBeenCalled()
  })

  it('never calls onChange in edit mode (the draft does not own the link)', async () => {
    const onChange = vi.fn()
    mockListForItem.mockResolvedValue([])

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={onChange} />)
    await waitFor(() => expect(mockListForItem).toHaveBeenCalled())

    fireEvent.click(screen.getByText('pick-Launch'))

    await waitFor(() => expect(mockLinkProjectItem).toHaveBeenCalled())
    expect(onChange).not.toHaveBeenCalled()
  })

  it('treats an IPC error envelope from listForItem as no links', async () => {
    mockListForItem.mockResolvedValue({ success: false, error: 'db error' })

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)

    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', '')
    )
  })

  it('shows a toast and reloads when a link write fails', async () => {
    mockListForItem.mockResolvedValue([])
    mockLinkProjectItem.mockResolvedValue({ success: false, error: 'link failed' })

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() => expect(mockListForItem).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByText('pick-Launch'))

    await waitFor(() => expect(mockToastError).toHaveBeenCalled())
    await waitFor(() => expect(mockListForItem).toHaveBeenCalledTimes(2))
  })

  it('reloads when a project update event fires', async () => {
    mockListForItem
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'p2', name: 'Finance', color: '#00ff00', icon: null }])
    let updateHandler: (() => void) | undefined
    mockOnProjectUpdated.mockImplementation((cb: () => void) => {
      updateHandler = cb
      return () => {}
    })

    render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
    await waitFor(() => expect(mockListForItem).toHaveBeenCalledTimes(1))

    updateHandler?.()

    await waitFor(() =>
      expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p2')
    )
  })
})
```

Also add the `sonner` mock next to the other `vi.mock` calls at the top of the file, and add `mockToastError` to the `vi.hoisted` block:

```tsx
// in the existing vi.hoisted({...}) object, add:
//   mockToastError: vi.fn()
vi.mock('sonner', () => ({
  toast: { error: mockToastError, success: vi.fn() }
}))
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @memry/desktop test:renderer src/renderer/src/components/calendar/event-project-field.test.tsx
```

Expected: FAIL — the edit-mode tests fail because nothing calls `listForItem`; the create-mode tests still pass.

- [ ] **Step 3: Implement edit mode**

Replace the contents of `event-project-field.tsx` with:

```tsx
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'

import { ProjectPicker } from '@/components/tasks/project-picker'
import { useTasksOptional } from '@/contexts/tasks'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { onProjectUpdated, tasksService, type ProjectRef } from '@/services/tasks-service'

const log = createLogger('EventProjectField')

export interface EventProjectFieldProps {
  mode: 'create' | 'edit'
  /** Saved event id. Required in edit mode; null while drafting a new event. */
  eventId?: string | null
  /** Create mode only: the draft's selected project id. */
  value: string | null
  /** Create mode only: writes the selection back into the draft. */
  onChange: (projectId: string | null) => void
  disabled?: boolean
}

/**
 * Project assignment for a calendar event, backed by `project_links`.
 *
 * Create mode is fully controlled — the selection rides in the draft until the
 * event has an id. Edit mode owns its own state and writes link/unlink
 * immediately, matching the calendar chip's "Add to project" context menu.
 */
export function EventProjectField({
  mode,
  eventId,
  value,
  onChange,
  disabled
}: EventProjectFieldProps): React.JSX.Element | null {
  const { t } = useT('calendar')
  const projects = useTasksOptional()?.projects ?? []
  const [links, setLinks] = useState<ProjectRef[]>([])
  const isEdit = mode === 'edit'

  const load = useCallback(async (): Promise<void> => {
    if (!isEdit || !eventId) return
    try {
      const result = await tasksService.listForItem('calendar_event', eventId)
      // `listForItem` runs through the main-side `withDb` wrapper: on a DB
      // error it resolves `{ success: false, error }` instead of rejecting.
      setLinks(Array.isArray(result) ? result : [])
    } catch (error) {
      log.error('Failed to load event projects', extractErrorMessage(error))
      setLinks([])
    }
  }, [isEdit, eventId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => onProjectUpdated(() => void load()), [load])

  const handleSelect = async (nextId: string | null): Promise<void> => {
    if (!isEdit || !eventId) {
      onChange(nextId)
      return
    }
    const previousId = links[0]?.id ?? null
    if (previousId === nextId) return

    try {
      if (previousId) {
        const removed = await tasksService.unlinkProjectItem({
          projectId: previousId,
          itemType: 'calendar_event',
          itemId: eventId
        })
        if (!removed.success) throw new Error(removed.error)
      }
      if (nextId) {
        const added = await tasksService.linkProjectItem({
          projectId: nextId,
          itemType: 'calendar_event',
          itemId: eventId
        })
        if (!added.success) throw new Error(added.error)
      }
    } catch (error) {
      toast.error(extractErrorMessage(error, t('form.project-update-failed')))
    }
    await load()
  }

  // Edit mode before the event is saved (canvas cards mount the form without an
  // id): nothing to link to, so render nothing rather than a dead control.
  if (isEdit && !eventId) return null

  const selectedId = isEdit ? (links[0]?.id ?? null) : value

  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{t('form.project')}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <ProjectPicker
          value={selectedId}
          onChange={(next) => void handleSelect(next)}
          projects={projects}
          includeAllOption
          allOptionLabel={t('form.no-project')}
          searchable
          allowCreate={false}
          className="min-w-[160px]"
        />
      </div>
    </label>
  )
}

export default EventProjectField
```

`disabled` stays unused until the form passes it — if lint flags it, wire it straight through to `ProjectPicker` only if `ProjectPickerProps` accepts it; it does not today, so instead drop `disabled` from the destructure and keep it in the props type for API symmetry with the other form fields.

- [ ] **Step 4: Add the failure-copy key**

`t('form.project-update-failed')` is referenced above. In `packages/i18n/src/locales/en/calendar.json`, inside `"form"`, add:

```json
    "project-update-failed": "Could not update the event's project"
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm --filter @memry/desktop test:renderer src/renderer/src/components/calendar/event-project-field.test.tsx
```

Expected: PASS — 12 tests (3 create + 9 edit).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/event-project-field.tsx apps/desktop/src/renderer/src/components/calendar/event-project-field.test.tsx packages/i18n/src/locales/en/calendar.json
git commit -m "feat(calendar): event project field writes links in edit mode"
```

---

### Task 3: Legacy multi-link chips

An event can already be linked to several projects — the right-click "Add to project" dialog has always allowed it. The single-select picker shows the first link; the rest must stay visible and removable, never silently dropped.

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/calendar/event-project-field.tsx`
- Modify: `apps/desktop/src/renderer/src/components/calendar/event-project-field.test.tsx`

**Interfaces:**

- Consumes: `X` icon from `@/lib/icons` (`export const X = createIcon(Cancel01Icon)`).
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Append to the edit-mode describe block in `event-project-field.test.tsx`:

```tsx
it('renders extra links as removable chips beside the picker', async () => {
  mockListForItem.mockResolvedValue([
    { id: 'p1', name: 'Launch', color: '#ff0000', icon: null },
    { id: 'p2', name: 'Finance', color: '#00ff00', icon: null }
  ])

  render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)

  await waitFor(() =>
    expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
  )
  expect(await screen.findByText('Finance')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Remove from Finance' })).toBeInTheDocument()
})

it('unlinks only the chip that was removed', async () => {
  mockListForItem.mockResolvedValue([
    { id: 'p1', name: 'Launch', color: '#ff0000', icon: null },
    { id: 'p2', name: 'Finance', color: '#00ff00', icon: null }
  ])

  render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
  const remove = await screen.findByRole('button', { name: 'Remove from Finance' })

  fireEvent.click(remove)

  await waitFor(() => expect(mockUnlinkProjectItem).toHaveBeenCalledTimes(1))
  expect(mockUnlinkProjectItem).toHaveBeenCalledWith({
    projectId: 'p2',
    itemType: 'calendar_event',
    itemId: 'evt-1'
  })
})

it('switching the primary project leaves the extra link untouched', async () => {
  mockListForItem.mockResolvedValue([
    { id: 'p1', name: 'Launch', color: '#ff0000', icon: null },
    { id: 'p2', name: 'Finance', color: '#00ff00', icon: null }
  ])

  render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)
  await waitFor(() =>
    expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
  )

  fireEvent.click(screen.getByText('pick-Finance'))

  await waitFor(() => expect(mockUnlinkProjectItem).toHaveBeenCalledTimes(1))
  expect(mockUnlinkProjectItem).toHaveBeenCalledWith({
    projectId: 'p1',
    itemType: 'calendar_event',
    itemId: 'evt-1'
  })
})

it('shows no chips when the event has a single project', async () => {
  mockListForItem.mockResolvedValue([{ id: 'p1', name: 'Launch', color: '#ff0000', icon: null }])

  render(<EventProjectField mode="edit" eventId="evt-1" value={null} onChange={vi.fn()} />)

  await waitFor(() =>
    expect(screen.getByTestId('project-picker')).toHaveAttribute('data-value', 'p1')
  )
  expect(screen.queryByRole('button', { name: /^Remove from/ })).not.toBeInTheDocument()
})
```

Note on the third test: the picker's `pick-Finance` selects `p2`, which is already the _extra_ link. `handleSelect` unlinks the previous primary (`p1`) and links `p2`; `linkProjectItem` is a no-op upsert on the existing unique index, so the assertion is about `unlinkProjectItem` being called exactly once, for `p1` only.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @memry/desktop test:renderer src/renderer/src/components/calendar/event-project-field.test.tsx
```

Expected: FAIL — `Unable to find an accessible element with the role "button" and name "Remove from Finance"`.

- [ ] **Step 3: Implement the chips**

In `event-project-field.tsx`, add the icon import:

```tsx
import { X } from '@/lib/icons'
```

Add the removal handler next to `handleSelect`:

```tsx
const handleRemoveExtra = async (projectId: string): Promise<void> => {
  if (!eventId) return
  try {
    const removed = await tasksService.unlinkProjectItem({
      projectId,
      itemType: 'calendar_event',
      itemId: eventId
    })
    if (!removed.success) throw new Error(removed.error)
  } catch (error) {
    toast.error(extractErrorMessage(error, t('form.project-update-failed')))
  }
  await load()
}
```

Derive the extras next to `selectedId`:

```tsx
// Single-select UI over a many-to-many table: an event linked to several
// projects (possible via the chip context menu) keeps every link visible and
// individually removable. Nothing is dropped that the user did not remove.
const extraLinks = isEdit ? links.slice(1) : []
```

And render them inside the existing flex row, after `<ProjectPicker … />`:

```tsx
{
  extraLinks.map((project) => (
    <span
      key={project.id}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
    >
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: project.color }}
        aria-hidden="true"
      />
      <span className="max-w-32 truncate">{project.name}</span>
      <button
        type="button"
        aria-label={t('form.remove-from-project', { project: project.name })}
        onClick={() => void handleRemoveExtra(project.id)}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  ))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm --filter @memry/desktop test:renderer src/renderer/src/components/calendar/event-project-field.test.tsx
```

Expected: PASS — 16 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar/event-project-field.tsx apps/desktop/src/renderer/src/components/calendar/event-project-field.test.tsx
git commit -m "feat(calendar): keep extra project links removable on events"
```

---

### Task 4: Wire the field into the event form

Replace the read-only `ItemProjectChips` row with the new field, add `projectId` to the draft type, and update every draft constructor so the codebase typechecks.

**Files:**

- Modify: `apps/desktop/src/renderer/src/components/calendar/types.ts`
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-event-form.tsx:20` (import) and `:222-224` (the chips block)
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-quick-create-dialog.tsx:79-88` (`buildDraft`)
- Modify: `apps/desktop/src/renderer/src/pages/calendar.tsx:111-137` (`createDraftFromAnchor`, `createDraftFromItem`) and `:420-427` (the record-based edit draft)
- Modify: `apps/desktop/src/renderer/src/pages/canvas/canvas-event-editor.tsx:37-51` (`toDraft`)
- Modify: `apps/desktop/src/renderer/src/components/calendar/calendar-event-form.test.tsx` (if the existing tests assert on the chips block)

**Interfaces:**

- Consumes: `EventProjectField` from `./event-project-field` (props exactly as defined in Task 1).
- Produces: `CalendarEventDraft` gains `projectId: string | null` — Task 5 reads `draft.projectId`.

**Do not** add the field to `CalendarQuickCreateDialog`'s UI. That popover stays title-only by design; it only needs the new draft key so its `buildDraft` still satisfies the type.

**Do not** pass `eventId` from `canvas-event-editor.tsx`. Idle canvas cards mount this form purely to paint, and several mount at once — each would fire a `listForItem` IPC. The field's `isEdit && !eventId` guard (Task 2) makes it render nothing there.

- [ ] **Step 1: Add `projectId` to the draft type**

In `apps/desktop/src/renderer/src/components/calendar/types.ts`:

```ts
export interface CalendarEventDraft {
  title: string
  description: string
  isAllDay: boolean
  startAt: string
  endAt: string
  /** M2: Google calendar this event should be pushed to. Null = fall through to default. */
  targetCalendarId: string | null
  /** Create mode only: project to link the event to once it has an id. */
  projectId: string | null
}
```

- [ ] **Step 2: Run typecheck to see every construction site**

```bash
pnpm --filter @memry/desktop typecheck:web
```

Expected: FAIL with "Property 'projectId' is missing" at four places — `calendar-quick-create-dialog.tsx`, two constructors in `calendar.tsx`, the inline record draft in `calendar.tsx`, and `canvas-event-editor.tsx`.

- [ ] **Step 3: Add `projectId: null` at every construction site**

In each of these object literals, add `projectId: null` after `targetCalendarId`:

- `calendar-quick-create-dialog.tsx` → `buildDraft()`
- `calendar.tsx` → `createDraftFromAnchor()` (currently ends `targetCalendarId: null`)
- `calendar.tsx` → `createDraftFromItem()` (currently ends `targetCalendarId: item.binding?.remoteCalendarId ?? null`)
- `calendar.tsx` → the inline `satisfies CalendarEventDraft` literal built from `record` (currently ends `targetCalendarId: record.targetCalendarId`)
- `canvas-event-editor.tsx` → `toDraft()` (currently ends `targetCalendarId: event.targetCalendarId`)

- [ ] **Step 4: Swap the form's chips row for the field**

In `apps/desktop/src/renderer/src/components/calendar/calendar-event-form.tsx`, replace the import on line 20:

```tsx
import { EventProjectField } from './event-project-field'
```

and replace the block at lines 222-224:

```tsx
<EventProjectField
  mode={mode}
  eventId={eventId}
  value={draft.projectId}
  onChange={(projectId) => onDraftChange({ ...draft, projectId })}
/>
```

- [ ] **Step 5: Run typecheck and the calendar renderer tests**

```bash
pnpm --filter @memry/desktop typecheck:web
pnpm --filter @memry/desktop test:renderer src/renderer/src/components/calendar
```

Expected: typecheck PASS. Tests PASS — if `calendar-event-form.test.tsx` or `calendar-event-popover.test.tsx` mocked or asserted `ItemProjectChips`, update those assertions to the new field (mock `./event-project-field` with a stub that renders `null` if the test is not about projects).

- [ ] **Step 6: Run the canvas editor tests**

```bash
pnpm --filter @memry/desktop test:renderer src/renderer/src/pages/canvas
```

Expected: PASS — the canvas editor passes no `eventId`, so the field renders nothing and the card layout is unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/src/components/calendar apps/desktop/src/renderer/src/pages/calendar.tsx apps/desktop/src/renderer/src/pages/canvas/canvas-event-editor.tsx
git commit -m "feat(calendar): show the project field in the event form"
```

---

### Task 5: Link the project after the event is created

Create mode holds the selection in the draft because there is no event id yet. `createEvent` returns the saved record, so the link is one call away.

**Files:**

- Modify: `apps/desktop/src/renderer/src/pages/calendar.tsx` (`handlePopoverSave`, the create branch around line 636)
- Create: `apps/desktop/src/renderer/src/pages/calendar-event-project.test.tsx`

**Interfaces:**

- Consumes: `calendarService.createEvent(input) => Promise<{ success: boolean; event: CalendarEventRecord | null; error?: string }>`; `tasksService.linkProjectItem(input) => Promise<{ success: boolean; error?: string }>`; `draft.projectId` from Task 4.
- Produces: nothing new.

A failed link must not fail the event creation — the event exists, so keep it, log, and toast.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/renderer/src/pages/calendar-event-project.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { renderWithProviders, userEvent } from '@tests/utils/render'
import { CalendarPage } from '@/pages/calendar'
import type { CalendarSourceRecord } from '@/services/calendar-service'

const {
  mockUseCalendarRange,
  mockListSources,
  mockCreateEvent,
  mockUpdateEvent,
  mockLinkProjectItem,
  mockOpenTab
} = vi.hoisted(() => ({
  mockUseCalendarRange: vi.fn(),
  mockListSources: vi.fn(),
  mockCreateEvent: vi.fn(),
  mockUpdateEvent: vi.fn(),
  mockLinkProjectItem: vi.fn(),
  mockOpenTab: vi.fn()
}))

vi.mock('@/hooks/use-calendar-range', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/use-calendar-range')>()),
  useCalendarRange: mockUseCalendarRange
}))

vi.mock('@/contexts/tabs', () => ({
  useActiveTab: () => null,
  useTabActions: () => ({ openTab: mockOpenTab })
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: {
    listSources: mockListSources,
    createEvent: mockCreateEvent,
    updateEvent: mockUpdateEvent
  },
  onCalendarChanged: vi.fn(() => () => {})
}))

// The project field is exercised in its own test; here it only needs to put a
// project id into the draft so the page's post-create link is observable.
vi.mock('@/components/calendar/event-project-field', () => ({
  EventProjectField: ({
    value,
    onChange
  }: {
    value: string | null
    onChange: (id: string | null) => void
  }) => (
    <button type="button" data-value={value ?? ''} onClick={() => onChange('p1')}>
      stub-pick-project
    </button>
  )
}))

vi.mock('@/services/tasks-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/tasks-service')>()),
  tasksService: {
    linkProjectItem: mockLinkProjectItem
  }
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() }
}))

const NO_SOURCES: CalendarSourceRecord[] = []

describe('CalendarPage · create with a project selected', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    mockListSources.mockResolvedValue({ sources: NO_SOURCES })
    mockUseCalendarRange.mockReturnValue({
      data: { items: [] },
      items: [],
      isLoading: false,
      isFetching: false,
      error: null
    })
    mockCreateEvent.mockResolvedValue({ success: true, event: { id: 'event-new' } })
    mockLinkProjectItem.mockResolvedValue({ success: true })
    localStorage.setItem('calendar-view', 'day')
  })

  async function openCreatePopover(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(await screen.findByRole('button', { name: 'Create event' }))
    await screen.findByTestId('event-edit-popover')
  }

  it('links the created event to the drafted project', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)
    await openCreatePopover(user)

    await user.type(screen.getByPlaceholderText('New Event'), 'Kickoff')
    await user.click(screen.getByText('stub-pick-project'))
    await user.click(screen.getByTestId('event-edit-save'))

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(mockLinkProjectItem).toHaveBeenCalledWith({
        projectId: 'p1',
        itemType: 'calendar_event',
        itemId: 'event-new'
      })
    )
  })

  it('does not link when no project was selected', async () => {
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)
    await openCreatePopover(user)

    await user.type(screen.getByPlaceholderText('New Event'), 'Kickoff')
    await user.click(screen.getByTestId('event-edit-save'))

    await waitFor(() => expect(mockCreateEvent).toHaveBeenCalledTimes(1))
    expect(mockLinkProjectItem).not.toHaveBeenCalled()
  })

  it('keeps the created event when linking fails', async () => {
    mockLinkProjectItem.mockResolvedValue({ success: false, error: 'link failed' })
    const user = userEvent.setup()
    renderWithProviders(<CalendarPage />)
    await openCreatePopover(user)

    await user.type(screen.getByPlaceholderText('New Event'), 'Kickoff')
    await user.click(screen.getByText('stub-pick-project'))
    await user.click(screen.getByTestId('event-edit-save'))

    await waitFor(() => expect(mockLinkProjectItem).toHaveBeenCalled())
    // The popover closes on a successful create even though the link failed.
    await waitFor(() => expect(screen.queryByTestId('event-edit-popover')).not.toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @memry/desktop test:renderer src/renderer/src/pages/calendar-event-project.test.tsx
```

Expected: FAIL — `mockLinkProjectItem` is never called.

- [ ] **Step 3: Implement the post-create link**

In `apps/desktop/src/renderer/src/pages/calendar.tsx`, in `handlePopoverSave`, replace the create branch:

```tsx
      if (popoverState.mode === 'create') {
        const result = await calendarService.createEvent(toCreatePayload(popoverState.draft))
        if (!result.success) {
          throw new Error(result.error ?? 'Could not create event.')
        }
        const createdId = result.event?.id
        const projectId = popoverState.draft.projectId
        // The link needs an event id, which only exists after the create. A
        // failed link must not discard a successfully created event.
        if (createdId && projectId) {
          try {
            const linked = await tasksService.linkProjectItem({
              projectId,
              itemType: 'calendar_event',
              itemId: createdId
            })
            if (!linked.success) throw new Error(linked.error)
          } catch (error) {
            const tCalendar = getI18n().getFixedT(null, 'calendar')
            log.error('Failed to link created event to project', {
              eventId: createdId,
              projectId,
              error: extractErrorMessage(error)
            })
            toast.error(extractErrorMessage(error, tCalendar('form.project-update-failed')))
          }
        }
      } else if (popoverState.eventId) {
```

Already in scope in this file: `tasksService` (line 39), `extractErrorMessage` (line 36), `log` (line 49), `getI18n` (line 47). The file builds its translator locally with `getI18n().getFixedT(null, 'calendar')` — lines 554 and 597 do the same, so follow that pattern rather than adding a hook.

One import is missing. Add it at the top of the file:

```tsx
import { toast } from 'sonner'
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @memry/desktop test:renderer src/renderer/src/pages/calendar-event-project.test.tsx
```

Expected: PASS — 3 tests.

- [ ] **Step 5: Run the rest of the calendar page tests**

```bash
pnpm --filter @memry/desktop test:renderer src/renderer/src/pages/calendar
```

Expected: PASS — the existing quick-create and callbacks suites are unaffected (the quick-create dialog never sets `projectId`).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/src/pages/calendar.tsx apps/desktop/src/renderer/src/pages/calendar-event-project.test.tsx
git commit -m "feat(calendar): link a new event to the project chosen at create time"
```

---

### Task 6: Full verification and docs gate

**Files:**

- Modify: `apps/docs/src/**` only if `docs:impact` reports `missing-docs`

- [ ] **Step 1: Run the full desktop renderer suite**

```bash
pnpm --filter @memry/desktop test:renderer
```

Expected: PASS. Fix any suite that mocked `ItemProjectChips` inside a calendar test.

- [ ] **Step 2: Typecheck the whole monorepo**

```bash
pnpm typecheck
```

Expected: PASS. Pre-existing errors in `websocket.test.ts` and `folders.test.ts` are known and may be ignored.

- [ ] **Step 3: Lint**

```bash
pnpm lint
```

Expected: PASS with zero warnings. Watch for the RTL rule — the new component must use logical Tailwind classes only.

- [ ] **Step 4: i18n check**

```bash
pnpm --filter @memry/desktop i18n:check
```

Expected: PASS. English is the gated locale; the four new keys must exist under `form` in `packages/i18n/src/locales/en/calendar.json`: `project`, `no-project`, `remove-from-project`, `project-update-failed`.

- [ ] **Step 5: Whitespace check**

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 6: Docs impact gate**

```bash
base_commit=$(git merge-base origin/main HEAD)
pnpm docs:impact --base "$base_commit" --strict
```

If it reports `missing-docs`, update the calendar page under `apps/docs/src/**` describing the new project field (create + edit, clearing with "No project", extra chips for events linked to several projects), then re-run the command and `pnpm docs:build`.

- [ ] **Step 7: Commit any docs changes**

```bash
git add apps/docs/src
git commit -m "docs(calendar): document event project assignment"
```

---

## Manual smoke test (after Task 6)

```bash
pnpm dev
```

1. Calendar → toolbar **+** → the form shows a **Project** row reading "No project".
2. Pick a project, add a title, Save → open the event again; the picker shows that project.
3. Change the project in the open event → close and reopen; the new project sticks.
4. Pick "No project" → reopen; it reads "No project" and the project hub no longer lists the event.
5. Right-click the event chip → "Add to project" → choose a _second_ project → open the event: the picker shows one project and the second appears as a chip with an ×. Click the × → only that link disappears.
6. Drag on the grid to open the quick-create box → it stays title-only, no project row.
