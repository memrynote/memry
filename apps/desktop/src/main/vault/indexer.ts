/**
 * Initial Vault Indexer
 *
 * Scans vault folders for supported files and populates the cache.
 * Supports markdown, PDF, images, audio, and video files.
 * Called when a vault is first opened or when reindexing.
 *
 * @module vault/indexer
 */

import path from 'path'
import { readdir, readFile, stat } from 'fs/promises'
import { existsSync, unlinkSync } from 'fs'
import { getConfig, emitIndexProgress } from './index'
import { getIndexDbPath } from './init'
import {
  initIndexDatabase,
  runIndexMigrations,
  initializeFts,
  getDatabase,
  getIndexDatabase,
  closeIndexDatabase
} from '../database'
import { parseNote } from './frontmatter'
import { generateNoteId } from '../lib/id'
import { normalizeRelativePath } from '../lib/paths'
import { syncNoteToCache, syncFileToCache } from './note-sync'
import { flushProjectionEvents } from '../projections'
import {
  getNoteCacheByPath,
  countNotes,
  countJournalEntries,
  ensureTagDefinitions
} from '@main/database/queries/notes'
import { getNoteMetadataByPath } from '@memry/storage-data'
import { isSupportedPath, getFileType, getMimeType, getExtension } from '@memry/shared/file-types'
import { createLogger } from '../lib/logger'
import { trackMainLog } from '../telemetry/diagnostics'

const logger = createLogger('Indexer')

// ============================================================================
// Types
// ============================================================================

interface IndexResult {
  indexed: number
  skipped: number
  errors: number
  /** True when `shouldStop` ended the walk before every file was visited. */
  cancelled: boolean
}

export interface IndexVaultOptions {
  /**
   * Cooperative cancellation, checked before each file. Used by the background
   * open-time build so a vault close (or switch) stops the walk within one
   * file's work instead of racing the database teardown. A cancelled pass is
   * resumable by design: the next `indexVault` run skips the paths already in
   * cache and indexes the rest.
   */
  shouldStop?: () => boolean
}

// ============================================================================
// Directory Scanner
// ============================================================================

/**
 * Recursively find all supported files in a directory.
 * Supports markdown, PDF, images, audio, and video files.
 * @param dirPath - Directory to scan
 * @param basePath - Vault root path for relative path calculation
 * @param excludePatterns - Patterns to exclude from scanning
 */
async function findVaultFiles(
  dirPath: string,
  basePath: string,
  excludePatterns: string[] = []
): Promise<string[]> {
  const files: string[] = []

  try {
    const entries = await readdir(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      // Skip hidden files and directories
      if (entry.name.startsWith('.')) continue

      // Skip excluded patterns (exact match or prefix match)
      if (excludePatterns.some((p) => entry.name === p || entry.name.startsWith(`${p}/`))) continue

      const fullPath = path.join(dirPath, entry.name)

      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        const subFiles = await findVaultFiles(fullPath, basePath, excludePatterns)
        files.push(...subFiles)
      } else if (entry.isFile()) {
        const supported = isSupportedPath(fullPath)
        if (supported) {
          // Add supported file (relative path from vault root)
          files.push(normalizeRelativePath(path.relative(basePath, fullPath)))
        } else {
          logger.debug(`Skipping unsupported file: ${entry.name}`)
        }
      }
    }
  } catch (error) {
    logger.error(`Error scanning directory ${dirPath}:`, error)
  }

  return files
}

// ============================================================================
// File Indexer
// ============================================================================

/**
 * Index a single file into the cache.
 * Handles both markdown files (with frontmatter) and non-markdown files (basic metadata).
 */
async function indexFile(
  vaultPath: string,
  relativePath: string
): Promise<'indexed' | 'skipped' | 'error'> {
  const absolutePath = path.join(vaultPath, relativePath)
  const fileType = getFileType(getExtension(absolutePath))

  if (!fileType) {
    logger.warn(`Unsupported file type: ${relativePath}`)
    return 'error'
  }

  try {
    const db = getIndexDatabase()

    // Check if already in cache by path
    const existingByPath = getNoteCacheByPath(db, relativePath)
    if (existingByPath) {
      return 'skipped'
    }

    // Handle markdown files with frontmatter support
    if (fileType === 'markdown') {
      return await indexMarkdownFile(vaultPath, relativePath, absolutePath, db)
    }

    // Handle non-markdown files (PDF, images, audio, video)
    return await indexNonMarkdownFile(vaultPath, relativePath, absolutePath, fileType, db)
  } catch (error) {
    logger.error(`Error indexing file ${relativePath}:`, error)
    return 'error'
  }
}

/**
 * Index a markdown file with full frontmatter support.
 */
async function indexMarkdownFile(
  _vaultPath: string,
  relativePath: string,
  absolutePath: string,
  db: ReturnType<typeof getIndexDatabase>
): Promise<'indexed' | 'error'> {
  // Read the file directly (not via safeRead) so the errno survives into the
  // log — ENOENT (vanished mid-scan), EACCES (permissions) and ELOOP (broken
  // symlink) all present as "could not read" otherwise (#844).
  let content: string
  try {
    content = await readFile(absolutePath, 'utf-8')
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN'
    logger.warn(`Could not read file: ${relativePath} (${code})`)
    return 'error'
  }

  // Path unknown to the index cache (indexFile skips known paths). Prefer the
  // canonical id from note_metadata (survives index rebuilds), else a fresh
  // one. Dates from fs stats. The indexer never writes files.
  const stats = await stat(absolutePath).catch(() => null)
  const parsed = parseNote(content, relativePath, stats ?? undefined)
  if (parsed.frontmatterError) {
    // Body is indexed without metadata rather than dropping the note.
    logger.warn(`Unparseable frontmatter, indexing body only: ${relativePath}`)
  }

  let canonical: ReturnType<typeof getNoteMetadataByPath>
  try {
    canonical = getNoteMetadataByPath(getDatabase(), relativePath)
  } catch {
    // data DB not ready — fall back to a fresh id
  }
  const noteId = canonical?.id ?? parsed.id

  // Use syncNoteToCache for unified cache operations
  try {
    const result = syncNoteToCache(
      db,
      {
        id: noteId,
        path: relativePath,
        fileContent: content,
        frontmatter: parsed.frontmatter,
        parsedContent: parsed.content,
        title: parsed.title,
        // Emoji is DB-only sidecar state (never written to the file); adopt it
        // from note_metadata by path so index rebuilds preserve the note icon,
        // mirroring the canonical-id adoption above. Without this the cache row
        // is written with emoji=null and the note falls back to the default icon.
        emoji: canonical?.emoji,
        createdAt: parsed.created,
        modifiedAt: parsed.modified
      },
      { isNew: true }
    )
    await flushProjectionEvents()
    logger.debug(`Indexed: ${relativePath}${result.date ? ` (journal: ${result.date})` : ''}`)
    if (result.tags.length > 0) {
      ensureTagDefinitions(getDatabase(), result.tags)
    }
  } catch (syncError) {
    logger.error(`Sync failed for ${relativePath}:`, syncError)
    return 'error'
  }

  return 'indexed'
}

/**
 * Index a single non-markdown file (PDF/image/audio/video) into the cache and
 * return its `note_cache` id.
 *
 * Idempotent: `syncFileToCache` resolves the id by path, so calling this before
 * the filesystem watcher indexes the same file (e.g. eagerly during inbox
 * filing) reuses one id and never touches `note_tags`. See #800.
 */
export async function indexBinaryFile(
  db: ReturnType<typeof getIndexDatabase>,
  relativePath: string,
  absolutePath: string,
  fileType: 'pdf' | 'image' | 'audio' | 'video'
): Promise<string> {
  // Get file stats for metadata
  const stats = await stat(absolutePath)

  // Generate a new ID for this file (reused if the path is already cached)
  const id = generateNoteId()

  // Get MIME type
  const ext = getExtension(absolutePath)
  const mimeType = getMimeType(ext)

  // Derive title from filename (without extension)
  const title = path.basename(absolutePath, path.extname(absolutePath))

  const result = syncFileToCache(db, {
    id,
    path: relativePath,
    title,
    fileType,
    mimeType,
    fileSize: stats.size,
    createdAt: stats.birthtime,
    modifiedAt: stats.mtime
  })
  await flushProjectionEvents()

  return result.id
}

/**
 * Index a non-markdown file (PDF, images, audio, video).
 */
async function indexNonMarkdownFile(
  _vaultPath: string,
  relativePath: string,
  absolutePath: string,
  fileType: 'pdf' | 'image' | 'audio' | 'video',
  db: ReturnType<typeof getIndexDatabase>
): Promise<'indexed' | 'error'> {
  try {
    await indexBinaryFile(db, relativePath, absolutePath, fileType)
    logger.debug(`Successfully indexed: ${relativePath} (${fileType})`)
    return 'indexed'
  } catch (error) {
    logger.error(`Error indexing file ${relativePath}:`, error)
    return 'error'
  }
}

// ============================================================================
// Concurrency Limiter
// ============================================================================

/**
 * Run tasks with a bounded concurrency limit.
 * Avoids exhausting file-descriptors or SQLite write slots on large vaults.
 */
async function withConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker())
  await Promise.all(workers)
  return results
}

// ============================================================================
// Main Indexer
// ============================================================================

const INDEX_CONCURRENCY = 8

/**
 * Index all files in the vault.
 * Scans notes and journal folders, populates cache.
 * Supports markdown, PDF, images, audio, and video files.
 *
 * @param vaultPath - Absolute path to the vault
 * @returns Index result with counts
 */
export async function indexVault(
  vaultPath: string,
  options: IndexVaultOptions = {}
): Promise<IndexResult> {
  logger.debug('Starting vault indexing:', vaultPath)

  const shouldStop = options.shouldStop ?? ((): boolean => false)
  const config = getConfig()
  const excludePatterns = config.excludePatterns ?? []
  const result: IndexResult = {
    indexed: 0,
    skipped: 0,
    errors: 0,
    cancelled: false
  }

  // Scan the entire vault root. findVaultFiles skips dotfolders (.memry,
  // .obsidian, .git) and excludePatterns; also exclude the attachments folder so
  // binaries are not indexed as notes.
  const scanExcludes = [...excludePatterns, config.attachmentsFolder].filter(Boolean)
  const foldersToScan = [vaultPath]

  // Find all supported files (respecting exclude patterns)
  const allFiles: string[] = []
  for (const folder of foldersToScan) {
    try {
      const folderStat = await stat(folder)
      if (folderStat.isDirectory()) {
        const files = await findVaultFiles(folder, vaultPath, scanExcludes)
        allFiles.push(...files)
      }
    } catch {
      // Folder doesn't exist, skip
      logger.debug(`Folder does not exist, skipping: ${folder}`)
    }
  }

  logger.debug(`Found ${allFiles.length} files to index`)

  if (allFiles.length === 0) {
    emitIndexProgress(100)
    return result
  }

  // Track completed count for progress reporting (thread-safe increment via closure)
  let completed = 0
  let cancelled = false

  const tasks = allFiles.map((file, i) => async () => {
    if (cancelled || shouldStop()) {
      cancelled = true
      return { i, status: 'cancelled' as const }
    }

    const status = await indexFile(vaultPath, file)
    completed++

    // Emit progress every 10 completions to reduce IPC overhead. Suppressed once
    // cancelled so a stale build never clobbers the next vault's progress.
    if (!cancelled && (completed % 10 === 0 || completed === allFiles.length)) {
      const progress = Math.round((completed / allFiles.length) * 100)
      emitIndexProgress(progress, { indexed: completed, total: allFiles.length })
    }

    return { i, status }
  })

  const statuses = await withConcurrency(tasks, INDEX_CONCURRENCY)

  for (const { status } of statuses) {
    switch (status) {
      case 'indexed':
        result.indexed++
        break
      case 'skipped':
        result.skipped++
        break
      case 'error':
        result.errors++
        break
      case 'cancelled':
        break
    }
  }

  result.cancelled = cancelled

  if (cancelled) {
    // Stopped mid-walk (vault close/switch): the databases may be about to go
    // away, so skip the verification queries. The pass is resumable — the next
    // indexVault run skips what this one finished and indexes the rest.
    logger.info(
      `Indexing cancelled: ${result.indexed} indexed, ${result.skipped} skipped, ` +
        `${result.errors} errors, ${allFiles.length - completed} remaining`
    )
    return result
  }

  const indexingMessage = `Indexing complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.errors} errors`
  if (result.indexed > 0 || result.errors > 0) {
    logger.info(indexingMessage)
  } else {
    logger.debug(indexingMessage)
  }

  if (result.errors > 0) {
    // itemCount = files that failed to index this pass; value = files indexed.
    trackMainLog('warn', {
      scope: 'vault',
      action: 'index_pass_errors',
      metrics: { itemCount: result.errors, value: result.indexed }
    })
  }

  // Verify counts (notes and journal entries are counted separately)
  const db = getIndexDatabase()
  const totalNotes = countNotes(db)
  const journalCount = countJournalEntries(db)
  logger.debug(`Total notes in cache: ${totalNotes}`)
  logger.debug(`Total journal entries in cache: ${journalCount}`)

  return result
}

/**
 * Check if the vault needs initial indexing.
 * Returns true if the cache is empty.
 */
export function needsInitialIndex(): boolean {
  try {
    const db = getIndexDatabase()
    const count = countNotes(db)
    return count === 0
  } catch {
    return true
  }
}

// ============================================================================
// Index Rebuild
// ============================================================================

/**
 * Result of index rebuild operation
 */
export interface RebuildResult {
  filesIndexed: number
  duration: number
}

/**
 * Reset the index database file: close, delete, re-run migrations, re-init the
 * connection and FTS5. Cheap (no file walk) — the open path uses it to get a
 * usable empty index synchronously and leaves repopulation to the background
 * build; `rebuildIndex` follows it with a full awaited walk.
 */
export function resetIndexDatabase(indexDbPath: string): void {
  // Close existing index database connection if open
  try {
    closeIndexDatabase()
  } catch {
    // Ignore if not open
  }

  // Delete corrupt/existing index file
  if (existsSync(indexDbPath)) {
    logger.info('Deleting existing index.db')
    unlinkSync(indexDbPath)
  }

  // Re-initialize database (migrations will recreate tables)
  logger.debug('Running index migrations')
  runIndexMigrations(indexDbPath)

  // Initialize the database connection
  logger.debug('Initializing index database')
  initIndexDatabase(indexDbPath)

  // Initialize FTS5
  logger.debug('Initializing FTS')
  initializeFts(getIndexDatabase())
}

/**
 * Rebuild the index database from scratch.
 * Deletes the existing index.db, recreates it, and re-indexes all markdown files.
 * Used for recovery from corruption or to force a fresh index.
 *
 * @param vaultPath - Absolute path to the vault
 * @returns Rebuild result with count and duration
 */
export async function rebuildIndex(vaultPath: string): Promise<RebuildResult> {
  const startTime = Date.now()
  const indexDbPath = getIndexDbPath(vaultPath)

  logger.info('Starting index rebuild:', vaultPath)

  resetIndexDatabase(indexDbPath)

  // Re-index all files
  logger.debug('Re-indexing all files')
  const result = await indexVault(vaultPath)

  const duration = Date.now() - startTime
  logger.info(`Rebuild complete: ${result.indexed} files in ${duration}ms`)

  return {
    filesIndexed: result.indexed,
    duration
  }
}
