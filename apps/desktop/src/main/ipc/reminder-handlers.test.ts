/**
 * Reminder IPC handlers tests
 *
 * @module ipc/reminder-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { ReminderChannels } from '@memry/contracts/ipc-channels'
import {
  reminderStatus,
  type Reminder,
  type ReminderWithTarget
} from '@memry/contracts/reminders-api'

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
  requireDatabase: vi.fn(),
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

vi.mock('@main/database/queries/notes', () => ({
  getNoteCacheById: vi.fn()
}))

import { registerReminderHandlers, unregisterReminderHandlers } from './reminder-handlers'
import { getDatabase, getIndexDatabase } from '../database'
import * as remindersService from '../lib/reminders'
import * as notesQueries from '@main/database/queries/notes'

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

  it('returns service-resolved reminders on get and list', async () => {
    // #given — service now resolves target title/existence itself; handler is a pass-through.
    registerReminderHandlers()

    const resolvedReminder: ReminderWithTarget = {
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
      modifiedAt: new Date().toISOString(),
      targetTitle: 'Note Two',
      targetExists: true,
      highlightExists: undefined
    }

    ;(remindersService.getReminder as Mock).mockReturnValue(resolvedReminder)
    ;(remindersService.listReminders as Mock).mockReturnValue({
      reminders: [resolvedReminder],
      total: 1,
      hasMore: false
    })

    // #when
    const getResult = await invokeHandler(ReminderChannels.invoke.GET, 'rem-2')
    const listResult = await invokeHandler(ReminderChannels.invoke.LIST, {})

    // #then — handler forwards the resolved payload verbatim.
    expect(getResult).toEqual(resolvedReminder)
    expect(listResult.reminders[0]).toEqual(resolvedReminder)
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

    const resolved: ReminderWithTarget = {
      ...baseReminder,
      targetTitle: 'Note Five',
      targetExists: true,
      highlightExists: undefined
    }

    ;(remindersService.getUpcomingReminders as Mock).mockReturnValue({
      reminders: [resolved],
      total: 1,
      hasMore: false
    })
    ;(remindersService.getDueReminders as Mock).mockReturnValue([resolved])
    ;(remindersService.getRemindersForTarget as Mock).mockReturnValue([baseReminder])
    ;(remindersService.countPendingReminders as Mock).mockReturnValue(4)
    ;(remindersService.bulkDismissReminders as Mock).mockReturnValue(2)

    const upcoming = await invokeHandler(ReminderChannels.invoke.GET_UPCOMING, 14)
    expect(remindersService.getUpcomingReminders).toHaveBeenCalledWith(14)
    expect(upcoming.reminders[0]).toEqual(resolved)

    const due = await invokeHandler(ReminderChannels.invoke.GET_DUE)
    expect(due[0]).toEqual(resolved)

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
