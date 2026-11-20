/**
 * Note metadata extraction, canonical persistence, and projection event publishing.
 * Projectors handle index-cache writes asynchronously.
 *
 * @module vault/note-sync
 */

import { posix } from 'path'
import type { NoteFrontmatter } from './frontmatter'
import {
  extractAliases,
  extractTags,
  mergeTagLists,
  extractProperties,
  calculateWordCount,
  generateContentHash,
  createSnippet
} from './frontmatter'
import { inferPropertyType, resolvePropertyType } from './property-type'
import { extractWikiLinks } from '@memry/shared/wiki-target'
import { extractInlineTagsFromMarkdown } from '@memry/shared/inline-tags'
import { COVER_FRONTMATTER_KEY, isCoverValue } from '@memry/shared/cover-image'
import { extractDateFromPath, getNoteCacheByPath } from '@main/database/queries/notes'
import { getDatabase, type IndexDb } from '../database'
import { diskCaseOf, volumeIgnoresCase } from './disk-case'
import { getPendingDelete } from './rename-tracker'
import type { FileType } from '@memry/shared/file-types'
import {
  isPersistableDefinitionType,
  PROJECT_PROPERTY_KEY,
  type PropertyType
} from '@memry/contracts/property-types'
import {
  deleteCanonicalNote,
  saveCanonicalNote,
  saveCanonicalPropertyDefinition
} from '@memry/domain-notes'
import {
  getNoteMetadataById,
  getNoteMetadataByPath,
  listNoteMetadataByFoldedPath,
  getPropertyDefinition as getCanonicalPropertyDefinition,
  updateNoteMetadata,
  type NoteMetadataDb
} from '@memry/storage-data'
import { flushProjectionEvents, publishProjectionEvent } from '../projections'
import { DEFAULT_PROJECTION_QUEUE_LIMIT } from '../projections/bus'
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
      learnCanonicalPropertyType(dataDb, name, value)
    }
  }
}

/**
 * A note only learns a type. Re-saving a known definition with bare fields
 * would null the options, default and color the user set.
 */
export function learnCanonicalPropertyType(
  dataDb: NoteMetadataDb,
  name: string,
  value: unknown
): PropertyType {
  const existing = getCanonicalPropertyDefinition(dataDb, name)
  const type = resolvePropertyType(
    name,
    value,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- string DB/wire column narrowed to the union its writers constrain
    existing?.type as PropertyType | undefined,
    inferPropertyType
  )
  // `relation` has no PropertyDefinitionSchema member, so it is never
  // persisted — it is re-derived from the value on every pass instead.
  if (
    isPersistableDefinitionType(type) &&
    (!existing || (name === PROJECT_PROPERTY_KEY && existing.type !== type))
  ) {
    saveCanonicalPropertyDefinition(dataDb, {
      name,
      type,
      options: existing?.options,
      defaultValue: existing?.defaultValue,
      color: existing?.color
    })
  }
  return type
}

export interface CanonicalNoteRef {
  id: string
  /** The row's spelling, which differs from the file's only in case. */
  path: string
  title: string
  createdAt: string
  modifiedAt: string
  fileSize: number | null
  /**
   * Other rows fold to this file's path (#5263), the row at its exact path
   * included: their bytes may be the ones on disk, so the file's size and
   * body say nothing about this row (#5297).
   */
  sharesFile: boolean
  emoji: string | null
  localOnly: boolean
}

/**
 * The identity the vault already holds for the file at `relativePath`, given
 * in the disk's spelling, if it holds one.
 *
 * `note_metadata.path` is unique, so a second row for the same path is not a
 * duplicate to be resolved later — it is an INSERT that throws. An ingest that
 * finds a path already claimed has to adopt that row's id rather than mint a
 * fresh one: the id is what the note's CRDT doc, sync item and open tabs are
 * keyed by, so renumbering it orphans all three.
 *
 * On a case-insensitive disk the row can spell the path in another case: sync
 * applies a note at `SuperNotes/a.md`, and the file lands in the `Supernotes/`
 * folder the disk already has. Each such file was listed again under a fresh
 * id and pushed as a create (#5261).
 */
export function findCanonicalNoteForFile(
  vaultPath: string,
  relativePath: string
): CanonicalNoteRef | null {
  const dataDb = getCanonicalDb()
  if (!dataDb) return null
  const exact = getNoteMetadataByPath(dataDb, relativePath)
  const candidates = volumeIgnoresCase(vaultPath)
    ? listNoteMetadataByFoldedPath(dataDb, relativePath)
    : []
  const row =
    exact ?? candidates.find((candidate) => diskCaseOf(vaultPath, candidate.path) === relativePath)
  return row
    ? {
        sharesFile: candidates.length > 1,
        id: row.id,
        path: row.path,
        title: row.title,
        createdAt: row.createdAt,
        modifiedAt: row.modifiedAt,
        fileSize: row.fileSize,
        emoji: row.emoji,
        localOnly: row.localOnly
      }
    : null
}

/**
 * Whether a file whose row spells its path in another case is the remote-apply
 * shape (#5261): only the folder segments differ, and no unlink of the row's
 * path is pending. Sync wrote the row's spelling into a folder the disk spells
 * otherwise, and nothing was renamed. A file name that changed case is the
 * user's rename, which syncs.
 */
export function isRemoteApplySpelling(claimed: CanonicalNoteRef, relativePath: string): boolean {
  return (
    posix.basename(claimed.path) === posix.basename(relativePath) &&
    getPendingDelete(claimed.id) === undefined
  )
}

/** The path the canonical row gives note `id`, or null when it has no row. */
export function findCanonicalNotePath(id: string): string | null {
  const dataDb = getCanonicalDb()
  if (!dataDb) return null
  return getNoteMetadataById(dataDb, id)?.path ?? null
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
  tags: string[]
  headerTags: string[]
  /** Custom properties from frontmatter */
  properties: Record<string, unknown>
  aliases: string[]
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
  /** Raw `cover` frontmatter value when it is a cover, else null */
  cover: string | null
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

  const headerTags = extractTags(frontmatter)
  const tags = mergeTagLists(headerTags, extractInlineTagsFromMarkdown(parsedContent))

  const properties = extractProperties(frontmatter)
  const aliases = extractAliases(frontmatter, input.title)
  const wikiLinks = extractWikiLinks(parsedContent)
  const wordCount = calculateWordCount(parsedContent)
  const characterCount = parsedContent.length
  const snippet = createSnippet(parsedContent)
  const contentHash = generateContentHash(fileContent)
  const date = extractDateFromPath(path)
  const emoji = input.emoji ?? null
  const rawCover = frontmatter[COVER_FRONTMATTER_KEY]
  const cover = isCoverValue(rawCover) ? rawCover : null

  return {
    id,
    tags,
    headerTags,
    properties,
    aliases,
    wikiLinks,
    wordCount,
    characterCount,
    snippet,
    contentHash,
    date,
    emoji,
    cover
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
  _options: NoteSyncOptions
): NoteSyncResult {
  const { id, path, parsedContent, title, createdAt, modifiedAt, localOnly } = input
  const metadata = extractNoteMetadata(input)
  const {
    tags,
    headerTags,
    properties,
    aliases,
    wikiLinks,
    wordCount,
    characterCount,
    snippet,
    contentHash,
    date,
    emoji,
    cover
  } = metadata

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
    cover,
    createdAt,
    modifiedAt,
    parsedContent,
    tags,
    headerTags,
    properties,
    aliases,
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
  publishProjectionEvent({ type: 'note.upserted', note: persistNoteStat(input, options) })
}

function persistNoteStat(
  input: NoteStatSyncInput,
  options: NoteStatSyncOptions
): MarkdownNoteProjection {
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

  return {
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
    headerTags: [],
    properties: null,
    aliases: null,
    wikiLinks: []
  }
}

/** A note row that a folder rename or move carries to a new path. */
export type NoteMove =
  | { kind: 'markdown'; input: NoteStatSyncInput }
  | { kind: 'file'; input: FileSyncInput }

/**
 * Projection lanes drop their oldest events past DEFAULT_PROJECTION_QUEUE_LIMIT,
 * and the note-cache lane has no repair for a dropped move.
 */
const MOVE_PROJECTION_BATCH = DEFAULT_PROJECTION_QUEUE_LIMIT / 4

/**
 * Carry many notes to new paths, as a folder rename does.
 *
 * Every canonical row moves first, in one synchronous pass, so a watcher event
 * handled while the index catches up already finds each note at its new path.
 * The index follows in batches the projection lanes can hold. Publishing one
 * event per note at once overflowed them on a folder of a few thousand notes,
 * and every dropped event left a note in the sidebar under the old folder.
 */
export async function moveNotesInCache(db: IndexDb, moves: NoteMove[]): Promise<void> {
  const notes = moves.map((move) =>
    move.kind === 'markdown'
      ? persistNoteStat(move.input, { isNew: false })
      : persistFile(db, move.input).note
  )
  for (let start = 0; start < notes.length; start += MOVE_PROJECTION_BATCH) {
    for (const note of notes.slice(start, start + MOVE_PROJECTION_BATCH)) {
      publishProjectionEvent({ type: 'note.upserted', note })
    }
    await flushProjectionEvents()
  }
}

/**
 * Tier 1 for a large-file-class file, whose body is never held as one string.
 *
 * The counts and the hash describe the whole file and come from a streaming
 * scan; only `indexedHead` is materialised, and it is what reaches search and
 * the snippet. Tags, properties and links stay empty on purpose: a log dump's
 * `#hashtags` and `[[brackets]]` are not the user's vault structure, and the
 * file is read-only anyway. Properties are null, not empty: the frontmatter
 * was never read, so the project links it derived earlier stay.
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
    headerTags: [],
    properties: null,
    aliases: null,
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
/**
 * Move a file's row to `input.path` and keep every other canonical column
 * (emoji, local-only, sync bookkeeping), as `syncNoteStatToCache` with
 * `isNew: false` does for markdown. `syncFileToCache` writes the whole row.
 */
export function moveFileInCache(_db: IndexDb, input: FileSyncInput): void {
  const dataDb = getCanonicalDb()
  if (dataDb) {
    updateNoteMetadata(dataDb, input.id, {
      path: input.path,
      title: input.title,
      fileSize: input.fileSize,
      modifiedAt: input.modifiedAt.toISOString()
    })
  }
  publishProjectionEvent({
    type: 'note.upserted',
    note: {
      kind: 'file',
      noteId: input.id,
      path: input.path,
      title: input.title,
      fileType: input.fileType,
      mimeType: input.mimeType,
      fileSize: input.fileSize,
      createdAt: input.createdAt.toISOString(),
      modifiedAt: input.modifiedAt.toISOString()
    }
  })
}

export function syncFileToCache(db: IndexDb, input: FileSyncInput): FileSyncResult {
  const { result, note } = persistFile(db, input)
  publishProjectionEvent({ type: 'note.upserted', note })
  return result
}

function persistFile(
  db: IndexDb,
  input: FileSyncInput
): { result: FileSyncResult; note: FileNoteProjection } {
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

  return { result: { id: noteId, path, title, fileType, mimeType, fileSize }, note }
}
