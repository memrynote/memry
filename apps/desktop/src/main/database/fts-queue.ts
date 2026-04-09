/**
 * FTS Update Queue
 *
 * Batches full-text search index updates to reduce write operations.
 * During rapid edits or bulk imports, individual updates are queued
 * and flushed together after a delay.
 *
 * @module database/fts-queue
 */

import { type IndexDb, getIndexDatabase } from './client'
import { updateFtsContent } from './fts'
import { createLogger } from '../lib/logger'

const logger = createLogger('FTS')

// ============================================================================
// Types
// ============================================================================

interface FtsUpdate {
  noteId: string
  content: string
  tags: string[]
}

// ============================================================================
// Queue State
// ============================================================================

const pendingUpdates = new Map<string, FtsUpdate>()
let flushTimer: NodeJS.Timeout | null = null

/** Delay before flushing queued updates (ms) */
const FLUSH_DELAY_MS = 2000

// ============================================================================
// Public API
// ============================================================================

/**
 * Queue an FTS update for a note.
 * Updates are deduplicated by noteId (latest update wins).
 * Automatically schedules a flush after FLUSH_DELAY_MS.
 *
 * @param noteId - The note's unique ID
 * @param content - The full markdown content to index
 * @param tags - Array of tags to index
 */
export function queueFtsUpdate(noteId: string, content: string, tags: string[]): void {
  // Add or replace in pending map (latest update wins for same note)
  pendingUpdates.set(noteId, { noteId, content, tags })

  // Schedule flush if not already scheduled
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      try {
        const db = getIndexDatabase()
        flushFtsUpdates(db)
      } catch (error) {
        // Database may not be open (vault closed), ignore
        logger.warn('Failed to flush updates:', error)
      }
    }, FLUSH_DELAY_MS)
  }
}

/**
 * Immediately flush all pending FTS updates.
 * Processes all queued updates in a single pass.
 *
 * @param db - Drizzle database instance
 * @returns Number of notes updated
 */
export function flushFtsUpdates(db: IndexDb): number {
  // Cancel pending timer
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  // Nothing to flush
  if (pendingUpdates.size === 0) {
    return 0
  }

  const count = pendingUpdates.size

  // Process all pending updates
  for (const update of pendingUpdates.values()) {
    updateFtsContent(db, update.noteId, update.content, update.tags)
  }

  // Clear the queue
  pendingUpdates.clear()

  return count
}

/**
 * Cancel all pending FTS updates without flushing.
 * Use on vault close when you don't need to persist.
 */
export function cancelPendingFtsUpdates(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingUpdates.clear()
}

/**
 * Get the number of pending FTS updates.
 * Useful for debugging and monitoring.
 */
export function getPendingFtsCount(): number {
  return pendingUpdates.size
}

/**
 * Check if there are pending FTS updates.
 */
export function hasPendingFtsUpdates(): boolean {
  return pendingUpdates.size > 0
}

/**
 * Schedule a flush with a custom delay.
 * Useful for testing or when you want immediate-ish updates.
 *
 * @param db - Drizzle database instance
 * @param delayMs - Delay in milliseconds (default: FLUSH_DELAY_MS)
 */
export function scheduleFlush(db: IndexDb, delayMs: number = FLUSH_DELAY_MS): void {
  // Cancel existing timer
  if (flushTimer) {
    clearTimeout(flushTimer)
  }

  flushTimer = setTimeout(() => {
    flushFtsUpdates(db)
  }, delayMs)
}
