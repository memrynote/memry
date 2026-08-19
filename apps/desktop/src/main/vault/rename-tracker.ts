/**
 * Rename Tracker for content-hash-based File Rename Detection
 *
 * Detects file renames by matching content hashes within a 500ms window.
 * chokidar emits 'unlink' then 'add' for renames - this module tracks
 * pending deletes (keyed by the cached content hash) and matches them with
 * new files by hash. Files carry no Memry identity; the internal id lives
 * in the sidecar DBs and is returned from the match.
 *
 * @module vault/rename-tracker
 */

import path from 'path'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { NotesChannels } from '@memry/contracts/ipc-channels'
import type { NoteRenamedEvent } from '@memry/contracts/notes-api'
import { createLogger } from '../lib/logger'

const logger = createLogger('RenameTracker')

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
  /** Internal note id (from the sidecar cache row) */
  id: string
  /** Content hash of the deleted file (from the cache row) */
  contentHash: string
  /**
   * Size + mtime of the deleted file, for a row whose body has not been read
   * yet and therefore has no cached content hash. Null when a hash exists.
   */
  statKey: string | null
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
 * Pending deletes keyed by content hash. When a file is deleted, we store
 * its cached hash here and wait to see if a new file with the same content
 * appears (indicating a rename). Identical-content collisions queue FIFO —
 * the oldest pending delete matches first.
 */
const pendingDeletes = new Map<string, PendingDelete[]>()

/**
 * The same pending deletes, keyed by `statKey`, for rows the tier-1 backfill
 * has not reached yet. Those carry no content hash, and the new file cannot be
 * hashed for free either — but a rename changes neither size nor mtime, and
 * both are already on the cache row and in the `add` event's `stat`.
 */
const pendingDeletesByStat = new Map<string, PendingDelete[]>()

let onRenameSyncCallback: ((id: string) => void) | null = null

export function registerRenameSyncCallback(cb: (id: string) => void): void {
  onRenameSyncCallback = cb
}

export function unregisterRenameSyncCallback(): void {
  onRenameSyncCallback = null
}

// ============================================================================
// Event Emission
// ============================================================================

/**
 * Emit note renamed event to all renderer windows.
 */
function emitNoteRenamed(event: NoteRenamedEvent): void {
  broadcastToAllWindows(NotesChannels.events.RENAMED, {
    ...event,
    source: 'external'
  })
}

// ============================================================================
// Public API
// ============================================================================

function removeFromIndex(
  index: Map<string, PendingDelete[]>,
  key: string,
  entry: PendingDelete
): void {
  const bucket = index.get(key)
  if (!bucket) return
  const position = bucket.indexOf(entry)
  if (position !== -1) bucket.splice(position, 1)
  if (bucket.length === 0) index.delete(key)
}

function removePending(entry: PendingDelete): void {
  removeFromIndex(pendingDeletes, entry.contentHash, entry)
  if (entry.statKey !== null) removeFromIndex(pendingDeletesByStat, entry.statKey, entry)
}

function addToIndex(index: Map<string, PendingDelete[]>, key: string, entry: PendingDelete): void {
  const bucket = index.get(key)
  if (bucket) {
    bucket.push(entry)
  } else {
    index.set(key, [entry])
  }
}

function takeMatch(index: Map<string, PendingDelete[]>, key: string): PendingDelete | null {
  const bucket = index.get(key)
  if (!bucket || bucket.length === 0) return null
  // FIFO: oldest pending delete wins.
  const pending = bucket[0]
  removePending(pending)
  return pending
}

/**
 * Track a pending delete. Called when a file is deleted externally.
 * Waits for RENAME_WINDOW_MS to see if a matching 'add' event arrives.
 *
 * @param id - Internal note id from the cache row (before file was deleted)
 * @param contentHash - Content hash from the cache row
 * @param relativePath - Relative path of the deleted file
 * @param onRealDelete - Callback to execute if this is a real delete
 * @param statKey - Size + mtime of the deleted file, for a row that has no
 *   cached content hash yet. Ignored when a hash is available.
 */
export function trackPendingDelete(
  id: string,
  contentHash: string,
  relativePath: string,
  onRealDelete: () => Promise<void>,
  statKey?: string | null
): void {
  // Clear any existing pending for this id (shouldn't happen, but be safe)
  clearPendingDelete(id)

  logger.debug(`Tracking pending delete: ${id} at ${relativePath}`)

  const entry: PendingDelete = {
    id,
    contentHash,
    statKey: statKey ?? null,
    path: relativePath,
    timestamp: Date.now(),
    timeout: setTimeout(() => {
      // No matching 'add' event arrived - this is a real delete
      logger.debug(`No rename detected for ${id}, processing as delete`)
      removePending(entry)
      void entry.onRealDelete()
    }, RENAME_WINDOW_MS),
    onRealDelete
  }

  addToIndex(pendingDeletes, contentHash, entry)
  if (entry.statKey !== null) addToIndex(pendingDeletesByStat, entry.statKey, entry)
}

/**
 * Check if a newly added file matches a pending delete (indicating a rename).
 * Identical-hash collisions match FIFO (oldest pending delete first). If a
 * match is found, the pending delete is cleared and the caller is responsible
 * for replaying the rename through projection-safe write paths.
 *
 * @param contentHash - Content hash of the newly added file, or null when it
 *   was not worth computing (no delete was in flight, so no rename is possible)
 * @param newPath - Relative path of the new file
 * @param statKey - Size + mtime of the new file, which matches a pending delete
 *   whose body was never read and therefore has no hash to compare
 * @returns The matched note id and old path if this was a rename, null if new
 */
export function checkForRename(
  contentHash: string | null,
  newPath: string,
  statKey?: string | null
): { id: string; oldPath: string } | null {
  const pending =
    (contentHash !== null ? takeMatch(pendingDeletes, contentHash) : null) ??
    (statKey ? takeMatch(pendingDeletesByStat, statKey) : null)

  if (!pending) {
    // No pending delete with this content - it's a new file
    return null
  }

  logger.info(`Rename detected: ${pending.path} -> ${newPath}`)
  clearTimeout(pending.timeout)

  return { id: pending.id, oldPath: pending.path }
}

/**
 * Clear a pending delete (e.g., when matched as a rename or on shutdown).
 *
 * @param id - Internal note id to clear
 */
export function clearPendingDelete(id: string): void {
  for (const bucket of pendingDeletes.values()) {
    const entry = bucket.find((p) => p.id === id)
    if (entry) {
      clearTimeout(entry.timeout)
      removePending(entry)
      logger.debug(`Cleared pending delete for ${id}`)
      return
    }
  }
}

/**
 * Clear all pending deletes (e.g., on watcher shutdown).
 */
export function clearAllPendingDeletes(): void {
  for (const bucket of pendingDeletes.values()) {
    for (const pending of bucket) {
      clearTimeout(pending.timeout)
      logger.debug(`Cleared pending delete for ${pending.id} (shutdown)`)
    }
  }
  pendingDeletes.clear()
  pendingDeletesByStat.clear()
}

/**
 * Rename key for a file whose body has not been read. A rename changes neither
 * size nor mtime, so the pair identifies the same bytes at a new path without
 * opening the file.
 */
export function buildStatRenameKey(
  fileSize: number | null,
  modifiedAt: string | null
): string | null {
  if (fileSize === null || modifiedAt === null) return null
  const modifiedMs = new Date(modifiedAt).getTime()
  if (Number.isNaN(modifiedMs)) return null
  return `${fileSize}:${modifiedMs}`
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
  let total = 0
  for (const bucket of pendingDeletes.values()) total += bucket.length
  return total
}

// ============================================================================
// Internal Functions
// ============================================================================

/**
 * Process a detected rename after the caller has updated canonical state and
 * published the corresponding projection event.
 *
 * @param id - Note UUID
 * @param oldPath - Old relative path
 * @param newPath - New relative path
 */
export function processRename(id: string, oldPath: string, newPath: string): void {
  // Extract old and new titles from filenames
  const oldTitle = path.basename(oldPath, '.md')
  const newTitle = path.basename(newPath, '.md')
  logger.debug(`Processed rename: ${oldPath} -> ${newPath}`)

  // Emit rename event to renderer
  const event: NoteRenamedEvent = {
    id,
    oldPath,
    newPath,
    oldTitle,
    newTitle
  }

  emitNoteRenamed(event)
  logger.debug(`Emitted RENAMED event for ${id}`)

  onRenameSyncCallback?.(id)
}

/**
 * Get a pending delete by note id (for testing/debugging).
 */
export function getPendingDelete(id: string): PendingDelete | undefined {
  for (const bucket of pendingDeletes.values()) {
    const entry = bucket.find((p) => p.id === id)
    if (entry) return entry
  }
  return undefined
}
