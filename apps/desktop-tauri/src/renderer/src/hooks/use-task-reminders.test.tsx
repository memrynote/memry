import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTaskReminders } from './use-task-reminders'

const mocks = vi.hoisted(() => ({
  taskReminders: [] as any[],
  taskLoading: false,
  createReminder: vi.fn(),
  updateReminder: vi.fn(),
  deleteReminder: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  logError: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.logError })
}))

vi.mock('./use-reminders', () => ({
  useRemindersForTarget: () => ({ reminders: mocks.taskReminders, isLoading: mocks.taskLoading }),
  useCreateReminder: () => ({ mutateAsync: mocks.createReminder }),
  useUpdateReminder: () => ({ mutateAsync: mocks.updateReminder }),
  useDeleteReminder: () => ({ mutateAsync: mocks.deleteReminder })
}))

describe('useTaskReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.taskReminders = [
      { id: 'later', remindAt: '2026-05-12T00:00:00.000Z', status: 'pending' },
      { id: 'done', remindAt: '2026-05-10T00:00:00.000Z', status: 'dismissed' },
      { id: 'soon', remindAt: '2026-05-11T00:00:00.000Z', status: 'snoozed' }
    ]
    mocks.taskLoading = false
    mocks.createReminder.mockResolvedValue({ success: true })
    mocks.updateReminder.mockResolvedValue({ success: true })
    mocks.deleteReminder.mockResolvedValue({ success: true })
  })

  it('sorts reminders, surfaces active state, and creates task reminders', async () => {
    const { result } = renderHook(() => useTaskReminders('task-1'))

    expect(result.current.reminders.map((r) => r.id)).toEqual(['done', 'soon', 'later'])
    expect(result.current.activeReminders.map((r) => r.id)).toEqual(['soon', 'later'])
    expect(result.current.hasActiveReminder).toBe(true)
    expect(result.current.activeReminderCount).toBe(2)
    expect(result.current.nextReminder?.id).toBe('soon')

    await act(async () => {
      expect(await result.current.actions.setReminder(new Date('2026-05-13T00:00:00Z'))).toBe(true)
      expect(await result.current.actions.deleteReminder('later')).toBe(true)
    })

    expect(mocks.createReminder).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'task', targetId: 'task-1' })
    )
    expect(mocks.deleteReminder).toHaveBeenCalledWith('later')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('reminders.toast.set')
  })

  it('edits a reminder with an ISO date and note and toasts success', async () => {
    const { result } = renderHook(() => useTaskReminders('task-1'))

    await act(async () => {
      expect(
        await result.current.actions.editReminder(
          'soon',
          new Date('2026-05-14T08:30:00.000Z'),
          'updated note'
        )
      ).toBe(true)
    })

    expect(mocks.updateReminder).toHaveBeenCalledWith({
      id: 'soon',
      remindAt: '2026-05-14T08:30:00.000Z',
      note: 'updated note'
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('reminders.toast.updated')
  })

  it('surfaces edit failures', async () => {
    const { result } = renderHook(() => useTaskReminders('task-1'))
    mocks.updateReminder.mockResolvedValueOnce({ success: false, error: 'boom' })

    await act(async () => {
      expect(
        await result.current.actions.editReminder('soon', new Date('2026-05-14T08:30:00.000Z'))
      ).toBe(false)
    })

    expect(mocks.toastError).toHaveBeenCalledWith('boom')
  })

  it('returns false for a missing task id and surfaces failures', async () => {
    const { result, rerender } = renderHook(({ taskId }) => useTaskReminders(taskId), {
      initialProps: { taskId: null as string | null }
    })

    await act(async () => {
      expect(await result.current.actions.setReminder(new Date())).toBe(false)
    })
    expect(mocks.createReminder).not.toHaveBeenCalled()

    rerender({ taskId: 'task-1' })
    mocks.createReminder.mockResolvedValueOnce({ success: false, error: 'nope' })

    await act(async () => {
      expect(await result.current.actions.setReminder(new Date())).toBe(false)
    })
    expect(mocks.toastError).toHaveBeenCalledWith('nope')
  })
})
