import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockTask = {
  id: 't1',
  title: 'Hello',
  description: null,
  projectId: 'p1',
  statusId: null,
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

const openForTaskMock = vi.fn()
vi.mock('@/contexts/day-panel-context', () => ({
  useDayPanel: () => ({ openForTask: openForTaskMock })
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
    openForTaskMock.mockClear()
    openTabMock.mockClear()
  })

  it('renders title and due', () => {
    render(
      <CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />
    )
    expect(screen.getByText('Hello')).toBeInTheDocument()
    expect(screen.getByText(/Tomorrow/)).toBeInTheDocument()
  })

  it('toggle complete on incomplete task calls tasks.complete', async () => {
    render(
      <CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />
    )
    await userEvent.click(screen.getByRole('checkbox'))
    expect(completeMock).toHaveBeenCalledWith({ id: 't1' })
  })

  it('Open task calls openForTask with the task id', async () => {
    render(
      <CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={vi.fn()} />
    )
    await userEvent.click(screen.getByRole('button', { name: /open task/i }))
    expect(openForTaskMock).toHaveBeenCalledWith('t1')
  })

  it('Escape calls onDismiss', async () => {
    const onDismiss = vi.fn()
    render(
      <CalendarTaskPopover item={baseItem} anchorRect={baseAnchor} onDismiss={onDismiss} />
    )
    await userEvent.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalled()
  })
})
