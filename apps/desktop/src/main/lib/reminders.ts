/**
 * Reminder Service
 *
 * Handles CRUD operations for reminders and the reminder scheduler.
 * Supports reminders for notes, journal entries, and highlighted text.
 *
 * @module main/lib/reminders
 */

import { BrowserWindow, Notification } from 'electron'
import { getDatabase, getIndexDatabase } from '../database'
import { getStatus } from '../vault'
import { reminders } from '@memry/db-schema/schema/reminders'
import { inboxItems, inboxItemType } from '@memry/db-schema/schema/inbox'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { eq, and, lte, sql, or, gte, asc } from 'drizzle-orm'
import { generateId } from './id'
import {
  ReminderChannels,
  reminderStatus,
  type Reminder,
  type ReminderWithTarget,
  type CreateReminderInput,
  type UpdateReminderInput,
  type SnoozeReminderInput,
  type ListRemindersInput,
  type ReminderDueEvent
} from '@memry/contracts/reminders-api'
import { InboxChannels, type ReminderMetadata } from '@memry/contracts/inbox-api'
import { createLogger } from './logger'
import { publishProjectionEvent } from '../projections'

const logger = createLogger('Reminders')

// ============================================================================
// Types
// ============================================================================

type ReminderRow = typeof reminders.$inferSelect

// ============================================================================
// Scheduler State
// ============================================================================

let schedulerInterval: ReturnType<typeof setInterval> | null = null
const SCHEDULER_INTERVAL_MS = 60 * 1000 // Check every 60 seconds

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert a database row to a Reminder object
 */
function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    targetType: row.targetType as Reminder['targetType'],
    targetId: row.targetId,
    remindAt: row.remindAt,
    highlightText: row.highlightText,
    highlightStart: row.highlightStart,
    highlightEnd: row.highlightEnd,
    title: row.title,
    note: row.note,
    status: row.status as Reminder['status'],
    triggeredAt: row.triggeredAt,
    dismissedAt: row.dismissedAt,
    snoozedUntil: row.snoozedUntil,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  }
}

/**
 * Convert a database row to a ReminderWithTarget object
 * TODO: Resolve target title from notes/journal service
 */
function toReminderWithTarget(row: ReminderRow): ReminderWithTarget {
  const reminder = toReminder(row)
  return {
    ...reminder,
    // These will be resolved by the IPC handler which has access to notes/journal
    targetTitle: null,
    targetExists: true,
    highlightExists: reminder.targetType === 'highlight' ? true : undefined
  }
}

/**
 * Emit an event to all windows
 */
function emitEvent(channel: string, data: unknown): void {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }
}

/**
 * Get current ISO datetime
 */
function now(): string {
  return new Date().toISOString()
}

/**
 * Resolve the target title for a reminder by looking up the note/journal in the cache
 * @param targetType - Type of target (note, journal, highlight)
 * @param targetId - ID of the target
 * @returns The target title or null if not found
 */
function resolveTargetTitle(targetType: string, targetId: string): string | null {
  try {
    const indexDb = getIndexDatabase()

    // For notes and highlights, look up the note by ID
    // For journals, targetId is the journal entry ID (notes with date field set)
    const note = indexDb
      .select({ title: noteCache.title })
      .from(noteCache)
      .where(eq(noteCache.id, targetId))
      .get()

    return note?.title || null
  } catch (error) {
    logger.error(`Failed to resolve target title for ${targetType}:${targetId}:`, error)
    return null
  }
}

/**
 * Create an inbox item for a triggered reminder
 * @param reminder - The reminder that was triggered
 */
function createReminderInboxItem(reminder: ReminderWithTarget): void {
  try {
    const db = getDatabase()
    const id = `inbox_rem_${generateId()}`
    const timestamp = now()

    // Build title from reminder or target
    const title = reminder.title || reminder.targetTitle || `Reminder: ${reminder.targetType}`

    // Build content from reminder note or highlight text
    const content = reminder.highlightText || reminder.note || null

    // Build metadata for the reminder inbox item
    const metadata: ReminderMetadata = {
      reminderId: reminder.id,
      targetType: reminder.targetType,
      targetId: reminder.targetId,
      targetTitle: reminder.targetTitle,
      remindAt: reminder.remindAt,
      highlightText: reminder.highlightText || undefined,
      highlightStart: reminder.highlightStart || undefined,
      highlightEnd: reminder.highlightEnd || undefined,
      reminderNote: reminder.note || undefined
    }

    // Insert inbox item
    db.insert(inboxItems)
      .values({
        id,
        type: inboxItemType.REMINDER,
        title,
        content,
        createdAt: timestamp,
        modifiedAt: timestamp,
        processingStatus: 'complete',
        metadata
      })
      .run()

    publishProjectionEvent({
      type: 'inbox.upserted',
      itemId: id
    })

    // Emit captured event for inbox refresh
    emitEvent(InboxChannels.events.CAPTURED, {
      item: {
        id,
        type: inboxItemType.REMINDER,
        title,
        content,
        createdAt: new Date(timestamp),
        thumbnailUrl: null,
        sourceUrl: null,
        tags: [],
        isStale: false,
        processingStatus: 'complete',
        metadata
      }
    })

    logger.debug(`Created inbox item ${id} for reminder ${reminder.id}`)
  } catch (error) {
    logger.error('Failed to create inbox item for reminder:', error)
  }
}

/**
 * Show a desktop notification for a due reminder
 * @param reminder - The reminder that is due
 */
function showDesktopNotification(reminder: ReminderWithTarget): void {
  // Check if notifications are supported
  if (!Notification.isSupported()) {
    logger.warn('Desktop notifications not supported')
    return
  }

  // Build notification title
  const title = reminder.title || reminder.targetTitle || 'Reminder'

  // Build notification body
  let body = ''
  if (reminder.targetType === 'highlight' && reminder.highlightText) {
    body = `"${reminder.highlightText.slice(0, 100)}${reminder.highlightText.length > 100 ? '...' : ''}"`
  } else if (reminder.note) {
    body = reminder.note
  } else {
    // Default body based on target type
    const typeLabels: Record<string, string> = {
      note: 'Note reminder',
      journal: 'Journal reminder',
      highlight: 'Highlight reminder'
    }
    body = typeLabels[reminder.targetType] || 'Reminder due'
  }

  try {
    const notification = new Notification({
      title: `🔔 ${title}`,
      body,
      silent: false
    })

    // Handle click - focus window and emit event to navigate
    notification.on('click', () => {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length > 0) {
        const win = windows[0]
        if (win.isMinimized()) win.restore()
        win.focus()
        // Emit event to navigate to the reminder target
        win.webContents.send(ReminderChannels.events.CLICKED, { reminder })
      }
    })

    notification.show()
    logger.debug(`Showed desktop notification for reminder ${reminder.id}`)
  } catch (error) {
    logger.error('Failed to show desktop notification:', error)
  }
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Create a new reminder
 * @param input - Create reminder input
 * @returns The created reminder
 */
export function createReminder(input: CreateReminderInput): Reminder {
  const db = getDatabase()
  const id = `rem_${generateId()}`
  const timestamp = now()

  // Validate remind time is in the future
  if (new Date(input.remindAt) <= new Date()) {
    throw new Error('Reminder time must be in the future')
  }

  const values: typeof reminders.$inferInsert = {
    id,
    targetType: input.targetType,
    targetId: input.targetId,
    remindAt: input.remindAt,
    title: input.title || null,
    note: input.note || null,
    status: reminderStatus.PENDING,
    createdAt: timestamp,
    modifiedAt: timestamp
  }

  // Add highlight fields if applicable
  if (input.targetType === 'highlight') {
    values.highlightText = input.highlightText
    values.highlightStart = input.highlightStart
    values.highlightEnd = input.highlightEnd
  }

  db.insert(reminders).values(values).run()

  const reminder = db.select().from(reminders).where(eq(reminders.id, id)).get()
  if (!reminder) {
    throw new Error('Failed to create reminder')
  }

  const result = toReminder(reminder)
  emitEvent(ReminderChannels.events.CREATED, { reminder: result })

  logger.info(`Created reminder ${id} for ${input.targetType}:${input.targetId}`)
  return result
}

/**
 * Update an existing reminder
 * @param input - Update reminder input
 * @returns The updated reminder or null if not found
 */
export function updateReminder(input: UpdateReminderInput): Reminder | null {
  const db = getDatabase()
  const timestamp = now()

  // Validate remind time if provided
  if (input.remindAt && new Date(input.remindAt) <= new Date()) {
    throw new Error('Reminder time must be in the future')
  }

  const updates: Partial<typeof reminders.$inferInsert> = {
    modifiedAt: timestamp
  }

  if (input.remindAt !== undefined) {
    updates.remindAt = input.remindAt
    // Reset status to pending if rescheduling
    updates.status = reminderStatus.PENDING
    updates.triggeredAt = null
    updates.snoozedUntil = null
  }

  if (input.title !== undefined) {
    updates.title = input.title
  }

  if (input.note !== undefined) {
    updates.note = input.note
  }

  db.update(reminders).set(updates).where(eq(reminders.id, input.id)).run()

  const reminder = db.select().from(reminders).where(eq(reminders.id, input.id)).get()
  if (!reminder) {
    return null
  }

  const result = toReminder(reminder)
  emitEvent(ReminderChannels.events.UPDATED, { reminder: result })

  logger.info(`Updated reminder ${input.id}`)
  return result
}

/**
 * Delete a reminder
 * @param id - Reminder ID
 * @returns Whether the reminder was deleted
 */
export function deleteReminder(id: string): boolean {
  const db = getDatabase()

  const reminder = db.select().from(reminders).where(eq(reminders.id, id)).get()
  if (!reminder) {
    return false
  }

  db.delete(reminders).where(eq(reminders.id, id)).run()

  emitEvent(ReminderChannels.events.DELETED, {
    id,
    targetType: reminder.targetType,
    targetId: reminder.targetId
  })

  logger.info(`Deleted reminder ${id}`)
  return true
}

/**
 * Get a reminder by ID
 * @param id - Reminder ID
 * @returns The reminder or null if not found
 */
export function getReminder(id: string): Reminder | null {
  const db = getDatabase()
  const reminder = db.select().from(reminders).where(eq(reminders.id, id)).get()
  return reminder ? toReminder(reminder) : null
}

/**
 * List reminders with optional filters
 * @param options - Filter and pagination options
 * @returns Object with reminders array, total count, and hasMore flag
 */
export function listReminders(options: Partial<ListRemindersInput> = {}): {
  reminders: ReminderWithTarget[]
  total: number
  hasMore: boolean
} {
  const db = getDatabase()
  const { targetType, targetId, status, fromDate, toDate, limit = 50, offset = 0 } = options

  // Get all rows and filter manually (simpler approach for SQLite)
  let query = db.select().from(reminders)

  // Build where clause
  if (targetType || targetId || status || fromDate || toDate) {
    const conditions: ReturnType<typeof eq>[] = []

    if (targetType) {
      conditions.push(eq(reminders.targetType, targetType))
    }

    if (targetId) {
      conditions.push(eq(reminders.targetId, targetId))
    }

    if (status) {
      if (Array.isArray(status) && status.length > 0) {
        const statusCondition = or(...status.map((s) => eq(reminders.status, s)))
        if (statusCondition) {
          conditions.push(statusCondition)
        }
      } else if (typeof status === 'string') {
        conditions.push(eq(reminders.status, status))
      }
    }

    if (fromDate) {
      conditions.push(gte(reminders.remindAt, fromDate))
    }

    if (toDate) {
      conditions.push(lte(reminders.remindAt, toDate))
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query
    }
  }

  // Get all rows matching the filter
  const allRows = query.orderBy(asc(reminders.remindAt)).all()
  const total = allRows.length

  // Apply pagination
  const paginatedRows = allRows.slice(offset, offset + limit)

  return {
    reminders: paginatedRows.map(toReminderWithTarget),
    total,
    hasMore: offset + paginatedRows.length < total
  }
}

/**
 * Get upcoming reminders (next N days)
 * @param days - Number of days to look ahead (default: 7)
 * @returns Object with reminders array, total count, and hasMore flag
 */
export function getUpcomingReminders(days = 7): {
  reminders: ReminderWithTarget[]
  total: number
  hasMore: boolean
} {
  const fromDate = now()
  const toDate = new Date()
  toDate.setDate(toDate.getDate() + days)

  return listReminders({
    status: [reminderStatus.PENDING, reminderStatus.SNOOZED],
    fromDate,
    toDate: toDate.toISOString(),
    limit: 100
  })
}

/**
 * Get due reminders (remindAt <= now and status = pending, or snoozedUntil <= now)
 * @returns Array of due reminders
 */
export function getDueReminders(): ReminderWithTarget[] {
  const db = getDatabase()
  const currentTime = now()

  const rows = db
    .select()
    .from(reminders)
    .where(
      or(
        // Pending reminders that are due
        and(eq(reminders.status, reminderStatus.PENDING), lte(reminders.remindAt, currentTime)),
        // Snoozed reminders that are due
        and(eq(reminders.status, reminderStatus.SNOOZED), lte(reminders.snoozedUntil, currentTime))
      )
    )
    .orderBy(asc(reminders.remindAt))
    .all()

  return rows.map(toReminderWithTarget)
}

/**
 * Get reminders for a specific target
 * @param targetType - Type of target (note, journal, highlight)
 * @param targetId - ID of the target
 * @returns Array of reminders for the target
 */
export function getRemindersForTarget(targetType: string, targetId: string): Reminder[] {
  const db = getDatabase()

  const rows = db
    .select()
    .from(reminders)
    .where(and(eq(reminders.targetType, targetType), eq(reminders.targetId, targetId)))
    .orderBy(asc(reminders.remindAt))
    .all()

  return rows.map(toReminder)
}

/**
 * Dismiss a reminder
 * @param id - Reminder ID
 * @returns The updated reminder or null if not found
 */
export function dismissReminder(id: string): Reminder | null {
  const db = getDatabase()
  const timestamp = now()

  db.update(reminders)
    .set({
      status: reminderStatus.DISMISSED,
      dismissedAt: timestamp,
      modifiedAt: timestamp
    })
    .where(eq(reminders.id, id))
    .run()

  const reminder = db.select().from(reminders).where(eq(reminders.id, id)).get()
  if (!reminder) {
    return null
  }

  const result = toReminder(reminder)
  emitEvent(ReminderChannels.events.DISMISSED, { reminder: result })

  logger.info(`Dismissed reminder ${id}`)
  return result
}

/**
 * Snooze a reminder to a later time
 * @param input - Snooze input with id and snoozeUntil time
 * @returns The updated reminder or null if not found
 */
export function snoozeReminder(input: SnoozeReminderInput): Reminder | null {
  const db = getDatabase()
  const timestamp = now()

  // Validate snooze time is in the future
  if (new Date(input.snoozeUntil) <= new Date()) {
    throw new Error('Snooze time must be in the future')
  }

  db.update(reminders)
    .set({
      status: reminderStatus.SNOOZED,
      snoozedUntil: input.snoozeUntil,
      modifiedAt: timestamp
    })
    .where(eq(reminders.id, input.id))
    .run()

  const reminder = db.select().from(reminders).where(eq(reminders.id, input.id)).get()
  if (!reminder) {
    return null
  }

  const result = toReminder(reminder)
  emitEvent(ReminderChannels.events.SNOOZED, { reminder: result })

  logger.info(`Snoozed reminder ${input.id} until ${input.snoozeUntil}`)
  return result
}

/**
 * Bulk dismiss multiple reminders
 * @param reminderIds - Array of reminder IDs to dismiss
 * @returns Number of reminders dismissed
 */
export function bulkDismissReminders(reminderIds: string[]): number {
  const db = getDatabase()
  const timestamp = now()

  let dismissedCount = 0

  for (const id of reminderIds) {
    const result = db
      .update(reminders)
      .set({
        status: reminderStatus.DISMISSED,
        dismissedAt: timestamp,
        modifiedAt: timestamp
      })
      .where(eq(reminders.id, id))
      .run()

    if (result.changes > 0) {
      dismissedCount++
    }
  }

  logger.info(`Bulk dismissed ${dismissedCount} reminders`)
  return dismissedCount
}

// ============================================================================
// Scheduler
// ============================================================================

/**
 * Process due reminders and emit notifications
 */
function processDueReminders(): void {
  if (!getStatus().isOpen) return

  try {
    const dueReminders = getDueReminders()

    if (dueReminders.length === 0) {
      return
    }

    logger.info(`Found ${dueReminders.length} due reminders`)

    // Mark reminders as triggered
    const db = getDatabase()
    const timestamp = now()

    for (const reminder of dueReminders) {
      db.update(reminders)
        .set({
          status: reminderStatus.TRIGGERED,
          triggeredAt: timestamp,
          modifiedAt: timestamp
        })
        .where(eq(reminders.id, reminder.id))
        .run()

      // Resolve the target title from the notes cache
      const resolvedTitle = resolveTargetTitle(reminder.targetType, reminder.targetId)
      if (resolvedTitle) {
        reminder.targetTitle = resolvedTitle
      }

      // T231: Show desktop notification for each due reminder
      showDesktopNotification(reminder)

      // Create inbox item for the triggered reminder
      createReminderInboxItem(reminder)
    }

    // Emit due event with all due reminders (for in-app notifications)
    const event: ReminderDueEvent = {
      reminders: dueReminders,
      count: dueReminders.length
    }

    emitEvent(ReminderChannels.events.DUE, event)
    logger.debug(`Emitted due event for ${dueReminders.length} reminders`)
  } catch (error) {
    logger.error('Error processing due reminders:', error)
  }
}

/**
 * Start the reminder scheduler
 * Called on app ready
 */
export function startReminderScheduler(): void {
  if (schedulerInterval) {
    logger.warn('Scheduler already running')
    return
  }

  // Process any reminders that became due while app was closed
  processDueReminders()

  // Set up interval to check for due reminders
  schedulerInterval = setInterval(processDueReminders, SCHEDULER_INTERVAL_MS)
}

/**
 * Stop the reminder scheduler
 * Called on app quit
 */
export function stopReminderScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
    logger.info('Scheduler stopped')
  }
}

/**
 * Check if the scheduler is running
 */
export function isSchedulerRunning(): boolean {
  return schedulerInterval !== null
}

/**
 * Count pending reminders (for badge display)
 * @returns Number of pending reminders
 */
export function countPendingReminders(): number {
  try {
    const db = getDatabase()
    const result = db
      .select({ count: sql<number>`count(*)` })
      .from(reminders)
      .where(
        or(
          eq(reminders.status, reminderStatus.PENDING),
          eq(reminders.status, reminderStatus.SNOOZED)
        )
      )
      .get()
    return result?.count || 0
  } catch {
    return 0
  }
}
