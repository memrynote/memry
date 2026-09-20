import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TaskMetaStrip } from './task-meta-strip'
import type { Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'

const mocks = vi.hoisted(() => ({
  tagDefs: [] as { tag: string; color: string }[],
  hasActiveReminder: false
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({ tags: mocks.tagDefs })
}))

vi.mock('@/hooks/use-task-reminders', () => ({
  useTaskReminders: () => ({
    activeReminders: [],
    hasActiveReminder: mocks.hasActiveReminder,
    nextReminder: null,
    activeReminderCount: 0,
    actions: { setReminder: vi.fn(), editReminder: vi.fn(), deleteReminder: vi.fn() }
  })
}))

// Both bring their own settings/query chains; this file is about which chip is
// on screen and what it writes, not about their internals.
vi.mock('./date-picker-content', () => ({
  DatePickerContent: ({ onSelect }: { onSelect: (date: Date | null) => void }) => (
    <>
      <button type="button" onClick={() => onSelect(new Date('2026-03-04T00:00:00'))}>
        pick-date
      </button>
      <button type="button" onClick={() => onSelect(null)}>
        clear-date
      </button>
    </>
  )
}))

vi.mock('./task-reminder-button', () => ({
  TaskReminderButton: () => <div data-testid="reminder-chip" />
}))

vi.mock('./interactive-project-badge', () => ({
  InteractiveProjectBadge: ({ onProjectChange }: { onProjectChange: (id: string) => void }) => (
    <button type="button" onClick={() => onProjectChange('project-2')}>
      project-badge
    </button>
  )
}))

const project: Project = {
  id: 'project-1',
  name: 'Inbox',
  description: '',
  icon: '',
  color: '#123456',
  statuses: [],
  isDefault: true,
  isArchived: false,
  createdAt: new Date('2026-01-01'),
  taskCount: 0
}

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  title: 'Ship the beta',
  description: '',
  projectId: 'project-1',
  statusId: 'todo',
  priority: 'none',
  startDate: null,
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  tags: [],
  parentId: null,
  subtaskIds: [],
  createdAt: new Date('2026-01-01'),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

const renderStrip = (task: Task = makeTask()) => {
  const onUpdate = vi.fn()
  const onProjectChange = vi.fn()
  render(
    <TaskMetaStrip
      task={task}
      project={project}
      projects={[project]}
      isCompleted={false}
      onUpdate={onUpdate}
      onProjectChange={onProjectChange}
    />
  )
  return { onUpdate, onProjectChange }
}

const openAddMenu = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'inlineContext.trigger' }))
}

describe('TaskMetaStrip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tagDefs = [
      { tag: 'launch', color: '' },
      { tag: 'beta', color: '' }
    ]
    mocks.hasActiveReminder = false
  })

  it('shows no chips for a bare task, and offers all five in the add menu', () => {
    renderStrip()

    expect(screen.queryByRole('button', { name: 'inlineContext.dueDate' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'task.tags' })).not.toBeInTheDocument()

    openAddMenu()
    for (const label of [
      'inlineContext.dueDate',
      'task.startDate',
      'task.reminder',
      'task.repeat',
      'task.tags'
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument()
    }
  })

  it('drops a property from the menu once it has a value', () => {
    renderStrip(makeTask({ dueDate: new Date('2026-03-04T00:00:00'), tags: ['launch'] }))

    openAddMenu()

    expect(screen.queryByText('inlineContext.dueDate')).not.toBeInTheDocument()
    expect(screen.queryByText('task.tags')).not.toBeInTheDocument()
    expect(screen.getByText('task.startDate')).toBeInTheDocument()
    expect(screen.getByText('task.repeat')).toBeInTheDocument()
  })

  it('hides the add affordance entirely once nothing is missing', () => {
    mocks.hasActiveReminder = true
    renderStrip(
      makeTask({
        dueDate: new Date('2026-03-04T00:00:00'),
        startDate: new Date('2026-03-01T00:00:00'),
        tags: ['launch'],
        isRepeating: true,
        repeatConfig: {
          frequency: 'weekly',
          interval: 1,
          endType: 'never',
          completedCount: 0,
          createdAt: new Date('2026-01-01')
        }
      })
    )

    expect(screen.queryByRole('button', { name: 'inlineContext.trigger' })).not.toBeInTheDocument()
  })

  it('mounts a chip and opens its picker straight from the menu', () => {
    const { onUpdate } = renderStrip()

    openAddMenu()
    fireEvent.click(screen.getByText('inlineContext.dueDate'))

    // No second click: the calendar is already on screen.
    fireEvent.click(screen.getByText('pick-date'))
    expect(onUpdate).toHaveBeenCalledWith({ dueDate: new Date('2026-03-04T00:00:00') })
  })

  it('writes to startDate when the menu asked for a start date', () => {
    const { onUpdate } = renderStrip()

    openAddMenu()
    fireEvent.click(screen.getByText('task.startDate'))
    fireEvent.click(screen.getByText('pick-date'))

    expect(onUpdate).toHaveBeenCalledWith({ startDate: new Date('2026-03-04T00:00:00') })
  })

  it('reads the pair as one range and clears the time with the date', () => {
    const { onUpdate } = renderStrip(
      makeTask({
        startDate: new Date('2026-03-01T00:00:00'),
        dueDate: new Date('2026-03-04T00:00:00'),
        dueTime: '09:00'
      })
    )

    const chip = screen.getByRole('button', { name: 'inlineContext.dueDate' })
    expect(chip).toHaveTextContent('→')

    fireEvent.click(chip)
    fireEvent.click(screen.getByText('clear-date'))
    expect(onUpdate).toHaveBeenCalledWith({ dueDate: null, dueTime: null })
  })

  it('toggles tags case-insensitively from the tag group', () => {
    const { onUpdate } = renderStrip(makeTask({ tags: ['Launch'] }))

    fireEvent.click(screen.getByRole('button', { name: 'task.tags' }))

    fireEvent.click(screen.getByText('launch'))
    expect(onUpdate).toHaveBeenLastCalledWith({ tags: [] })

    fireEvent.click(screen.getByText('beta'))
    expect(onUpdate).toHaveBeenLastCalledWith({ tags: ['Launch', 'beta'] })
  })

  it('collapses more than two tags rather than growing the row', () => {
    renderStrip(makeTask({ tags: ['launch', 'beta', 'urgent', 'ops'] }))

    const group = screen.getByRole('button', { name: 'task.tags' })
    expect(group).toHaveTextContent('launch')
    expect(group).toHaveTextContent('beta')
    expect(group).not.toHaveTextContent('urgent')
    expect(group).toHaveTextContent('+2')
  })

  it('routes a project change through its own callback', () => {
    const { onUpdate, onProjectChange } = renderStrip()

    fireEvent.click(screen.getByText('project-badge'))

    expect(onProjectChange).toHaveBeenCalledWith('project-2')
    expect(onUpdate).not.toHaveBeenCalled()
  })
})
