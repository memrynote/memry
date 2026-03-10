/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
// Dynamic require for circular dependency avoidance returns untyped module

/**
 * Inbox Snooze Service
 *
 * Handles snoozing inbox items to resurface them at a later time.
 * Includes scheduler that checks for due items every minute.
 *
 * @module inbox/snooze
 */

import { BrowserWindow } from 'electron'
import { eq, and, isNotNull, lte, isNull } from 'drizzle-orm'
import { createLogger } from '../lib/logger'
import { getDatabase, type DrizzleDb } from '../database'
import { getStatus } from '../vault'
import { inboxItems, inboxItemTags } from '@memry/db-schema/schema/inbox'
import { InboxChannels } from '@memry/contracts/ipc-channels'
import type { InboxItem, InboxItemListItem } from '@memry/contracts/inbox-api'

const log = createLogger('Inbox:Snooze')

// ============================================================================
// Types
// ============================================================================

export interface SnoozeInput {
  itemId: string
  snoozeUntil: string // ISO datetime string
  reason?: string
}

export interface SnoozeResult {
  success: boolean
  item?: InboxItem
  error?: string
}

export interface SnoozedItem {
  id: string
  type: string
  title: string
  content: string | null
  createdAt: Date
  snoozedUntil: Date
  snoozeReason: string | null
  thumbnailUrl: string | null
  sourceUrl: string | null
  tags: string[]
}

// ============================================================================
// Constants
// ============================================================================

/** Scheduler check interval in milliseconds (1 minute) */
const SCHEDULER_INTERVAL_MS = 60 * 1000

// ============================================================================
// Module State
// ============================================================================

/** Reference to the scheduler interval */
let schedulerInterval: NodeJS.Timeout | null = null

/** Flag to track if scheduler is running */
let isSchedulerRunning = false

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get database instance, throwing if not available
 */
function requireDatabase(): DrizzleDb {
  try {
    return getDatabase()
  } catch {
    throw new Error('No vault is open. Please open a vault first.')
  }
}

/**
 * Emit snooze event to all windows
 */
function emitSnoozeEvent(channel: string, data: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, data)
  })
}

/**
 * Resolve attachment URL for renderer
 */
function resolveAttachmentUrl(path: string | null): string | null {
  if (!path) return null
  // Import dynamically to avoid circular dependency
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { resolveAttachmentUrl: resolve } = require('./attachments')
    return resolve(path)
  } catch {
    return null
  }
}

/**
 * Get tags for an inbox item
 */
function getItemTags(db: ReturnType<typeof getDatabase>, itemId: string): string[] {
  const tags = db.select().from(inboxItemTags).where(eq(inboxItemTags.itemId, itemId)).all()
  return tags.map((t) => t.tag)
}

/**
 * Convert database row to InboxItem
 */
function toInboxItem(row: typeof inboxItems.$inferSelect, tags: string[]): InboxItem {
  return {
    id: row.id,
    type: row.type as InboxItem['type'],
    title: row.title,
    content: row.content,
    createdAt: new Date(row.createdAt),
    modifiedAt: new Date(row.modifiedAt),
    filedAt: row.filedAt ? new Date(row.filedAt) : null,
    filedTo: row.filedTo,
    filedAction: row.filedAction as InboxItem['filedAction'],
    snoozedUntil: row.snoozedUntil ? new Date(row.snoozedUntil) : null,
    snoozeReason: row.snoozeReason,
    viewedAt: row.viewedAt ? new Date(row.viewedAt) : null,
    archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
    processingStatus: (row.processingStatus || 'complete') as InboxItem['processingStatus'],
    processingError: row.processingError,
    metadata: row.metadata as InboxItem['metadata'],
    attachmentPath: row.attachmentPath,
    attachmentUrl: resolveAttachmentUrl(row.attachmentPath),
    thumbnailPath: row.thumbnailPath,
    thumbnailUrl: resolveAttachmentUrl(row.thumbnailPath),
    transcription: row.transcription,
    transcriptionStatus: row.transcriptionStatus as InboxItem['transcriptionStatus'],
    sourceUrl: row.sourceUrl,
    sourceTitle: row.sourceTitle,
    captureSource: row.captureSource as InboxItem['captureSource'],
    tags,
    isStale: false // Snoozed items are not considered stale
  }
}

/**
 * Convert database row to list item (lighter weight)
 */
function toListItem(row: typeof inboxItems.$inferSelect, tags: string[]): InboxItemListItem {
  const metadata = row.metadata as Record<string, unknown> | null

  return {
    id: row.id,
    type: row.type as InboxItemListItem['type'],
    title: row.title,
    content: row.content,
    createdAt: new Date(row.createdAt),
    thumbnailUrl: resolveAttachmentUrl(row.thumbnailPath),
    sourceUrl: row.sourceUrl,
    tags,
    isStale: false,
    processingStatus: (row.processingStatus || 'complete') as InboxItemListItem['processingStatus'],
    duration: metadata?.duration as number | undefined,
    excerpt: metadata?.excerpt as string | undefined,
    pageCount: metadata?.pageCount as number | undefined,
    transcription: row.transcription,
    transcriptionStatus: row.transcriptionStatus as InboxItemListItem['transcriptionStatus'],
    // Snooze-specific fields
    snoozedUntil: row.snoozedUntil ? new Date(row.snoozedUntil) : undefined,
    snoozeReason: row.snoozeReason || undefined
  }
}

// ============================================================================
// Core Snooze Functions
// ============================================================================

/**
 * Snooze an inbox item until a specified time
 *
 * @param input - Snooze input with itemId, snoozeUntil, and optional reason
 * @returns Result with updated item or error
 */
export function snoozeItem(input: SnoozeInput): SnoozeResult {
  try {
    const db = requireDatabase()
    const { itemId, snoozeUntil, reason } = input

    // Validate snooze time is in the future
    const snoozeDate = new Date(snoozeUntil)
    if (isNaN(snoozeDate.getTime())) {
      return { success: false, error: 'Invalid snooze date format' }
    }

    if (snoozeDate <= new Date()) {
      return { success: false, error: 'Snooze time must be in the future' }
    }

    // Check item exists and is not already filed
    const existing = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
    if (!existing) {
      return { success: false, error: 'Item not found' }
    }

    if (existing.filedAt) {
      return { success: false, error: 'Cannot snooze a filed item' }
    }

    // Update item with snooze info
    const now = new Date().toISOString()
    db.update(inboxItems)
      .set({
        snoozedUntil: snoozeUntil,
        snoozeReason: reason || null,
        modifiedAt: now
      })
      .where(eq(inboxItems.id, itemId))
      .run()

    // Fetch updated item
    const updated = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
    if (!updated) {
      return { success: false, error: 'Failed to fetch updated item' }
    }

    const tags = getItemTags(db, itemId)
    const item = toInboxItem(updated, tags)

    // Emit snoozed event
    emitSnoozeEvent(InboxChannels.events.SNOOZED, {
      id: itemId,
      snoozeUntil: snoozeUntil
    })

    log.info(`Item ${itemId} snoozed until ${snoozeUntil}`)

    return { success: true, item }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Error snoozing item:', message)
    return { success: false, error: message }
  }
}

/**
 * Unsnooze an inbox item immediately
 *
 * @param itemId - ID of the item to unsnooze
 * @returns Result with updated item or error
 */
export function unsnoozeItem(itemId: string): SnoozeResult {
  try {
    const db = requireDatabase()

    // Check item exists
    const existing = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
    if (!existing) {
      return { success: false, error: 'Item not found' }
    }

    if (!existing.snoozedUntil) {
      return { success: false, error: 'Item is not snoozed' }
    }

    // Clear snooze status
    const now = new Date().toISOString()
    db.update(inboxItems)
      .set({
        snoozedUntil: null,
        snoozeReason: null,
        modifiedAt: now
      })
      .where(eq(inboxItems.id, itemId))
      .run()

    // Fetch updated item
    const updated = db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get()
    if (!updated) {
      return { success: false, error: 'Failed to fetch updated item' }
    }

    const tags = getItemTags(db, itemId)
    const item = toInboxItem(updated, tags)

    log.info(`Item ${itemId} unsnoozed`)

    return { success: true, item }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    log.error('Error unsnoozing item:', message)
    return { success: false, error: message }
  }
}

/**
 * Get all snoozed items (not yet due)
 *
 * @returns Array of snoozed items ordered by snooze due time
 */
export function getSnoozedItems(): SnoozedItem[] {
  try {
    const db = requireDatabase()

    // Get items where snoozedUntil is set and in the future
    const rows = db
      .select()
      .from(inboxItems)
      .where(
        and(
          isNotNull(inboxItems.snoozedUntil),
          isNull(inboxItems.filedAt)
          // Note: We include all snoozed items, even past-due ones,
          // since the scheduler handles surfacing them
        )
      )
      .orderBy(inboxItems.snoozedUntil)
      .all()

    return rows.map((row) => {
      const tags = getItemTags(db, row.id)
      return {
        id: row.id,
        type: row.type,
        title: row.title,
        content: row.content,
        createdAt: new Date(row.createdAt),
        snoozedUntil: new Date(row.snoozedUntil!),
        snoozeReason: row.snoozeReason,
        thumbnailUrl: resolveAttachmentUrl(row.thumbnailPath),
        sourceUrl: row.sourceUrl,
        tags
      }
    })
  } catch (error) {
    log.error('Error getting snoozed items:', error)
    return []
  }
}

/**
 * Get items whose snooze time has passed (due items)
 *
 * @returns Array of items that need to be surfaced
 */
export function getDueSnoozeItems(): InboxItemListItem[] {
  try {
    const db = requireDatabase()
    const nowStr = new Date().toISOString()

    // Get items where snoozedUntil <= now
    const rows = db
      .select()
      .from(inboxItems)
      .where(
        and(
          isNotNull(inboxItems.snoozedUntil),
          lte(inboxItems.snoozedUntil, nowStr),
          isNull(inboxItems.filedAt)
        )
      )
      .all()

    return rows.map((row) => {
      const tags = getItemTags(db, row.id)
      return toListItem(row, tags)
    })
  } catch (error) {
    log.error('Error getting due snooze items:', error)
    return []
  }
}

// ============================================================================
// Snooze Scheduler
// ============================================================================

/**
 * Process items that have become due
 * Clears their snooze status and emits events
 */
function processDueItems(): void {
  if (!getStatus().isOpen) return

  try {
    const dueItems = getDueSnoozeItems()

    if (dueItems.length === 0) {
      return
    }

    log.debug(`Processing ${dueItems.length} due items`)

    const db = requireDatabase()
    const now = new Date().toISOString()

    // Clear snooze status for all due items
    for (const item of dueItems) {
      db.update(inboxItems)
        .set({
          snoozedUntil: null,
          snoozeReason: null,
          modifiedAt: now
        })
        .where(eq(inboxItems.id, item.id))
        .run()
    }

    // Emit SNOOZE_DUE event with all surfaced items
    emitSnoozeEvent(InboxChannels.events.SNOOZE_DUE, {
      count: dueItems.length,
      items: dueItems
    })

    log.info(`Surfaced ${dueItems.length} items`)
  } catch (error) {
    log.error('Error processing due items:', error)
  }
}

/**
 * Check for due items on app startup
 * Processes any items that became due while app was closed
 */
export function checkDueItemsOnStartup(): void {
  processDueItems()
}

/**
 * Start the snooze scheduler
 * Checks for due items every minute
 */
export function startSnoozeScheduler(): void {
  if (isSchedulerRunning) {
    log.debug('Scheduler already running')
    return
  }

  // Run immediately on start
  processDueItems()

  // Then run every minute
  schedulerInterval = setInterval(() => {
    processDueItems()
  }, SCHEDULER_INTERVAL_MS)

  isSchedulerRunning = true
}

/**
 * Stop the snooze scheduler
 */
export function stopSnoozeScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
    isSchedulerRunning = false
    log.info('Scheduler stopped')
  }
}

/**
 * Check if scheduler is currently running
 */
export function isSchedulerActive(): boolean {
  return isSchedulerRunning
}

// ============================================================================
// Bulk Snooze
// ============================================================================

/**
 * Snooze multiple items at once
 *
 * @param itemIds - Array of item IDs to snooze
 * @param snoozeUntil - ISO datetime string for when to surface items
 * @param reason - Optional reason for snoozing
 * @returns Result with processed count and errors
 */
export function bulkSnoozeItems(
  itemIds: string[],
  snoozeUntil: string,
  reason?: string
): { success: boolean; processedCount: number; errors: Array<{ itemId: string; error: string }> } {
  const errors: Array<{ itemId: string; error: string }> = []
  let processedCount = 0

  for (const itemId of itemIds) {
    const result = snoozeItem({ itemId, snoozeUntil, reason })
    if (result.success) {
      processedCount++
    } else {
      errors.push({ itemId, error: result.error || 'Unknown error' })
    }
  }

  return {
    success: errors.length === 0,
    processedCount,
    errors
  }
}
