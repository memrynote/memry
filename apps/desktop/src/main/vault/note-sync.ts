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
  inferPropertyType,
  resolvePropertyType
} from './frontmatter'
import { extractDateFromPath, getNoteCacheByPath } from '@main/database/queries/notes'
import { getDatabase, type IndexDb } from '../database'
import type { FileType } from '@memry/shared/file-types'
import type { PropertyType } from '@memry/contracts/property-types'
import {
  deleteCanonicalNote,
  saveCanonicalNote,
  saveCanonicalPropertyDefinition
} from '@memry/domain-notes'
import {
  getPropertyDefinition as getCanonicalPropertyDefinition,
  updateNoteMetadata
} from '@memry/storage-data'
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
      const type = resolvePropertyType(
        name,
        value,
        existing?.type as PropertyType | undefined,
        inferPropertyType
      )
      saveCanonicalPropertyDefinition(dataDb, { name, type: type })
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
  /** Internal note ID (sidecar-owned, never read from file frontmatter) */
  id: string
  /** Relative path from vault root */
  path: string
  /** Full file content including frontmatter */
  fileContent: string
  /** Raw user frontmatter keys (used for tags/aliases/properties extraction) */
  frontmatter: NoteFrontmatter
  /** Markdown body content (without frontmatter) */
  parsedContent: string
  /** Display title (verbatim basename) */
  title: string
  /** ISO created timestamp (sidecar/fs-sourced, never from frontmatter) */
  createdAt: string
  /** ISO modified timestamp (sidecar/fs-sourced, never from frontmatter) */
  modifiedAt: string
  /** Local-only privacy flag (sidecar-only state) */
  localOnly?: boolean
  /** Emoji icon (sidecar-only state) */
  emoji?: string | null
}

/**
 * Result of extracting metadata from a note.
 */
export interface NoteMetadata {
  /** Note ID */
  id: string
  /** Extracted tags (case preserved, deduplicated case-insensitively) */
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
  // Case-insensitive merge; frontmatter spelling wins over inline
  const tagsByKey = new Map<string, string>()
  for (const tag of [...frontmatterTags, ...inlineTags]) {
    const key = tag.toLowerCase()
    if (!tagsByKey.has(key)) tagsByKey.set(key, tag)
  }
  const tags = [...tagsByKey.values()]

  const properties = extractProperties(frontmatter)
  const wikiLinks = extractWikiLinks(parsedContent)
  const wordCount = calculateWordCount(parsedContent)
  const characterCount = parsedContent.length
  const snippet = createSnippet(parsedContent)
  const contentHash = generateContentHash(fileContent)
  const date = extractDateFromPath(path)
  const emoji = input.emoji ?? null

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
  const { id, path, parsedContent, title, createdAt, modifiedAt, localOnly } = input
  const metadata = extractNoteMetadata(input)
  const { properties, wikiLinks, wordCount, characterCount, snippet, contentHash, date, emoji } =
    metadata
  const tags = tagsOverride ?? metadata.tags

  syncCanonicalMetadata(
    {
      id,
      path,
      title,
      emoji,
      localOnly: localOnly ?? false,
      journalDate: date,
      properties,
      createdAt,
      modifiedAt
    },
    properties
  )

  const note: MarkdownNoteProjection = {
    kind: 'markdown',
    noteId: id,
    path,
    title,
    fileType: 'markdown',
    localOnly: localOnly ?? false,
    contentHash,
    wordCount,
    characterCount,
    snippet,
    date,
    emoji,
    createdAt,
    modifiedAt,
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
 * Tier 0 of vault ingest: everything the sidebar needs, from `stat`, the path
 * and the filename.
 *
 * The file is not read, so every content-derived field is published as null —
 * "not known yet", not "empty". {@link syncNoteToCache} replaces the row once
 * the idle backfill has measured the body.
 */
export interface NoteStatSyncInput {
  id: string
  path: string
  title: string
  createdAt: string
  modifiedAt: string
  /** Kept so a rename of a not-yet-backfilled row can still be matched. */
  fileSize: number
  localOnly?: boolean
  emoji?: string | null
}

export interface NoteStatSyncOptions {
  /**
   * False for a rename, where the row already exists and only its identity
   * moved. The canonical upsert writes every column it is given, so a
   * stat-only full save erases bookkeeping a `stat` cannot reconstruct —
   * `propertyDefinitionNames` most visibly, which is how the note's properties
   * reach other devices.
   */
  isNew: boolean
}

export function syncNoteStatToCache(
  _db: IndexDb,
  input: NoteStatSyncInput,
  options: NoteStatSyncOptions
): void {
  const { id, path, title, createdAt, modifiedAt, fileSize } = input
  const localOnly = input.localOnly ?? false
  const emoji = input.emoji ?? null
  const date = extractDateFromPath(path)

  if (options.isNew) {
    syncCanonicalMetadata({
      id,
      path,
      title,
      emoji,
      localOnly,
      journalDate: date,
      createdAt,
      modifiedAt
    })
  } else {
    const dataDb = getCanonicalDb()
    if (dataDb) {
      updateNoteMetadata(dataDb, id, { path, title, journalDate: date, modifiedAt })
    }
  }

  const note: MarkdownNoteProjection = {
    kind: 'markdown',
    noteId: id,
    path,
    title,
    fileType: 'markdown',
    localOnly,
    contentHash: null,
    wordCount: null,
    characterCount: null,
    snippet: null,
    date,
    emoji,
    createdAt,
    modifiedAt,
    parsedContent: null,
    fileSize,
    tags: [],
    properties: {},
    wikiLinks: []
  }

  publishProjectionEvent({ type: 'note.upserted', note })
}

/**
 * Tier 1 for a large-file-class file, whose body is never held as one string.
 *
 * The counts and the hash describe the whole file and come from a streaming
 * scan; only `indexedHead` is materialised, and it is what reaches search and
 * the snippet. Tags, properties and links stay empty on purpose: a log dump's
 * `#hashtags` and `[[brackets]]` are not the user's vault structure, and the
 * file is read-only anyway.
 */
export interface LargeFileBodySyncInput {
  id: string
  path: string
  title: string
  createdAt: string
  modifiedAt: string
  localOnly?: boolean
  emoji?: string | null
  wordCount: number
  characterCount: number
  contentHash: string
  indexedHead: string
}

export function syncLargeFileBodyToCache(_db: IndexDb, input: LargeFileBodySyncInput): void {
  const { id, path, title, createdAt, modifiedAt, wordCount, characterCount, contentHash } = input
  const localOnly = input.localOnly ?? false
  const emoji = input.emoji ?? null
  const date = extractDateFromPath(path)

  syncCanonicalMetadata({
    id,
    path,
    title,
    emoji,
    localOnly,
    journalDate: date,
    createdAt,
    modifiedAt
  })

  const note: MarkdownNoteProjection = {
    kind: 'markdown',
    noteId: id,
    path,
    title,
    fileType: 'markdown',
    localOnly,
    contentHash,
    wordCount,
    characterCount,
    snippet: createSnippet(input.indexedHead),
    date,
    emoji,
    createdAt,
    modifiedAt,
    parsedContent: input.indexedHead,
    tags: [],
    properties: {},
    wikiLinks: []
  }

  publishProjectionEvent({ type: 'note.upserted', note })
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
