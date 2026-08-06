/**
 * Reminder Service
 *
 * Handles CRUD operations for reminders and the reminder scheduler.
 * Supports reminders for notes, journal entries, and highlighted text.
 *
 * @module main/lib/reminders
 */

import { app, BrowserWindow, Notification } from 'electron'
import { getDatabase, getIndexDatabase } from '../database'
import type { IndexDb } from '../database/types'
import { getNoteCacheById } from '../database/queries/notes'
import { getStatus } from '../vault'
import { reminders } from '@memry/db-schema/schema/reminders'
import { tasks } from '@memry/db-schema/schema/tasks'
import { inboxItems, inboxItemType } from '@memry/db-schema/schema/inbox'
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
import { trackMainError } from '../telemetry/diagnostics'
import { broadcastToAllWindows } from './window-broadcast'
import { getMainI18n } from './main-i18n'
import { publishProjectionEvent } from '../projections'
import { emitCalendarProjectionChanged } from '../calendar/change-events'
import { scheduleGoogleCalendarSourceSync } from '../calendar/google/local-sync-effects'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

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
    anchorId: row.anchorId,
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
 * Resolve target title + existence flags for a reminder.
 *
 * - `note` / `highlight`: look up the note in the index cache; `targetExists`
 *   reflects whether the note is still present. For highlights we also set
 *   `highlightExists` (same value today — the file itself isn't re-scanned).
 * - `journal`: `targetId` is the YYYY-MM-DD date and doubles as the title.
 *   Journal entries are created on demand so they always "exist".
 */
function resolveReminderTarget(
  reminder: Reminder,
  indexDb: IndexDb
): Pick<ReminderWithTarget, 'targetTitle' | 'targetExists' | 'highlightExists' | 'projectId'> {
  switch (reminder.targetType) {
    case 'journal':
      return { targetTitle: reminder.targetId, targetExists: true, highlightExists: undefined }

    case 'note':
    case 'note_date':
    case 'highlight': {
      const note = getNoteCacheById(indexDb, reminder.targetId)
      const targetExists = !!note
      return {
        targetTitle: note?.title ?? null,
        targetExists,
        highlightExists: reminder.targetType === 'highlight' ? targetExists : undefined
      }
    }

    case 'task': {
      const task = getDatabase()
        .select({ title: tasks.title, projectId: tasks.projectId })
        .from(tasks)
        .where(eq(tasks.id, reminder.targetId))
        .get()
      return {
        targetTitle: task?.title ?? null,
        targetExists: !!task,
        highlightExists: undefined,
        projectId: task?.projectId
      }
    }
  }
}

/**
 * Convert a database row to a ReminderWithTarget with resolved title/existence.
 */
function toReminderWithTarget(row: ReminderRow, indexDb: IndexDb): ReminderWithTarget {
  const reminder = toReminder(row)
  return {
    ...reminder,
    ...resolveReminderTarget(reminder, indexDb)
  }
}

/**
 * Emit an event to all windows
 */
function emitEvent(channel: string, data: unknown): void {
  broadcastToAllWindows(channel, data)
}

/**
 * Get current ISO datetime
 */
function now(): string {
  return new Date().toISOString()
}

function syncReminderCalendarState(reminderId: string): void {
  emitCalendarProjectionChanged(`reminder:${reminderId}`)
  scheduleGoogleCalendarSourceSync({ sourceType: 'reminder', sourceId: reminderId })
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
      anchorId: reminder.anchorId ?? undefined,
      highlightText: reminder.highlightText || undefined,
      highlightStart: reminder.highlightStart || undefined,
      highlightEnd: reminder.highlightEnd || undefined,
      reminderNote: reminder.note || undefined,
      projectId: reminder.projectId || undefined
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
    trackMainError('reminders', 'reminder_inbox_item_create', error)
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

  const t = getMainI18n().getFixedT(null, 'system')

  const title = reminder.title || reminder.targetTitle || t('notification.reminder.default')

  let body = ''
  if (reminder.targetType === 'highlight' && reminder.highlightText) {
    body = `"${reminder.highlightText.slice(0, 100)}${reminder.highlightText.length > 100 ? '...' : ''}"`
  } else if (reminder.note) {
    body = reminder.note
  } else {
    const typeLabels: Record<string, string> = {
      note: t('notification.reminder.note'),
      journal: t('notification.reminder.journal'),
      highlight: t('notification.reminder.highlight'),
      task: t('notification.reminder.task')
    }
    body = typeLabels[reminder.targetType] || t('notification.reminder.fallback')
  }

  try {
    const notification = new Notification({
      // Electron 42+: a stable per-reminder id lets a delivered banner be cleared
      // later on dismiss/snooze, and a shared groupId collapses same-tick reminder
      // banners in Notification Center. Both are ignored on Electron <42 and Linux.
      id: reminder.id,
      groupId: 'memry-reminders',
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

    // Electron 42+ routes macOS notifications through UNUserNotificationCenter:
    // unsigned builds no longer display and emit 'failed' instead of showing.
    // Every reminder also lands as an inbox item, so log for diagnosability
    // rather than re-notifying (which would double-create the fallback).
    notification.on('failed', (_event, error) => {
      logger.error(`Desktop notification failed for reminder ${reminder.id}:`, error)
      trackMainError('reminders', 'reminder_notification_failed', error)
    })

    notification.show()
    logger.debug(`Showed desktop notification for reminder ${reminder.id}`)
  } catch (error) {
    logger.error('Failed to show desktop notification:', error)
    trackMainError('reminders', 'reminder_notification_show', error)
  }
}

/**
 * Remove a delivered notification banner for a reminder from Notification
 * Center. `Notification.remove` is Electron 42+ and only implemented on
 * macOS — everywhere else this is a silent no-op.
 * @param reminderId - Stable reminder id used as the notification id
 */
function removeDeliveredNotification(reminderId: string): void {
  if (process.platform !== 'darwin') return
  if (typeof Notification.remove !== 'function') return

  try {
    Notification.remove(reminderId)
  } catch (error) {
    logger.warn(`Failed to remove delivered notification for reminder ${reminderId}:`, error)
  }
}

/**
 * Reflect the pending reminder count on the dock/taskbar badge
 * (macOS dock + Unity launcher; a no-op false return on Windows).
 * A badge failure must never break the reminder flow.
 */
function updateAppBadge(): void {
  try {
    app.setBadgeCount(countPendingReminders())
  } catch (error) {
    logger.warn('Failed to update app badge count:', error)
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

  if (new Date(input.remindAt) <= new Date()) {
    throw new Error(getMainI18n().t('system:error.reminderTimeMustBeFuture'))
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
  enqueueLocalSyncCreate('reminder', id)
  syncReminderCalendarState(id)
  updateAppBadge()

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

  if (input.remindAt && new Date(input.remindAt) <= new Date()) {
    throw new Error(getMainI18n().t('system:error.reminderTimeMustBeFuture'))
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
  enqueueLocalSyncUpdate('reminder', input.id)
  syncReminderCalendarState(input.id)
  updateAppBadge()

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

  // Snapshot must be captured BEFORE the delete runs (a post-delete read
  // returns undefined) and triggeredAt must be stripped — it is device-local
  // and must never sync. enqueueLocalSyncDelete no-ops on a falsy snapshot,
  // so a missing snapshot here means the delete silently never syncs.
  const { triggeredAt: _triggeredAt, ...snapshot } = reminder

  enqueueLocalSyncDelete('reminder', id, JSON.stringify(snapshot))
  db.delete(reminders).where(eq(reminders.id, id)).run()

  emitEvent(ReminderChannels.events.DELETED, {
    id,
    targetType: reminder.targetType,
    targetId: reminder.targetId
  })
  syncReminderCalendarState(id)
  updateAppBadge()

  logger.info(`Deleted reminder ${id}`)
  return true
}

/**
 * Get a reminder by ID
 * @param id - Reminder ID
 * @returns The reminder or null if not found
 */
export function getReminder(id: string): ReminderWithTarget | null {
  const db = getDatabase()
  const row = db.select().from(reminders).where(eq(reminders.id, id)).get()
  if (!row) return null
  const indexDb = getIndexDatabase()
  return toReminderWithTarget(row, indexDb)
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
  const indexDb = getIndexDatabase()

  return {
    reminders: paginatedRows.map((row) => toReminderWithTarget(row, indexDb)),
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

  const indexDb = getIndexDatabase()
  return rows.map((row) => toReminderWithTarget(row, indexDb))
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
  enqueueLocalSyncUpdate('reminder', id)
  syncReminderCalendarState(id)
  removeDeliveredNotification(id)
  updateAppBadge()

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
  enqueueLocalSyncUpdate('reminder', input.id)
  syncReminderCalendarState(input.id)
  removeDeliveredNotification(input.id)
  updateAppBadge()

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
      enqueueLocalSyncUpdate('reminder', id)
      syncReminderCalendarState(id)
    }
  }

  updateAppBadge()

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
      // Reminders can also mutate outside this module (e.g. note date pills),
      // so refresh the badge on every tick to self-heal a stale count.
      updateAppBadge()
      return
    }

    logger.info(`Found ${dueReminders.length} due reminders`)

    // Mark reminders as triggered
    const db = getDatabase()
    const timestamp = now()

    for (const reminder of dueReminders) {
      // triggeredAt is device-local (see reminder-handler): each device shows its
      // own notification, so this transition must never push.
      db.update(reminders)
        .set({
          status: reminderStatus.TRIGGERED,
          triggeredAt: timestamp,
          modifiedAt: timestamp
        })
        .where(eq(reminders.id, reminder.id))
        .run()
      syncReminderCalendarState(reminder.id)

      // T231: Show desktop notification for each due reminder
      // (targetTitle is already resolved by toReminderWithTarget inside getDueReminders)
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

    // Fired reminders left the pending/snoozed set — reflect that on the badge.
    updateAppBadge()
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

  // Seed the dock/taskbar badge on startup (processDueReminders skips it
  // when the vault is not open yet).
  updateAppBadge()

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
