import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useNoteReminders } from './use-note-reminders'

const mocks = vi.hoisted(() => ({
  noteReminders: [] as any[],
  highlightReminders: [] as any[],
  noteLoading: false,
  highlightLoading: false,
  createReminder: vi.fn(),
  updateReminder: vi.fn(),
  deleteReminder: vi.fn(),
  dismissReminder: vi.fn(),
  snoozeReminder: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  logError: vi.fn()
}))

vi.mock('@memry/i18n/renderer', () => ({
  useT: () => ({ t: (key: string) => key })
}))

vi.mock('react-i18next', () => ({
  getI18n: () => ({ getFixedT: () => (key: string) => key })
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
  useRemindersForTarget: (targetType: 'note' | 'highlight') => ({
    reminders: targetType === 'note' ? mocks.noteReminders : mocks.highlightReminders,
    isLoading: targetType === 'note' ? mocks.noteLoading : mocks.highlightLoading
  }),
  useCreateReminder: () => ({ mutateAsync: mocks.createReminder }),
  useUpdateReminder: () => ({ mutateAsync: mocks.updateReminder }),
  useDeleteReminder: () => ({ mutateAsync: mocks.deleteReminder }),
  useDismissReminder: () => ({ mutateAsync: mocks.dismissReminder }),
  useSnoozeReminder: () => ({ mutateAsync: mocks.snoozeReminder })
}))

describe('useNoteReminders', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.noteReminders = [
      { id: 'later', remindAt: '2026-05-12T00:00:00.000Z', status: 'pending' },
      { id: 'done', remindAt: '2026-05-10T00:00:00.000Z', status: 'dismissed' }
    ]
    mocks.highlightReminders = [
      { id: 'soon', remindAt: '2026-05-11T00:00:00.000Z', status: 'snoozed' }
    ]
    mocks.noteLoading = false
    mocks.highlightLoading = false
    mocks.createReminder.mockResolvedValue({ success: true })
    mocks.updateReminder.mockResolvedValue({ success: true })
    mocks.deleteReminder.mockResolvedValue({ success: true })
    mocks.dismissReminder.mockResolvedValue({ success: true })
    mocks.snoozeReminder.mockResolvedValue({ success: true })
  })

  it('combines note and existing highlight reminders, sorts them, and exposes successful actions', async () => {
    const { result } = renderHook(() => useNoteReminders('note-1'))

    expect(result.current.reminders.map((reminder) => reminder.id)).toEqual([
      'done',
      'soon',
      'later'
    ])
    expect(result.current.hasActiveReminder).toBe(true)
    expect(result.current.activeReminderCount).toBe(2)
    expect(result.current.nextReminder?.id).toBe('soon')

    await act(async () => {
      expect(
        await result.current.actions.setReminder(new Date('2026-05-13T00:00:00Z'), 'note')
      ).toBe(true)
      expect(await result.current.actions.deleteReminder('later')).toBe(true)
      expect(await result.current.actions.dismissReminder('soon')).toBe(true)
      expect(
        await result.current.actions.snoozeReminder('soon', new Date('2026-05-15T00:00:00Z'))
      ).toBe(true)
    })

    expect(mocks.deleteReminder).toHaveBeenCalledWith('later')
    expect(mocks.dismissReminder).toHaveBeenCalledWith('soon')
    expect(mocks.snoozeReminder).toHaveBeenCalledWith({
      id: 'soon',
      snoozeUntil: '2026-05-15T00:00:00.000Z'
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('phaseI.toasts.reminderSnoozed')
  })

  it("moves the note's own reminder instead of adding a second one", async () => {
    const { result } = renderHook(() => useNoteReminders('note-1'))

    await act(async () => {
      expect(
        await result.current.actions.setReminder(new Date('2026-05-13T00:00:00Z'), 'note')
      ).toBe(true)
    })

    expect(mocks.createReminder).not.toHaveBeenCalled()
    expect(mocks.updateReminder).toHaveBeenCalledTimes(1)
    expect(mocks.updateReminder).toHaveBeenCalledWith({
      id: 'later',
      remindAt: '2026-05-13T00:00:00.000Z',
      note: 'note'
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('reminders.toast.updated')
  })

  it('never moves a highlight reminder, even when it is the next one due', async () => {
    mocks.noteReminders = []
    const { result } = renderHook(() => useNoteReminders('note-1'))

    expect(result.current.nextReminder?.id).toBe('soon')

    await act(async () => {
      await result.current.actions.setReminder(new Date('2026-05-13T00:00:00Z'))
    })

    expect(mocks.updateReminder).not.toHaveBeenCalled()
    expect(mocks.createReminder).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'note', targetId: 'note-1' })
    )
    expect(mocks.toastSuccess).toHaveBeenCalledWith('reminders.toast.set')
  })

  it('lists every active reminder for the picker and edits one by id', async () => {
    const { result } = renderHook(() => useNoteReminders('note-1'))

    expect(result.current.activeReminders.map((reminder) => reminder.id)).toEqual(['soon', 'later'])

    await act(async () => {
      expect(
        await result.current.actions.editReminder('soon', new Date('2026-05-15T00:00:00Z'), 'moved')
      ).toBe(true)
    })

    expect(mocks.updateReminder).toHaveBeenCalledWith({
      id: 'soon',
      remindAt: '2026-05-15T00:00:00.000Z',
      note: 'moved'
    })
  })

  it('drops the active indicator once the last reminder is gone', () => {
    mocks.highlightReminders = []
    const { result, rerender } = renderHook(() => useNoteReminders('note-1'))

    expect(result.current.hasActiveReminder).toBe(true)

    mocks.noteReminders = []
    rerender()

    expect(result.current.hasActiveReminder).toBe(false)
    expect(result.current.activeReminderCount).toBe(0)
    expect(result.current.activeReminders).toEqual([])
    expect(result.current.nextReminder).toBeNull()
  })

  it('reports a failed replace against the update wording', async () => {
    mocks.updateReminder.mockResolvedValueOnce({ success: false })
    const { result } = renderHook(() => useNoteReminders('note-1'))

    await act(async () => {
      expect(await result.current.actions.setReminder(new Date('2026-05-13T00:00:00Z'))).toBe(false)
    })

    expect(mocks.toastError).toHaveBeenCalledWith('reminders.toast.updateFailed')
  })

  it('returns false for missing note ids, mutation failures, thrown errors, and loading states', async () => {
    mocks.noteLoading = true
    const { result, rerender } = renderHook(({ noteId }) => useNoteReminders(noteId), {
      initialProps: { noteId: null as string | null }
    })
    expect(result.current.isLoading).toBe(true)

    await act(async () => {
      expect(await result.current.actions.setReminder(new Date())).toBe(false)
    })
    expect(mocks.createReminder).not.toHaveBeenCalled()

    rerender({ noteId: 'note-1' })
    mocks.updateReminder.mockResolvedValueOnce({ success: false, error: 'nope' })
    mocks.deleteReminder.mockResolvedValueOnce({ success: false, error: 'delete nope' })
    mocks.dismissReminder.mockRejectedValueOnce(new Error('dismiss boom'))
    mocks.snoozeReminder.mockResolvedValueOnce({ success: false, error: 'snooze nope' })

    await act(async () => {
      expect(await result.current.actions.setReminder(new Date())).toBe(false)
      expect(await result.current.actions.deleteReminder('later')).toBe(false)
      expect(await result.current.actions.dismissReminder('soon')).toBe(false)
      expect(await result.current.actions.snoozeReminder('soon', new Date())).toBe(false)
    })

    expect(mocks.toastError).toHaveBeenCalledWith('nope')
    expect(mocks.toastError).toHaveBeenCalledWith('delete nope')
    expect(mocks.toastError).toHaveBeenCalledWith('reminders.toast.dismissFailed')
    expect(mocks.toastError).toHaveBeenCalledWith('snooze nope')
    expect(mocks.logError).toHaveBeenCalledWith('Failed to dismiss reminder:', expect.any(Error))
  })
})
