import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TaskContextPopover } from './task-context-popover'
import type { Task as DisplayTask } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'

const mocks = vi.hoisted(() => ({
  tagDefs: [] as { tag: string; color: string }[]
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({ tags: mocks.tagDefs })
}))

// The real one pulls in the clock-format and week-start settings hooks; this
// file is about the popover's own wiring, not the calendar's.
vi.mock('@/components/tasks/date-picker-content', () => ({
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

const project: Project = {
  id: 'project-1',
  name: 'Work',
  description: '',
  icon: '',
  color: '#123456',
  statuses: [],
  isDefault: true,
  isArchived: false,
  createdAt: new Date('2026-01-01'),
  taskCount: 0
}

const otherProject: Project = { ...project, id: 'project-2', name: 'Personal', isDefault: false }

const makeTask = (overrides: Partial<DisplayTask> = {}): DisplayTask => ({
  id: 'task-1',
  title: 'Ship the beta',
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
  createdAt: new Date('2026-01-01'),
  completedAt: null,
  archivedAt: null,
  ...overrides
})

const renderPopover = (task: DisplayTask = makeTask()) => {
  const onUpdate = vi.fn()
  const onProjectChange = vi.fn()
  render(
    <TaskContextPopover
      task={task}
      projects={[project, otherProject]}
      onUpdate={onUpdate}
      onProjectChange={onProjectChange}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'inlineContext.trigger' }))
  return { onUpdate, onProjectChange }
}

describe('TaskContextPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tagDefs = [
      { tag: 'launch', color: '' },
      { tag: 'beta', color: '' }
    ]
  })

  it('summarises what the task already carries on the root menu', () => {
    renderPopover(
      makeTask({ priority: 'high', dueDate: new Date('2026-03-04T00:00:00'), tags: ['launch'] })
    )

    expect(screen.getByText('task.priority')).toBeInTheDocument()
    expect(screen.getByText('launch')).toBeInTheDocument()
    expect(screen.getByText('Work')).toBeInTheDocument()
  })

  it('reads "none" for every field the task has not been given', () => {
    renderPopover()

    // priority, due date and tags — the project always resolves to one.
    expect(screen.getAllByText('inlineContext.none')).toHaveLength(3)
  })

  it('sets a priority and returns to the menu', () => {
    const { onUpdate } = renderPopover()

    fireEvent.click(screen.getByText('task.priority'))
    fireEvent.click(screen.getByText('Urgent'))

    expect(onUpdate).toHaveBeenCalledWith({ priority: 'urgent' })
    // Back on the root menu, ready for the next field.
    expect(screen.getByText('task.tags')).toBeInTheDocument()
  })

  it('sets a due date without touching the time', () => {
    const { onUpdate } = renderPopover(makeTask({ dueTime: '09:00' }))

    fireEvent.click(screen.getByText('inlineContext.dueDate'))
    fireEvent.click(screen.getByText('pick-date'))

    expect(onUpdate).toHaveBeenCalledWith({ dueDate: new Date('2026-03-04T00:00:00') })
  })

  it('drops the time when the date is cleared — a time with no day is unreachable', () => {
    const { onUpdate } = renderPopover(
      makeTask({ dueDate: new Date('2026-03-04T00:00:00'), dueTime: '09:00' })
    )

    fireEvent.click(screen.getByText('inlineContext.dueDate'))
    fireEvent.click(screen.getByText('clear-date'))

    expect(onUpdate).toHaveBeenCalledWith({ dueDate: null, dueTime: null })
  })

  it('switches project through its own callback, not the generic update', () => {
    const { onUpdate, onProjectChange } = renderPopover()

    fireEvent.click(screen.getByText('task.project'))
    fireEvent.click(screen.getByText('Personal'))

    expect(onProjectChange).toHaveBeenCalledWith('project-2')
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('toggles tags case-insensitively and stays open across several', () => {
    const { onUpdate } = renderPopover(makeTask({ tags: ['Launch'] }))

    fireEvent.click(screen.getByText('task.tags'))

    // `Launch` on the task matches the `launch` in the pool, so toggling it
    // removes rather than adding a near-duplicate.
    fireEvent.click(screen.getByText('launch'))
    expect(onUpdate).toHaveBeenLastCalledWith({ tags: [] })

    // Still on the tag panel: a task usually takes more than one.
    fireEvent.click(screen.getByText('beta'))
    expect(onUpdate).toHaveBeenLastCalledWith({ tags: ['Launch', 'beta'] })
  })

  it('offers to create a tag the pool does not have yet', () => {
    const { onUpdate } = renderPopover()

    fireEvent.click(screen.getByText('task.tags'))
    fireEvent.change(screen.getByLabelText('inlineContext.searchTags'), {
      target: { value: 'launch' }
    })
    // An exact match is not offered as a creation.
    expect(screen.queryByText('inlineContext.createTag')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('inlineContext.searchTags'), {
      target: { value: 'shipping' }
    })
    fireEvent.click(screen.getByText('inlineContext.createTag'))

    expect(onUpdate).toHaveBeenCalledWith({ tags: ['shipping'] })
  })
})
