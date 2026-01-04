/**
 * Reminder IPC handlers tests
 *
 * @module ipc/reminder-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { ReminderChannels } from '@shared/ipc-channels'
import { reminderStatus, type Reminder, type ReminderWithTarget } from '@shared/contracts/reminders-api'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  }
}))

vi.mock('../database', () => ({
  getDatabase: vi.fn(),
  getIndexDatabase: vi.fn()
}))

vi.mock('../lib/reminders', () => ({
  createReminder: vi.fn(),
  updateReminder: vi.fn(),
  deleteReminder: vi.fn(),
  getReminder: vi.fn(),
  listReminders: vi.fn(),
  getUpcomingReminders: vi.fn(),
  getDueReminders: vi.fn(),
  getRemindersForTarget: vi.fn(),
  countPendingReminders: vi.fn(),
  dismissReminder: vi.fn(),
  snoozeReminder: vi.fn(),
  bulkDismissReminders: vi.fn()
}))

vi.mock('@shared/db/queries/notes', () => ({
  getNoteCacheById: vi.fn()
}))

import { registerReminderHandlers, unregisterReminderHandlers } from './reminder-handlers'
import { getDatabase, getIndexDatabase } from '../database'
import * as remindersService from '../lib/reminders'
import * as notesQueries from '@shared/db/queries/notes'

describe('reminder-handlers', () => {
  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0

    ;(getDatabase as Mock).mockReturnValue({})
    ;(getIndexDatabase as Mock).mockReturnValue({})
  })

  afterEach(() => {
    unregisterReminderHandlers()
  })

  it('registers all reminder handlers', () => {
    registerReminderHandlers()
    expect(handleCalls.length).toBe(Object.values(ReminderChannels.invoke).length)
  })

  it('creates a reminder', async () => {
    registerReminderHandlers()

    const reminder: Reminder = {
      id: 'rem-1',
      targetType: 'note',
      targetId: 'note-1',
      remindAt: new Date(Date.now() + 60_000).toISOString(),
      highlightText: null,
      highlightStart: null,
      highlightEnd: null,
      title: 'Check in',
      note: 'Follow up',
      status: reminderStatus.PENDING,
      triggeredAt: null,
      dismissedAt: null,
      snoozedUntil: null,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString()
    }

    ;(remindersService.createReminder as Mock).mockReturnValue(reminder)

    const result = await invokeHandler(ReminderChannels.invoke.CREATE, {
      targetType: 'note',
      targetId: 'note-1',
      remindAt: reminder.remindAt,
      title: 'Check in',
      note: 'Follow up'
    })

    expect(result).toEqual({ success: true, reminder })
  })

  it('resolves reminder targets on get and list', async () => {
    registerReminderHandlers()

    const baseReminder: Reminder = {
      id: 'rem-2',
      targetType: 'note',
      targetId: 'note-2',
      remindAt: new Date(Date.now() + 60_000).toISOString(),
      highlightText: null,
      highlightStart: null,
      highlightEnd: null,
      title: null,
      note: null,
      status: reminderStatus.PENDING,
      triggeredAt: null,
      dismissedAt: null,
      snoozedUntil: null,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString()
    }

    ;(remindersService.getReminder as Mock).mockReturnValue(baseReminder)
    ;(remindersService.listReminders as Mock).mockReturnValue({
      reminders: [
        {
          ...baseReminder,
          targetTitle: null,
          targetExists: true
        } as ReminderWithTarget
      ],
      total: 1,
      hasMore: false
    })

    ;(notesQueries.getNoteCacheById as Mock).mockReturnValue({
      id: 'note-2',
      title: 'Note Two'
    })

    const getResult = await invokeHandler(ReminderChannels.invoke.GET, 'rem-2')
    expect(getResult).toEqual(
      expect.objectContaining({ targetTitle: 'Note Two', targetExists: true })
    )

    const listResult = await invokeHandler(ReminderChannels.invoke.LIST, {})
    expect(listResult.reminders[0]).toEqual(
      expect.objectContaining({ targetTitle: 'Note Two', targetExists: true })
    )
  })

  it('handles update, snooze, and dismiss flows', async () => {
    registerReminderHandlers()

    const reminder: Reminder = {
      id: 'rem-3',
      targetType: 'note',
      targetId: 'note-3',
      remindAt: new Date(Date.now() + 60_000).toISOString(),
      highlightText: null,
      highlightStart: null,
      highlightEnd: null,
      title: null,
      note: null,
      status: reminderStatus.PENDING,
      triggeredAt: null,
      dismissedAt: null,
      snoozedUntil: null,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString()
    }

    ;(remindersService.updateReminder as Mock).mockReturnValue(reminder)
    ;(remindersService.snoozeReminder as Mock).mockReturnValue(reminder)
    ;(remindersService.dismissReminder as Mock).mockReturnValue(reminder)

    const updateResult = await invokeHandler(ReminderChannels.invoke.UPDATE, {
      id: 'rem-3',
      title: 'Updated'
    })
    expect(updateResult).toEqual({ success: true, reminder })

    const snoozeResult = await invokeHandler(ReminderChannels.invoke.SNOOZE, {
      id: 'rem-3',
      snoozeUntil: new Date(Date.now() + 120_000).toISOString()
    })
    expect(snoozeResult).toEqual({ success: true, reminder })

    const dismissResult = await invokeHandler(ReminderChannels.invoke.DISMISS, 'rem-3')
    expect(dismissResult).toEqual({ success: true, reminder })
  })

  it('deletes reminders and reports missing ones', async () => {
    registerReminderHandlers()

    ;(remindersService.deleteReminder as Mock).mockReturnValue(true)
    const deleteResult = await invokeHandler(ReminderChannels.invoke.DELETE, 'rem-4')
    expect(deleteResult).toEqual({ success: true })

    ;(remindersService.deleteReminder as Mock).mockReturnValue(false)
    const missingResult = await invokeHandler(ReminderChannels.invoke.DELETE, 'missing')
    expect(missingResult).toEqual({ success: false, error: 'Reminder not found' })
  })

  it('handles upcoming, due, target, count, and bulk dismiss queries', async () => {
    registerReminderHandlers()

    const baseReminder: Reminder = {
      id: 'rem-5',
      targetType: 'note',
      targetId: 'note-5',
      remindAt: new Date(Date.now() + 60_000).toISOString(),
      highlightText: null,
      highlightStart: null,
      highlightEnd: null,
      title: null,
      note: null,
      status: reminderStatus.PENDING,
      triggeredAt: null,
      dismissedAt: null,
      snoozedUntil: null,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString()
    }

    ;(remindersService.getUpcomingReminders as Mock).mockReturnValue({
      reminders: [
        {
          ...baseReminder,
          targetTitle: null,
          targetExists: true
        } as ReminderWithTarget
      ],
      total: 1,
      hasMore: false
    })
    ;(remindersService.getDueReminders as Mock).mockReturnValue([
      {
        ...baseReminder,
        targetTitle: null,
        targetExists: true
      } as ReminderWithTarget
    ])
    ;(remindersService.getRemindersForTarget as Mock).mockReturnValue([baseReminder])
    ;(remindersService.countPendingReminders as Mock).mockReturnValue(4)
    ;(remindersService.bulkDismissReminders as Mock).mockReturnValue(2)
    ;(notesQueries.getNoteCacheById as Mock).mockReturnValue({
      id: 'note-5',
      title: 'Note Five'
    })

    const upcoming = await invokeHandler(ReminderChannels.invoke.GET_UPCOMING, 14)
    expect(remindersService.getUpcomingReminders).toHaveBeenCalledWith(14)
    expect(upcoming.reminders[0]).toEqual(
      expect.objectContaining({ targetTitle: 'Note Five', targetExists: true })
    )

    const due = await invokeHandler(ReminderChannels.invoke.GET_DUE)
    expect(due[0]).toEqual(expect.objectContaining({ targetTitle: 'Note Five' }))

    const forTarget = await invokeHandler(ReminderChannels.invoke.GET_FOR_TARGET, {
      targetType: 'note',
      targetId: 'note-5'
    })
    expect(forTarget).toEqual([baseReminder])

    const count = await invokeHandler(ReminderChannels.invoke.COUNT_PENDING)
    expect(count).toBe(4)

    const bulkDismiss = await invokeHandler(ReminderChannels.invoke.BULK_DISMISS, {
      reminderIds: ['rem-5', 'rem-6']
    })
    expect(bulkDismiss).toEqual({ success: true, dismissedCount: 2 })
  })

  it('returns error when reminder does not exist', async () => {
    registerReminderHandlers()
    ;(remindersService.updateReminder as Mock).mockReturnValue(null)

    const result = await invokeHandler(ReminderChannels.invoke.UPDATE, {
      id: 'missing',
      title: 'Nope'
    })
    expect(result).toEqual({ success: false, reminder: null, error: 'Reminder not found' })
  })
})
