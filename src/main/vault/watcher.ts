/**
 * File Watcher for External Change Detection
 *
 * Uses chokidar to watch vault folders for external file changes.
 * Updates the cache and emits IPC events to renderer.
 *
 * @module vault/watcher
 */

import path from 'path'
import chokidar from 'chokidar'
import type { FSWatcher } from 'chokidar'
import { BrowserWindow } from 'electron'
import { getConfig } from './index'
import {
  parseNote,
  serializeNote,
  extractTags,
  generateContentHash,
  extractProperties
} from './frontmatter'
import { safeRead, atomicWrite } from './file-ops'
import { generateNoteId } from '../lib/id'
import { syncNoteToCache } from './note-sync'
import { deleteNoteCache, getNoteCacheByPath, getNoteCacheById } from '@shared/db/queries/notes'
import { getIndexDatabase } from '../database'
import { NotesChannels, JournalChannels } from '@shared/ipc-channels'
import { trackPendingDelete, checkForRename, clearAllPendingDeletes } from './rename-tracker'
import { queueEmbeddingUpdate } from '../inbox/embedding-queue'

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
    const timeout = setTimeout(async () => {
      pending.delete(filePath)
      try {
        await handler(filePath)
      } catch (error) {
        console.error(`[Watcher] Error processing ${filePath}:`, error)
      }
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

      // Ignore hidden files, excluded patterns, non-.md files
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

        // For files, only watch .md files
        if (stats?.isFile()) {
          return !filePath.endsWith('.md')
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
      .on('add', (filePath) => this.handleFileAdd(filePath))
      .on('change', (filePath) => this.debouncedChange?.(filePath))
      .on('unlink', (filePath) => this.handleFileDelete(filePath))
      .on('ready', () => {
        this.isReady = true
      })
      .on('error', (err) => {
        const error = err instanceof Error ? err : new Error(String(err))
        console.error('[Watcher] Error:', error)
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
   */
  private async handleFileAdd(absolutePath: string): Promise<void> {
    if (!this.vaultPath) return

    try {
      const relativePath = path.relative(this.vaultPath, absolutePath)

      // Read and parse the file
      const content = await safeRead(absolutePath)
      if (!content) {
        return
      }

      const parsed = parseNote(content, relativePath)
      const db = getIndexDatabase()

      // Check if this is a rename (UUID matches a pending delete)
      const oldPath = await checkForRename(parsed.frontmatter.id, relativePath)
      if (oldPath !== null) {
        // This was a rename - rename-tracker already handled cache update and event
        return
      }

      // Check if already in cache (might have been added by internal operation)
      const existing = getNoteCacheByPath(db, relativePath)
      if (existing) {
        // Already cached, skip
        return
      }

      // Check if a note with this ID exists at a different path (copy-paste scenario)
      const existingById = getNoteCacheById(db, parsed.frontmatter.id)
      if (existingById && existingById.path !== relativePath) {
        // This is a copy of an existing note - regenerate ID
        const newId = generateNoteId()
        parsed.frontmatter.id = newId

        // Write back to file with new ID
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

      // Extract tags and properties for event emission
      const tags = extractTags(parsed.frontmatter)
      const properties = extractProperties(parsed.frontmatter)

      // Create list item for event
      const noteListItem: NoteListItem = {
        id: parsed.frontmatter.id,
        path: relativePath,
        title: parsed.frontmatter.title ?? path.basename(relativePath, '.md'),
        created: new Date(parsed.frontmatter.created),
        modified: new Date(parsed.frontmatter.modified),
        tags,
        wordCount: syncResult.wordCount,
        snippet: syncResult.snippet
      }

      // Emit event to renderer
      emitEvent(NotesChannels.events.CREATED, {
        note: noteListItem,
        properties, // T012: Include properties in event
        source: 'external'
      })

      // Queue embedding update for AI suggestions (batched for performance)
      queueEmbeddingUpdate(parsed.frontmatter.id)

      // Also emit journal event if this is a journal entry
      const config = getConfig()
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
    } catch (error) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * Handle file modification.
   */
  private async handleFileChange(absolutePath: string): Promise<void> {
    if (!this.vaultPath) return

    try {
      const relativePath = path.relative(this.vaultPath, absolutePath)

      // Read and parse the file
      const content = await safeRead(absolutePath)
      if (!content) {
        return
      }

      const parsed = parseNote(content, relativePath)
      const db = getIndexDatabase()

      // Get cached version
      const cached = getNoteCacheByPath(db, relativePath)

      // Calculate new hash
      const contentHash = generateContentHash(content)

      // Check if content actually changed
      if (cached && cached.contentHash === contentHash) {
        // No actual change, skip
        return
      }

      if (cached) {
        // Sync to cache using NoteSyncService (handles tags, properties, FTS, links)
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

        // Extract tags and properties for event emission
        const tags = extractTags(parsed.frontmatter)
        const properties = extractProperties(parsed.frontmatter)
        const title = parsed.frontmatter.title ?? path.basename(relativePath, '.md')

        // Emit update event for notes
        emitEvent(NotesChannels.events.UPDATED, {
          id: cached.id,
          changes: {
            title,
            content: parsed.content,
            tags,
            properties, // T012: Include properties in event
            modified: new Date(parsed.frontmatter.modified),
            wordCount: syncResult.wordCount,
            snippet: syncResult.snippet
          },
          source: 'external'
        })

        // Queue embedding update for AI suggestions (batched for performance)
        queueEmbeddingUpdate(cached.id)

        // Also emit journal event if this is a journal entry
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
      } else {
        // File not in cache, treat as add
        await this.handleFileAdd(absolutePath)
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.onError?.(error)
    }
  }

  /**
   * Handle file deletion.
   * Tracks as pending delete to detect renames (delete + add with same UUID).
   */
  private async handleFileDelete(absolutePath: string): Promise<void> {
    if (!this.vaultPath) return

    try {
      const relativePath = path.relative(this.vaultPath, absolutePath)

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
        // This callback runs if no rename is detected within 500ms
        // Remove from cache (cascades to tags and links)
        deleteNoteCache(db, cached.id)

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
      console.error('[Watcher] Error:', error)
      // Could emit vault error here if needed
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
