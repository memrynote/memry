import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestQueryClient } from '@tests/utils/render'
import type { CalendarProjectionItem } from '@/services/calendar-service'
import { useCalendarGridActions } from './use-calendar-grid-actions'

const mocks = vi.hoisted(() => ({
  updateTask: vi.fn(),
  updateEvent: vi.fn(),
  createEvent: vi.fn(),
  undoStack: [] as Array<{ description: string; undo: () => void }>
}))

vi.mock('@/services/tasks-service', () => ({
  tasksService: { update: mocks.updateTask }
}))

vi.mock('@/services/calendar-service', () => ({
  calendarService: { updateEvent: mocks.updateEvent, createEvent: mocks.createEvent }
}))

vi.mock('@/hooks/use-undo', () => ({
  useUndoTracker: () => ({
    registerUndo: (description: string, undo: () => void) => {
      mocks.undoStack.push({ description, undo })
      return 'undo-1'
    }
  })
}))

const at = (hours: number, minutes = 0): string =>
  new Date(2026, 8, 21, hours, minutes).toISOString()

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
}

describe('useCalendarGridActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.undoStack.length = 0
    mocks.updateTask.mockResolvedValue({ success: true })
    mocks.updateEvent.mockResolvedValue({ success: true })
    mocks.createEvent.mockResolvedValue({ success: true })
  })

  it('writes a resized task block to the task and undoes back to no length', async () => {
    const { result } = renderHook(() => useCalendarGridActions(), { wrapper })
    const block = {
      sourceType: 'task',
      sourceId: 'task-1',
      startAt: at(9),
      endAt: null
    } as CalendarProjectionItem

    await act(() => result.current.moveItem(block, at(9), at(10, 30)))

    expect(mocks.updateTask).toHaveBeenLastCalledWith({
      id: 'task-1',
      dueDate: '2026-09-21',
      dueTime: '09:00',
      durationMinutes: 90
    })

    await act(async () => mocks.undoStack[0].undo())

    expect(mocks.updateTask).toHaveBeenLastCalledWith({
      id: 'task-1',
      dueDate: '2026-09-21',
      dueTime: '09:00',
      durationMinutes: null
    })
  })

  it('moves an event and undoes back to its old times', async () => {
    const { result } = renderHook(() => useCalendarGridActions(), { wrapper })
    const event = {
      sourceType: 'event',
      sourceId: 'event-1',
      startAt: at(14),
      endAt: at(15)
    } as CalendarProjectionItem

    await act(() => result.current.moveItem(event, at(16), at(17)))
    expect(mocks.updateEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'event-1', startAt: at(16), endAt: at(17), isAllDay: false })
    )

    await act(async () => mocks.undoStack[0].undo())
    expect(mocks.updateEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'event-1', startAt: at(14), endAt: at(15) })
    )
  })

  it('registers no undo when the task write fails', async () => {
    mocks.updateTask.mockResolvedValue({ success: false, error: 'locked' })
    const { result } = renderHook(() => useCalendarGridActions(), { wrapper })
    const block = {
      sourceType: 'task',
      sourceId: 'task-1',
      startAt: at(9),
      endAt: null
    } as CalendarProjectionItem

    await act(() => result.current.moveItem(block, at(11), at(12)))

    expect(mocks.undoStack).toEqual([])
  })

  it('creates a quick-created event with trimmed text and local times', async () => {
    const { result } = renderHook(() => useCalendarGridActions(), { wrapper })

    await act(() =>
      result.current.quickCreate({
        title: '  Standup  ',
        description: '',
        isAllDay: false,
        startAt: '2026-09-21T09:00',
        endAt: '2026-09-21T09:15',
        targetCalendarId: null,
        projectId: null
      })
    )

    expect(mocks.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Standup',
        description: null,
        startAt: at(9),
        endAt: at(9, 15),
        isAllDay: false,
        targetCalendarId: null
      })
    )
  })

  it('surfaces a failed quick create to the dialog', async () => {
    mocks.createEvent.mockResolvedValue({ success: false, error: 'Calendar is read-only' })
    const { result } = renderHook(() => useCalendarGridActions(), { wrapper })

    await expect(
      result.current.quickCreate({
        title: 'Standup',
        description: '',
        isAllDay: false,
        startAt: '2026-09-21T09:00',
        endAt: '',
        targetCalendarId: null,
        projectId: null
      })
    ).rejects.toThrow('Calendar is read-only')
  })
})
