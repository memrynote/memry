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
import { BrowserWindow } from 'electron'
import { getConfig } from './index'
import { parseNote, serializeNote, generateContentHash, extractProperties } from './frontmatter'
import { safeRead, atomicWrite } from './file-ops'
import { generateNoteId } from '../lib/id'
import { syncNoteToCache, syncFileToCache, deleteNoteFromCache } from './note-sync'
import {
  getNoteCacheByPath,
  getNoteCacheById,
  ensureTagDefinitions
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
import { createLogger } from '../lib/logger'
import { isWritebackIgnored, wasRecentNetworkUpdate } from '../sync/crdt-writeback'
import { attachmentEvents } from '../sync/attachment-events'
import { flushProjectionEvents } from '../projections'
import { getCrdtProvider, ORIGIN_LOCAL } from '../sync/crdt-provider'
import { markdownToBlocks, blocksToYFragment } from '../sync/blocknote-converter'
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
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, payload)
  })
}

/**
 * Check if a path is a journal entry (in the journal folder with YYYY-MM-DD.md pattern).
 */
function isJournalPath(relativePath: string, journalFolder: string): boolean {
  // Get the directory part of the path
  const lastSlash = relativePath.lastIndexOf('/')
  const dir = lastSlash >= 0 ? relativePath.substring(0, lastSlash) : ''
  const filename = lastSlash >= 0 ? relativePath.substring(lastSlash + 1) : relativePath

  // Check if file is directly in the journal folder
  if (dir !== journalFolder) {
    return false
  }

  // Check for YYYY-MM-DD.md pattern
  const datePattern = /^\d{4}-\d{2}-\d{2}\.md$/
  return datePattern.test(filename)
}

/**
 * Extract date from journal path (YYYY-MM-DD).
 */
function extractJournalDate(relativePath: string): string {
  const filename = relativePath.substring(relativePath.lastIndexOf('/') + 1)
  return filename.replace('.md', '')
}

// Full fragment replace on external edits: lossy but acceptable since
// out-of-app edits are infrequent and round-trip through MD destroys Yjs history anyway
async function feedExternalEditToCrdt(noteId: string, markdownContent: string): Promise<void> {
  const provider = getCrdtProvider()
  const doc = provider.getDoc(noteId)
  if (!doc) return

  if (wasRecentNetworkUpdate(noteId)) {
    emitEvent('sync:concurrent-edit', { noteId })
  }

  const blocks = await markdownToBlocks(markdownContent)
  if (!blocks) return

  const fragment = doc.getXmlFragment('prosemirror')
  doc.transact(() => {
    fragment.delete(0, fragment.length)
    blocksToYFragment(blocks, fragment)
  }, ORIGIN_LOCAL)
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

    // Get vault config for folder names
    const config = getConfig()
    const watchPaths = [
      path.join(vaultPath, config.defaultNoteFolder),
      path.join(vaultPath, config.journalFolder)
    ]

    // Create debounced handlers
    this.debouncedChange = createPathDebouncer((filePath) => this.handleFileChange(filePath), 100)

    // Capture exclude patterns for use in ignored function
    const userExcludePatterns = this.excludePatterns

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

    const parsed = parseNote(content, relativePath)

    // Check if this is a rename (UUID matches a pending delete)
    const oldPath = checkForRename(parsed.frontmatter.id, relativePath)
    if (oldPath !== null) {
      await this.applyMarkdownRename(db, content, parsed, relativePath, oldPath)
      return
    }

    // Check if a note with this ID exists at a different path
    const existingById = getNoteCacheById(db, parsed.frontmatter.id)
    if (existingById && existingById.path !== relativePath) {
      const oldAbsPath = path.join(this.vaultPath!, existingById.path)
      let oldFileExists = false
      try {
        await fs.access(oldAbsPath)
        oldFileExists = true
      } catch {
        // old file gone
      }

      if (!oldFileExists) {
        await this.applyMarkdownRename(db, content, parsed, relativePath, existingById.path)
        return
      }

      // Old file still exists — genuine copy, regenerate ID + derive title from OS filename
      const newId = generateNoteId()
      parsed.frontmatter.id = newId
      parsed.frontmatter.title = path.basename(relativePath, path.extname(relativePath))
      try {
        const newContent = serializeNote(parsed.frontmatter, parsed.content)
        await atomicWrite(absolutePath, newContent)
      } catch {
        return
      }
    }

    // Sync to cache using NoteSyncService (handles tags, properties, FTS, links)
    const syncResult = syncNoteToCache(
      db,
      {
        id: parsed.frontmatter.id,
        path: relativePath,
        fileContent: content,
        frontmatter: parsed.frontmatter,
        parsedContent: parsed.content
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
      id: parsed.frontmatter.id,
      path: relativePath,
      title: parsed.frontmatter.title ?? path.basename(relativePath, '.md'),
      created: new Date(parsed.frontmatter.created),
      modified: new Date(parsed.frontmatter.modified),
      tags,
      wordCount: syncResult.wordCount,
      snippet: syncResult.snippet,
      localOnly: parsed.frontmatter.localOnly ?? false
    }

    // Enqueue sync push so other devices learn about the new file
    const config = getConfig()
    if (isJournalPath(relativePath, config.journalFolder)) {
      const journalDate = extractJournalDate(relativePath)
      enqueueJournalCreate(parsed.frontmatter.id, journalDate)
      initializeJournalCrdt(parsed.frontmatter.id, journalDate, tags)
    } else {
      syncNoteCreate(
        parsed.frontmatter.id,
        parsed.frontmatter.title ?? path.basename(relativePath, '.md'),
        tags
      )
    }

    // Emit event to renderer
    emitEvent(NotesChannels.events.CREATED, {
      note: noteListItem,
      properties, // T012: Include properties in event
      source: 'external'
    })

    // Also emit journal event if this is a journal entry
    if (isJournalPath(relativePath, config.journalFolder)) {
      const journalDate = extractJournalDate(relativePath)
      emitEvent(JournalChannels.events.ENTRY_CREATED, {
        date: journalDate,
        entry: {
          date: journalDate,
          content: parsed.content,
          tags,
          wordCount: syncResult.wordCount,
          characterCount: syncResult.characterCount,
          modified: new Date(parsed.frontmatter.modified),
          created: new Date(parsed.frontmatter.created)
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
    oldPath: string
  ): Promise<void> {
    const syncResult = syncNoteToCache(
      db,
      {
        id: parsed.frontmatter.id,
        path: relativePath,
        fileContent,
        frontmatter: parsed.frontmatter,
        parsedContent: parsed.content
      },
      { isNew: false }
    )

    if (syncResult.tags.length > 0) {
      ensureTagDefinitions(getDatabase(), syncResult.tags)
    }

    processRename(parsed.frontmatter.id, oldPath, relativePath)
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

    const parsed = parseNote(content, relativePath)

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
        parsedContent: parsed.content
      },
      { isNew: false }
    )
    void flushProjectionEvents()

    const tags = syncResult.tags
    const properties = extractProperties(parsed.frontmatter)
    const title = parsed.frontmatter.title ?? path.basename(relativePath, '.md')

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
        modified: new Date(parsed.frontmatter.modified),
        wordCount: syncResult.wordCount,
        snippet: syncResult.snippet
      },
      source: 'external'
    })
    feedExternalEditToCrdt(cached.id, parsed.content).catch((err) => {
      logger.warn('Failed to feed external edit to CRDT', { noteId: cached.id, error: err })
    })

    const config = getConfig()
    if (isJournalPath(relativePath, config.journalFolder)) {
      const journalDate = extractJournalDate(relativePath)
      emitEvent(JournalChannels.events.ENTRY_UPDATED, {
        date: journalDate,
        entry: {
          date: journalDate,
          content: parsed.content,
          tags,
          wordCount: syncResult.wordCount,
          characterCount: syncResult.characterCount,
          modified: new Date(parsed.frontmatter.modified),
          created: new Date(parsed.frontmatter.created)
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

      // Capture config for use in callback
      const config = getConfig()
      const isJournal = isJournalPath(relativePath, config.journalFolder)
      const journalDate = isJournal ? extractJournalDate(relativePath) : null

      // Track as pending delete - wait for potential rename (matching 'add' event)
      trackPendingDelete(cached.id, relativePath, async () => {
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
export async function startWatcher(vaultPath: string, excludePatterns?: string[]): Promise<void> {
  const watcher = getWatcher()
  // Use provided patterns or fall back to config
  const patterns = excludePatterns ?? getConfig().excludePatterns ?? []
  await watcher.start({
    vaultPath,
    excludePatterns: patterns,
    onError: (error) => {
      logger.error('Error:', error)
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
