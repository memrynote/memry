import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
  repeatConfig: null as { frequency: string; interval: number; endType: string } | null,
  repeatFrom: null,
  sourceNoteId: null as string | null,
  completedAt: null,
  archivedAt: null,
  createdAt: '2026-04-01T00:00:00Z',
  modifiedAt: '2026-04-01T00:00:00Z',
  tags: [] as string[]
}
let mockSubtasks: Array<{ id: string; title: string; completedAt: string | null }> = []

vi.mock('@/hooks/use-task', () => ({
  useTask: (id: string | null) => ({
    data: id === 't1' ? mockTask : null,
    isLoading: false
  })
}))
vi.mock('@/hooks/use-subtasks', () => ({
  useSubtasks: () => ({ data: mockSubtasks, isLoading: false })
}))
vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ data: { id: 'p1', name: 'memrynote' } })
}))
vi.mock('@/hooks/use-notes-query', () => ({
  useNoteTagsQuery: () => ({ tags: [{ tag: 'focus', color: 'rose' }] })
}))
vi.mock('@/contexts/tasks', () => ({
  useTasksOptional: () => ({
    projects: [
      {
        id: 'p1',
        name: 'memrynote',
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

const openSidebarItemMock = vi.fn()
vi.mock('@/hooks/use-sidebar-navigation', () => ({
  useSidebarNavigation: () => ({ openSidebarItem: openSidebarItemMock })
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
    noteGetMock.mockClear()
    openTabMock.mockClear()
    openSidebarItemMock.mockClear()
    mockTask.sourceNoteId = null
    mockTask.repeatConfig = null
    mockTask.tags = []
    mockSubtasks = []
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

  it('Open task opens the tasks tab filtered to the task project on the All tab', async () => {
    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /open task/i }))
    expect(openTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        viewState: {
          openTaskId: 't1',
          selectedProjectId: 'p1',
          activeInternalTab: 'all',
          activeTab: 'all'
        }
      })
    )
  })

  it('Pick date & time opens the tasks tab filtered to the task project on the All tab', async () => {
    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /reschedule/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /pick date.*time/i }))
    expect(openTabMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tasks',
        viewState: {
          openTaskId: 't1',
          selectedProjectId: 'p1',
          activeInternalTab: 'all',
          activeTab: 'all'
        }
      })
    )
  })

  it('Escape calls onDismiss', async () => {
    const onDismiss = vi.fn()
    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={onDismiss} />)
    await userEvent.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalled()
  })

  it('clicking a tag drills the sidebar and keeps the popover open', async () => {
    mockTask.tags = ['#focus']
    try {
      const onDismiss = vi.fn()
      render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={onDismiss} />)
      await userEvent.click(screen.getByText('focus'))
      expect(openSidebarItemMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'tag', entityId: 'focus', color: 'rose' })
      )
      expect(onDismiss).not.toHaveBeenCalled()
    } finally {
      mockTask.tags = []
    }
  })

  it('toggles subtasks and reschedules or clears due dates', async () => {
    const onDismiss = vi.fn()
    mockSubtasks = [
      { id: 'sub-1', title: 'Draft outline', completedAt: null },
      { id: 'sub-2', title: 'Send review', completedAt: '2026-04-29T12:00:00Z' }
    ]

    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={onDismiss} />)

    await userEvent.click(screen.getByLabelText(/mark done/i))
    expect(completeMock).toHaveBeenCalledWith({ id: 'sub-1' })

    await userEvent.click(screen.getByLabelText(/mark not done/i))
    expect(uncompleteMock).toHaveBeenCalledWith('sub-2')

    await userEvent.click(screen.getByRole('button', { name: /reschedule/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /tomorrow/i }))
    await waitFor(() => expect(onDismiss).toHaveBeenCalled())
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }))

    await userEvent.click(screen.getByRole('button', { name: /reschedule/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /remove due date/i }))
    expect(updateMock).toHaveBeenCalledWith({ id: 't1', dueDate: null, dueTime: null })
  })

  it('logs failed task actions without dismissing the popover', async () => {
    const onDismiss = vi.fn()
    mockSubtasks = [{ id: 'sub-1', title: 'Draft outline', completedAt: null }]
    completeMock.mockRejectedValueOnce(new Error('nope'))
    updateMock.mockRejectedValueOnce(new Error('nope'))

    render(<CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={onDismiss} />)

    await userEvent.click(screen.getByLabelText(/mark done/i))
    await userEvent.click(screen.getByRole('button', { name: /reschedule/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /tomorrow/i }))
    await Promise.resolve()

    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('opens source notes and ignores missing task data', async () => {
    const onDismiss = vi.fn()
    mockTask.sourceNoteId = 'note-1'
    noteGetMock.mockResolvedValueOnce({ id: 'note-1', title: 'Source note', path: '/source.md' })

    const { rerender } = render(
      <CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={onDismiss} />
    )

    await userEvent.click(screen.getByRole('button', { name: /source note/i }))
    await waitFor(() =>
      expect(openTabMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'note',
          title: 'Source note',
          entityId: 'note-1'
        })
      )
    )
    expect(onDismiss).toHaveBeenCalled()

    rerender(
      <CalendarTaskPopover
        item={{ ...baseItem, sourceId: 'missing' }}
        anchorRect={baseAnchor}
        onDismiss={vi.fn()}
      />
    )
    expect(screen.queryByTestId('calendar-task-popover')).not.toBeInTheDocument()
  })

  it('covers repeat summary variants', () => {
    for (const frequency of ['daily', 'weekly', 'monthly', 'yearly'] as const) {
      mockTask.repeatConfig = { frequency, interval: 1, endType: 'never' }
      const { unmount } = render(
        <CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />
      )
      expect(screen.getByTestId('calendar-task-popover')).toBeInTheDocument()
      unmount()
    }
  })
})
