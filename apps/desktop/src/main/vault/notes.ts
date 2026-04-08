/**
 * Note CRUD operations.
 * Combines frontmatter parsing, atomic file operations, and cache queries.
 *
 * @module vault/notes
 */

import path from 'path'
import fs from 'fs/promises'
import { shell } from 'electron'
import { BrowserWindow } from 'electron'
import { getStatus, getConfig } from './index'
import {
  parseNote,
  serializeNote,
  createFrontmatter,
  calculateWordCount,
  generateContentHash,
  createSnippet,
  extractInlineTagsFromMarkdown,
  type NoteFrontmatter
} from './frontmatter'
import { syncNoteToCache, deleteNoteFromCache } from './note-sync'
import {
  atomicWrite,
  safeRead,
  deleteFile,
  ensureDirectory,
  listDirectories,
  sanitizeFilename,
  generateNotePath,
  generateUniquePath
} from './file-ops'
import {
  insertNoteCache,
  updateNoteCache,
  deleteNoteCache,
  getNoteCacheById,
  getNoteCacheByPath,
  listNotesFromCache,
  countNotes,
  getNoteTags,
  getTagsForNotes,
  getAllTags,
  getAllTagDefinitions,
  getOrCreateTag,
  ensureTagDefinitions,
  deleteTagDefinition,
  getNotePropertiesAsRecord,
  getPropertiesForNotes,
  getOutgoingLinks,
  getIncomingLinks,
  findDuplicateId,
  resolveNoteByTitle,
  insertNoteSnapshot,
  getLatestSnapshot,
  snapshotExistsWithHash,
  getNoteSnapshots,
  getNoteSnapshotById,
  pruneOldSnapshots
} from '@main/database/queries/notes'
import { getAllTaskTags } from '@main/database/queries/tasks'
import { SnapshotReasons, type SnapshotReason } from '@memry/db-schema/schema/notes-cache'
import { getDatabase, getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode, VaultError, VaultErrorCode } from '../lib/errors'
import { generateNoteId } from '../lib/id'
import { NotesChannels } from '@memry/contracts/notes-api'
import type { FolderInfo } from '@memry/contracts/templates-api'
import { readFolderConfig } from './folders'
import { queueEmbeddingUpdate } from '../inbox/embedding-queue'
import { createLogger } from '../lib/logger'
import { getFileType, getExtension, isBinaryFileType } from '@memry/shared/file-types'
import { deleteCanonicalNote, saveCanonicalNote } from '@memry/domain-notes'
import { updateNoteMetadata } from '@memry/storage-data'

const logger = createLogger('Notes')

// ============================================================================
// Types
// ============================================================================

export interface Note {
  id: string
  path: string
  title: string
  content: string
  frontmatter: NoteFrontmatter
  created: Date
  modified: Date
  tags: string[]
  aliases: string[]
  wordCount: number
  properties: Record<string, unknown> // T013: Properties support
  emoji?: string | null // T028: Emoji icon for visual identification
}

export interface NoteListItem {
  id: string
  path: string
  title: string
  created: Date
  modified: Date
  tags: string[]
  wordCount: number
  snippet?: string
  emoji?: string | null // T028: Emoji icon for visual identification
  localOnly?: boolean
  properties?: Record<string, unknown> // T040: Optional properties for folder view
  fileType?: 'markdown' | 'pdf' | 'image' | 'audio' | 'video' // File type discriminator
  mimeType?: string | null // MIME type (e.g., 'application/pdf')
  fileSize?: number | null // File size in bytes
}

/**
 * File metadata for non-markdown files (PDF, image, audio, video)
 */
export interface FileMetadata {
  id: string
  path: string // Relative path within vault
  absolutePath: string // Full filesystem path for viewers
  title: string
  fileType: 'pdf' | 'image' | 'audio' | 'video'
  mimeType: string | null
  fileSize: number | null
  created: Date
  modified: Date
}

export interface NoteCreateInput {
  title: string
  content?: string
  folder?: string
  tags?: string[]
  template?: string
  properties?: Record<string, unknown> // T014: Properties support
}

export interface NoteUpdateInput {
  id: string
  title?: string
  content?: string
  tags?: string[]
  frontmatter?: Record<string, unknown>
  properties?: Record<string, unknown> // T013: Properties support
  emoji?: string | null // T028: Emoji icon for visual identification
}

export interface NoteListOptions {
  folder?: string
  tags?: string[]
  sortBy?: 'modified' | 'created' | 'title' | 'position'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
  includeProperties?: boolean
}

export interface NoteListResponse {
  notes: NoteListItem[]
  total: number
  hasMore: boolean
}

export interface NoteLink {
  sourceId: string
  targetId: string | null
  targetTitle: string
}

export interface BacklinkContext {
  snippet: string
  linkStart: number
  linkEnd: number
}

export interface Backlink {
  sourceId: string
  sourcePath: string
  sourceTitle: string
  contexts: BacklinkContext[]
}

export interface NoteLinksResponse {
  outgoing: NoteLink[]
  incoming: Backlink[]
}

// ============================================================================
// Snapshot Configuration
// ============================================================================

/**
 * Maximum number of snapshots to keep per note.
 * Older snapshots are pruned when this limit is exceeded.
 */
const MAX_SNAPSHOTS_PER_NOTE = 50

/**
 * Minimum time between auto-snapshots (in milliseconds).
 * Prevents excessive snapshot creation during rapid edits.
 */
const MIN_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

/**
 * Minimum word count change to trigger a "significant" snapshot.
 * Helps capture meaningful changes vs minor edits.
 */
const SIGNIFICANT_WORD_CHANGE = 10

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the vault path, throwing if no vault is open.
 */
function getVaultPath(): string {
  const status = getStatus()
  if (!status.path) {
    throw new VaultError('No vault is currently open', VaultErrorCode.NOT_INITIALIZED)
  }
  return status.path
}

/**
 * Get the notes directory path.
 */
export function getNotesDir(): string {
  const vaultPath = getVaultPath()
  const config = getConfig()
  return path.join(vaultPath, config.defaultNoteFolder)
}

/**
 * Convert relative path to absolute path.
 */
export function toAbsolutePath(relativePath: string): string {
  const vaultPath = getVaultPath()
  return path.join(vaultPath, relativePath)
}

/**
 * Convert absolute path to relative path (from vault root).
 */
export function toRelativePath(absolutePath: string): string {
  const vaultPath = getVaultPath()
  return path.relative(vaultPath, absolutePath)
}

/**
 * Emit note event to all windows.
 */
function emitNoteEvent(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(channel, payload)
  })
}

// ============================================================================
// Create
// ============================================================================

/**
 * Create a new note.
 */
export async function createNote(input: NoteCreateInput): Promise<Note> {
  const notesDir = getNotesDir()
  const db = getIndexDatabase()
  const dataDb = getDatabase()

  // T096.6: Apply template if specified or folder has default
  let templateContent = ''
  let templateTags: string[] = []
  let templateProperties: Record<string, unknown> = {}

  // Check for template - explicit or folder default
  let templateId = input.template
  if (!templateId && input.folder) {
    // Check if folder has a default template
    const { getFolderTemplate } = await import('./folders')
    templateId = (await getFolderTemplate(input.folder)) ?? undefined
  }

  if (templateId) {
    const { getTemplate, applyTemplate } = await import('./templates')
    const template = await getTemplate(templateId)
    if (template) {
      const applied = applyTemplate(template, input.title)
      templateContent = applied.content
      templateTags = applied.tags
      templateProperties = applied.properties
    }
  }

  // Generate file path
  let filePath = generateNotePath(notesDir, input.title, input.folder)
  filePath = await generateUniquePath(filePath)

  // Merge template tags with input tags (input tags take precedence for duplicates)
  const mergedTags = [...new Set([...templateTags, ...(input.tags ?? [])])]

  // Create frontmatter with merged tags
  const frontmatter = createFrontmatter(input.title, mergedTags)

  // T014: Merge properties - input properties override template properties
  const properties = { ...templateProperties, ...(input.properties ?? {}) }
  if (Object.keys(properties).length > 0) {
    ;(frontmatter as NoteFrontmatter & { properties: Record<string, unknown> }).properties =
      properties
  }

  // Serialize content - use input content if provided (and non-empty), otherwise use template content
  const content = input.content && input.content.trim() ? input.content : templateContent
  const fileContent = serializeNote(frontmatter, content)

  // Write file atomically
  await atomicWrite(filePath, fileContent)

  // Get relative path for cache
  const relativePath = toRelativePath(filePath)

  // Sync to cache using NoteSyncService (handles tags, properties, FTS, links)
  const syncResult = syncNoteToCache(
    db,
    {
      id: frontmatter.id,
      path: relativePath,
      fileContent,
      frontmatter,
      parsedContent: content
    },
    { isNew: true }
  )

  ensureTagDefinitions(dataDb, mergedTags)

  // Build response
  const note: Note = {
    id: frontmatter.id,
    path: relativePath,
    title: input.title,
    content,
    frontmatter,
    created: new Date(frontmatter.created),
    modified: new Date(frontmatter.modified),
    tags: mergedTags,
    aliases: frontmatter.aliases ?? [],
    wordCount: syncResult.wordCount,
    properties, // T014/T096.6: Include merged properties in response
    emoji: null // T028: New notes start without emoji
  }

  // Emit event
  emitNoteEvent(NotesChannels.events.CREATED, {
    note: noteToListItem(note),
    source: 'internal'
  })

  // Queue embedding update (batched for performance)
  queueEmbeddingUpdate(note.id)

  return note
}

// ============================================================================
// Read
// ============================================================================

/**
 * Get a note by ID.
 */
export async function getNoteById(id: string): Promise<Note | null> {
  const db = getIndexDatabase()

  // Get from cache
  const cached = getNoteCacheById(db, id)
  if (!cached) {
    return null
  }

  // Read file
  const absolutePath = toAbsolutePath(cached.path)
  const fileContent = await safeRead(absolutePath)

  if (!fileContent) {
    logger.warn('getNoteById: file missing on disk, returning null (watcher handles cleanup)', {
      id,
      path: cached.path
    })
    return null
  }

  // Parse content
  const parsed = parseNote(fileContent, cached.path)

  // Check for duplicate ID (T046)
  const duplicate = findDuplicateId(db, parsed.frontmatter.id, cached.path)
  if (duplicate) {
    const dataDb = getDatabase()
    // Generate new ID and update file
    const newId = generateNoteId()
    parsed.frontmatter.id = newId
    parsed.frontmatter.title = path.basename(cached.path, path.extname(cached.path))
    const newContent = serializeNote(parsed.frontmatter, parsed.content)
    await atomicWrite(absolutePath, newContent)

    // Update cache with new ID
    deleteNoteCache(db, id)
    deleteCanonicalNote(dataDb, id)
    insertNoteCache(db, {
      id: newId,
      path: cached.path,
      title: parsed.frontmatter.title ?? path.basename(cached.path, '.md'),
      contentHash: generateContentHash(newContent),
      wordCount: calculateWordCount(parsed.content),
      snippet: createSnippet(parsed.content),
      createdAt: parsed.frontmatter.created,
      modifiedAt: parsed.frontmatter.modified
    })
    saveCanonicalNote(dataDb, {
      id: newId,
      path: cached.path,
      title: parsed.frontmatter.title ?? path.basename(cached.path, '.md'),
      emoji: (parsed.frontmatter as { emoji?: string | null }).emoji ?? null,
      createdAt: parsed.frontmatter.created,
      modifiedAt: parsed.frontmatter.modified,
      properties: (parsed.frontmatter.properties as Record<string, unknown> | undefined) ?? {}
    })

    // Update ID for response
    id = newId
  }

  // Get tags from cache
  const tags = getNoteTags(db, id)

  // T013: Get properties from cache
  const properties = getNotePropertiesAsRecord(db, id)

  return {
    id,
    path: cached.path,
    title: parsed.frontmatter.title ?? cached.title,
    content: parsed.content,
    frontmatter: parsed.frontmatter,
    created: new Date(parsed.frontmatter.created),
    modified: new Date(parsed.frontmatter.modified),
    tags,
    aliases: parsed.frontmatter.aliases ?? [],
    wordCount: cached.wordCount ?? 0,
    properties, // T013: Include properties
    emoji: cached.emoji ?? (parsed.frontmatter as { emoji?: string }).emoji ?? null // T028: Include emoji from cache or frontmatter
  }
}

/**
 * Get file metadata by ID (for non-markdown files).
 * Returns metadata without reading file content.
 */
export async function getFileById(id: string): Promise<FileMetadata | null> {
  const db = getIndexDatabase()

  // Get from cache
  const cached = getNoteCacheById(db, id)
  if (!cached) {
    return null
  }

  // Only return for non-markdown files
  const fileType = cached.fileType ?? 'markdown'
  if (fileType === 'markdown') {
    return null
  }

  // Check file exists
  const absolutePath = toAbsolutePath(cached.path)
  try {
    await fs.access(absolutePath)
  } catch {
    // File was deleted externally, remove from cache
    deleteNoteFromCache(db, id)
    return null
  }

  return {
    id: cached.id,
    path: cached.path,
    absolutePath,
    title: cached.title,
    fileType: fileType,
    mimeType: cached.mimeType ?? null,
    fileSize: cached.fileSize ?? null,
    created: new Date(cached.createdAt),
    modified: new Date(cached.modifiedAt)
  }
}

/**
 * Get a note by path.
 */
export async function getNoteByPath(notePath: string): Promise<Note | null> {
  const db = getIndexDatabase()

  // Get from cache by path
  const cached = getNoteCacheByPath(db, notePath)
  if (cached) {
    return getNoteById(cached.id)
  }

  // Try reading directly (might not be in cache yet)
  const absolutePath = toAbsolutePath(notePath)
  const fileContent = await safeRead(absolutePath)

  if (!fileContent) {
    return null
  }

  // Parse and sync to cache using NoteSyncService
  const parsed = parseNote(fileContent, notePath)

  const syncResult = syncNoteToCache(
    db,
    {
      id: parsed.frontmatter.id,
      path: notePath,
      fileContent,
      frontmatter: parsed.frontmatter,
      parsedContent: parsed.content
    },
    { isNew: true }
  )

  return {
    id: parsed.frontmatter.id,
    path: notePath,
    title: parsed.frontmatter.title ?? path.basename(notePath, '.md'),
    content: parsed.content,
    frontmatter: parsed.frontmatter,
    created: new Date(parsed.frontmatter.created),
    modified: new Date(parsed.frontmatter.modified),
    tags: syncResult.tags,
    aliases: parsed.frontmatter.aliases ?? [],
    wordCount: syncResult.wordCount,
    properties: syncResult.properties,
    emoji: syncResult.emoji
  }
}

// ============================================================================
// Update
// ============================================================================

/**
 * Update an existing note.
 */
export async function updateNote(input: NoteUpdateInput): Promise<Note> {
  const db = getIndexDatabase()
  const dataDb = getDatabase()

  // Get existing note
  const existing = await getNoteById(input.id)
  if (!existing) {
    throw new NoteError(`Note not found: ${input.id}`, NoteErrorCode.NOT_FOUND, input.id)
  }

  // Merge updates
  const newTitle = input.title ?? existing.title
  const newContent = input.content ?? existing.content
  let newTags = input.tags ?? existing.tags

  if (input.content !== undefined && input.tags === undefined) {
    const oldInline = new Set(extractInlineTagsFromMarkdown(existing.content))
    const newInline = new Set(extractInlineTagsFromMarkdown(input.content))

    const removedInline = [...oldInline].filter((t) => !newInline.has(t))
    const addedInline = [...newInline].filter((t) => !oldInline.has(t))

    if (removedInline.length > 0 || addedInline.length > 0) {
      newTags = newTags.filter((t) => !removedInline.includes(t))
      for (const tag of addedInline) {
        if (!newTags.includes(tag)) newTags.push(tag)
      }
    }
  }
  const newProperties = input.properties ?? existing.properties // T013: Properties support
  // T028: Handle emoji - use input.emoji if provided, otherwise keep existing
  const newEmoji = input.emoji !== undefined ? input.emoji : existing.emoji

  if (input.content !== undefined && input.content !== existing.content) {
    logger.info('updateNote: content changed, attempting snapshot', { noteId: input.id })
    try {
      const absolutePath = toAbsolutePath(existing.path)
      const currentFileContent = await fs.readFile(absolutePath, 'utf-8')
      const snap = maybeCreateSignificantSnapshot(
        input.id,
        currentFileContent,
        existing.content,
        newContent,
        existing.title
      )
      if (snap) {
        logger.info('updateNote: snapshot created', { noteId: input.id, snapshotId: snap.id })
      } else {
        logger.info('updateNote: snapshot skipped (below threshold)', { noteId: input.id })
      }
    } catch (err) {
      logger.error('Failed to read current file for snapshot:', err)
    }
  } else if (input.content !== undefined) {
    logger.info('updateNote: content unchanged, skipping snapshot', { noteId: input.id })
  }

  // Update frontmatter
  const newFrontmatter: NoteFrontmatter & {
    properties?: Record<string, unknown>
    emoji?: string | null
  } = {
    ...existing.frontmatter,
    ...input.frontmatter,
    title: newTitle,
    tags: newTags,
    modified: new Date().toISOString()
  }

  if (Object.keys(newProperties).length > 0) {
    newFrontmatter.properties = newProperties
  } else {
    delete newFrontmatter.properties
  }

  // T028: Add emoji to frontmatter if present
  if (newEmoji !== undefined) {
    newFrontmatter.emoji = newEmoji
  }

  // Serialize and write
  const fileContent = serializeNote(newFrontmatter, newContent)
  const absolutePath = toAbsolutePath(existing.path)
  await atomicWrite(absolutePath, fileContent)

  // Sync to cache using NoteSyncService (handles tags, properties, FTS, links)
  const syncResult = syncNoteToCache(
    db,
    {
      id: input.id,
      path: existing.path,
      fileContent,
      frontmatter: newFrontmatter,
      parsedContent: newContent
    },
    { isNew: false, tagsOverride: newTags }
  )

  // Check if tags changed (for event emission)
  const tagsChanged =
    newTags.length !== existing.tags.length || newTags.some((t) => !existing.tags.includes(t))

  if (tagsChanged) {
    // Ensure all tags have definitions (creates new tags with auto-assigned colors)
    ensureTagDefinitions(dataDb, newTags)
  }

  // Build response
  const note: Note = {
    id: input.id,
    path: existing.path,
    title: newTitle,
    content: newContent,
    frontmatter: newFrontmatter,
    created: existing.created,
    modified: new Date(newFrontmatter.modified),
    tags: newTags,
    aliases: newFrontmatter.aliases ?? [],
    wordCount: syncResult.wordCount,
    properties: newProperties, // T013: Include properties
    emoji: newEmoji // T028: Include emoji
  }

  // Emit note updated event
  emitNoteEvent(NotesChannels.events.UPDATED, {
    id: input.id,
    changes: {
      title: newTitle,
      content: newContent,
      tags: newTags,
      properties: newProperties,
      emoji: newEmoji
    },
    source: 'internal'
  })

  // Emit tags-changed event if tags were modified (for cross-note autocomplete refresh)
  if (tagsChanged) {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('notes:tags-changed')
    })
  }

  // Queue embedding update if content changed (batched for performance)
  if (input.content !== undefined) {
    queueEmbeddingUpdate(input.id)
  }

  return note
}

/**
 * Rename a note (changes filename).
 */
export async function renameNote(id: string, newTitle: string): Promise<Note> {
  const db = getIndexDatabase()

  // Get existing note
  const existing = await getNoteById(id)
  if (!existing) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  // Check if binary from cache
  const cached = getNoteCacheById(db, id)
  const isBinary = cached?.fileType ? isBinaryFileType(cached.fileType) : false

  // Generate new path — preserve original extension
  const oldPath = toAbsolutePath(existing.path)
  const dir = path.dirname(oldPath)
  const ext = path.extname(oldPath) || '.md'
  let newPath = path.join(dir, sanitizeFilename(newTitle) + ext)
  newPath = await generateUniquePath(newPath)
  const newRelativePath = toRelativePath(newPath)

  const now = new Date().toISOString()
  const newFrontmatter: NoteFrontmatter = {
    ...existing.frontmatter,
    title: newTitle,
    modified: now
  }

  if (isBinary) {
    // Binary files: filesystem rename only, no frontmatter manipulation
    await fs.rename(oldPath, newPath)
    updateNoteCache(db, id, {
      path: newRelativePath,
      title: newTitle,
      modifiedAt: now
    })
    updateNoteMetadata(getDatabase(), id, {
      path: newRelativePath,
      title: newTitle,
      modifiedAt: now
    })
  } else {
    // Markdown: update frontmatter and rewrite
    const fileContent = serializeNote(newFrontmatter, existing.content)
    await atomicWrite(newPath, fileContent)
    await deleteFile(oldPath)
    updateNoteCache(db, id, {
      path: newRelativePath,
      title: newTitle,
      contentHash: generateContentHash(fileContent),
      modifiedAt: now
    })
    updateNoteMetadata(getDatabase(), id, {
      path: newRelativePath,
      title: newTitle,
      modifiedAt: now
    })
  }

  // Build response
  const note: Note = {
    ...existing,
    path: newRelativePath,
    title: newTitle,
    frontmatter: newFrontmatter,
    modified: new Date(now)
  }

  // Emit event
  emitNoteEvent(NotesChannels.events.RENAMED, {
    id,
    oldPath: existing.path,
    newPath: newRelativePath,
    oldTitle: existing.title,
    newTitle
  })

  return note
}

/**
 * Move a note to a different folder.
 */
export async function moveNote(id: string, newFolder: string): Promise<Note> {
  const db = getIndexDatabase()
  const notesDir = getNotesDir()

  // Get existing note
  const existing = await getNoteById(id)
  if (!existing) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  // Check if binary from cache
  const cached = getNoteCacheById(db, id)
  const isBinary = cached?.fileType ? isBinaryFileType(cached.fileType) : false

  // Generate new path
  const oldPath = toAbsolutePath(existing.path)
  const filename = path.basename(oldPath)
  const newDir = path.join(notesDir, newFolder)
  await ensureDirectory(newDir)
  let newPath = path.join(newDir, filename)
  newPath = await generateUniquePath(newPath)
  const newRelativePath = toRelativePath(newPath)

  const now = new Date().toISOString()
  const newFrontmatter: NoteFrontmatter = {
    ...existing.frontmatter,
    modified: now
  }

  if (isBinary) {
    // Binary files: filesystem move only, no serialization
    await fs.rename(oldPath, newPath)
    updateNoteCache(db, id, {
      path: newRelativePath,
      modifiedAt: now
    })
    updateNoteMetadata(getDatabase(), id, {
      path: newRelativePath,
      modifiedAt: now
    })
  } else {
    // Markdown: update frontmatter and rewrite
    const fileContent = serializeNote(newFrontmatter, existing.content)
    await atomicWrite(newPath, fileContent)
    await deleteFile(oldPath)
    updateNoteCache(db, id, {
      path: newRelativePath,
      contentHash: generateContentHash(fileContent),
      modifiedAt: now
    })
    updateNoteMetadata(getDatabase(), id, {
      path: newRelativePath,
      modifiedAt: now
    })
  }

  // Build response
  const note: Note = {
    ...existing,
    path: newRelativePath,
    frontmatter: newFrontmatter,
    modified: new Date(now)
  }

  // Emit event
  emitNoteEvent(NotesChannels.events.MOVED, {
    id,
    oldPath: existing.path,
    newPath: newRelativePath
  })

  return note
}

// ============================================================================
// Delete
// ============================================================================

/**
 * Delete a note.
 */
export async function deleteNote(id: string): Promise<void> {
  const db = getIndexDatabase()

  // Get existing note
  const cached = getNoteCacheById(db, id)
  if (!cached) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  // Delete file
  const absolutePath = toAbsolutePath(cached.path)
  await deleteFile(absolutePath)

  // Remove from cache using NoteSyncService (handles links cleanup + cache deletion)
  deleteNoteFromCache(db, id)

  // Emit event
  emitNoteEvent(NotesChannels.events.DELETED, {
    id,
    path: cached.path,
    source: 'internal'
  })
}

// ============================================================================
// List
// ============================================================================

/**
 * List notes with filtering and pagination.
 * Optimized to use batch tag/property queries and cached snippets (no file reads).
 */
export function listNotes(options: NoteListOptions = {}): NoteListResponse {
  const db = getIndexDatabase()
  const limit = options.limit ?? 100
  const offset = options.offset ?? 0

  // Get notes from cache
  const cached = listNotesFromCache(db, {
    ...options,
    limit: limit + 1, // Fetch one extra to check hasMore
    offset
  })

  // Check if there are more
  const hasMore = cached.length > limit
  const notes = cached.slice(0, limit)

  // Get total count
  const total = countNotes(db, options.folder)

  // Batch load tags for all notes in a single query (O(1) instead of O(n))
  const noteIds = notes.map((n) => n.id)
  const tagsMap = getTagsForNotes(db, noteIds)

  // T040-T041: Optionally batch load properties (for folder view)
  const propertiesMap = options.includeProperties ? getPropertiesForNotes(db, noteIds) : null

  // Convert to list items using cached snippets (no file reads needed)
  const noteItems: NoteListItem[] = notes.map((c) => ({
    id: c.id,
    path: c.path,
    title: c.title,
    created: new Date(c.createdAt),
    modified: new Date(c.modifiedAt),
    tags: tagsMap.get(c.id) ?? [],
    wordCount: c.wordCount ?? 0,
    snippet: c.snippet ?? undefined, // Use cached snippet from database
    emoji: c.emoji, // T028: Include emoji
    localOnly: c.localOnly ?? false,
    fileType: c.fileType ?? 'markdown', // File type (default to markdown for backward compat)
    mimeType: c.mimeType, // MIME type
    fileSize: c.fileSize, // File size in bytes
    ...(propertiesMap && { properties: propertiesMap.get(c.id) ?? {} }) // T040: Include properties if requested
  }))

  return { notes: noteItems, total, hasMore }
}

/**
 * Convert Note to NoteListItem.
 */
function noteToListItem(note: Note): NoteListItem {
  return {
    id: note.id,
    path: note.path,
    title: note.title,
    created: note.created,
    modified: note.modified,
    tags: note.tags,
    wordCount: note.wordCount,
    snippet: createSnippet(note.content),
    emoji: note.emoji // T028: Include emoji
  }
}

// ============================================================================
// Tags & Links
// ============================================================================

/**
 * Get all tags with counts and colors.
 * Returns tags sorted by usage count descending.
 */
export function getTagsWithCounts(): { tag: string; color: string; count: number }[] {
  const indexDb = getIndexDatabase()
  const dataDb = getDatabase()

  const definitions = getAllTagDefinitions(dataDb)
  const noteUsage = getAllTags(indexDb)
  const taskUsage = getAllTaskTags(dataDb)

  const noteCountMap = new Map(noteUsage.map((u) => [u.tag, u.count]))
  const taskCountMap = new Map(taskUsage.map((u) => [u.tag, u.count]))
  const defMap = new Map(definitions.map((d) => [d.name, d.color]))

  const results: { tag: string; color: string; count: number }[] = []

  for (const def of definitions) {
    const totalCount = (noteCountMap.get(def.name) ?? 0) + (taskCountMap.get(def.name) ?? 0)
    if (totalCount > 0) {
      results.push({ tag: def.name, color: def.color, count: totalCount })
    } else {
      deleteTagDefinition(dataDb, def.name)
    }
  }

  for (const usage of noteUsage) {
    if (!defMap.has(usage.tag)) {
      const { color } = getOrCreateTag(dataDb, usage.tag)
      defMap.set(usage.tag, color)
      const totalCount = usage.count + (taskCountMap.get(usage.tag) ?? 0)
      results.push({ tag: usage.tag, color, count: totalCount })
    }
  }

  for (const usage of taskUsage) {
    if (!defMap.has(usage.tag) && !noteCountMap.has(usage.tag)) {
      const { color } = getOrCreateTag(dataDb, usage.tag)
      results.push({ tag: usage.tag, color, count: usage.count })
    }
  }

  return results.sort((a, b) => b.count - a.count)
}

interface LinkContext {
  snippet: string
  linkStart: number
  linkEnd: number
}

/**
 * Extract context snippets around ALL [[targetTitle]] mentions in content.
 * Returns one LinkContext per occurrence with ~150 char radius.
 */
function extractAllLinkContexts(content: string, targetTitle: string): LinkContext[] {
  const escaped = targetTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\\[\\[${escaped}(?:\\|[^\\]]+)?\\]\\]`, 'gi')
  const matches = [...content.matchAll(pattern)]
  if (matches.length === 0) return []

  const radius = 75

  return matches.map((match) => {
    const matchIndex = match.index!
    const matchText = match[0]
    const start = Math.max(0, matchIndex - radius)
    const end = Math.min(content.length, matchIndex + matchText.length + radius)

    let snippet = content.slice(start, end)
    const prefixOffset = start > 0 ? 3 : 0
    if (start > 0) snippet = '...' + snippet
    if (end < content.length) snippet = snippet + '...'

    snippet = snippet.replace(/\n+/g, ' ').trim()

    const linkStart = matchIndex - start + prefixOffset
    const linkEnd = linkStart + matchText.length

    return { snippet, linkStart, linkEnd }
  })
}

/**
 * Get links for a note (outgoing and incoming).
 */
export async function getNoteLinks(id: string): Promise<NoteLinksResponse> {
  const db = getIndexDatabase()

  const outgoing = getOutgoingLinks(db, id)
  const outgoingLinks: NoteLink[] = outgoing.map((link) => ({
    sourceId: link.sourceId,
    targetId: link.targetId,
    targetTitle: link.targetTitle
  }))

  const incoming = getIncomingLinks(db, id)
  const targetCache = getNoteCacheById(db, id)
  const targetTitle = targetCache?.title ?? ''

  const backlinks: Backlink[] = await Promise.all(
    incoming.map(async (link) => {
      const sourceCache = getNoteCacheById(db, link.sourceId)
      let contexts: Backlink['contexts'] = []

      if (sourceCache?.path && targetTitle) {
        const absolutePath = toAbsolutePath(sourceCache.path)
        const content = await safeRead(absolutePath)
        if (content) {
          contexts = extractAllLinkContexts(content, targetTitle)
        }
      }

      return {
        sourceId: link.sourceId,
        sourcePath: sourceCache?.path ?? '',
        sourceTitle: sourceCache?.title ?? '',
        contexts
      }
    })
  )

  return { outgoing: outgoingLinks, incoming: backlinks }
}

// ============================================================================
// Folders
// ============================================================================

/**
 * Get all folders in the notes directory with their icons.
 */
export async function getFolders(): Promise<FolderInfo[]> {
  const notesDir = getNotesDir()
  const paths = await listDirectories(notesDir, notesDir)

  return Promise.all(
    paths.map(async (folderPath) => {
      const config = await readFolderConfig(folderPath)
      return { path: folderPath, icon: config?.icon ?? null }
    })
  )
}

/**
 * Create a new folder.
 */
export async function createFolder(folderPath: string): Promise<void> {
  const notesDir = getNotesDir()
  const absolutePath = path.join(notesDir, folderPath)
  await ensureDirectory(absolutePath)
}

/**
 * Rename a folder.
 */
export async function renameFolder(oldPath: string, newPath: string): Promise<void> {
  const notesDir = getNotesDir()
  const oldAbsPath = path.join(notesDir, oldPath)
  const newAbsPath = path.join(notesDir, newPath)

  // Use fs.promises.rename for atomic rename
  const { rename } = await import('fs/promises')
  await rename(oldAbsPath, newAbsPath)
}

/**
 * Delete a folder and all its contents recursively.
 */
export async function deleteFolder(folderPath: string): Promise<void> {
  const notesDir = getNotesDir()
  const absPath = path.join(notesDir, folderPath)

  // Recursively delete folder and all contents
  const { rm } = await import('fs/promises')
  await rm(absPath, { recursive: true, force: true })
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Check if a note exists by title or path.
 */
export function noteExists(titleOrPath: string): boolean {
  const db = getIndexDatabase()

  // Check by path first
  if (titleOrPath.endsWith('.md')) {
    const cached = getNoteCacheByPath(db, titleOrPath)
    return cached !== undefined
  }

  // Check by title
  const resolved = resolveNoteByTitle(db, titleOrPath)
  return resolved !== undefined
}

/**
 * Open a note in the default external editor.
 */
export async function openExternal(id: string): Promise<void> {
  const db = getIndexDatabase()
  const cached = getNoteCacheById(db, id)

  if (!cached) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  const absolutePath = toAbsolutePath(cached.path)
  await shell.openPath(absolutePath)
}

/**
 * Reveal a note in the file explorer.
 */
export function revealInFinder(id: string): void {
  const db = getIndexDatabase()
  const cached = getNoteCacheById(db, id)

  if (!cached) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  const absolutePath = toAbsolutePath(cached.path)
  shell.showItemInFolder(absolutePath)
}

// ============================================================================
// Version History (T110-T114)
// ============================================================================

export interface SnapshotListItem {
  id: string
  noteId: string
  title: string
  wordCount: number
  reason: SnapshotReason
  createdAt: string
}

export interface SnapshotDetail extends SnapshotListItem {
  fileContent: string // Full file content (frontmatter + markdown body)
}

/**
 * Create a snapshot of the current note file.
 * Saves the complete file content including frontmatter (tags, properties, etc.).
 *
 * @param noteId - The note ID
 * @param fileContent - Full file content (frontmatter + markdown)
 * @param title - Current title (for display in list)
 * @param reason - Why the snapshot was created
 * @param forceCreate - Skip deduplication check
 */
export function createSnapshot(
  noteId: string,
  fileContent: string,
  title: string,
  reason: SnapshotReason,
  forceCreate = false
): SnapshotListItem | null {
  const db = getIndexDatabase()

  // Calculate content hash for deduplication
  const contentHash = generateContentHash(fileContent)

  // Skip if identical snapshot already exists (unless forced)
  if (!forceCreate && snapshotExistsWithHash(db, noteId, contentHash)) {
    return null
  }

  // Check minimum interval for auto/timer snapshots
  if (reason === SnapshotReasons.AUTO || reason === SnapshotReasons.TIMER) {
    const latest = getLatestSnapshot(db, noteId)
    if (latest) {
      const latestTime = new Date(latest.createdAt).getTime()
      const now = Date.now()
      if (now - latestTime < MIN_SNAPSHOT_INTERVAL_MS) {
        return null // Too soon since last snapshot
      }
    }
  }

  // Parse to get word count from markdown body
  const parsed = parseNote(fileContent)
  const wordCount = calculateWordCount(parsed.content)

  // Create the snapshot
  const snapshot = insertNoteSnapshot(db, {
    id: generateNoteId(), // Reuse nanoid generator
    noteId,
    fileContent,
    title,
    wordCount,
    contentHash,
    reason
  })

  // Prune old snapshots if we have too many
  pruneOldSnapshots(db, noteId, MAX_SNAPSHOTS_PER_NOTE)

  return {
    id: snapshot.id,
    noteId: snapshot.noteId,
    title: snapshot.title,
    wordCount: snapshot.wordCount,
    reason: snapshot.reason as SnapshotReason,
    createdAt: snapshot.createdAt
  }
}

/**
 * Create a snapshot before a significant edit.
 * Called automatically by updateNote when content changes significantly.
 * Takes the current file content (before the new save) to preserve the full state.
 */
export function maybeCreateSignificantSnapshot(
  noteId: string,
  currentFileContent: string,
  oldContent: string,
  newContent: string,
  title: string
): SnapshotListItem | null {
  const oldWordCount = calculateWordCount(oldContent)
  const newWordCount = calculateWordCount(newContent)
  const wordDiff = Math.abs(newWordCount - oldWordCount)

  // Only create snapshot for significant changes
  if (wordDiff >= SIGNIFICANT_WORD_CHANGE) {
    try {
      return createSnapshot(noteId, currentFileContent, title, SnapshotReasons.SIGNIFICANT)
    } catch {
      return null
    }
  }

  return null
}

/**
 * Get version history for a note.
 */
export function getVersionHistory(noteId: string, limit = 50): SnapshotListItem[] {
  const db = getIndexDatabase()
  const snapshots = getNoteSnapshots(db, noteId, limit)

  return snapshots.map((s) => ({
    id: s.id,
    noteId: s.noteId,
    title: s.title,
    wordCount: s.wordCount,
    reason: s.reason as SnapshotReason,
    createdAt: s.createdAt
  }))
}

/**
 * Get a specific version/snapshot with full file content.
 */
export function getVersion(snapshotId: string): SnapshotDetail | null {
  const db = getIndexDatabase()
  const snapshot = getNoteSnapshotById(db, snapshotId)

  if (!snapshot) {
    return null
  }

  return {
    id: snapshot.id,
    noteId: snapshot.noteId,
    title: snapshot.title,
    fileContent: snapshot.fileContent,
    wordCount: snapshot.wordCount,
    reason: snapshot.reason as SnapshotReason,
    createdAt: snapshot.createdAt
  }
}

/**
 * Restore a note from a previous version.
 * Creates a snapshot of current state before restoring.
 * Restores the full file content including frontmatter (tags, properties, etc.).
 */
export async function restoreVersion(snapshotId: string): Promise<Note> {
  const db = getIndexDatabase()
  const dataDb = getDatabase()
  const snapshot = getNoteSnapshotById(db, snapshotId)

  if (!snapshot) {
    throw new NoteError(`Snapshot not found: ${snapshotId}`, NoteErrorCode.NOT_FOUND, snapshotId)
  }

  // Get current note from cache to get the file path
  const cached = getNoteCacheById(db, snapshot.noteId)
  if (!cached) {
    throw new NoteError(
      `Note not found: ${snapshot.noteId}`,
      NoteErrorCode.NOT_FOUND,
      snapshot.noteId
    )
  }

  // Read current file content for creating a backup snapshot
  const absolutePath = toAbsolutePath(cached.path)
  const currentFileContent = await fs.readFile(absolutePath, 'utf-8')
  const currentParsed = parseNote(currentFileContent)

  // Create a snapshot of current state before restoring (so user can undo the restore)
  createSnapshot(
    cached.id,
    currentFileContent,
    currentParsed.frontmatter.title ?? cached.title,
    SnapshotReasons.SIGNIFICANT, // Use SIGNIFICANT since it's auto-created before restore
    true // Force create even if duplicate
  )

  // Parse the snapshot content to extract frontmatter and body
  const snapshotParsed = parseNote(snapshot.fileContent)

  // Write the snapshot file content directly to disk
  await atomicWrite(absolutePath, snapshot.fileContent)

  // Sync to cache using NoteSyncService (handles tags, properties, FTS, links)
  const syncResult = syncNoteToCache(
    db,
    {
      id: cached.id,
      path: cached.path,
      fileContent: snapshot.fileContent,
      frontmatter: snapshotParsed.frontmatter,
      parsedContent: snapshotParsed.content
    },
    { isNew: false }
  )

  // Ensure all tags have definitions (creates new tags with auto-assigned colors)
  ensureTagDefinitions(dataDb, syncResult.tags)

  // Build the restored note object
  const restoredNote: Note = {
    id: cached.id,
    path: cached.path,
    title: snapshotParsed.frontmatter.title ?? cached.title,
    content: snapshotParsed.content,
    frontmatter: snapshotParsed.frontmatter,
    created: new Date(snapshotParsed.frontmatter.created),
    modified: new Date(),
    tags: syncResult.tags,
    aliases: snapshotParsed.frontmatter.aliases ?? [],
    wordCount: syncResult.wordCount,
    properties: syncResult.properties,
    emoji: syncResult.emoji
  }

  // Emit event
  emitNoteEvent(NotesChannels.events.UPDATED, {
    id: cached.id,
    changes: restoredNote,
    source: 'internal'
  })

  return restoredNote
}

// ============================================================================
// File Import
// ============================================================================

export interface ImportFilesInput {
  /** Array of absolute source file paths to import */
  sourcePaths: string[]
  /** Target folder within vault (relative to notes folder, e.g., 'projects' or '') */
  targetFolder?: string
}

export interface ImportedFileInfo {
  destPath: string
  filename: string
  fileType: string
}

export interface ImportFilesResult {
  success: boolean
  imported: number
  failed: number
  errors: string[]
  importedFiles: ImportedFileInfo[]
}

/**
 * Import external files into the vault.
 * Copies files to the target folder and the watcher will automatically index them.
 */
export async function importFiles(input: ImportFilesInput): Promise<ImportFilesResult> {
  const { sourcePaths, targetFolder = '' } = input
  const status = getStatus()

  if (!status.isOpen || !status.path) {
    throw new Error('No vault is open')
  }

  const notesPath = path.join(status.path, 'notes', targetFolder)

  // Ensure target folder exists
  await ensureDirectory(notesPath)

  const errors: string[] = []
  const importedFiles: ImportedFileInfo[] = []
  let imported = 0
  let failed = 0

  for (const sourcePath of sourcePaths) {
    try {
      // Check source exists
      await fs.access(sourcePath)

      // Get source filename
      const filename = path.basename(sourcePath)

      // Generate unique filename if exists
      let destFilename = filename
      let destPath = path.join(notesPath, destFilename)
      let counter = 1

      while (true) {
        try {
          await fs.access(destPath)
          // File exists, try another name
          const ext = path.extname(filename)
          const base = path.basename(filename, ext)
          destFilename = `${base} (${counter})${ext}`
          destPath = path.join(notesPath, destFilename)
          counter++
        } catch {
          // File doesn't exist, we can use this name
          break
        }
      }

      // Copy file
      await fs.copyFile(sourcePath, destPath)
      imported++

      const fileType = getFileType(getExtension(destPath)) ?? 'markdown'
      importedFiles.push({ destPath, filename, fileType })
    } catch (error) {
      failed++
      const message = error instanceof Error ? error.message : 'Unknown error'
      errors.push(`Failed to import ${path.basename(sourcePath)}: ${message}`)
    }
  }

  return {
    success: failed === 0,
    imported,
    failed,
    errors,
    importedFiles
  }
}
