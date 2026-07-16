import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DueDateBadge, PriorityBadge, ProjectBadge, StatusBadge, TaskCheckbox } from './task-badges'
import { TaskRow } from './task-row'
import type { Project } from '@/data/tasks-data'
import type { Task } from '@/data/task-model'

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/hooks/use-general-settings', () => ({
  useGeneralSettings: () => ({
    settings: { clockFormat: '24h' }
  })
}))

vi.mock('@/components/tasks/inline-status-popover', () => ({
  InlineStatusPopover: ({
    onStatusChange,
    onToggleComplete
  }: {
    onStatusChange: (statusId: string) => void
    onToggleComplete: () => void
  }) => (
    <span>
      <button type="button" onClick={onToggleComplete}>
        status toggle
      </button>
      <button type="button" onClick={() => onStatusChange('done')}>
        status done
      </button>
    </span>
  )
}))

vi.mock('@/components/tasks/inline-priority-popover', () => ({
  InlinePriorityPopover: ({
    onPriorityChange
  }: {
    onPriorityChange: (priority: Task['priority']) => void
  }) => (
    <button type="button" onClick={() => onPriorityChange('urgent')}>
      priority urgent
    </button>
  )
}))

vi.mock('@/components/tasks/interactive-project-badge', () => ({
  InteractiveProjectBadge: ({
    onProjectChange
  }: {
    onProjectChange: (projectId: string) => void
  }) => (
    <button type="button" onClick={() => onProjectChange('project-b')}>
      project change
    </button>
  )
}))

vi.mock('@/components/tasks/bulk-actions', () => ({
  SelectionCheckbox: ({
    checked,
    onChange,
    onClick,
    'aria-label': ariaLabel
  }: {
    checked: boolean
    onChange: () => void
    onClick: (event: React.MouseEvent) => void
    'aria-label': string
  }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={checked}
      onClick={(event) => {
        onClick(event)
        onChange()
      }}
    />
  )
}))

vi.mock('@/components/tasks/repeat-indicator', () => ({
  RepeatIndicator: () => <span data-testid="repeat-indicator" />
}))

const project: Project = {
  id: 'project-a',
  name: 'Alpha',
  color: '#336699',
  description: null,
  taskCount: 0,
  completedCount: 0,
  archivedAt: null,
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
  statuses: [
    { id: 'todo', name: 'Todo', type: 'todo', color: '#999999', order: 0 },
    { id: 'done', name: 'Done', type: 'done', color: '#228855', order: 1 }
  ]
} as Project

const task: Task = {
  id: 'task-a',
  title: 'Write launch plan',
  description: null,
  projectId: 'project-a',
  statusId: 'todo',
  priority: 'low',
  dueDate: new Date('2026-05-09T00:00:00.000Z'),
  dueTime: '09:30',
  tags: [],
  completedAt: null,
  archivedAt: null,
  order: 0,
  createdAt: new Date('2026-05-01T00:00:00.000Z'),
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
  isRepeating: true,
  repeatConfig: { frequency: 'daily', interval: 1 }
} as Task

describe('task row and badge major states', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-10T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('handles row click, keyboard, selection modifiers, and inline edits', () => {
    const onClick = vi.fn()
    const onToggleComplete = vi.fn()
    const onUpdateTask = vi.fn()
    const onToggleSelect = vi.fn()
    const onShiftSelect = vi.fn()
    const onProjectChange = vi.fn()

    const { rerender } = render(
      <TaskRow
        task={task}
        project={project}
        projects={[project, { ...project, id: 'project-b', name: 'Beta' }]}
        isCompleted={false}
        showProjectBadge
        onClick={onClick}
        onToggleComplete={onToggleComplete}
        onUpdateTask={onUpdateTask}
        onToggleSelect={onToggleSelect}
        onShiftSelect={onShiftSelect}
        onProjectChange={onProjectChange}
      />
    )

    const row = screen.getByRole('button', { name: /task: write launch plan/i })
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(onClick).toHaveBeenCalledTimes(2)

    fireEvent.click(row, { metaKey: true })
    expect(onToggleSelect).toHaveBeenCalledWith('task-a')

    fireEvent.click(screen.getByText('status toggle'))
    fireEvent.click(screen.getByText('status done'))
    fireEvent.click(screen.getByText('priority urgent'))
    fireEvent.click(screen.getByText('project change'))

    expect(onToggleComplete).toHaveBeenCalledWith('task-a')
    expect(onUpdateTask).toHaveBeenCalledWith('task-a', { statusId: 'done' })
    expect(onUpdateTask).toHaveBeenCalledWith('task-a', { priority: 'urgent' })
    expect(onProjectChange).toHaveBeenCalledWith('project-b')
    expect(screen.getByTestId('repeat-indicator')).toBeInTheDocument()
    expect(screen.getByText(/may 9/i)).toBeInTheDocument()

    rerender(
      <TaskRow
        task={{ ...task, isRepeating: false, repeatConfig: null } as Task}
        project={project}
        projects={[project]}
        isCompleted
        isSelected
        showProjectBadge
        onClick={onClick}
        onToggleComplete={onToggleComplete}
        onToggleSelect={onToggleSelect}
        renderTitle={() => <strong>Custom title</strong>}
      />
    )

    expect(screen.getByText('Custom title')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()

    rerender(
      <TaskRow
        task={task}
        project={project}
        projects={[project]}
        isCompleted={false}
        isSelectionMode
        isCheckedForSelection
        onClick={onClick}
        onToggleComplete={onToggleComplete}
        onToggleSelect={onToggleSelect}
        onShiftSelect={onShiftSelect}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /task: write launch plan/i }), {
      shiftKey: true
    })
    expect(onShiftSelect).toHaveBeenCalledWith('task-a')
    fireEvent.click(screen.getByRole('button', { name: /select write launch plan/i }))
    expect(onToggleSelect).toHaveBeenCalledWith('task-a')
  })

  it('renders badge variants and checkbox interactions', () => {
    const onChange = vi.fn()

    const { rerender, container } = render(<PriorityBadge priority="none" />)
    expect(container).toBeEmptyDOMElement()

    rerender(<PriorityBadge priority="none" fixedWidth />)
    expect(container.querySelector('.w-\\[70px\\]')).toBeInTheDocument()

    rerender(<PriorityBadge priority="urgent" variant="dot" compact showTooltip />)
    expect(screen.getByLabelText('Urgent priority')).toBeInTheDocument()

    rerender(<ProjectBadge project={project} fixedWidth />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()

    rerender(<DueDateBadge dueDate={null} dueTime={null} fixedWidth />)
    expect(screen.getByText('—')).toBeInTheDocument()

    rerender(
      <DueDateBadge dueDate={new Date('2026-05-08T00:00:00.000Z')} dueTime={null} isRepeating />
    )
    expect(screen.getByText('2d late')).toBeInTheDocument()

    rerender(<TaskCheckbox checked={false} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark as complete' }))
    expect(onChange).toHaveBeenCalledTimes(1)

    rerender(<TaskCheckbox checked onChange={onChange} disabled size="sm" />)
    fireEvent.click(screen.getByRole('button', { name: 'Mark as incomplete' }))
    expect(onChange).toHaveBeenCalledTimes(1)

    rerender(<StatusBadge label="Done" color="#228855" type="done" />)
    expect(screen.getByText('Done')).toBeInTheDocument()
  })
})
