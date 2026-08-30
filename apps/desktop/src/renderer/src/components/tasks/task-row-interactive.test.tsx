/**
 * #1907 — `interactive={false}` is what a taskBlock uses when it has no
 * `tasks` row to act on. Every control that would write to a row must stop
 * being a control.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskRow } from './task-row'
import type { Project } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'

const statusDisabled = vi.fn()
const priorityDisabled = vi.fn()

vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (key: string) => key }) }))
vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))
vi.mock('@/components/tasks/inline-status-popover', () => ({
  InlineStatusPopover: ({ disabled }: { disabled?: boolean }) => {
    statusDisabled(disabled)
    return <span data-testid="status-popover" data-disabled={String(!!disabled)} />
  }
}))
vi.mock('@/components/tasks/inline-priority-popover', () => ({
  InlinePriorityPopover: ({ disabled }: { disabled?: boolean }) => {
    priorityDisabled(disabled)
    return <span data-testid="priority-popover" data-disabled={String(!!disabled)} />
  }
}))
vi.mock('@/components/tasks/interactive-project-badge', () => ({
  InteractiveProjectBadge: () => <span data-testid="interactive-project-badge" />
}))

const project: Project = {
  id: 'project-1',
  name: 'Inbox',
  color: '#ff671a',
  statuses: [{ id: 'todo', name: 'Todo', type: 'todo', color: '#aaa', order: 0 }]
} as unknown as Project

const task: Task = {
  id: 'task-1',
  title: 'Buy milk',
  description: '',
  projectId: 'project-1',
  statusId: 'todo',
  priority: 'none',
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  tags: [],
  parentId: null,
  subtaskIds: [],
  createdAt: new Date('2026-08-01T00:00:00Z'),
  completedAt: null,
  archivedAt: null
}

function renderRow(interactive: boolean, onClick = vi.fn()): void {
  render(
    <TaskRow
      task={task}
      project={project}
      projects={[project]}
      isCompleted={false}
      showProjectBadge
      interactive={interactive}
      onClick={onClick}
      onToggleComplete={vi.fn()}
      onUpdateTask={vi.fn()}
      onProjectChange={vi.fn()}
    />
  )
}

describe('TaskRow interactive', () => {
  it('disables the status and priority pickers when not interactive', () => {
    renderRow(false)

    expect(screen.getByTestId('status-popover').getAttribute('data-disabled')).toBe('true')
    expect(screen.getByTestId('priority-popover').getAttribute('data-disabled')).toBe('true')
  })

  it('shows a static project badge instead of the picker when not interactive', () => {
    renderRow(false)

    expect(screen.queryByTestId('interactive-project-badge')).toBeNull()
    expect(screen.getByText('Inbox')).toBeInTheDocument()
  })

  it('does not open the task when a non-interactive row is clicked', () => {
    const onClick = vi.fn()
    renderRow(false, onClick)

    screen.getByRole('button', { name: /Task: Buy milk/ }).click()

    expect(onClick).not.toHaveBeenCalled()
  })

  it('marks a non-interactive row busy and keeps it out of the tab order', () => {
    renderRow(false)

    const row = screen.getByRole('button', { name: /Task: Buy milk/ })
    expect(row.getAttribute('aria-busy')).toBe('true')
    expect(row.getAttribute('tabindex')).toBe('-1')
  })

  it('keeps every control live by default', () => {
    const onClick = vi.fn()
    renderRow(true, onClick)

    expect(screen.getByTestId('status-popover').getAttribute('data-disabled')).toBe('false')
    expect(screen.getByTestId('priority-popover').getAttribute('data-disabled')).toBe('false')
    expect(screen.getByTestId('interactive-project-badge')).toBeInTheDocument()
    screen.getByRole('button', { name: /Task: Buy milk/ }).click()
    expect(onClick).toHaveBeenCalledWith('task-1')
  })
})
