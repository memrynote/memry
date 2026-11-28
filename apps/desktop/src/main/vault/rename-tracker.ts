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

import type { Stats } from 'fs'
import path from 'path'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { NotesChannels } from '@memry/contracts/ipc-channels'
import type { NoteRenamedEvent } from '@memry/contracts/notes-api'
import { createLogger } from '../lib/logger'
import { birthtimeIsReal } from './birthtime-probe'
import { isAppFolderChange } from './app-folder-changes'

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
  /**
   * Timeout handle for processing real delete. Null for a deferred delete,
   * which waits for `settleDeferredDeletes` on its batch instead of a clock.
   */
  timeout: NodeJS.Timeout | null
  /** Callback to execute if this is a real delete (not a rename) */
  onRealDelete: () => Promise<void>
  /**
   * The path the file's own rename event named, until its add ran. Only the
   * add at that path takes this delete meanwhile.
   */
  renamedTo: string | null
}

/**
 * The deferred deletes one rescan tracked, in tracking order. Settling a batch
 * settles only its own deletes, so overlapping rescans never settle each
 * other's while the other is still adding files.
 */
export type DeferredDeletes = Set<PendingDelete>

export function createDeferredDeletes(): DeferredDeletes {
  return new Set()
}

type IdentityStats = Pick<
  Stats,
  'dev' | 'ino' | 'birthtime' | 'birthtimeMs' | 'ctimeMs' | 'size' | 'mtime'
>

export interface RenameMatch {
  id: string
  oldPath: string
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

/**
 * Give `entry` its rename window. A window that closes while the app is still
 * moving or deleting the entry's folder opens again: the app re-keys the rows
 * only once its move ends, and a move that goes entry by entry (Windows,
 * `moveDirectory`) unlinks each file long before the folder reappears (#5695).
 */
function armRenameWindow(entry: PendingDelete): void {
  entry.timeout = setTimeout(() => {
    if (isAppFolderChange(entry.path)) return armRenameWindow(entry)
    // No matching 'add' event arrived - this is a real delete
    logger.debug(`No rename detected for ${entry.id}, processing as delete`)
    removePending(entry)
    void entry.onRealDelete()
  }, RENAME_WINDOW_MS)
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
 * @param deferred - Arm no window and record the delete in this batch. A
 *   caller that knows every add up front (a rescan) adds them all, then
 *   settles the batch's unmatched deletes with `settleDeferredDeletes`, so a
 *   slow batch of adds cannot outlast a clock.
 * @param renamedTo - The relative path the file's own rename event named. Only
 *   the add at that path takes the delete until `forgetRenameTarget`.
 */
export function trackPendingDelete(
  id: string,
  contentHash: string,
  relativePath: string,
  onRealDelete: () => Promise<void>,
  statKey?: string | null,
  deferred: DeferredDeletes | null = null,
  renamedTo: string | null = null
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
    timeout: null,
    onRealDelete,
    renamedTo
  }

  if (!deferred) armRenameWindow(entry)
  deferred?.add(entry)
  addToIndex(pendingDeletes, contentHash, entry)
  if (entry.statKey !== null) addToIndex(pendingDeletesByStat, entry.statKey, entry)
}

/**
 * The add at the path a delete's rename named ran without taking the delete:
 * that path was not the file's, so any add may take it from now on. A newer
 * delete of the same note, as in a chained rename, keeps the path it named.
 */
export function forgetRenameTarget(id: string, renamedTo: string): void {
  const entry = getPendingDelete(id)
  if (entry?.renamedTo === renamedTo) entry.renamedTo = null
}

/**
 * Check if a newly added file matches a pending delete (indicating a rename).
 * A delete whose rename named this path wins; otherwise identical-hash
 * collisions match FIFO (oldest pending delete first), among deletes no rename
 * named another path for. If a match is found, the pending delete is cleared
 * and the caller is responsible for replaying the rename through
 * projection-safe write paths.
 *
 * @param contentHash - Content hash of the newly added file, or null when it
 *   was not worth computing (no delete was in flight, so no rename is possible)
 * @param newPath - Relative path of the new file
 * @param statKeys - The new file's identity key, then its size + mtime key,
 *   which match a pending delete whose hash could not be compared
 * @returns The matched note id and old path if this was a rename, null if new.
 *   `onRealDelete` is the matched delete's own callback, for a caller that
 *   decides the move is not a rename after all (a journal leaving the journal
 *   folder) and has to finish the delete itself.
 */
export function checkForRename(
  contentHash: string | null,
  newPath: string,
  statKeys: readonly (string | null)[] = []
): RenameMatch | null {
  const candidates = [
    ...(contentHash !== null ? (pendingDeletes.get(contentHash) ?? []) : []),
    ...statKeys.flatMap((statKey) => (statKey ? (pendingDeletesByStat.get(statKey) ?? []) : []))
  ]
  const pending =
    candidates.find((entry) => entry.renamedTo === newPath) ??
    candidates.find((entry) => entry.renamedTo === null)

  if (!pending) {
    // No pending delete with this content - it's a new file
    return null
  }

  logger.info(`Rename detected: ${pending.path} -> ${newPath}`)
  removePending(pending)
  if (pending.timeout) clearTimeout(pending.timeout)

  return { id: pending.id, oldPath: pending.path, onRealDelete: pending.onRealDelete }
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
      if (entry.timeout) clearTimeout(entry.timeout)
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
      if (pending.timeout) clearTimeout(pending.timeout)
      logger.debug(`Cleared pending delete for ${pending.id} (shutdown)`)
    }
  }
  pendingDeletes.clear()
  pendingDeletesByStat.clear()
}

/**
 * Process the batch's deferred deletes that are still pending as real
 * deletes, in the order they were tracked. One an add claimed, or a later
 * track of the same id replaced, is no longer pending and is skipped.
 */
export async function settleDeferredDeletes(batch: DeferredDeletes): Promise<void> {
  const unmatched = [...batch]
  batch.clear()
  for (const pending of unmatched) {
    if (!pendingDeletes.get(pending.contentHash)?.includes(pending)) continue
    if (isAppFolderChange(pending.path)) {
      armRenameWindow(pending)
      continue
    }
    removePending(pending)
    logger.debug(`No rename detected for ${pending.id}, processing as delete`)
    await pending.onRealDelete()
  }
}

/**
 * Drop the batch's deferred deletes that are still pending without running
 * them, for a rescan that failed before its adds finished. Every row stays, and
 * the next rescan finds the files missing again and decides then (#3055).
 */
export function discardDeferredDeletes(batch: DeferredDeletes): number {
  let dropped = 0
  for (const pending of batch) {
    if (!pendingDeletes.get(pending.contentHash)?.includes(pending)) continue
    removePending(pending)
    dropped++
  }
  batch.clear()
  return dropped
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
 * Rename key for a file the watcher saw change but whose index row may trail
 * the change. Device + inode + birthtime tie it to that file, which a rename
 * keeps: an unrelated file of the same size and mtime has another inode, or,
 * where the filesystem hands a freed inode to the next file (ext4), another
 * birthtime. Null when the filesystem reports no inode or no birthtime (0 on
 * some Windows, Linux and network filesystems), so such a file never falls
 * back to size + mtime alone. Where Linux has no statx, libuv reports the
 * ctime as birthtime, and with 1 s timestamps an unrelated file written the
 * same second would share it, so no file gets a key once the startup probe
 * (`probeBirthtime`) finds that. Until the probe answers, a birthtime equal to
 * the ctime counts as none; after it found real birthtimes, a fresh file whose
 * birthtime and ctime share a timestamp tick keeps its key. The probe answers
 * once per process; `birthtime-probe.ts` says when that answer goes stale, and
 * `buildAddedFileIdentityKey` keeps a stale answer from pairing a wrong file.
 */
export function buildFileIdentityKey(stats: IdentityStats): string | null {
  const born = stats.birthtime.getTime()
  if (!stats.ino || !born) return null
  const realBirthtime = birthtimeIsReal()
  if (realBirthtime === false) return null
  if (realBirthtime === null && stats.birthtimeMs === stats.ctimeMs) return null
  return `ino:${stats.dev}:${stats.ino}:${born}:${stats.size}:${stats.mtime.getTime()}`
}

/**
 * Identity key of the file an `add` reports. A renamed file's ctime is past its
 * birthtime: the rename, or a write after its creation, moved it, except a
 * file created and renamed within one timestamp tick. On Linux an add whose
 * birthtime equals its ctime therefore gets no key, and that file's rename
 * only misses its identity match. Once libuv falls
 * back to stat(2) after the probe found real birthtimes, every birthtime is
 * the ctime, so no add pairs by identity, and an unrelated file written on a
 * deleted note's freed inode in the same second never takes that note over.
 */
export function buildAddedFileIdentityKey(stats: IdentityStats): string | null {
  if (process.platform === 'linux' && stats.birthtimeMs === stats.ctimeMs) return null
  return buildFileIdentityKey(stats)
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
export function processRename(
  id: string,
  oldPath: string,
  newPath: string,
  options: { sync?: boolean } = {}
): void {
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

  // A journal's path is never synced (every device derives it from the date),
  // and the callback pushes a `note` item: handing it a journal id would make
  // the server hold the journal under both types.
  if (options.sync !== false) onRenameSyncCallback?.(id)
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
