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
  extractTags,
  extractWikiLinks,
  calculateWordCount,
  generateContentHash,
  createSnippet
} from './frontmatter'
import { safeRead } from './file-ops'
import {
  insertNoteCache,
  updateNoteCache,
  deleteNoteCache,
  getNoteCacheByPath,
  getNoteCacheById,
  setNoteTags,
  setNoteLinks,
  resolveNoteByTitle
} from '@shared/db/queries/notes'
import { getIndexDatabase } from '../database'
import { NotesChannels } from '@shared/ipc-channels'
import {
  trackPendingDelete,
  checkForRename,
  clearAllPendingDeletes
} from './rename-tracker'

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
 * Emit note event to all renderer windows.
 */
function emitNoteEvent(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, payload)
  })
}

// ============================================================================
// VaultWatcher Class
// ============================================================================

export class VaultWatcher {
  private watcher: FSWatcher | null = null
  private vaultPath: string | null = null
  private onError?: (error: Error) => void
  private isReady = false

  // Debounced handlers
  private debouncedChange: ((path: string) => void) | null = null

  /**
   * Start watching the vault for file changes.
   */
  async start(options: WatcherOptions): Promise<void> {
    const { vaultPath, onError } = options

    if (this.watcher) {
      await this.stop()
    }

    this.vaultPath = vaultPath
    this.onError = onError
    this.isReady = false

    // Get vault config for folder names
    const config = getConfig()
    const watchPaths = [
      path.join(vaultPath, config.defaultNoteFolder),
      path.join(vaultPath, config.journalFolder)
    ]

    // Create debounced handlers
    this.debouncedChange = createPathDebouncer(
      (filePath) => this.handleFileChange(filePath),
      100
    )

    // Create watcher with chokidar
    this.watcher = chokidar.watch(watchPaths, {
      persistent: true,

      // Ignore hidden files, .git, node_modules, .memry, non-.md files
      ignored: (filePath: string, stats) => {
        const basename = path.basename(filePath)

        // Ignore hidden files and directories
        if (basename.startsWith('.')) return true

        // Ignore common directories
        if (basename === 'node_modules' || basename === '.git') return true

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
        console.log('[Watcher] Initial scan complete, watching for changes')
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
    console.log('[Watcher] Stopped')
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
      console.log('[Watcher] File added:', relativePath)

      // Read and parse the file
      const content = await safeRead(absolutePath)
      if (!content) {
        console.warn('[Watcher] Could not read added file:', relativePath)
        return
      }

      const parsed = parseNote(content, relativePath)
      const db = getIndexDatabase()

      // Check if this is a rename (UUID matches a pending delete)
      const oldPath = await checkForRename(parsed.frontmatter.id, relativePath)
      if (oldPath !== null) {
        // This was a rename - rename-tracker already handled cache update and event
        console.log('[Watcher] File rename handled:', oldPath, '->', relativePath)
        return
      }

      // Check if already in cache (might have been added by internal operation)
      const existing = getNoteCacheByPath(db, relativePath)
      if (existing) {
        // Already cached, skip
        return
      }

      // Also check if a note with this ID exists at a different path
      // (e.g., copy-paste scenario - the ID exists but path is different)
      const existingById = getNoteCacheById(db, parsed.frontmatter.id)
      if (existingById && existingById.path !== relativePath) {
        // Note with this ID exists elsewhere - this is a new file with duplicate ID
        // The file should have gotten a new ID from parseNote/ensureFrontmatter
        // but if not, we skip to avoid conflicts
        console.warn('[Watcher] Duplicate ID detected, skipping:', parsed.frontmatter.id)
        return
      }

      // Extract metadata
      const tags = extractTags(parsed.frontmatter)
      const wikiLinks = extractWikiLinks(parsed.content)
      const wordCount = calculateWordCount(parsed.content)
      const contentHash = generateContentHash(content)
      const snippet = createSnippet(parsed.content)

      // Insert into cache
      insertNoteCache(db, {
        id: parsed.frontmatter.id,
        path: relativePath,
        title: parsed.frontmatter.title ?? path.basename(relativePath, '.md'),
        contentHash,
        wordCount,
        createdAt: parsed.frontmatter.created,
        modifiedAt: parsed.frontmatter.modified
      })

      // Set tags
      if (tags.length > 0) {
        setNoteTags(db, parsed.frontmatter.id, tags)
      }

      // Set links
      if (wikiLinks.length > 0) {
        const links = wikiLinks.map((title) => {
          const target = resolveNoteByTitle(db, title)
          return { targetTitle: title, targetId: target?.id }
        })
        setNoteLinks(db, parsed.frontmatter.id, links)
      }

      // Create list item for event
      const noteListItem: NoteListItem = {
        id: parsed.frontmatter.id,
        path: relativePath,
        title: parsed.frontmatter.title ?? path.basename(relativePath, '.md'),
        created: new Date(parsed.frontmatter.created),
        modified: new Date(parsed.frontmatter.modified),
        tags,
        wordCount,
        snippet
      }

      // Emit event to renderer
      emitNoteEvent(NotesChannels.events.CREATED, {
        note: noteListItem,
        source: 'external'
      })
    } catch (error) {
      console.error('[Watcher] Error handling file add:', error)
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
      console.log('[Watcher] File changed:', relativePath)

      // Read and parse the file
      const content = await safeRead(absolutePath)
      if (!content) {
        console.warn('[Watcher] Could not read changed file:', relativePath)
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

      // Extract metadata
      const tags = extractTags(parsed.frontmatter)
      const wikiLinks = extractWikiLinks(parsed.content)
      const wordCount = calculateWordCount(parsed.content)
      const snippet = createSnippet(parsed.content)
      const title = parsed.frontmatter.title ?? path.basename(relativePath, '.md')

      if (cached) {
        // Update existing cache entry
        updateNoteCache(db, cached.id, {
          title,
          contentHash,
          wordCount,
          modifiedAt: parsed.frontmatter.modified
        })

        // Update tags
        setNoteTags(db, cached.id, tags)

        // Update links
        const links = wikiLinks.map((linkTitle) => {
          const target = resolveNoteByTitle(db, linkTitle)
          return { targetTitle: linkTitle, targetId: target?.id }
        })
        setNoteLinks(db, cached.id, links)

        // Emit update event
        emitNoteEvent(NotesChannels.events.UPDATED, {
          id: cached.id,
          changes: {
            title,
            content: parsed.content,
            tags,
            modified: new Date(parsed.frontmatter.modified),
            wordCount,
            snippet
          },
          source: 'external'
        })
      } else {
        // File not in cache, treat as add
        await this.handleFileAdd(absolutePath)
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      console.error('[Watcher] Error handling file change:', error)
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
      console.log('[Watcher] File deleted:', relativePath)

      const db = getIndexDatabase()

      // Get cached entry to get the UUID
      const cached = getNoteCacheByPath(db, relativePath)
      if (!cached) {
        // Not in cache, nothing to do
        return
      }

      // Track as pending delete - wait for potential rename (matching 'add' event)
      trackPendingDelete(cached.id, relativePath, async () => {
        // This callback runs if no rename is detected within 500ms
        // Remove from cache (cascades to tags and links)
        deleteNoteCache(db, cached.id)

        // Emit delete event
        emitNoteEvent(NotesChannels.events.DELETED, {
          id: cached.id,
          path: relativePath,
          source: 'external'
        })
      })
    } catch (error) {
      console.error('[Watcher] Error handling file delete:', error)
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
 */
export async function startWatcher(vaultPath: string): Promise<void> {
  const watcher = getWatcher()
  await watcher.start({
    vaultPath,
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
