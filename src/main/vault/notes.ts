/**
 * Note CRUD operations.
 * Combines frontmatter parsing, atomic file operations, and cache queries.
 *
 * @module vault/notes
 */

import path from 'path'
import { shell } from 'electron'
import { BrowserWindow } from 'electron'
import { getStatus, getConfig } from './index'
import {
  parseNote,
  serializeNote,
  createFrontmatter,
  extractWikiLinks,
  extractTags,
  calculateWordCount,
  generateContentHash,
  createSnippet,
  type NoteFrontmatter
} from './frontmatter'
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
  setNoteTags,
  getNoteTags,
  getAllTags,
  setNoteLinks,
  getOutgoingLinks,
  getIncomingLinks,
  findDuplicateId,
  resolveNoteByTitle
} from '@shared/db/queries/notes'
import { getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode, VaultError, VaultErrorCode } from '../lib/errors'
import { generateNoteId } from '../lib/id'
import { NotesChannels } from '@shared/contracts/notes-api'

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
}

export interface NoteCreateInput {
  title: string
  content?: string
  folder?: string
  tags?: string[]
  template?: string
}

export interface NoteUpdateInput {
  id: string
  title?: string
  content?: string
  tags?: string[]
  frontmatter?: Record<string, unknown>
}

export interface NoteListOptions {
  folder?: string
  tags?: string[]
  sortBy?: 'modified' | 'created' | 'title'
  sortOrder?: 'asc' | 'desc'
  limit?: number
  offset?: number
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
  lineNumber: number
}

export interface Backlink {
  sourceId: string
  sourcePath: string
  sourceTitle: string
  context: string
  lineNumber: number
}

export interface NoteLinksResponse {
  outgoing: NoteLink[]
  incoming: Backlink[]
}

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
function getNotesDir(): string {
  const vaultPath = getVaultPath()
  const config = getConfig()
  return path.join(vaultPath, config.defaultNoteFolder)
}

/**
 * Convert relative path to absolute path.
 */
function toAbsolutePath(relativePath: string): string {
  const vaultPath = getVaultPath()
  return path.join(vaultPath, relativePath)
}

/**
 * Convert absolute path to relative path (from vault root).
 */
function toRelativePath(absolutePath: string): string {
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

  // Generate file path
  let filePath = generateNotePath(notesDir, input.title, input.folder)
  filePath = await generateUniquePath(filePath)

  // Create frontmatter
  const frontmatter = createFrontmatter(input.title, input.tags)

  // Serialize content
  const content = input.content ?? ''
  const fileContent = serializeNote(frontmatter, content)

  // Write file atomically
  await atomicWrite(filePath, fileContent)

  // Get relative path for cache
  const relativePath = toRelativePath(filePath)

  // Update cache
  const contentHash = generateContentHash(fileContent)
  const wordCount = calculateWordCount(content)

  insertNoteCache(db, {
    id: frontmatter.id,
    path: relativePath,
    title: input.title,
    contentHash,
    wordCount,
    createdAt: frontmatter.created,
    modifiedAt: frontmatter.modified
  })

  // Set tags
  if (input.tags && input.tags.length > 0) {
    setNoteTags(db, frontmatter.id, input.tags)
  }

  // Extract and set links
  const wikiLinks = extractWikiLinks(content)
  if (wikiLinks.length > 0) {
    const links = wikiLinks.map((title) => {
      const target = resolveNoteByTitle(db, title)
      return { targetTitle: title, targetId: target?.id }
    })
    setNoteLinks(db, frontmatter.id, links)
  }

  // Build response
  const note: Note = {
    id: frontmatter.id,
    path: relativePath,
    title: input.title,
    content,
    frontmatter,
    created: new Date(frontmatter.created),
    modified: new Date(frontmatter.modified),
    tags: input.tags ?? [],
    aliases: frontmatter.aliases ?? [],
    wordCount
  }

  // Emit event
  emitNoteEvent(NotesChannels.events.CREATED, {
    note: noteToListItem(note),
    source: 'internal'
  })

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
    // File was deleted externally, remove from cache
    deleteNoteCache(db, id)
    return null
  }

  // Parse content
  const parsed = parseNote(fileContent, cached.path)

  // Check for duplicate ID (T046)
  const duplicate = findDuplicateId(db, parsed.frontmatter.id, cached.path)
  if (duplicate) {
    // Generate new ID and update file
    const newId = generateNoteId()
    parsed.frontmatter.id = newId
    const newContent = serializeNote(parsed.frontmatter, parsed.content)
    await atomicWrite(absolutePath, newContent)

    // Update cache with new ID
    deleteNoteCache(db, id)
    insertNoteCache(db, {
      id: newId,
      path: cached.path,
      title: parsed.frontmatter.title ?? path.basename(cached.path, '.md'),
      contentHash: generateContentHash(newContent),
      wordCount: calculateWordCount(parsed.content),
      createdAt: parsed.frontmatter.created,
      modifiedAt: parsed.frontmatter.modified
    })

    // Update ID for response
    id = newId
  }

  // Get tags from cache
  const tags = getNoteTags(db, id)

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
    wordCount: cached.wordCount
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

  // Parse and index
  const parsed = parseNote(fileContent, notePath)
  const contentHash = generateContentHash(fileContent)
  const wordCount = calculateWordCount(parsed.content)
  const tags = extractTags(parsed.frontmatter)

  // Insert into cache
  insertNoteCache(db, {
    id: parsed.frontmatter.id,
    path: notePath,
    title: parsed.frontmatter.title ?? path.basename(notePath, '.md'),
    contentHash,
    wordCount,
    createdAt: parsed.frontmatter.created,
    modifiedAt: parsed.frontmatter.modified
  })

  if (tags.length > 0) {
    setNoteTags(db, parsed.frontmatter.id, tags)
  }

  return {
    id: parsed.frontmatter.id,
    path: notePath,
    title: parsed.frontmatter.title ?? path.basename(notePath, '.md'),
    content: parsed.content,
    frontmatter: parsed.frontmatter,
    created: new Date(parsed.frontmatter.created),
    modified: new Date(parsed.frontmatter.modified),
    tags,
    aliases: parsed.frontmatter.aliases ?? [],
    wordCount
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

  // Get existing note
  const existing = await getNoteById(input.id)
  if (!existing) {
    throw new NoteError(`Note not found: ${input.id}`, NoteErrorCode.NOT_FOUND, input.id)
  }

  // Merge updates
  const newTitle = input.title ?? existing.title
  const newContent = input.content ?? existing.content
  const newTags = input.tags ?? existing.tags

  // Update frontmatter
  const newFrontmatter: NoteFrontmatter = {
    ...existing.frontmatter,
    ...input.frontmatter,
    title: newTitle,
    tags: newTags,
    modified: new Date().toISOString()
  }

  // Serialize and write
  const fileContent = serializeNote(newFrontmatter, newContent)
  const absolutePath = toAbsolutePath(existing.path)
  await atomicWrite(absolutePath, fileContent)

  // Update cache
  const contentHash = generateContentHash(fileContent)
  const wordCount = calculateWordCount(newContent)

  updateNoteCache(db, input.id, {
    title: newTitle,
    contentHash,
    wordCount,
    modifiedAt: newFrontmatter.modified
  })

  // Update tags
  setNoteTags(db, input.id, newTags)

  // Update links
  const wikiLinks = extractWikiLinks(newContent)
  const links = wikiLinks.map((title) => {
    const target = resolveNoteByTitle(db, title)
    return { targetTitle: title, targetId: target?.id }
  })
  setNoteLinks(db, input.id, links)

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
    wordCount
  }

  // Emit event
  emitNoteEvent(NotesChannels.events.UPDATED, {
    id: input.id,
    changes: { title: newTitle, content: newContent, tags: newTags },
    source: 'internal'
  })

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

  // Generate new path
  const oldPath = toAbsolutePath(existing.path)
  const dir = path.dirname(oldPath)
  let newPath = path.join(dir, sanitizeFilename(newTitle) + '.md')
  newPath = await generateUniquePath(newPath)
  const newRelativePath = toRelativePath(newPath)

  // Update frontmatter
  const newFrontmatter: NoteFrontmatter = {
    ...existing.frontmatter,
    title: newTitle,
    modified: new Date().toISOString()
  }

  // Serialize and write to new location
  const fileContent = serializeNote(newFrontmatter, existing.content)
  await atomicWrite(newPath, fileContent)

  // Delete old file
  await deleteFile(oldPath)

  // Update cache
  updateNoteCache(db, id, {
    path: newRelativePath,
    title: newTitle,
    contentHash: generateContentHash(fileContent),
    modifiedAt: newFrontmatter.modified
  })

  // Build response
  const note: Note = {
    ...existing,
    path: newRelativePath,
    title: newTitle,
    frontmatter: newFrontmatter,
    modified: new Date(newFrontmatter.modified)
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

  // Generate new path
  const oldPath = toAbsolutePath(existing.path)
  const filename = path.basename(oldPath)
  const newDir = path.join(notesDir, newFolder)
  await ensureDirectory(newDir)
  let newPath = path.join(newDir, filename)
  newPath = await generateUniquePath(newPath)
  const newRelativePath = toRelativePath(newPath)

  // Update frontmatter
  const newFrontmatter: NoteFrontmatter = {
    ...existing.frontmatter,
    modified: new Date().toISOString()
  }

  // Serialize and write to new location
  const fileContent = serializeNote(newFrontmatter, existing.content)
  await atomicWrite(newPath, fileContent)

  // Delete old file
  await deleteFile(oldPath)

  // Update cache
  updateNoteCache(db, id, {
    path: newRelativePath,
    contentHash: generateContentHash(fileContent),
    modifiedAt: newFrontmatter.modified
  })

  // Build response
  const note: Note = {
    ...existing,
    path: newRelativePath,
    frontmatter: newFrontmatter,
    modified: new Date(newFrontmatter.modified)
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

  // Remove from cache (cascades to tags and links)
  deleteNoteCache(db, id)

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
 */
export async function listNotes(options: NoteListOptions = {}): Promise<NoteListResponse> {
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

  // Convert to list items
  const noteItems: NoteListItem[] = await Promise.all(
    notes.map(async (c) => {
      const tags = getNoteTags(db, c.id)

      // Get snippet from file if needed
      let snippet: string | undefined
      try {
        const absolutePath = toAbsolutePath(c.path)
        const content = await safeRead(absolutePath)
        if (content) {
          const parsed = parseNote(content)
          snippet = createSnippet(parsed.content)
        }
      } catch {
        // Ignore snippet errors
      }

      return {
        id: c.id,
        path: c.path,
        title: c.title,
        created: new Date(c.createdAt),
        modified: new Date(c.modifiedAt),
        tags,
        wordCount: c.wordCount,
        snippet
      }
    })
  )

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
    snippet: createSnippet(note.content)
  }
}

// ============================================================================
// Tags & Links
// ============================================================================

/**
 * Get all tags with counts.
 */
export function getTagsWithCounts(): { tag: string; count: number }[] {
  const db = getIndexDatabase()
  return getAllTags(db)
}

/**
 * Get links for a note (outgoing and incoming).
 */
export async function getNoteLinks(id: string): Promise<NoteLinksResponse> {
  const db = getIndexDatabase()

  // Get outgoing links
  const outgoing = getOutgoingLinks(db, id)
  const outgoingLinks: NoteLink[] = outgoing.map((link) => ({
    sourceId: link.sourceId,
    targetId: link.targetId,
    targetTitle: link.targetTitle,
    lineNumber: 0 // TODO: Calculate line number from content
  }))

  // Get incoming links (backlinks)
  const incoming = getIncomingLinks(db, id)
  const backlinks: Backlink[] = await Promise.all(
    incoming.map(async (link) => {
      const sourceCache = getNoteCacheById(db, link.sourceId)
      return {
        sourceId: link.sourceId,
        sourcePath: sourceCache?.path ?? '',
        sourceTitle: sourceCache?.title ?? '',
        context: '', // TODO: Extract context from content
        lineNumber: 0
      }
    })
  )

  return { outgoing: outgoingLinks, incoming: backlinks }
}

// ============================================================================
// Folders
// ============================================================================

/**
 * Get all folders in the notes directory.
 */
export async function getFolders(): Promise<string[]> {
  const notesDir = getNotesDir()
  return listDirectories(notesDir, notesDir)
}

/**
 * Create a new folder.
 */
export async function createFolder(folderPath: string): Promise<void> {
  const notesDir = getNotesDir()
  const absolutePath = path.join(notesDir, folderPath)
  await ensureDirectory(absolutePath)
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Check if a note exists by title or path.
 */
export async function noteExists(titleOrPath: string): Promise<boolean> {
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
export async function revealInFinder(id: string): Promise<void> {
  const db = getIndexDatabase()
  const cached = getNoteCacheById(db, id)

  if (!cached) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  const absolutePath = toAbsolutePath(cached.path)
  shell.showItemInFolder(absolutePath)
}
