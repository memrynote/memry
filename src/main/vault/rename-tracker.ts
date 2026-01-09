/**
 * Rename Tracker for UUID-based File Rename Detection
 *
 * Detects file renames by matching UUIDs within a 500ms window.
 * chokidar emits 'unlink' then 'add' for renames - this module
 * tracks pending deletes and matches them with new files by UUID.
 *
 * @module vault/rename-tracker
 */

import path from 'path'
import { BrowserWindow } from 'electron'
import { updateNoteCache } from '@shared/db/queries/notes'
import { getIndexDatabase } from '../database'
import { NotesChannels } from '@shared/ipc-channels'
import type { NoteRenamedEvent } from '@shared/contracts/notes-api'

// ============================================================================
// Configuration
// ============================================================================

/**
 * Time window (ms) to wait for a matching 'add' event after 'unlink'.
 * If no match is found within this window, the delete is processed as real.
 */
const RENAME_WINDOW_MS = 500

// ============================================================================
// Types
// ============================================================================

interface PendingDelete {
  /** Note UUID from frontmatter */
  id: string
  /** Old file path (relative to vault) */
  path: string
  /** Timestamp when delete was detected */
  timestamp: number
  /** Timeout handle for processing real delete */
  timeout: NodeJS.Timeout
  /** Callback to execute if this is a real delete (not a rename) */
  onRealDelete: () => Promise<void>
}

// ============================================================================
// State
// ============================================================================

/**
 * Map of pending deletes keyed by UUID.
 * When a file is deleted, we store its UUID here and wait to see
 * if a new file with the same UUID appears (indicating a rename).
 */
const pendingDeletes = new Map<string, PendingDelete>()

// ============================================================================
// Event Emission
// ============================================================================

/**
 * Emit note renamed event to all renderer windows.
 */
function emitNoteRenamed(event: NoteRenamedEvent): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(NotesChannels.events.RENAMED, {
      ...event,
      source: 'external'
    })
  })
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Track a pending delete. Called when a file is deleted externally.
 * Waits for RENAME_WINDOW_MS to see if a matching 'add' event arrives.
 *
 * @param id - Note UUID from cache (before file was deleted)
 * @param relativePath - Relative path of the deleted file
 * @param onRealDelete - Callback to execute if this is a real delete
 */
export function trackPendingDelete(
  id: string,
  relativePath: string,
  onRealDelete: () => Promise<void>
): void {
  // Clear any existing pending for this ID (shouldn't happen, but be safe)
  clearPendingDelete(id)

  console.log(`[RenameTracker] Tracking pending delete: ${id} at ${relativePath}`)

  const timeout = setTimeout(() => {
    // No matching 'add' event arrived - this is a real delete
    const pending = pendingDeletes.get(id)
    if (pending) {
      console.log(`[RenameTracker] No rename detected for ${id}, processing as delete`)
      pendingDeletes.delete(id)
      void pending.onRealDelete()
    }
  }, RENAME_WINDOW_MS)

  pendingDeletes.set(id, {
    id,
    path: relativePath,
    timestamp: Date.now(),
    timeout,
    onRealDelete
  })
}

/**
 * Check if a newly added file matches a pending delete (indicating a rename).
 * If a match is found, the rename is processed and the pending delete is cleared.
 *
 * @param id - Note UUID from the newly added file's frontmatter
 * @param newPath - Relative path of the new file
 * @returns The old path if this was a rename, null if it's a new file
 */
export function checkForRename(id: string, newPath: string): string | null {
  const pending = pendingDeletes.get(id)

  if (!pending) {
    // No pending delete with this UUID - it's a new file
    return null
  }

  // Found a match! This is a rename.
  console.log(`[RenameTracker] Rename detected: ${pending.path} -> ${newPath}`)

  // Clear the timeout and pending entry
  clearTimeout(pending.timeout)
  pendingDeletes.delete(id)

  // Process the rename
  processRename(id, pending.path, newPath)

  return pending.path
}

/**
 * Clear a pending delete (e.g., when matched as a rename or on shutdown).
 *
 * @param id - Note UUID to clear
 */
export function clearPendingDelete(id: string): void {
  const pending = pendingDeletes.get(id)
  if (pending) {
    clearTimeout(pending.timeout)
    pendingDeletes.delete(id)
    console.log(`[RenameTracker] Cleared pending delete for ${id}`)
  }
}

/**
 * Clear all pending deletes (e.g., on watcher shutdown).
 */
export function clearAllPendingDeletes(): void {
  for (const [id, pending] of pendingDeletes) {
    clearTimeout(pending.timeout)
    console.log(`[RenameTracker] Cleared pending delete for ${id} (shutdown)`)
  }
  pendingDeletes.clear()
}

/**
 * Check if there are any pending deletes.
 */
export function hasPendingDeletes(): boolean {
  return pendingDeletes.size > 0
}

/**
 * Get the count of pending deletes.
 */
export function getPendingDeleteCount(): number {
  return pendingDeletes.size
}

// ============================================================================
// Internal Functions
// ============================================================================

/**
 * Process a detected rename: update the cache and emit event.
 *
 * @param id - Note UUID
 * @param oldPath - Old relative path
 * @param newPath - New relative path
 */
function processRename(id: string, oldPath: string, newPath: string): void {
  const db = getIndexDatabase()

  // Extract old and new titles from filenames
  const oldTitle = path.basename(oldPath, '.md')
  const newTitle = path.basename(newPath, '.md')
  const now = new Date().toISOString()

  // Update the cache with new path and title
  const updated = updateNoteCache(db, id, {
    path: newPath,
    title: newTitle,
    modifiedAt: now
  })

  if (!updated) {
    console.error(`[RenameTracker] Failed to update cache for ${id}`)
    return
  }

  console.log(`[RenameTracker] Updated cache: ${oldPath} -> ${newPath}`)

  // Emit rename event to renderer
  const event: NoteRenamedEvent = {
    id,
    oldPath,
    newPath,
    oldTitle,
    newTitle
  }

  emitNoteRenamed(event)
  console.log(`[RenameTracker] Emitted RENAMED event for ${id}`)
}

/**
 * Get a pending delete by ID (for testing/debugging).
 */
export function getPendingDelete(id: string): PendingDelete | undefined {
  return pendingDeletes.get(id)
}
