/**
 * Note metadata extraction, canonical persistence, and projection event publishing.
 * Projectors handle index-cache writes asynchronously.
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
  extractDateFromPath,
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

function syncCanonicalMetadata(
  input: Parameters<typeof saveCanonicalNote>[1],
  properties?: Record<string, unknown>
): void {
  const dataDb = getCanonicalDb()
  if (!dataDb) return
  saveCanonicalNote(dataDb, input)
  if (properties) {
    for (const [name, value] of Object.entries(properties)) {
      const existing = getCanonicalPropertyDefinition(dataDb, name)
      const type = (existing?.type as PropertyType | undefined) ?? inferPropertyType(name, value)
      saveCanonicalPropertyDefinition(dataDb, { name, type: type as PropertyType })
    }
  }
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
export type NoteSyncResult = NoteMetadata

/**
 * Options for sync operations.
 */
export interface NoteSyncOptions {
  /** Whether this is a new note (insert) or existing (update). */
  isNew: boolean

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

  const properties = extractProperties(frontmatter)
  const wikiLinks = extractWikiLinks(parsedContent)
  const wordCount = calculateWordCount(parsedContent)
  const characterCount = parsedContent.length
  const snippet = createSnippet(parsedContent)
  const contentHash = generateContentHash(fileContent)
  const date = extractDateFromPath(path)
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
 * Extract note metadata, persist canonical state, and publish a projection event.
 */
export function syncNoteToCache(
  _db: IndexDb,
  input: NoteSyncInput,
  options: NoteSyncOptions
): NoteSyncResult {
  const { tagsOverride } = options
  const { id, path, frontmatter, parsedContent } = input
  const metadata = extractNoteMetadata(input)
  const { properties, wikiLinks, wordCount, characterCount, snippet, contentHash, date, emoji } =
    metadata
  const tags = tagsOverride ?? metadata.tags

  const title = frontmatter.title ?? path.split('/').pop()?.replace('.md', '') ?? 'Untitled'

  syncCanonicalMetadata(
    {
      id,
      path,
      title,
      emoji,
      localOnly: frontmatter.localOnly ?? false,
      journalDate: date,
      properties,
      createdAt: frontmatter.created,
      modifiedAt: frontmatter.modified
    },
    properties
  )

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

  return metadata
}

/**
 * Publish a note.deleted projection event and remove canonical metadata.
 */
export function deleteNoteFromCache(_db: IndexDb, noteId: string): void {
  publishProjectionEvent({
    type: 'note.deleted',
    noteId
  })

  removeCanonicalMetadata(noteId)
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

  return {
    id: noteId,
    path,
    title,
    fileType,
    mimeType,
    fileSize
  }
}
