/**
 * Reminder IPC handlers.
 * Handles all reminder-related IPC communication from renderer.
 *
 * @module ipc/reminder-handlers
 */

import { ipcMain } from 'electron'
import { ReminderChannels } from '@memry/contracts/ipc-channels'
import {
  CreateReminderSchema,
  UpdateReminderSchema,
  SnoozeReminderSchema,
  ListRemindersSchema,
  GetForTargetSchema,
  BulkDismissSchema,
  type ReminderWithTarget
} from '@memry/contracts/reminders-api'
import { createLogger } from '../lib/logger'
import {
  createValidatedHandler,
  createStringHandler,
  createHandler,
  withErrorHandler
} from './validate'
import { requireDatabase, getIndexDatabase } from '../database'
import * as remindersService from '../lib/reminders'
import { getNoteCacheById } from '../notes/store'
import { z } from 'zod'

const logger = createLogger('IPC:Reminder')

/**
 * Helper to get index database for resolving note titles
 */
function getIndexDb() {
  try {
    return getIndexDatabase()
  } catch {
    return null
  }
}

/**
 * Resolve target details for a reminder
 */
function resolveReminderTarget(reminder: ReminderWithTarget): ReminderWithTarget {
  const indexDb = getIndexDb()

  // Default values
  let targetTitle: string | null = null
  let targetExists = false
  let highlightExists: boolean | undefined = undefined

  switch (reminder.targetType) {
    case 'note':
    case 'highlight': {
      if (indexDb) {
        const note = getNoteCacheById(indexDb, reminder.targetId)
        if (note) {
          targetTitle = note.title
          targetExists = true

          // For highlights, check if the text still exists in the note
          if (reminder.targetType === 'highlight' && reminder.highlightText) {
            // We can't easily check if the exact text exists without reading the file
            // For now, assume it exists if the note exists
            highlightExists = true
          }
        }
      }
      break
    }

    case 'journal': {
      // Journal entries use the date as both ID and title
      // Format: YYYY-MM-DD
      targetTitle = reminder.targetId
      // We assume journal entries always "exist" since they're created on demand
      targetExists = true
      break
    }
  }

  return {
    ...reminder,
    targetTitle,
    targetExists,
    highlightExists
  }
}

/**
 * Register all reminder-related IPC handlers.
 * Call this once during app initialization.
 */
export function registerReminderHandlers(): void {
  // Ensure database is available for handlers that need it
  const ensureDb = () => {
    requireDatabase()
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  // reminder:create - Create a new reminder
  ipcMain.handle(
    ReminderChannels.invoke.CREATE,
    createValidatedHandler(
      CreateReminderSchema,
      withErrorHandler((input) => {
        ensureDb()
        const reminder = remindersService.createReminder(input)
        return { success: true, reminder }
      }, 'Failed to create reminder')
    )
  )

  // reminder:update - Update an existing reminder
  ipcMain.handle(
    ReminderChannels.invoke.UPDATE,
    createValidatedHandler(
      UpdateReminderSchema,
      withErrorHandler((input) => {
        ensureDb()
        const reminder = remindersService.updateReminder(input)
        if (!reminder) {
          return { success: false, reminder: null, error: 'Reminder not found' }
        }
        return { success: true, reminder }
      }, 'Failed to update reminder')
    )
  )

  // reminder:delete - Delete a reminder
  ipcMain.handle(
    ReminderChannels.invoke.DELETE,
    createStringHandler((id) => {
      ensureDb()

      const deleted = remindersService.deleteReminder(id)
      if (!deleted) {
        return { success: false, error: 'Reminder not found' }
      }
      return { success: true }
    })
  )

  // reminder:get - Get a reminder by ID
  ipcMain.handle(
    ReminderChannels.invoke.GET,
    createStringHandler((id) => {
      ensureDb()

      const reminder = remindersService.getReminder(id)
      if (!reminder) {
        return null
      }

      // Resolve target details
      return resolveReminderTarget({
        ...reminder,
        targetTitle: null,
        targetExists: true
      })
    })
  )

  // reminder:list - List reminders with filters
  ipcMain.handle(
    ReminderChannels.invoke.LIST,
    createValidatedHandler(ListRemindersSchema, (input) => {
      ensureDb()

      const result = remindersService.listReminders(input)

      // Resolve target details for each reminder
      return {
        ...result,
        reminders: result.reminders.map(resolveReminderTarget)
      }
    })
  )

  // ============================================================================
  // Specialized Queries
  // ============================================================================

  // reminder:get-upcoming - Get upcoming reminders (next N days)
  ipcMain.handle(
    ReminderChannels.invoke.GET_UPCOMING,
    createValidatedHandler(z.number().int().min(1).max(365).optional(), (days) => {
      ensureDb()

      const result = remindersService.getUpcomingReminders(days ?? 7)

      // Resolve target details for each reminder
      return {
        ...result,
        reminders: result.reminders.map(resolveReminderTarget)
      }
    })
  )

  // reminder:get-due - Get due reminders
  ipcMain.handle(
    ReminderChannels.invoke.GET_DUE,
    createHandler(() => {
      ensureDb()

      const reminders = remindersService.getDueReminders()
      return reminders.map(resolveReminderTarget)
    })
  )

  // reminder:get-for-target - Get reminders for a specific target
  ipcMain.handle(
    ReminderChannels.invoke.GET_FOR_TARGET,
    createValidatedHandler(GetForTargetSchema, (input) => {
      ensureDb()

      return remindersService.getRemindersForTarget(input.targetType, input.targetId)
    })
  )

  // reminder:count-pending - Count pending reminders (for badge)
  ipcMain.handle(
    ReminderChannels.invoke.COUNT_PENDING,
    createHandler(() => {
      ensureDb()

      return remindersService.countPendingReminders()
    })
  )

  // ============================================================================
  // Status Operations
  // ============================================================================

  // reminder:dismiss - Dismiss a reminder
  ipcMain.handle(
    ReminderChannels.invoke.DISMISS,
    createStringHandler(
      withErrorHandler((id) => {
        ensureDb()
        const reminder = remindersService.dismissReminder(id)
        if (!reminder) {
          return { success: false, reminder: null, error: 'Reminder not found' }
        }
        return { success: true, reminder }
      }, 'Failed to dismiss reminder')
    )
  )

  // reminder:snooze - Snooze a reminder
  ipcMain.handle(
    ReminderChannels.invoke.SNOOZE,
    createValidatedHandler(
      SnoozeReminderSchema,
      withErrorHandler((input) => {
        ensureDb()
        const reminder = remindersService.snoozeReminder(input)
        if (!reminder) {
          return { success: false, reminder: null, error: 'Reminder not found' }
        }
        return { success: true, reminder }
      }, 'Failed to snooze reminder')
    )
  )

  // reminder:bulk-dismiss - Bulk dismiss reminders
  ipcMain.handle(
    ReminderChannels.invoke.BULK_DISMISS,
    createValidatedHandler(
      BulkDismissSchema,
      withErrorHandler((input) => {
        ensureDb()
        const dismissedCount = remindersService.bulkDismissReminders(input.reminderIds)
        return { success: true, dismissedCount }
      }, 'Failed to dismiss reminders')
    )
  )
}

/**
 * Unregister all reminder-related IPC handlers.
 */
export function unregisterReminderHandlers(): void {
  ipcMain.removeHandler(ReminderChannels.invoke.CREATE)
  ipcMain.removeHandler(ReminderChannels.invoke.UPDATE)
  ipcMain.removeHandler(ReminderChannels.invoke.DELETE)
  ipcMain.removeHandler(ReminderChannels.invoke.GET)
  ipcMain.removeHandler(ReminderChannels.invoke.LIST)
  ipcMain.removeHandler(ReminderChannels.invoke.GET_UPCOMING)
  ipcMain.removeHandler(ReminderChannels.invoke.GET_DUE)
  ipcMain.removeHandler(ReminderChannels.invoke.GET_FOR_TARGET)
  ipcMain.removeHandler(ReminderChannels.invoke.COUNT_PENDING)
  ipcMain.removeHandler(ReminderChannels.invoke.DISMISS)
  ipcMain.removeHandler(ReminderChannels.invoke.SNOOZE)
  ipcMain.removeHandler(ReminderChannels.invoke.BULK_DISMISS)

  logger.info('Reminder handlers unregistered')
}
