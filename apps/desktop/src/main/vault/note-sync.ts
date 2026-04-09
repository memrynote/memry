/**
 * Note Sync Service
 * Unified logic for syncing notes to the database cache.
 *
 * This service consolidates duplicate code from notes.ts, watcher.ts, and indexer.ts
 * into a single source of truth for cache synchronization operations.
 *
 * @module vault/note-sync
 */

import type { NoteFrontmatter } from './frontmatter'
import {
  extractTags,
  extractInlineTagsFromMarkdown,
  extractProperties,
  extractWikiLinks,
  calculateWordCount,
  generateContentHash,
  createSnippet,
  inferPropertyType
} from './frontmatter'
import {
  insertNoteCache,
  updateNoteCache,
  deleteNoteCache,
  setNoteTags,
  setNoteLinks,
  setNoteProperties,
  extractDateFromPath,
  deleteLinksToNote,
  resolveNotesByTitles,
  getNoteCacheByPath
} from '@main/database/queries/notes'
import { getDatabase, type IndexDb } from '../database'
import type { FileType } from '@memry/shared/file-types'
import type { PropertyType } from '@memry/contracts/property-types'
import {
  deleteCanonicalNote,
  saveCanonicalNote,
  saveCanonicalPropertyDefinition
} from '@memry/domain-notes'
import { getPropertyDefinition as getCanonicalPropertyDefinition } from '@memry/storage-data'
import { publishProjectionEvent } from '../projections'
import type { FileNoteProjection, MarkdownNoteProjection } from '../projections/types'

function getCanonicalDb() {
  try {
    return getDatabase()
  } catch {
    return null
  }
}

function syncCanonicalMetadata(input: Parameters<typeof saveCanonicalNote>[1]): void {
  const dataDb = getCanonicalDb()
  if (!dataDb) return
  saveCanonicalNote(dataDb, input)
}

function removeCanonicalMetadata(noteId: string): void {
  const dataDb = getCanonicalDb()
  if (!dataDb) return
  deleteCanonicalNote(dataDb, noteId)
}

/**
 * Input for syncing a note to the cache.
 */
export interface NoteSyncInput {
  /** Unique note ID from frontmatter */
  id: string
  /** Relative path from vault root */
  path: string
  /** Full file content including frontmatter */
  fileContent: string
  /** Parsed frontmatter object */
  frontmatter: NoteFrontmatter
  /** Markdown body content (without frontmatter) */
  parsedContent: string
}

/**
 * Result of extracting metadata from a note.
 */
export interface NoteMetadata {
  /** Note ID */
  id: string
  /** Extracted tags (normalized to lowercase) */
  tags: string[]
  /** Custom properties from frontmatter */
  properties: Record<string, unknown>
  /** Wiki links found in content */
  wikiLinks: string[]
  /** Word count of markdown body */
  wordCount: number
  /** Character count of markdown body */
  characterCount: number
  /** Preview snippet */
  snippet: string
  /** Content hash for change detection */
  contentHash: string
  /** Journal date if this is a journal entry (YYYY-MM-DD), null otherwise */
  date: string | null
  /** Emoji icon from frontmatter */
  emoji: string | null
}

/**
 * Result of syncing a note to cache.
 */
export interface NoteSyncResult extends NoteMetadata {
  /** Resolved wiki links with target IDs */
  links: { targetTitle: string; targetId: string | undefined }[]
}

/**
 * Options for sync operations.
 */
export interface NoteSyncOptions {
  /**
   * Whether this is a new note (insert) or existing (update).
   * Determines which cache operation to use.
   */
  isNew: boolean

  /**
   * Skip link resolution (useful when batch resolving links later).
   * @default false
   */
  skipLinks?: boolean

  /**
   * Authoritative tags to use instead of re-extracting from content.
   * Prevents stale inline tags from being resurrected when content
   * and tags are saved in separate IPC calls.
   */
  tagsOverride?: string[]
}

// ============================================================================
// Metadata Extraction
// ============================================================================

/**
 * Extract all metadata from a parsed note.
 * This is a pure function that doesn't touch the database.
 *
 * @param input - Note sync input
 * @returns Extracted metadata
 */
export function extractNoteMetadata(input: NoteSyncInput): NoteMetadata {
  const { id, path, fileContent, frontmatter, parsedContent } = input

  const frontmatterTags = extractTags(frontmatter)
  const inlineTags = extractInlineTagsFromMarkdown(parsedContent)
  const tags = [...new Set([...frontmatterTags, ...inlineTags])]

  // Extract custom properties (non-reserved frontmatter fields)
  const properties = extractProperties(frontmatter)

  // Extract wiki links from content
  const wikiLinks = extractWikiLinks(parsedContent)

  // Calculate metrics
  const wordCount = calculateWordCount(parsedContent)
  const characterCount = parsedContent.length
  const snippet = createSnippet(parsedContent)
  const contentHash = generateContentHash(fileContent)

  // Check if this is a journal entry
  const date = extractDateFromPath(path)

  // Extract emoji from frontmatter
  const emoji = (frontmatter as { emoji?: string }).emoji ?? null

  return {
    id,
    tags,
    properties,
    wikiLinks,
    wordCount,
    characterCount,
    snippet,
    contentHash,
    date,
    emoji
  }
}

// ============================================================================
// Cache Sync Operations
// ============================================================================

/**
 * Sync a note to the database cache.
 * This is now a compatibility wrapper that extracts note metadata,
 * publishes a projection event, and returns the extracted result.
 *
 * @param db - Database instance
 * @param input - Note sync input
 * @param options - Sync options
 * @returns Sync result with resolved links
 */
export function syncNoteToCache(
  db: IndexDb,
  input: NoteSyncInput,
  options: NoteSyncOptions
): NoteSyncResult {
  const { isNew, skipLinks = false, tagsOverride } = options
  const { id, path, frontmatter, parsedContent } = input

  // Extract all metadata
  const metadata = extractNoteMetadata(input)
  const { properties, wikiLinks, wordCount, characterCount, snippet, contentHash, date, emoji } =
    metadata
  const tags = tagsOverride ?? metadata.tags

  // Get title from frontmatter or path
  const title = frontmatter.title ?? path.split('/').pop()?.replace('.md', '') ?? 'Untitled'
  const canonicalDb = getCanonicalDb()

  syncCanonicalMetadata({
    id,
    path,
    title,
    emoji,
    localOnly: frontmatter.localOnly ?? false,
    journalDate: date,
    properties,
    createdAt: frontmatter.created,
    modifiedAt: frontmatter.modified
  })

  const note: MarkdownNoteProjection = {
    kind: 'markdown',
    noteId: id,
    path,
    title,
    fileType: 'markdown',
    localOnly: frontmatter.localOnly ?? false,
    contentHash,
    wordCount,
    characterCount,
    snippet,
    date,
    emoji,
    createdAt: frontmatter.created,
    modifiedAt: frontmatter.modified,
    parsedContent,
    tags,
    properties,
    wikiLinks
  }

  publishProjectionEvent({
    type: 'note.upserted',
    note
  })

  if (isNew) {
    insertNoteCache(db, {
      id,
      path,
      title,
      emoji,
      localOnly: frontmatter.localOnly ?? false,
      contentHash,
      wordCount,
      characterCount,
      snippet,
      date,
      createdAt: frontmatter.created,
      modifiedAt: frontmatter.modified
    })
  } else {
    updateNoteCache(db, id, {
      path,
      title,
      emoji,
      localOnly: frontmatter.localOnly ?? false,
      contentHash,
      wordCount,
      characterCount,
      snippet,
      modifiedAt: frontmatter.modified
    })
  }

  setNoteTags(db, id, tags)

  setNoteProperties(db, id, properties, (name, value) => {
    const canonicalType = canonicalDb
      ? (getCanonicalPropertyDefinition(canonicalDb, name)?.type as PropertyType | undefined)
      : undefined
    const type = canonicalType ?? inferPropertyType(name, value)
    if (canonicalDb) {
      saveCanonicalPropertyDefinition(canonicalDb, { name, type })
    }
    return type
  })

  let links: { targetTitle: string; targetId: string | undefined }[] = []
  if (!skipLinks) {
    links = resolveAndSetLinks(db, id, wikiLinks)
  }

  return {
    ...metadata,
    links
  }
}

/**
 * Resolve wiki links to note IDs and set them in the database.
 * Uses batch query for O(1) instead of O(n) individual queries.
 *
 * @param db - Database instance
 * @param sourceId - Source note ID
 * @param wikiLinks - Array of wiki link titles
 * @returns Resolved links with target IDs
 */
function resolveAndSetLinks(
  db: IndexDb,
  sourceId: string,
  wikiLinks: string[]
): { targetTitle: string; targetId: string | undefined }[] {
  // Batch resolve all titles in a single query
  const resolvedMap = resolveNotesByTitles(db, wikiLinks)

  const links = wikiLinks.map((title) => {
    const target = resolvedMap.get(title)
    return { targetTitle: title, targetId: target?.id }
  })

  setNoteLinks(db, sourceId, links)

  return links
}

/**
 * Delete a note from the cache.
 * Cleans up links, tags, properties, and the cache entry itself.
 *
 * @param db - Database instance
 * @param noteId - Note ID to delete
 */
export function deleteNoteFromCache(db: IndexDb, noteId: string): void {
  publishProjectionEvent({
    type: 'note.deleted',
    noteId
  })

  deleteLinksToNote(db, noteId)
  deleteNoteCache(db, noteId)
  removeCanonicalMetadata(noteId)
}

// ============================================================================
// Batch Operations (re-exported from queries for convenience)
// ============================================================================

// Re-export for consumers of this module
export { resolveNotesByTitles } from '@main/database/queries/notes'

/**
 * Sync links using batch-resolved titles.
 * More efficient when syncing multiple notes.
 *
 * @param db - Database instance
 * @param sourceId - Source note ID
 * @param wikiLinks - Array of wiki link titles
 * @param resolvedTitles - Pre-resolved title map from resolveNotesByTitles
 */
export function syncLinksWithResolvedTitles(
  db: IndexDb,
  sourceId: string,
  wikiLinks: string[],
  resolvedTitles: Map<string, { id: string; path: string } | null>
): void {
  const links = wikiLinks.map((title) => {
    const resolved = resolvedTitles.get(title)
    return { targetTitle: title, targetId: resolved?.id }
  })

  setNoteLinks(db, sourceId, links)
}

// ============================================================================
// File Sync (Non-Markdown Files)
// ============================================================================

/**
 * Input for syncing a non-markdown file to the cache.
 */
export interface FileSyncInput {
  /** Unique file ID */
  id: string
  /** Relative path from vault root */
  path: string
  /** Title derived from filename */
  title: string
  /** File type: 'pdf' | 'image' | 'audio' | 'video' */
  fileType: Exclude<FileType, 'markdown'>
  /** MIME type (e.g., 'application/pdf') */
  mimeType: string | null
  /** File size in bytes */
  fileSize: number
  /** File creation time */
  createdAt: Date
  /** File modification time */
  modifiedAt: Date
}

/**
 * Result of syncing a file to cache.
 */
export interface FileSyncResult {
  id: string
  path: string
  title: string
  fileType: Exclude<FileType, 'markdown'>
  mimeType: string | null
  fileSize: number
}

/**
 * Sync a non-markdown file to the database cache.
 * This is simpler than note sync - just stores basic file metadata.
 *
 * @param db - Database instance
 * @param input - File sync input
 * @returns Sync result
 */
export function syncFileToCache(db: IndexDb, input: FileSyncInput): FileSyncResult {
  const { id, path, title, fileType, mimeType, fileSize, createdAt, modifiedAt } = input

  syncCanonicalMetadata({
    id,
    path,
    title,
    fileType,
    mimeType,
    fileSize,
    createdAt: createdAt.toISOString(),
    modifiedAt: modifiedAt.toISOString()
  })

  // Check if file already exists in cache
  const existing = getNoteCacheByPath(db, path)
  const noteId = existing?.id ?? id

  const note: FileNoteProjection = {
    kind: 'file',
    noteId,
    path,
    title,
    fileType,
    mimeType,
    fileSize,
    createdAt: createdAt.toISOString(),
    modifiedAt: modifiedAt.toISOString()
  }

  publishProjectionEvent({
    type: 'note.upserted',
    note
  })

  if (existing) {
    updateNoteCache(db, existing.id, {
      path,
      title,
      fileType,
      mimeType,
      fileSize,
      modifiedAt: modifiedAt.toISOString()
    })
  } else {
    insertNoteCache(db, {
      id,
      path,
      title,
      fileType,
      mimeType,
      fileSize,
      contentHash: null,
      wordCount: null,
      characterCount: null,
      snippet: null,
      emoji: null,
      date: null,
      createdAt: createdAt.toISOString(),
      modifiedAt: modifiedAt.toISOString()
    })
  }

  return {
    id: noteId,
    path,
    title,
    fileType,
    mimeType,
    fileSize
  }
}
