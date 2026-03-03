import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import {
  reminderService,
  createNoteReminder,
  createJournalReminder,
  createHighlightReminder,
  onReminderCreated,
  onReminderUpdated,
  onReminderDeleted,
  onReminderDue,
  onReminderDismissed,
  onReminderSnoozed
} from './reminder-service'

describe('reminder-service', () => {
  let api: any

  beforeEach(() => {
    api = createMockApi()
    api.reminders.get = vi.fn().mockResolvedValue(null)
    api.reminders.getUpcoming = vi
      .fn()
      .mockResolvedValue({ reminders: [], total: 0, hasMore: false })
    api.reminders.getDue = vi.fn().mockResolvedValue([])
    api.reminders.getForTarget = vi.fn().mockResolvedValue([])
    api.reminders.countPending = vi.fn().mockResolvedValue(0)
    api.reminders.bulkDismiss = vi.fn().mockResolvedValue({ success: true, dismissedCount: 0 })

    api.onReminderCreated = vi.fn().mockReturnValue(() => {})
    api.onReminderUpdated = vi.fn().mockReturnValue(() => {})
    api.onReminderDeleted = vi.fn().mockReturnValue(() => {})
    api.onReminderDue = vi.fn().mockReturnValue(() => {})
    api.onReminderDismissed = vi.fn().mockReturnValue(() => {})
    api.onReminderSnoozed = vi.fn().mockReturnValue(() => {})
    ;(window as Window & { api: unknown }).api = api
  })

  it('forwards reminder CRUD and query operations', async () => {
    api.reminders.create = vi.fn().mockResolvedValue({ success: true })
    api.reminders.update = vi.fn().mockResolvedValue({ success: true })
    api.reminders.delete = vi.fn().mockResolvedValue({ success: true })
    api.reminders.list = vi.fn().mockResolvedValue({ reminders: [], total: 0, hasMore: false })
    api.reminders.dismiss = vi.fn().mockResolvedValue({ success: true })
    api.reminders.snooze = vi.fn().mockResolvedValue({ success: true })

    await reminderService.create({ targetType: 'note', targetId: 'note-1', remindAt: '2025-01-01' })
    expect(api.reminders.create).toHaveBeenCalledWith({
      targetType: 'note',
      targetId: 'note-1',
      remindAt: '2025-01-01'
    })

    await reminderService.update({ id: 'rem-1', title: 'Update' })
    expect(api.reminders.update).toHaveBeenCalledWith({ id: 'rem-1', title: 'Update' })

    await reminderService.delete('rem-1')
    expect(api.reminders.delete).toHaveBeenCalledWith('rem-1')

    await reminderService.list({ status: 'pending' })
    expect(api.reminders.list).toHaveBeenCalledWith({ status: 'pending' })

    await reminderService.get('rem-2')
    expect(api.reminders.get).toHaveBeenCalledWith('rem-2')

    await reminderService.getUpcoming(3)
    expect(api.reminders.getUpcoming).toHaveBeenCalledWith(3)

    await reminderService.getDue()
    expect(api.reminders.getDue).toHaveBeenCalled()

    await reminderService.getForTarget('note', 'note-1')
    expect(api.reminders.getForTarget).toHaveBeenCalledWith({
      targetType: 'note',
      targetId: 'note-1'
    })

    await reminderService.countPending()
    expect(api.reminders.countPending).toHaveBeenCalled()

    await reminderService.dismiss('rem-3')
    expect(api.reminders.dismiss).toHaveBeenCalledWith('rem-3')

    await reminderService.snooze({ id: 'rem-4', snoozeUntil: '2025-01-02' })
    expect(api.reminders.snooze).toHaveBeenCalledWith({ id: 'rem-4', snoozeUntil: '2025-01-02' })

    await reminderService.bulkDismiss(['rem-5', 'rem-6'])
    expect(api.reminders.bulkDismiss).toHaveBeenCalledWith({ reminderIds: ['rem-5', 'rem-6'] })
  })

  it('builds convenience reminder payloads', async () => {
    api.reminders.create = vi.fn().mockResolvedValue({ success: true })

    await createNoteReminder('note-1', '2025-01-01', { title: 'Check', note: 'Note' })
    expect(api.reminders.create).toHaveBeenCalledWith({
      targetType: 'note',
      targetId: 'note-1',
      remindAt: '2025-01-01',
      title: 'Check',
      note: 'Note'
    })

    await createJournalReminder('2025-01-02', '2025-01-03')
    expect(api.reminders.create).toHaveBeenCalledWith({
      targetType: 'journal',
      targetId: '2025-01-02',
      remindAt: '2025-01-03',
      title: undefined,
      note: undefined
    })

    await createHighlightReminder('note-2', 'Highlight', 1, 5, '2025-01-04')
    expect(api.reminders.create).toHaveBeenCalledWith({
      targetType: 'highlight',
      targetId: 'note-2',
      remindAt: '2025-01-04',
      highlightText: 'Highlight',
      highlightStart: 1,
      highlightEnd: 5,
      title: undefined,
      note: undefined
    })
  })

  it('registers reminder event subscriptions', () => {
    const unsubscribe = vi.fn()
    api.onReminderCreated = vi.fn(() => unsubscribe)
    api.onReminderUpdated = vi.fn(() => unsubscribe)
    api.onReminderDeleted = vi.fn(() => unsubscribe)
    api.onReminderDue = vi.fn(() => unsubscribe)
    api.onReminderDismissed = vi.fn(() => unsubscribe)
    api.onReminderSnoozed = vi.fn(() => unsubscribe)

    expect(onReminderCreated(vi.fn())).toBe(unsubscribe)
    expect(onReminderUpdated(vi.fn())).toBe(unsubscribe)
    expect(onReminderDeleted(vi.fn())).toBe(unsubscribe)
    expect(onReminderDue(vi.fn())).toBe(unsubscribe)
    expect(onReminderDismissed(vi.fn())).toBe(unsubscribe)
    expect(onReminderSnoozed(vi.fn())).toBe(unsubscribe)
  })
})
