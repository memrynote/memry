/**
 * #1907 — a checkbox line Memry has no `tasks` row for must never be dressed
 * as a task it cannot act on.
 *
 * A `{task:<id>}` suffix whose id resolves to no row (a vault copied between
 * installs) renders a full `TaskRow` built from `placeholderTask` (`id: ''`),
 * whose every handler early-returns on the empty id, until the async lookup
 * settles into the deleted-task row. Nothing on it may claim to act on a task.
 *
 * The other id-less shape, `taskId: ''`, is a draft the create has not caught
 * up with. #2271 separates it from this rule: see the draft test below.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type React from 'react'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getLinkedTasks: vi.fn(),
  update: vi.fn(),
  complete: vi.fn(),
  uncomplete: vi.fn(),
  deleteTask: vi.fn(),
  onTaskUpdated: vi.fn(() => () => {}),
  onTaskCompleted: vi.fn(() => () => {}),
  onTaskDeleted: vi.fn(() => () => {}),
  openTab: vi.fn(),
  projects: [] as unknown[]
}))

vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (key: string) => key }) }))
vi.mock('@/contexts/tasks', () => ({ useTasksOptional: () => ({ projects: mocks.projects }) }))
vi.mock('@/contexts/tabs', () => ({ useTabActions: () => ({ openTab: mocks.openTab }) }))
vi.mock('@/services/tasks-service', () => ({
  tasksService: {
    get: mocks.get,
    getLinkedTasks: mocks.getLinkedTasks,
    update: mocks.update,
    complete: mocks.complete,
    uncomplete: mocks.uncomplete,
    delete: mocks.deleteTask
  },
  onTaskUpdated: mocks.onTaskUpdated,
  onTaskCompleted: mocks.onTaskCompleted,
  onTaskDeleted: mocks.onTaskDeleted,
  // The prefetch provider re-reads the note's project links on a project
  // change, so it subscribes here.
  onProjectUpdated: () => vi.fn()
}))

// Stands in for the real row: only an interactive row exposes the controls
// that write to a `tasks` row.
vi.mock('@/components/tasks/task-row', () => ({
  TaskRow: ({
    task,
    interactive = true,
    onToggleComplete,
    onUpdateTask,
    onProjectChange,
    renderTitle
  }: {
    task: { id: string }
    interactive?: boolean
    onToggleComplete: (taskId: string) => void
    onUpdateTask?: (taskId: string, updates: Record<string, unknown>) => void
    onProjectChange?: (projectId: string) => void
    renderTitle?: () => React.ReactNode
  }) => (
    <div data-testid="task-row" data-task-id={task.id} data-interactive={String(interactive)}>
      {renderTitle?.()}
      {interactive && (
        <>
          <button type="button" onClick={() => onToggleComplete(task.id)}>
            toggle
          </button>
          <button type="button" onClick={() => onUpdateTask?.(task.id, { priority: 'urgent' })}>
            priority
          </button>
          <button type="button" onClick={() => onProjectChange?.('project-2')}>
            project
          </button>
        </>
      )}
    </div>
  )
}))

import { TaskBlockRenderer, type TaskBlock, type TaskBlockEditor } from './task-block-renderer'
import { TaskPrefetchProvider } from './task-prefetch-context'

const project = {
  id: 'project-1',
  name: 'Inbox',
  color: '#000',
  isDefault: true,
  statuses: [{ id: 'todo', name: 'Todo', type: 'todo', color: '#aaa', order: 0 }]
}

function makeBlock(overrides: Partial<TaskBlock['props']> = {}): TaskBlock {
  return {
    id: 'block-1',
    type: 'taskBlock',
    props: { taskId: 'task-1', title: 'Buy milk', checked: false, parentTaskId: '', ...overrides },
    children: []
  }
}

function makeEditor(document: TaskBlock[]): TaskBlockEditor {
  return {
    document,
    updateBlock: vi.fn(),
    replaceBlocks: vi.fn(),
    removeBlocks: vi.fn(),
    insertBlocks: vi.fn(),
    setTextCursorPosition: vi.fn(),
    focus: vi.fn(),
    getTextCursorPosition: vi.fn(() => ({ block: document[0] }))
  }
}

function renderBlock(block: TaskBlock): ReturnType<typeof render> {
  return render(
    <TaskPrefetchProvider noteId="note-1">
      <TaskBlockRenderer block={block} editor={makeEditor([block])} />
    </TaskPrefetchProvider>
  )
}

describe('taskBlock with no tasks row behind it', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.projects = [project]
    mocks.getLinkedTasks.mockResolvedValue([])
    mocks.get.mockResolvedValue(null)
    mocks.update.mockResolvedValue({ success: false, error: 'Task not found' })
    mocks.complete.mockResolvedValue({ success: false, error: 'Task not found' })
  })

  it('offers no task controls while a {task:<id>} has not resolved to a row', () => {
    // #given a note copied from another install: the suffix points at no row
    // #when the block first paints, before the lookup settles
    renderBlock(makeBlock({ taskId: 'nonexistent' }))

    // #then the row is inert rather than a live task row over an empty id
    const row = screen.getByTestId('task-row')
    expect(row.getAttribute('data-interactive')).toBe('false')
    expect(screen.queryByText('toggle')).toBeNull()
    expect(screen.queryByText('priority')).toBeNull()
    expect(screen.queryByText('project')).toBeNull()
  })

  // #2271 revisits the `taskId: ''` half of the rule. That block is a draft
  // whose create has not resolved yet, not a dead one: the id is coming, and
  // the picker the user reaches for while it is in flight now holds the
  // choice until it arrives (see `task-block-renderer.test.tsx`). Writing
  // nothing against the empty id is still the invariant — the controls are
  // live, the service calls are not.
  it('keeps the controls live on a draft whose id has not arrived, and writes nothing yet', () => {
    // #given a checkbox rewritten to a taskBlock, create still in flight
    // #when it renders
    renderBlock(makeBlock({ taskId: '' }))

    // #then the row is usable
    const row = screen.getByTestId('task-row')
    expect(row.getAttribute('data-interactive')).toBe('true')

    // #and nothing it offers reaches a service with an empty id
    screen.getByText('priority').click()
    screen.getByText('project').click()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('never hands a control an empty task id', () => {
    // #given an unresolved block
    renderBlock(makeBlock({ taskId: 'nonexistent' }))

    // #then no rendered control is wired to the placeholder's empty id
    expect(screen.queryByText('toggle')).toBeNull()
  })

  it('replaces the row with the deleted-task notice once the id resolves to nothing', async () => {
    // #given a suffix pointing at a row that does not exist
    renderBlock(makeBlock({ taskId: 'nonexistent' }))

    // #when the lookup settles
    await waitFor(() => expect(mocks.get).toHaveBeenCalledWith('nonexistent'))

    // #then the block says so instead of pretending to be a task
    await waitFor(() =>
      expect(
        screen.getByText('phaseF.componentsNoteContentAreaTaskBlockTaskBlockRenderer.taskDeleted')
      ).toBeInTheDocument()
    )
    expect(screen.queryByTestId('task-row')).toBeNull()
  })

  it('keeps every control for a task that does resolve', async () => {
    // #given the id resolves to a real row
    mocks.getLinkedTasks.mockResolvedValue([
      { id: 'task-1', title: 'Buy milk', projectId: 'project-1', statusId: 'todo', priority: 0 }
    ])

    // #when it renders
    renderBlock(makeBlock({ taskId: 'task-1' }))

    // #then the row stays fully interactive
    await waitFor(() =>
      expect(screen.getByTestId('task-row').getAttribute('data-interactive')).toBe('true')
    )
    expect(screen.getByText('toggle')).toBeInTheDocument()
    expect(screen.getByText('project')).toBeInTheDocument()
  })
})
