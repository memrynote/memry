/**
 * File Watcher for External Change Detection
 *
 * Uses chokidar to watch vault folders for external file changes.
 * Updates the cache and emits IPC events to renderer.
 *
 * @module vault/watcher
 */

import path from 'path'
import fs from 'fs/promises'
import type { Stats } from 'fs'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { getConfig } from './index'
import {
  parseNote,
  generateContentHash,
  extractProperties,
  extractTitleFromPath
} from './frontmatter'
import { safeRead } from './file-ops'
import { scanMarkdownFile } from './file-scan'
import { enqueueIngestBackfill, clearIngestBackfill } from './ingest-backfill'
import { generateNoteId } from '../lib/id'
import {
  syncNoteToCache,
  syncNoteStatToCache,
  syncFileToCache,
  deleteNoteFromCache,
  findCanonicalNoteByPath
} from './note-sync'
import {
  getNoteCacheByPath,
  getNoteCacheById,
  ensureTagDefinitions,
  isJournalEntry,
  extractDateFromPath
} from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'
import { NotesChannels, JournalChannels } from '@memry/contracts/ipc-channels'
import {
  trackPendingDelete,
  checkForRename,
  clearAllPendingDeletes,
  hasPendingDeletes,
  buildStatRenameKey,
  processRename
} from './rename-tracker'
import { isSupportedPath, getFileType, getMimeType, getExtension } from '@memry/shared/file-types'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { isWritebackIgnored } from '../sync/crdt-writeback'
import { attachmentEvents } from '../sync/attachment-events'
import { flushProjectionEvents } from '../projections'
import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { reconcileTaskCheckboxesFromMarkdown } from '../tasks/reconcile-markdown-tasks'
import { enqueueJournalDelete } from '../journal/runtime-effects'
import { syncNoteCreate, syncNoteDelete, syncNoteUpdate } from '../notes/runtime-effects'
import { normalizeRelativePath } from '../lib/paths'

const logger = createLogger('Watcher')

// ============================================================================
// Types
// ============================================================================

interface NoteListItem {
  id: string
  path: string
  title: string
  created: Date
  modified: Date
  tags: string[]
  /** Null until the tier-1 backfill has measured the body. */
  wordCount: number | null
  snippet?: string | null
  localOnly?: boolean
}

interface WatcherOptions {
  vaultPath: string
  excludePatterns?: string[]
  onError?: (error: Error) => void
}

// ============================================================================
// Debounce Utility
// ============================================================================

/**
 * Creates a debounced function that batches calls by path.
 * Waits for 100ms of inactivity before processing.
 */
function createPathDebouncer(
  handler: (filePath: string) => Promise<void>,
  delayMs: number = 100
): (filePath: string) => void {
  const pending = new Map<string, NodeJS.Timeout>()

  return (filePath: string) => {
    // Clear any existing timeout for this path
    const existingTimeout = pending.get(filePath)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
    }

    // Set new timeout
    const timeout = setTimeout(() => {
      pending.delete(filePath)
      handler(filePath).catch((error: unknown) => {
        logger.error(`Error processing ${filePath}:`, error)
      })
    }, delayMs)

    pending.set(filePath, timeout)
  }
}

// ============================================================================
// Event Emission
// ============================================================================

/**
 * Emit event to all renderer windows.
 */
function emitEvent(channel: string, payload: unknown): void {
  broadcastToAllWindows(channel, payload)
}

/**
 * Check if a path is a journal entry, per the active vault's journal folder +
 * date format (delegates to the shared config-aware detector).
 */
function isJournalPath(relativePath: string): boolean {
  return isJournalEntry(relativePath)
}

/**
 * Extract the canonical ISO date (YYYY-MM-DD) from a journal path.
 */
function extractJournalDate(relativePath: string): string {
  return extractDateFromPath(relativePath) ?? ''
}

/** Cache timestamps come back as an ISO string or a Date, depending on driver. */
function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : value
}

// ============================================================================
// VaultWatcher Class
// ============================================================================

export class VaultWatcher {
  private watcher: FSWatcher | null = null
  private vaultPath: string | null = null
  private excludePatterns: string[] = []
  private onError?: (error: Error) => void
  private isReady = false

  // Debounced handlers
  private debouncedChange: ((path: string) => void) | null = null

  /**
   * Start watching the vault for file changes.
   */
  async start(options: WatcherOptions): Promise<void> {
    const { vaultPath, excludePatterns = [], onError } = options

    if (this.watcher) {
      await this.stop()
    }

    this.vaultPath = vaultPath
    this.excludePatterns = excludePatterns
    this.onError = onError
    this.isReady = false

    // Watch the entire vault root. The `ignored` filter below drops dotfolders
    // (.memry, .obsidian, .git) and excluded dirs; the attachments folder is added
    // to the exclude set so binaries are not watched/indexed as notes.
    const config = getConfig()
    const watchPaths = [vaultPath]

    // Create debounced handlers
    this.debouncedChange = createPathDebouncer((filePath) => this.handleFileChange(filePath), 100)

    // Capture exclude patterns for use in ignored function
    const userExcludePatterns = [...this.excludePatterns, config.attachmentsFolder].filter(Boolean)

    // Create watcher with chokidar
    this.watcher = chokidar.watch(watchPaths, {
      persistent: true,

      // Ignore hidden files, excluded patterns, unsupported file types
      ignored: (filePath: string, stats) => {
        const basename = path.basename(filePath)

        // Always ignore hidden files and directories
        if (basename.startsWith('.')) return true

        // Check user-defined exclude patterns
        for (const pattern of userExcludePatterns) {
          // Exact match (e.g., 'node_modules', '.git')
          if (basename === pattern) return true
          // Check if file is inside an excluded directory
          if (filePath.includes(`/${pattern}/`) || filePath.includes(`\\${pattern}\\`)) return true
        }

        // For files, only watch supported file types (md, pdf, images, audio, video)
        if (stats?.isFile()) {
          return !isSupportedPath(filePath)
        }

        return false
      },

      // Wait for file writes to complete (100ms stability)
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50
      },

      // Handle atomic writes (temp file -> rename pattern)
      atomic: true,

      // Skip initial scan events (files already in cache)
      ignoreInitial: true,

      // Watch recursively with deep nesting support
      depth: 99,

      // Don't follow symlinks for security
      followSymlinks: false,

      // Use native OS APIs (not polling)
      usePolling: false
    })

    // Set up event handlers
    this.watcher
      .on('add', (filePath) => void this.handleFileAdd(filePath))
      .on('change', (filePath) => this.debouncedChange?.(filePath))
      .on('unlink', (filePath) => void this.handleFileDelete(filePath))
      .on('ready', () => {
        this.isReady = true
      })
      .on('error', (err) => {
        const error = err instanceof Error ? err : new Error(String(err))
        logger.error('Error:', error)
        this.onError?.(error)
      })

    // Wait for ready state
    await new Promise<void>((resolve) => {
      if (this.isReady) {
        resolve()
      } else {
        this.watcher?.once('ready', () => resolve())
      }
    })
  }

  /**
   * Stop watching the vault.
   */
  async stop(): Promise<void> {
    // Clear any pending rename detections
    clearAllPendingDeletes()
    // Drop queued backfills: they belong to the vault being closed.
    clearIngestBackfill()

    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }
    this.vaultPath = null
    this.debouncedChange = null
    this.isReady = false
  }

  /**
   * Check if the watcher is currently active.
   */
  isWatching(): boolean {
    return this.watcher !== null && this.isReady
  }

  // ==========================================================================
  // File Event Handlers
  // ==========================================================================

  /**
   * Handle new file creation.
   * Also checks if this might be a rename (matching UUID with pending delete).
   * Supports all file types: markdown, pdf, images, audio, video.
   */
  private async handleFileAdd(absolutePath: string): Promise<void> {
    if (!this.vaultPath) return

    if (isWritebackIgnored(absolutePath)) return

    try {
      const relativePath = normalizeRelativePath(path.relative(this.vaultPath, absolutePath))
      const fileType = getFileType(getExtension(absolutePath))

      if (!fileType) {
        return
      }

      const db = getIndexDatabase()

      const existing = getNoteCacheByPath(db, relativePath)
      if (existing) {
        return
      }

      // The index cache is derived: it is rebuilt, and the projector that fills
      // it runs behind the canonical write, so "no cache row" does not mean
      // "the vault has never seen this path". The canonical row is the one with
      // a unique path, and if it is already there this add has to adopt its id.
      const claimed = findCanonicalNoteByPath(relativePath)

      if (fileType === 'markdown') {
        await this.handleMarkdownFileAdd(absolutePath, relativePath, db, claimed)
      } else {
        await this.handleNonMarkdownFileAdd(
          absolutePath,
          relativePath,
          fileType,
          db,
          claimed?.id ?? null
        )
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      // A thrown add costs the user a sidebar row and says nothing on screen,
      // so it has to be countable rather than left to a promise nobody awaits.
      logger.error('Failed to add file', { path: absolutePath, error })
      trackMainError('vault', 'file_add', error)
      this.onError?.(error)
    }
  }

  /**
   * Tier 0 of ingest: list the file from `stat`, the path and the filename.
   *
   * The file is not read. Everything a sidebar row needs is here, and reading
   * the body to get the rest cost a multi-hundred-megabyte allocation and a
   * main-process GC pause for a large paste. The idle backfill fills in word
   * count, snippet, tags and search, and decides whether the file may have a
   * CRDT doc — a decision that needs its largest block, which needs the body.
   */
  private async handleMarkdownFileAdd(
    absolutePath: string,
    relativePath: string,
    db: ReturnType<typeof getIndexDatabase>,
    claimed: { id: string; createdAt: string } | null
  ): Promise<void> {
    const stats = await fs.stat(absolutePath).catch(() => null)
    if (!stats) {
      return
    }

    const renameMatch = await this.matchPendingRename(absolutePath, relativePath, stats)
    if (renameMatch !== null) {
      await this.applyMarkdownRename(db, relativePath, stats, renameMatch)
      return
    }

    // Genuinely new external file: fresh internal id, fs-stat dates. A path the
    // vault already has a canonical row for keeps that row's id and created
    // date, and updates rather than inserts — a stat-only full save would erase
    // bookkeeping a `stat` cannot reconstruct.
    // No watcher path writes files.
    const noteId = claimed?.id ?? generateNoteId()
    const title = extractTitleFromPath(relativePath)
    const createdAt = claimed?.createdAt ?? stats.birthtime.toISOString()
    const modifiedAt = stats.mtime.toISOString()

    syncNoteStatToCache(
      db,
      {
        id: noteId,
        path: relativePath,
        title,
        createdAt,
        modifiedAt,
        fileSize: stats.size
      },
      { isNew: claimed === null }
    )
    void flushProjectionEvents()

    const noteListItem: NoteListItem = {
      id: noteId,
      path: relativePath,
      title,
      created: new Date(createdAt),
      modified: new Date(modifiedAt),
      tags: [],
      // Null, not zero: the body has not been read, so the count is unknown
      // rather than empty. The backfill's UPDATED event replaces it.
      wordCount: null,
      localOnly: false
    }

    // No sync item and no Y.Doc here. Both are gated on the file's size class,
    // and the class is not known yet: it needs the largest block, which needs
    // the body, which this path deliberately never reads. The backfill measures
    // the file and makes both calls once the answer is in — so a large file is
    // never even transiently given a sync item to withdraw.

    // Emit event to renderer
    emitEvent(NotesChannels.events.CREATED, {
      note: noteListItem,
      properties: {},
      source: 'external'
    })

    enqueueIngestBackfill({ noteId, absolutePath, relativePath, fileBytes: stats.size })
  }

  /**
   * Rename detection is the one thing on the add path that still needs the
   * file's content hash — chokidar reports a rename as `unlink` then `add`, and
   * the hash is what ties the two together.
   *
   * It is only computed while a delete is actually in flight, so an ordinary
   * paste pays nothing for it, and it is computed by streaming, so even a file
   * past V8's string ceiling is hashable. A pending delete whose own row was
   * never backfilled has no cached hash to compare against; that one matches on
   * size and mtime instead, which a rename leaves untouched.
   */
  private async matchPendingRename(
    absolutePath: string,
    relativePath: string,
    stats: Stats
  ): Promise<{ id: string; oldPath: string } | null> {
    if (!hasPendingDeletes()) return null

    const scan = await scanMarkdownFile(absolutePath, 0)
    const statKey = buildStatRenameKey(stats.size, stats.mtime.toISOString())

    return checkForRename(scan?.contentHash ?? null, relativePath, statKey)
  }

  private async applyMarkdownRename(
    db: ReturnType<typeof getIndexDatabase>,
    relativePath: string,
    stats: Stats,
    renameMatch: { id: string; oldPath: string }
  ): Promise<void> {
    const { id, oldPath } = renameMatch
    const cached = getNoteCacheById(db, id)

    // A rename changes the path and the title and nothing else, so the row's
    // body-derived state stays valid and is left alone — a stat-only update
    // never writes nulls over it. The backfill re-measures at the new path,
    // which is what the journal date and the search row are keyed off.
    syncNoteStatToCache(
      db,
      {
        id,
        path: relativePath,
        title: extractTitleFromPath(relativePath),
        createdAt: cached?.createdAt ?? stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        fileSize: stats.size,
        localOnly: cached?.localOnly ?? false,
        emoji: cached?.emoji ?? null
      },
      { isNew: false }
    )
    await flushProjectionEvents()

    processRename(id, oldPath, relativePath)

    if (this.vaultPath) {
      enqueueIngestBackfill({
        noteId: id,
        absolutePath: path.join(this.vaultPath, relativePath),
        relativePath,
        fileBytes: stats.size
      })
    }
  }

  /**
   * Handle non-markdown file creation (PDF, images, audio, video).
   * These files don't have frontmatter, so we generate an ID and cache basic metadata.
   */
  private async handleNonMarkdownFileAdd(
    absolutePath: string,
    relativePath: string,
    fileType: 'pdf' | 'image' | 'audio' | 'video',
    db: ReturnType<typeof getIndexDatabase>,
    claimedId: string | null
  ): Promise<void> {
    // Get file stats for metadata
    const stats = await fs.stat(absolutePath)

    // Generate a new ID for this file, unless the path already has one
    const id = claimedId ?? generateNoteId()

    // Get MIME type
    const ext = getExtension(absolutePath)
    const mimeType = getMimeType(ext)

    // Derive title from filename (without extension)
    const title = path.basename(absolutePath, path.extname(absolutePath))

    // Sync to cache
    syncFileToCache(db, {
      id,
      path: relativePath,
      title,
      fileType,
      mimeType,
      fileSize: stats.size,
      createdAt: stats.birthtime,
      modifiedAt: stats.mtime
    })
    void flushProjectionEvents()

    // Create list item for event
    const fileListItem: NoteListItem = {
      id,
      path: relativePath,
      title,
      created: stats.birthtime,
      modified: stats.mtime,
      tags: [],
      wordCount: 0
    }

    syncNoteCreate(id, title, [])

    // Emit event to renderer (using same channel for unified tree)
    emitEvent(NotesChannels.events.CREATED, {
      note: fileListItem,
      properties: {},
      source: 'external',
      fileType // Include file type so renderer knows this is not markdown
    })

    attachmentEvents.emitSaved({ noteId: id, diskPath: absolutePath })
  }

  /**
   * Handle file modification.
   * Supports all file types: markdown, pdf, images, audio, video.
   */
  private async handleFileChange(absolutePath: string): Promise<void> {
    if (!this.vaultPath) return

    if (isWritebackIgnored(absolutePath)) return

    try {
      const relativePath = normalizeRelativePath(path.relative(this.vaultPath, absolutePath))
      const fileType = getFileType(getExtension(absolutePath))

      if (!fileType) {
        return
      }

      const db = getIndexDatabase()

      const cached = getNoteCacheByPath(db, relativePath)

      if (!cached) {
        await this.handleFileAdd(absolutePath)
        return
      }

      if (fileType === 'markdown') {
        await this.handleMarkdownFileChange(absolutePath, relativePath, cached, db)
      } else {
        await this.handleNonMarkdownFileChange(absolutePath, relativePath, fileType, cached, db)
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.onError?.(error)
    }
  }

  /**
   * Handle markdown file modification with full frontmatter parsing.
   */
  private async handleMarkdownFileChange(
    absolutePath: string,
    relativePath: string,
    cached: NonNullable<ReturnType<typeof getNoteCacheByPath>>,
    db: ReturnType<typeof getIndexDatabase>
  ): Promise<void> {
    const content = await safeRead(absolutePath)
    if (!content) {
      return
    }

    const stats = await fs.stat(absolutePath).catch(() => null)
    const parsed = parseNote(content, relativePath, stats ?? undefined)

    const contentHash = generateContentHash(content)

    if (cached.contentHash === contentHash) {
      return
    }

    const syncResult = syncNoteToCache(
      db,
      {
        id: cached.id,
        path: relativePath,
        fileContent: content,
        frontmatter: parsed.frontmatter,
        parsedContent: parsed.content,
        title: cached.title,
        createdAt: cached.createdAt,
        modifiedAt: parsed.modified,
        localOnly: cached.localOnly ?? false,
        emoji: cached.emoji ?? null
      },
      { isNew: false }
    )
    void flushProjectionEvents()

    const tags = syncResult.tags
    const properties = extractProperties(parsed.frontmatter)
    const title = cached.title

    if (tags.length > 0) {
      ensureTagDefinitions(getDatabase(), tags)
    }

    emitEvent(NotesChannels.events.UPDATED, {
      id: cached.id,
      changes: {
        title,
        content: parsed.content,
        tags,
        properties,
        modified: new Date(parsed.modified),
        wordCount: syncResult.wordCount,
        snippet: syncResult.snippet
      },
      source: 'external'
    })
    feedExternalEditToCrdt(cached.id, parsed.content).catch((err) => {
      logger.warn('Failed to feed external edit to CRDT', { noteId: cached.id, error: err })
    })

    // Markdown wins: a `- [x]`/`- [ ]` flipped outside the app is the user's
    // intent for that task, so the DB row follows the file.
    reconcileTaskCheckboxesFromMarkdown(parsed.content).catch((err) => {
      logger.warn('Failed to reconcile task checkboxes from external edit', {
        noteId: cached.id,
        error: err
      })
    })

    if (isJournalPath(relativePath)) {
      const journalDate = extractJournalDate(relativePath)
      emitEvent(JournalChannels.events.ENTRY_UPDATED, {
        date: journalDate,
        entry: {
          date: journalDate,
          content: parsed.content,
          tags,
          wordCount: syncResult.wordCount,
          characterCount: syncResult.characterCount,
          modified: new Date(parsed.modified),
          created: new Date(cached.createdAt)
        },
        source: 'external'
      })
    }
  }

  /**
   * Handle non-markdown file modification (PDF, images, audio, video).
   * For these files, we mainly update the modified timestamp and file size.
   */
  private async handleNonMarkdownFileChange(
    absolutePath: string,
    relativePath: string,
    fileType: 'pdf' | 'image' | 'audio' | 'video',
    cached: NonNullable<ReturnType<typeof getNoteCacheByPath>>,
    db: ReturnType<typeof getIndexDatabase>
  ): Promise<void> {
    // Get file stats for updated metadata
    const stats = await fs.stat(absolutePath)

    // Update cache with new metadata
    syncFileToCache(db, {
      id: cached.id,
      path: relativePath,
      title: cached.title,
      fileType,
      mimeType: cached.mimeType,
      fileSize: stats.size,
      createdAt: new Date(cached.createdAt),
      modifiedAt: stats.mtime
    })
    void flushProjectionEvents()

    syncNoteUpdate(cached.id)

    // Emit update event
    emitEvent(NotesChannels.events.UPDATED, {
      id: cached.id,
      changes: {
        modified: stats.mtime,
        fileSize: stats.size
      },
      source: 'external',
      fileType
    })

    attachmentEvents.emitSaved({ noteId: cached.id, diskPath: absolutePath })
  }

  /**
   * Handle file deletion.
   * Tracks as pending delete to detect renames (delete + add with same UUID).
   */
  private handleFileDelete(absolutePath: string): void {
    if (!this.vaultPath) return

    try {
      const relativePath = normalizeRelativePath(path.relative(this.vaultPath, absolutePath))

      const db = getIndexDatabase()

      // Get cached entry to get the UUID
      const cached = getNoteCacheByPath(db, relativePath)
      if (!cached) {
        // Not in cache, nothing to do
        return
      }

      const isJournal = isJournalPath(relativePath)
      const journalDate = isJournal ? extractJournalDate(relativePath) : null

      // Track as pending delete - wait for potential rename (matching 'add'
      // event with the same content hash). A row the tier-1 backfill has not
      // reached yet has no hash, so it carries size + mtime instead; without
      // that, renaming a just-pasted file would read as a delete plus a new
      // note. A row with neither never matches and degrades to a real delete
      // after the window.
      const statKey = cached.contentHash
        ? null
        : buildStatRenameKey(cached.fileSize ?? null, toIsoOrNull(cached.modifiedAt))

      trackPendingDelete(
        cached.id,
        cached.contentHash ?? '',
        relativePath,
        async () => {
          // Enqueue sync delete BEFORE cache removal (enqueue reads cache for vector clock)
          if (isJournal && journalDate) {
            enqueueJournalDelete(cached.id, journalDate)
          } else {
            syncNoteDelete(cached.id)
          }

          deleteNoteFromCache(db, cached.id)
          void flushProjectionEvents()

          // Emit delete event
          emitEvent(NotesChannels.events.DELETED, {
            id: cached.id,
            path: relativePath,
            source: 'external'
          })

          // Also emit journal event if this is a journal entry
          if (isJournal && journalDate) {
            emitEvent(JournalChannels.events.ENTRY_DELETED, {
              date: journalDate,
              source: 'external'
            })
          }

          await Promise.resolve()
        },
        statKey
      )
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

// ============================================================================
// Module-level Singleton
// ============================================================================

let watcherInstance: VaultWatcher | null = null

/**
 * Get the singleton watcher instance.
 */
export function getWatcher(): VaultWatcher {
  if (!watcherInstance) {
    watcherInstance = new VaultWatcher()
  }
  return watcherInstance
}

/**
 * Start the file watcher for a vault.
 * @param vaultPath - Absolute path to the vault
 * @param excludePatterns - Optional patterns to exclude from watching (defaults to config)
 */
// Watcher errors can burst per-file (e.g. a permission-denied subtree), so
// sample telemetry to one report per minute — same idea as trackIpcError's
// 60s throttle. Every error still reaches the local log.
let lastWatcherErrorTrackedAt = 0
const WATCHER_ERROR_TRACK_INTERVAL_MS = 60_000

export async function startWatcher(vaultPath: string, excludePatterns?: string[]): Promise<void> {
  const watcher = getWatcher()
  // Use provided patterns or fall back to config
  const patterns = excludePatterns ?? getConfig().excludePatterns ?? []
  await watcher.start({
    vaultPath,
    excludePatterns: patterns,
    onError: (error) => {
      logger.error('Error:', error)
      const now = Date.now()
      if (now - lastWatcherErrorTrackedAt >= WATCHER_ERROR_TRACK_INTERVAL_MS) {
        lastWatcherErrorTrackedAt = now
        trackMainError('vault', 'watcher', error)
      }
    }
  })
}

/**
 * Stop the file watcher.
 */
export async function stopWatcher(): Promise<void> {
  if (watcherInstance) {
    await watcherInstance.stop()
  }
}
