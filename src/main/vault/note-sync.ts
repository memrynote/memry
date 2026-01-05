/**
 * Note Sync Service
 * Unified logic for syncing notes to the database cache.
 *
 * This service consolidates duplicate code from notes.ts, watcher.ts, and indexer.ts
 * into a single source of truth for cache synchronization operations.
 *
 * @module vault/note-sync
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '@shared/db/schema'
import type { NoteFrontmatter } from './frontmatter'
import {
  extractTags,
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
  getPropertyType,
  deleteLinksToNote,
  extractDateFromPath,
  resolveNotesByTitles
} from '@shared/db/queries/notes'
import { queueFtsUpdate } from '../database'

// ============================================================================
// Types
// ============================================================================

type DrizzleDb = BetterSQLite3Database<typeof schema>

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
   * Skip FTS update (useful for batch operations that do FTS separately).
   * @default false
   */
  skipFts?: boolean

  /**
   * Skip link resolution (useful when batch resolving links later).
   * @default false
   */
  skipLinks?: boolean
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

  // Extract tags from frontmatter
  const tags = extractTags(frontmatter)

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
 * Handles insert or update, tags, properties, FTS, and links.
 *
 * @param db - Database instance
 * @param input - Note sync input
 * @param options - Sync options
 * @returns Sync result with resolved links
 */
export function syncNoteToCache(
  db: DrizzleDb,
  input: NoteSyncInput,
  options: NoteSyncOptions
): NoteSyncResult {
  const { isNew, skipFts = false, skipLinks = false } = options
  const { id, path, frontmatter, parsedContent } = input

  // Extract all metadata
  const metadata = extractNoteMetadata(input)
  const {
    tags,
    properties,
    wikiLinks,
    wordCount,
    characterCount,
    snippet,
    contentHash,
    date,
    emoji
  } = metadata

  // Get title from frontmatter or path
  const title = frontmatter.title ?? path.split('/').pop()?.replace('.md', '') ?? 'Untitled'

  // Insert or update cache entry
  if (isNew) {
    insertNoteCache(db, {
      id,
      path,
      title,
      emoji,
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
      contentHash,
      wordCount,
      characterCount,
      snippet,
      modifiedAt: frontmatter.modified
    })
  }

  // Set tags (replaces existing)
  setNoteTags(db, id, tags)

  // Set properties with type inference
  if (Object.keys(properties).length > 0) {
    setNoteProperties(db, id, properties, (name, value) =>
      getPropertyType(db, name, value, inferPropertyType)
    )
  }

  // Queue FTS index update (batched for performance)
  if (!skipFts) {
    queueFtsUpdate(id, parsedContent, tags)
  }

  // Resolve and set links
  let links: { targetTitle: string; targetId: string | undefined }[] = []
  if (!skipLinks && wikiLinks.length > 0) {
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
  db: DrizzleDb,
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
export function deleteNoteFromCache(db: DrizzleDb, noteId: string): void {
  // Clean up links where this note is the target (orphaned outgoing links from other notes)
  deleteLinksToNote(db, noteId)

  // Delete the note cache entry (cascades to tags, properties, and outgoing links via foreign keys)
  deleteNoteCache(db, noteId)
}

// ============================================================================
// Batch Operations (re-exported from queries for convenience)
// ============================================================================

// Re-export for consumers of this module
export { resolveNotesByTitles } from '@shared/db/queries/notes'

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
  db: DrizzleDb,
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
