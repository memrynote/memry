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
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { getConfig } from './index'
import { parseNote, generateContentHash, extractProperties } from './frontmatter'
import { safeRead } from './file-ops'
import { generateNoteId } from '../lib/id'
import { syncNoteToCache, syncFileToCache, deleteNoteFromCache } from './note-sync'
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
  processRename
} from './rename-tracker'
import { isSupportedPath, getFileType, getMimeType, getExtension } from '@memry/shared/file-types'
import { classifyMarkdownContent } from '@memry/shared/markdown-class'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { isWritebackIgnored, wasRecentNetworkUpdate } from '../sync/crdt-writeback'
import { attachmentEvents } from '../sync/attachment-events'
import { flushProjectionEvents } from '../projections'
import { getCrdtProvider } from '../sync/crdt-provider'
import { replaceNoteBodyInCrdt } from '../sync/crdt-feed'
import { reconcileTaskCheckboxesFromMarkdown } from '../tasks/reconcile-markdown-tasks'
import {
  enqueueJournalCreate,
  enqueueJournalDelete,
  initializeJournalCrdt
} from '../journal/runtime-effects'
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
  wordCount: number
  snippet?: string
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

// Full fragment replace on external edits: lossy but acceptable since
// out-of-app edits are infrequent and round-trip through MD destroys Yjs history anyway
async function feedExternalEditToCrdt(noteId: string, markdownContent: string): Promise<void> {
  const provider = getCrdtProvider()
  if (!provider.getDoc(noteId)) return

  if (wasRecentNetworkUpdate(noteId)) {
    emitEvent('sync:concurrent-edit', { noteId })
  }

  await replaceNoteBodyInCrdt(noteId, markdownContent)
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

      if (fileType === 'markdown') {
        await this.handleMarkdownFileAdd(absolutePath, relativePath, db)
      } else {
        await this.handleNonMarkdownFileAdd(absolutePath, relativePath, fileType, db)
      }
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Handle markdown file creation with full frontmatter parsing.
   */
  private async handleMarkdownFileAdd(
    absolutePath: string,
    relativePath: string,
    db: ReturnType<typeof getIndexDatabase>
  ): Promise<void> {
    // Read and parse the file
    const content = await safeRead(absolutePath)
    if (!content) {
      return
    }

    const stats = await fs.stat(absolutePath).catch(() => null)
    const parsed = parseNote(content, relativePath, stats ?? undefined)

    // Check if this is a rename (content hash matches a pending delete);
    // the internal id comes from the matched sidecar entry
    const renameMatch = checkForRename(generateContentHash(content), relativePath)
    if (renameMatch !== null) {
      await this.applyMarkdownRename(db, content, parsed, relativePath, renameMatch)
      return
    }

    // Genuinely new external file: fresh internal id, fs-stat dates.
    // No watcher path writes files.
    const noteId = parsed.id

    // Sync to cache using NoteSyncService (handles tags, properties, FTS, links)
    const syncResult = syncNoteToCache(
      db,
      {
        id: noteId,
        path: relativePath,
        fileContent: content,
        frontmatter: parsed.frontmatter,
        parsedContent: parsed.content,
        title: parsed.title,
        createdAt: parsed.created,
        modifiedAt: parsed.modified
      },
      { isNew: true }
    )
    void flushProjectionEvents()

    const tags = syncResult.tags
    const properties = extractProperties(parsed.frontmatter)

    if (tags.length > 0) {
      ensureTagDefinitions(getDatabase(), tags)
    }

    const noteListItem: NoteListItem = {
      id: noteId,
      path: relativePath,
      title: parsed.title,
      created: new Date(parsed.created),
      modified: new Date(parsed.modified),
      tags,
      wordCount: syncResult.wordCount,
      snippet: syncResult.snippet,
      localOnly: false
    }

    // A large-file-class file still gets a sidebar row, but never a Y.Doc.
    // Seeding one runs the BlockNote markdown parse over the whole file on the
    // main process with no yield point, and that parse is the freeze: its cost
    // tracks single-block size, so a blank-line-free dump costs 14x the same
    // bytes shaped as paragraphs.
    const classification = classifyMarkdownContent(content)
    const isLargeFile = classification.sizeClass === 'large-file'
    if (isLargeFile) {
      logger.warn('Ingested file is large-file class; skipping CRDT seed', {
        path: relativePath,
        reason: classification.reason,
        fileBytes: classification.fileBytes,
        largestBlockBytes: classification.largestBlockBytes
      })
    }

    // Enqueue sync push so other devices learn about the new file
    if (isJournalPath(relativePath)) {
      const journalDate = extractJournalDate(relativePath)
      enqueueJournalCreate(noteId, journalDate)
      if (!isLargeFile) void initializeJournalCrdt(noteId, journalDate, tags)
    } else {
      syncNoteCreate(noteId, parsed.title, tags, { initCrdt: !isLargeFile })
    }

    // Emit event to renderer
    emitEvent(NotesChannels.events.CREATED, {
      note: noteListItem,
      properties, // T012: Include properties in event
      source: 'external'
    })

    // Also emit journal event if this is a journal entry
    if (isJournalPath(relativePath)) {
      const journalDate = extractJournalDate(relativePath)
      emitEvent(JournalChannels.events.ENTRY_CREATED, {
        date: journalDate,
        entry: {
          date: journalDate,
          content: parsed.content,
          tags,
          wordCount: syncResult.wordCount,
          characterCount: syncResult.characterCount,
          modified: new Date(parsed.modified),
          created: new Date(parsed.created)
        },
        source: 'external'
      })
    }
  }

  private async applyMarkdownRename(
    db: ReturnType<typeof getIndexDatabase>,
    fileContent: string,
    parsed: ReturnType<typeof parseNote>,
    relativePath: string,
    renameMatch: { id: string; oldPath: string }
  ): Promise<void> {
    const { id, oldPath } = renameMatch
    const cached = getNoteCacheById(db, id)

    const syncResult = syncNoteToCache(
      db,
      {
        id,
        path: relativePath,
        fileContent,
        frontmatter: parsed.frontmatter,
        parsedContent: parsed.content,
        title: parsed.title,
        createdAt: cached?.createdAt ?? parsed.created,
        modifiedAt: parsed.modified,
        localOnly: cached?.localOnly ?? false,
        emoji: cached?.emoji ?? null
      },
      { isNew: false }
    )

    if (syncResult.tags.length > 0) {
      ensureTagDefinitions(getDatabase(), syncResult.tags)
    }

    processRename(id, oldPath, relativePath)
  }

  /**
   * Handle non-markdown file creation (PDF, images, audio, video).
   * These files don't have frontmatter, so we generate an ID and cache basic metadata.
   */
  private async handleNonMarkdownFileAdd(
    absolutePath: string,
    relativePath: string,
    fileType: 'pdf' | 'image' | 'audio' | 'video',
    db: ReturnType<typeof getIndexDatabase>
  ): Promise<void> {
    // Get file stats for metadata
    const stats = await fs.stat(absolutePath)

    // Generate a new ID for this file
    const id = generateNoteId()

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
      // event with the same content hash). A missing hash never matches, so
      // it degrades to a real delete after the window.
      trackPendingDelete(cached.id, cached.contentHash ?? '', relativePath, async () => {
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
      })
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
