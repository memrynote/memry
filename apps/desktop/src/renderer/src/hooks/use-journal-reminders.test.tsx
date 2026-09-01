import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useJournalReminders } from './use-journal-reminders'

const mocks = vi.hoisted(() => ({
  reminders: [] as Array<{ id: string; status: string; remindAt: string }>,
  isLoading: false,
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  dismiss: vi.fn(),
  snooze: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  logError: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('sonner', () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: mocks.logError })
}))

vi.mock('./use-reminders', () => ({
  useRemindersForTarget: vi.fn((_targetType: string, _targetId: string) => ({
    reminders: mocks.reminders,
    isLoading: mocks.isLoading,
    hasReminders: mocks.reminders.length > 0
  })),
  useCreateReminder: () => ({ mutateAsync: mocks.create }),
  useUpdateReminder: () => ({ mutateAsync: mocks.update }),
  useDeleteReminder: () => ({ mutateAsync: mocks.delete }),
  useDismissReminder: () => ({ mutateAsync: mocks.dismiss }),
  useSnoozeReminder: () => ({ mutateAsync: mocks.snooze })
}))

describe('useJournalReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isLoading = false
    mocks.reminders = [
      { id: 'done', status: 'dismissed', remindAt: '2026-05-12T09:00:00.000Z' },
      { id: 'later', status: 'snoozed', remindAt: '2026-05-11T09:00:00.000Z' },
      { id: 'next', status: 'pending', remindAt: '2026-05-10T10:00:00.000Z' }
    ]
    mocks.create.mockResolvedValue({ success: true })
    mocks.update.mockResolvedValue({ success: true })
    mocks.delete.mockResolvedValue({ success: true })
    mocks.dismiss.mockResolvedValue({ success: true })
    mocks.snooze.mockResolvedValue({ success: true })
  })

  it('derives active reminder state and the next reminder', () => {
    const { result } = renderHook(() => useJournalReminders('2026-05-10'))

    expect(result.current.hasActiveReminder).toBe(true)
    expect(result.current.activeReminderCount).toBe(2)
    expect(result.current.nextReminder?.id).toBe('next')
    expect(result.current.isLoading).toBe(false)
  })

  it('deletes, dismisses, and snoozes journal reminders', async () => {
    const { result } = renderHook(() => useJournalReminders('2026-05-10'))

    await act(async () => {
      await expect(
        result.current.actions.setReminder(new Date('2026-05-10T12:00:00.000Z'), 'Read')
      ).resolves.toBe(true)
      await expect(result.current.actions.deleteReminder('next')).resolves.toBe(true)
      await expect(result.current.actions.dismissReminder('next')).resolves.toBe(true)
      await expect(
        result.current.actions.snoozeReminder('next', new Date('2026-05-11T12:00:00.000Z'))
      ).resolves.toBe(true)
    })

    expect(mocks.delete).toHaveBeenCalledWith('next')
    expect(mocks.dismiss).toHaveBeenCalledWith('next')
    expect(mocks.snooze).toHaveBeenCalledWith({
      id: 'next',
      snoozeUntil: '2026-05-11T12:00:00.000Z'
    })
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(4)
  })

  it('returns false and reports mutation failures', async () => {
    mocks.update.mockResolvedValueOnce({ success: false, error: 'Nope' })
    mocks.delete.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useJournalReminders('2026-05-10'))

    await act(async () => {
      await expect(
        result.current.actions.setReminder(new Date('2026-05-10T12:00:00.000Z'))
      ).resolves.toBe(false)
      await expect(result.current.actions.deleteReminder('next')).resolves.toBe(false)
    })

    expect(mocks.toastError).toHaveBeenCalledWith('Nope')
    expect(mocks.toastError).toHaveBeenCalledWith('reminder.error.delete')
    expect(mocks.logError).toHaveBeenCalledWith('Failed to delete reminder:', expect.any(Error))
  })

  it('moves the active reminder instead of adding a second one', async () => {
    const { result } = renderHook(() => useJournalReminders('2026-05-10'))

    await act(async () => {
      await expect(
        result.current.actions.setReminder(new Date('2026-05-10T18:30:00.000Z'), 'Read')
      ).resolves.toBe(true)
    })

    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update).toHaveBeenCalledWith({
      id: 'next',
      remindAt: '2026-05-10T18:30:00.000Z',
      note: 'Read'
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('reminder.success.updated')
  })

  it('clears the note the replaced reminder carried when the picker sends none', async () => {
    const { result } = renderHook(() => useJournalReminders('2026-05-10'))

    await act(async () => {
      await result.current.actions.setReminder(new Date('2026-05-10T18:30:00.000Z'))
    })

    expect(mocks.update).toHaveBeenCalledWith({
      id: 'next',
      remindAt: '2026-05-10T18:30:00.000Z',
      note: null
    })
  })

  it('creates the first reminder when the entry has no active one', async () => {
    mocks.reminders = [{ id: 'done', status: 'dismissed', remindAt: '2026-05-12T09:00:00.000Z' }]
    const { result } = renderHook(() => useJournalReminders('2026-05-10'))

    await act(async () => {
      await expect(
        result.current.actions.setReminder(new Date('2026-05-10T18:30:00.000Z'), 'Read')
      ).resolves.toBe(true)
    })

    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledWith({
      targetType: 'journal',
      targetId: '2026-05-10',
      remindAt: '2026-05-10T18:30:00.000Z',
      note: 'Read'
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('reminder.success.set')
  })

  it('exposes the active reminders the picker manages and edits one by id', async () => {
    const { result } = renderHook(() => useJournalReminders('2026-05-10'))

    expect(result.current.activeReminders.map((reminder) => reminder.id)).toEqual(['next', 'later'])

    await act(async () => {
      await expect(
        result.current.actions.editReminder('later', new Date('2026-05-11T18:30:00.000Z'), 'moved')
      ).resolves.toBe(true)
    })

    expect(mocks.update).toHaveBeenCalledWith({
      id: 'later',
      remindAt: '2026-05-11T18:30:00.000Z',
      note: 'moved'
    })
  })

  it('reports a failed replace against the update wording', async () => {
    mocks.update.mockResolvedValueOnce({ success: false })
    const { result } = renderHook(() => useJournalReminders('2026-05-10'))

    await act(async () => {
      await expect(
        result.current.actions.setReminder(new Date('2026-05-10T18:30:00.000Z'))
      ).resolves.toBe(false)
    })

    expect(mocks.toastError).toHaveBeenCalledWith('reminder.error.update')
  })

  it('drops the active indicator once the last reminder is gone', () => {
    mocks.reminders = [{ id: 'next', status: 'pending', remindAt: '2026-05-10T10:00:00.000Z' }]
    const { result, rerender } = renderHook(() => useJournalReminders('2026-05-10'))

    expect(result.current.hasActiveReminder).toBe(true)
    expect(result.current.activeReminderCount).toBe(1)

    mocks.reminders = []
    rerender()

    expect(result.current.hasActiveReminder).toBe(false)
    expect(result.current.activeReminderCount).toBe(0)
    expect(result.current.activeReminders).toEqual([])
    expect(result.current.nextReminder).toBeNull()
  })

  it('does not create a reminder without a journal date', async () => {
    const { result } = renderHook(() => useJournalReminders(null))

    await act(async () => {
      await expect(result.current.actions.setReminder(new Date())).resolves.toBe(false)
    })

    expect(mocks.create).not.toHaveBeenCalled()
  })
})
