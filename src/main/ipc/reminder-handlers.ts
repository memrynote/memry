/**
 * Reminder IPC handlers.
 * Handles all reminder-related IPC communication from renderer.
 *
 * @module ipc/reminder-handlers
 */

import { ipcMain } from 'electron'
import { ReminderChannels } from '@shared/ipc-channels'
import {
  CreateReminderSchema,
  UpdateReminderSchema,
  SnoozeReminderSchema,
  ListRemindersSchema,
  GetForTargetSchema,
  BulkDismissSchema,
  type ReminderWithTarget
} from '@shared/contracts/reminders-api'
import { createValidatedHandler, createStringHandler, createHandler } from './validate'
import { getDatabase, getIndexDatabase } from '../database'
import * as remindersService from '../lib/reminders'
import * as notesQueries from '@shared/db/queries/notes'
import { z } from 'zod'

/**
 * Helper to get data database, throwing a user-friendly error if not available.
 */
function requireDatabase() {
  try {
    return getDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
}

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
        const note = notesQueries.getNoteCacheById(indexDb, reminder.targetId)
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
    createValidatedHandler(CreateReminderSchema, (input) => {
      ensureDb()

      try {
        const reminder = remindersService.createReminder(input)
        return { success: true, reminder }
      } catch (error) {
        return {
          success: false,
          reminder: null,
          error: error instanceof Error ? error.message : 'Failed to create reminder'
        }
      }
    })
  )

  // reminder:update - Update an existing reminder
  ipcMain.handle(
    ReminderChannels.invoke.UPDATE,
    createValidatedHandler(UpdateReminderSchema, (input) => {
      ensureDb()

      try {
        const reminder = remindersService.updateReminder(input)
        if (!reminder) {
          return { success: false, reminder: null, error: 'Reminder not found' }
        }
        return { success: true, reminder }
      } catch (error) {
        return {
          success: false,
          reminder: null,
          error: error instanceof Error ? error.message : 'Failed to update reminder'
        }
      }
    })
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
    createStringHandler((id) => {
      ensureDb()

      try {
        const reminder = remindersService.dismissReminder(id)
        if (!reminder) {
          return { success: false, reminder: null, error: 'Reminder not found' }
        }
        return { success: true, reminder }
      } catch (error) {
        return {
          success: false,
          reminder: null,
          error: error instanceof Error ? error.message : 'Failed to dismiss reminder'
        }
      }
    })
  )

  // reminder:snooze - Snooze a reminder
  ipcMain.handle(
    ReminderChannels.invoke.SNOOZE,
    createValidatedHandler(SnoozeReminderSchema, (input) => {
      ensureDb()

      try {
        const reminder = remindersService.snoozeReminder(input)
        if (!reminder) {
          return { success: false, reminder: null, error: 'Reminder not found' }
        }
        return { success: true, reminder }
      } catch (error) {
        return {
          success: false,
          reminder: null,
          error: error instanceof Error ? error.message : 'Failed to snooze reminder'
        }
      }
    })
  )

  // reminder:bulk-dismiss - Bulk dismiss reminders
  ipcMain.handle(
    ReminderChannels.invoke.BULK_DISMISS,
    createValidatedHandler(BulkDismissSchema, (input) => {
      ensureDb()

      try {
        const dismissedCount = remindersService.bulkDismissReminders(input.reminderIds)
        return { success: true, dismissedCount }
      } catch (error) {
        return {
          success: false,
          dismissedCount: 0,
          error: error instanceof Error ? error.message : 'Failed to dismiss reminders'
        }
      }
    })
  )

  console.log('[IPC] Reminder handlers registered')
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

  console.log('[IPC] Reminder handlers unregistered')
}
