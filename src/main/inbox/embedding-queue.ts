/**
 * Embedding Update Queue
 *
 * Batches embedding computations to reduce model initialization overhead
 * and avoid overwhelming the system during rapid note edits.
 *
 * The queue processes notes in batches with configurable size and delay,
 * using Promise.allSettled for error resilience.
 *
 * @module inbox/embedding-queue
 */

import { createLogger } from '../lib/logger'
import { updateNoteEmbedding } from './suggestions'

const log = createLogger('Inbox:Embeddings')

// ============================================================================
// Configuration
// ============================================================================

/** Maximum number of embeddings to compute in parallel */
const BATCH_SIZE = 10

/** Delay between batches in milliseconds */
const BATCH_DELAY_MS = 500

/** Delay before starting to process queue after first item is added */
const PROCESS_START_DELAY_MS = 1000

// ============================================================================
// Queue State
// ============================================================================

/** Set of note IDs pending embedding update (deduplicated) */
const pendingNoteIds = new Set<string>()

/** Whether the queue is currently being processed */
let isProcessing = false

/** Timer for starting queue processing */
let processTimer: NodeJS.Timeout | null = null

// ============================================================================
// Public API
// ============================================================================

/**
 * Queue a note for embedding update.
 * Duplicate note IDs are automatically deduplicated.
 * Processing starts automatically after PROCESS_START_DELAY_MS.
 *
 * @param noteId - The note's unique ID to update embedding for
 */
export function queueEmbeddingUpdate(noteId: string): void {
  // Add to pending set (automatically dedupes)
  pendingNoteIds.add(noteId)

  // Schedule processing if not already scheduled and not currently processing
  if (!processTimer && !isProcessing) {
    processTimer = setTimeout(() => {
      processTimer = null
      processEmbeddingQueue().catch((err) => {
        log.error('Processing error:', err)
      })
    }, PROCESS_START_DELAY_MS)
  }
}

/**
 * Process all pending embedding updates.
 * Processes in batches of BATCH_SIZE with BATCH_DELAY_MS between batches.
 * Uses Promise.allSettled for error resilience.
 *
 * @returns Results summary
 */
export async function processEmbeddingQueue(): Promise<{
  processed: number
  succeeded: number
  failed: number
}> {
  // Prevent concurrent processing
  if (isProcessing) {
    return { processed: 0, succeeded: 0, failed: 0 }
  }

  // Cancel any pending timer
  if (processTimer) {
    clearTimeout(processTimer)
    processTimer = null
  }

  // Nothing to process
  if (pendingNoteIds.size === 0) {
    return { processed: 0, succeeded: 0, failed: 0 }
  }

  isProcessing = true

  let totalProcessed = 0
  let totalSucceeded = 0
  let totalFailed = 0

  try {
    // Process in batches
    while (pendingNoteIds.size > 0) {
      // Get next batch
      const batch = Array.from(pendingNoteIds).slice(0, BATCH_SIZE)

      // Remove from pending
      for (const noteId of batch) {
        pendingNoteIds.delete(noteId)
      }

      // Process batch in parallel
      const results = await Promise.allSettled(batch.map((noteId) => updateNoteEmbedding(noteId)))

      // Count results
      for (const result of results) {
        totalProcessed++
        if (result.status === 'fulfilled' && result.value === true) {
          totalSucceeded++
        } else {
          totalFailed++
        }
      }

      // Log batch progress
      if (batch.length > 0) {
        log.debug(
          `Processed batch of ${batch.length}: ${totalSucceeded} succeeded, ${totalFailed} failed`
        )
      }

      // Delay before next batch if there are more items
      if (pendingNoteIds.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS))
      }
    }
  } finally {
    isProcessing = false
  }

  return {
    processed: totalProcessed,
    succeeded: totalSucceeded,
    failed: totalFailed
  }
}

/**
 * Clear all pending embedding updates without processing.
 * Use on vault close when you don't need to persist.
 */
export function clearEmbeddingQueue(): void {
  if (processTimer) {
    clearTimeout(processTimer)
    processTimer = null
  }
  pendingNoteIds.clear()
  // Note: If processing is in progress, it will complete its current batch
  // but won't pick up any new items since we cleared the set
}

/**
 * Get the number of pending embedding updates.
 * Useful for debugging and monitoring.
 */
export function getPendingEmbeddingCount(): number {
  return pendingNoteIds.size
}

/**
 * Check if there are pending embedding updates.
 */
export function hasPendingEmbeddings(): boolean {
  return pendingNoteIds.size > 0
}

/**
 * Check if the queue is currently processing.
 */
export function isQueueProcessing(): boolean {
  return isProcessing
}

/**
 * Force immediate processing of the queue.
 * Useful for testing or when you need to ensure embeddings are up to date.
 *
 * @returns Processing results
 */
export async function flushEmbeddingQueue(): Promise<{
  processed: number
  succeeded: number
  failed: number
}> {
  // Cancel pending timer
  if (processTimer) {
    clearTimeout(processTimer)
    processTimer = null
  }

  // Process immediately
  return processEmbeddingQueue()
}
