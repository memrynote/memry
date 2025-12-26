/**
 * Initial Vault Indexer
 *
 * Scans vault folders for markdown files and populates the notes cache.
 * Called when a vault is first opened or when reindexing.
 *
 * @module vault/indexer
 */

import path from 'path'
import { readdir, stat } from 'fs/promises'
import { existsSync, unlinkSync } from 'fs'
import { getConfig, emitIndexProgress } from './index'
import { getIndexDbPath } from './init'
import {
  initIndexDatabase,
  runIndexMigrations,
  initializeFts,
  getIndexDatabase,
  closeIndexDatabase
} from '../database'
import {
  parseNote,
  serializeNote,
  extractTags,
  extractWikiLinks,
  calculateWordCount,
  generateContentHash
} from './frontmatter'
import { safeRead, atomicWrite } from './file-ops'
import { generateNoteId } from '../lib/id'
import {
  insertNoteCache,
  getNoteCacheByPath,
  getNoteCacheById,
  setNoteTags,
  setNoteLinks,
  resolveNoteByTitle,
  countNotes,
  extractDateFromPath
} from '@shared/db/queries/notes'

// ============================================================================
// Types
// ============================================================================

interface IndexResult {
  indexed: number
  skipped: number
  errors: number
}

// ============================================================================
// Directory Scanner
// ============================================================================

/**
 * Recursively find all markdown files in a directory.
 * @param dirPath - Directory to scan
 * @param basePath - Vault root path for relative path calculation
 * @param excludePatterns - Patterns to exclude from scanning
 */
async function findMarkdownFiles(
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
        const subFiles = await findMarkdownFiles(fullPath, basePath, excludePatterns)
        files.push(...subFiles)
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        // Add markdown file (relative path from vault root)
        files.push(path.relative(basePath, fullPath))
      }
    }
  } catch (error) {
    console.error(`[Indexer] Error scanning directory ${dirPath}:`, error)
  }

  return files
}

// ============================================================================
// File Indexer
// ============================================================================

/**
 * Index a single markdown file into the cache.
 */
async function indexFile(
  vaultPath: string,
  relativePath: string
): Promise<'indexed' | 'skipped' | 'error'> {
  const absolutePath = path.join(vaultPath, relativePath)

  try {
    const db = getIndexDatabase()

    // Read and parse the file first
    const content = await safeRead(absolutePath)
    if (!content) {
      console.warn(`[Indexer] Could not read file: ${relativePath}`)
      return 'error'
    }

    const parsed = parseNote(content, relativePath)
    console.log(`[Indexer] Parsed file: ${relativePath}, id: ${parsed.frontmatter.id}, title: ${parsed.frontmatter.title}`)

    // Check if already in cache by path
    const existingByPath = getNoteCacheByPath(db, relativePath)
    if (existingByPath) {
      console.log(`[Indexer] Skipping (already cached by path): ${relativePath}`)
      return 'skipped'
    }

    // Check if already in cache by ID (possible duplicate/copied file)
    const existingById = getNoteCacheById(db, parsed.frontmatter.id)
    if (existingById) {
      // This is a copy of an existing note - regenerate ID
      console.log(`[Indexer] Duplicate ID detected, regenerating for: ${relativePath}`)
      const newId = generateNoteId()
      parsed.frontmatter.id = newId

      // Write back to file with new ID
      try {
        const newContent = serializeNote(parsed.frontmatter, parsed.content)
        await atomicWrite(absolutePath, newContent)
        console.log(`[Indexer] Regenerated ID for ${relativePath}: ${existingById.id} → ${newId}`)
      } catch (writeError) {
        console.error(`[Indexer] Failed to write new ID for ${relativePath}:`, writeError)
        return 'error'
      }
    }

    // Extract metadata
    const tags = extractTags(parsed.frontmatter)
    const wikiLinks = extractWikiLinks(parsed.content)
    const wordCount = calculateWordCount(parsed.content)
    const characterCount = parsed.content.length
    const contentHash = generateContentHash(content)

    // Check if this is a journal entry (journal/YYYY-MM-DD.md)
    const date = extractDateFromPath(relativePath)

    // Insert into cache
    try {
      insertNoteCache(db, {
        id: parsed.frontmatter.id,
        path: relativePath,
        title: parsed.frontmatter.title ?? path.basename(relativePath, '.md'),
        contentHash,
        wordCount,
        characterCount,
        date,
        createdAt: parsed.frontmatter.created,
        modifiedAt: parsed.frontmatter.modified
      })
      console.log(`[Indexer] Indexed: ${relativePath}${date ? ` (journal: ${date})` : ''}`)
    } catch (insertError) {
      console.error(`[Indexer] Insert failed for ${relativePath}:`, insertError)
      return 'error'
    }

    // Set tags
    if (tags.length > 0) {
      setNoteTags(db, parsed.frontmatter.id, tags)
    }

    // Set links (resolve targets after all files are indexed)
    if (wikiLinks.length > 0) {
      const links = wikiLinks.map((title) => {
        const target = resolveNoteByTitle(db, title)
        return { targetTitle: title, targetId: target?.id }
      })
      setNoteLinks(db, parsed.frontmatter.id, links)
    }

    return 'indexed'
  } catch (error) {
    console.error(`[Indexer] Error indexing file ${relativePath}:`, error)
    return 'error'
  }
}

// ============================================================================
// Main Indexer
// ============================================================================

/**
 * Index all notes in the vault.
 * Scans notes and journal folders, populates cache.
 *
 * @param vaultPath - Absolute path to the vault
 * @returns Index result with counts
 */
export async function indexVault(vaultPath: string): Promise<IndexResult> {
  console.log('[Indexer] Starting vault indexing:', vaultPath)

  const config = getConfig()
  const excludePatterns = config.excludePatterns ?? []
  const result: IndexResult = {
    indexed: 0,
    skipped: 0,
    errors: 0
  }

  // Get folders to scan
  const foldersToScan = [
    path.join(vaultPath, config.defaultNoteFolder),
    path.join(vaultPath, config.journalFolder)
  ]

  // Find all markdown files (respecting exclude patterns)
  const allFiles: string[] = []
  for (const folder of foldersToScan) {
    try {
      const folderStat = await stat(folder)
      if (folderStat.isDirectory()) {
        const files = await findMarkdownFiles(folder, vaultPath, excludePatterns)
        allFiles.push(...files)
      }
    } catch {
      // Folder doesn't exist, skip
      console.log(`[Indexer] Folder does not exist, skipping: ${folder}`)
    }
  }

  console.log(`[Indexer] Found ${allFiles.length} markdown files to index`)

  if (allFiles.length === 0) {
    emitIndexProgress(100)
    return result
  }

  // Index each file
  for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i]
    const status = await indexFile(vaultPath, file)

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
    }

    // Emit progress (batch every 10 files to reduce IPC overhead)
    if (i % 10 === 0 || i === allFiles.length - 1) {
      const progress = Math.round(((i + 1) / allFiles.length) * 100)
      emitIndexProgress(progress)
    }
  }

  console.log(
    `[Indexer] Indexing complete: ${result.indexed} indexed, ${result.skipped} skipped, ${result.errors} errors`
  )

  // Verify count
  const db = getIndexDatabase()
  const totalNotes = countNotes(db)
  console.log(`[Indexer] Total notes in cache: ${totalNotes}`)

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

  console.log('[Indexer] Starting index rebuild:', vaultPath)

  // Close existing index database connection if open
  try {
    closeIndexDatabase()
  } catch {
    // Ignore if not open
  }

  // Delete corrupt/existing index file
  if (existsSync(indexDbPath)) {
    console.log('[Indexer] Deleting existing index.db')
    unlinkSync(indexDbPath)
  }

  // Re-initialize database (migrations will recreate tables)
  console.log('[Indexer] Running index migrations')
  runIndexMigrations(indexDbPath)

  // Initialize the database connection
  console.log('[Indexer] Initializing index database')
  initIndexDatabase(indexDbPath)

  // Initialize FTS5
  console.log('[Indexer] Initializing FTS')
  initializeFts(getIndexDatabase())

  // Re-index all files
  console.log('[Indexer] Re-indexing all files')
  const result = await indexVault(vaultPath)

  const duration = Date.now() - startTime
  console.log(`[Indexer] Rebuild complete: ${result.indexed} files in ${duration}ms`)

  return {
    filesIndexed: result.indexed,
    duration
  }
}
