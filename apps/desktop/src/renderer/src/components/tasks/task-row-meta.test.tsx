/**
 * The two props the note's task block hands TaskRow: a `meta` slot for its
 * editable property chips, and control over which of the row's own pickers is
 * open. Without them the row is the Tasks page's row, unchanged.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskRow } from './task-row'
import type { Project } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'

vi.mock('@memry/i18n/renderer', () => ({ useT: () => ({ t: (key: string) => key }) }))
vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({ settings: { clockFormat: '24h' } })
}))

type PickerStub = { open?: boolean; onOpenChange?: (open: boolean) => void }

// Hoisted with the mocks below, which are hoisted above every other statement.
const { pickerStub } = vi.hoisted(() => ({
  pickerStub:
    (name: string) =>
    ({ open, onOpenChange }: PickerStub): React.JSX.Element => (
      <button
        type="button"
        data-testid={name}
        data-open={open === undefined ? 'uncontrolled' : String(open)}
        onClick={() => onOpenChange?.(!open)}
      />
    )
}))

vi.mock('@/components/tasks/inline-status-popover', () => ({
  InlineStatusPopover: pickerStub('status')
}))
vi.mock('@/components/tasks/inline-priority-popover', () => ({
  InlinePriorityPopover: pickerStub('priority')
}))
vi.mock('@/components/tasks/interactive-project-badge', () => ({
  InteractiveProjectBadge: pickerStub('project')
}))
vi.mock('@/components/tasks/task-badges', () => ({
  TaskTagsBadge: ({ tags }: { tags: string[] }) => <span>{tags.join(' ')}</span>
}))

const project = {
  id: 'project-1',
  name: 'Inbox',
  color: '#000',
  statuses: [{ id: 'todo', name: 'Todo', type: 'todo', color: '#aaa', order: 0 }]
} as unknown as Project

const task: Task = {
  id: 'task-1',
  title: 'Ship the beta',
  description: '',
  projectId: 'project-1',
  statusId: 'todo',
  priority: 'none',
  dueDate: new Date(2099, 8, 12),
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  repeatFrom: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  tags: ['launch'],
  parentId: null,
  subtaskIds: [],
  createdAt: new Date(2026, 0, 1),
  completedAt: null,
  archivedAt: null
}

const renderRow = (props: Partial<React.ComponentProps<typeof TaskRow>> = {}) =>
  render(
    <TaskRow
      task={task}
      project={project}
      projects={[project]}
      isCompleted={false}
      showProjectBadge
      onToggleComplete={vi.fn()}
      onProjectChange={vi.fn()}
      {...props}
    />
  )

describe('TaskRow meta slot', () => {
  it('keeps the read-only badges when no meta is given', () => {
    renderRow()

    expect(screen.getByText('launch')).toBeInTheDocument()
    expect(screen.getByText('Sep 12')).toBeInTheDocument()
  })

  it('puts the meta in place of the tag and due-date badges', () => {
    renderRow({ meta: <span>chips</span> })

    expect(screen.getByText('chips')).toBeInTheDocument()
    expect(screen.queryByText('launch')).not.toBeInTheDocument()
    expect(screen.queryByText('Sep 12')).not.toBeInTheDocument()
  })
})

describe('TaskRow picker control', () => {
  it('leaves each picker to its own state without a control', () => {
    renderRow()

    expect(screen.getByTestId('status')).toHaveAttribute('data-open', 'uncontrolled')
  })

  it('opens the picker the control names and reports changes by id', () => {
    const onOpenChange = vi.fn()
    renderRow({ pickerControl: { open: 'priority', onOpenChange } })

    expect(screen.getByTestId('priority')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('status')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('project')).toHaveAttribute('data-open', 'false')

    fireEvent.click(screen.getByTestId('project'))
    expect(onOpenChange).toHaveBeenCalledWith('project', true)
  })
})
