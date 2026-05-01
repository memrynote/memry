import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockTask = {
  id: 't1',
  title: 'Hello',
  description: null,
  projectId: 'p1',
  statusId: 'p-todo',
  parentId: null,
  priority: 0 as const,
  position: 0,
  dueDate: '2026-04-30',
  dueTime: '14:00',
  startDate: null,
  repeatConfig: null,
  repeatFrom: null,
  sourceNoteId: null,
  completedAt: null,
  archivedAt: null,
  createdAt: '2026-04-01T00:00:00Z',
  modifiedAt: '2026-04-01T00:00:00Z',
  tags: [] as string[]
}

vi.mock('@/hooks/use-task', () => ({
  useTask: (id: string | null) => ({
    data: id === 't1' ? mockTask : null,
    isLoading: false
  })
}))
vi.mock('@/hooks/use-subtasks', () => ({
  useSubtasks: () => ({ data: [], isLoading: false })
}))
vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ data: { id: 'p1', name: 'Memry' } })
}))
vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({ tags: [{ tag: 'focus', color: 'rose' }] })
}))
vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => ({
    projects: [
      {
        id: 'p1',
        name: 'Memry',
        statuses: [
          { id: 'p-todo', name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
          {
            id: 'p-progress',
            name: 'In Progress',
            color: '#3b82f6',
            type: 'in_progress',
            order: 1
          },
          { id: 'p-done', name: 'Done', color: '#10b981', type: 'done', order: 2 }
        ]
      }
    ]
  })
}))

const openTabMock = vi.fn()
vi.mock('@/contexts/tabs', () => ({
  useTabs: () => ({ openTab: openTabMock })
}))

import { CalendarTaskPopover } from './calendar-task-popover'

const completeMock = vi.fn().mockResolvedValue({ id: 't1' })
const uncompleteMock = vi.fn().mockResolvedValue({ id: 't1' })
const updateMock = vi.fn().mockResolvedValue({ id: 't1' })
const noteGetMock = vi.fn().mockResolvedValue(null)

const baseItem = {
  projectionId: 'p:t1',
  sourceId: 't1',
  sourceType: 'task' as const,
  title: 'Hello',
  descriptionPreview: null,
  startAt: '2026-04-30T14:00:00',
  endAt: null,
  isAllDay: false,
  timezone: 'UTC',
  visualType: 'task' as const,
  editability: 'full' as const,
  source: {
    provider: null,
    calendarSourceId: null,
    title: null,
    color: null,
    kind: null,
    isMemryManaged: true
  },
  binding: null,
  snoozeOffsetMinutes: null
}
const baseAnchor = { x: 100, y: 100, width: 80, height: 22 }

describe('CalendarTaskPopover', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-04-29T10:00:00'))
    Object.defineProperty(window, 'api', {
      value: {
        tasks: {
          complete: completeMock,
          uncomplete: uncompleteMock,
          update: updateMock
        },
        notes: { get: noteGetMock }
      },
      writable: true
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    completeMock.mockClear()
    uncompleteMock.mockClear()
    updateMock.mockClear()
    openTabMock.mockClear()
  })

  it('renders title and due', () => {
    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />)
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.getByText(/Tomorrow/)).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /status: to do/i })).toBeInTheDocument()
    expect(screen.queryByText('To Do')).not.toBeInTheDocument()
  })

  it('does not render a completion checkbox for the task', () => {
    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('keeps the status icon read-only', async () => {
    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />)
    await userEvent.click(screen.getByRole('img', { name: /status: to do/i }))
    expect(screen.queryByRole('option', { name: /in progress/i })).not.toBeInTheDocument()
    expect(updateMock).not.toHaveBeenCalled()
    expect(completeMock).not.toHaveBeenCalled()
  })

  it('Open task opens the tasks tab focused on the task id', async () => {
    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /open task/i }))
    expect(openTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        viewState: { openTaskId: 't1' }
      })
    )
  })

  it('Escape calls onDismiss', async () => {
    const onDismiss = vi.fn()
    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={onDismiss} />)
    await userEvent.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalled()
  })
})
