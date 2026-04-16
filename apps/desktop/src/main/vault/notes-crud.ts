/**
 * Note CRUD, listing, folders, tags/links, file import, and small utilities.
 * Pulled from notes.ts during the Phase 3.1 split
 * (.claude/plans/tech-debt-remediation.md).
 *
 * @module vault/notes-crud
 */

import path from 'path'
import fs from 'fs/promises'
import { shell } from 'electron'
import { eq } from 'drizzle-orm'
import {
  parseNote,
  serializeNote,
  createFrontmatter,
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
  generateNotePath,
  generateUniquePath
} from './file-ops'
import {
  getNoteCacheById,
  getNoteCacheByPath,
  getNoteTags,
  ensureTagDefinitions,
  getNotePropertiesAsRecord,
  findDuplicateId,
  resolveNoteByTitle
} from '@main/database/queries/notes'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { getDatabase, getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { generateNoteId } from '../lib/id'
import { NotesChannels } from '@memry/contracts/notes-api'
import type { FolderInfo } from '@memry/contracts/templates-api'
import { readFolderConfig } from './folders'
import { createLogger } from '../lib/logger'
import { getFileType, getExtension } from '@memry/shared/file-types'
import { getStatus } from './index'
import { emitNoteEvent, getNotesDir, toAbsolutePath, toRelativePath } from './notes-io'
import { maybeCreateSignificantSnapshot } from './notes-versions'
import { noteToListItem } from './notes-queries'

const logger = createLogger('VaultNotesCrud')

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
  properties: Record<string, unknown>
  emoji?: string | null
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
  emoji?: string | null
  localOnly?: boolean
  properties?: Record<string, unknown>
  fileType?: 'markdown' | 'pdf' | 'image' | 'audio' | 'video'
  mimeType?: string | null
  fileSize?: number | null
}

export interface FileMetadata {
  id: string
  path: string
  absolutePath: string
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
  properties?: Record<string, unknown>
}

export interface NoteUpdateInput {
  id: string
  title?: string
  content?: string
  tags?: string[]
  frontmatter?: Record<string, unknown>
  properties?: Record<string, unknown>
  emoji?: string | null
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

export interface ImportFilesInput {
  sourcePaths: string[]
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

// ============================================================================
// Create
// ============================================================================

export async function createNote(input: NoteCreateInput): Promise<Note> {
  const notesDir = getNotesDir()
  const db = getIndexDatabase()
  const dataDb = getDatabase()

  let templateContent = ''
  let templateTags: string[] = []
  let templateProperties: Record<string, unknown> = {}

  let templateId = input.template
  if (!templateId && input.folder) {
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

  let filePath = generateNotePath(notesDir, input.title, input.folder)
  filePath = await generateUniquePath(filePath)

  const mergedTags = [...new Set([...templateTags, ...(input.tags ?? [])])]

  const frontmatter = createFrontmatter(input.title, mergedTags)

  const properties = { ...templateProperties, ...(input.properties ?? {}) }
  if (Object.keys(properties).length > 0) {
    ;(frontmatter as NoteFrontmatter & { properties: Record<string, unknown> }).properties =
      properties
  }

  const content = input.content && input.content.trim() ? input.content : templateContent
  const fileContent = serializeNote(frontmatter, content)

  await atomicWrite(filePath, fileContent)

  const relativePath = toRelativePath(filePath)

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
    properties,
    emoji: null
  }

  emitNoteEvent(NotesChannels.events.CREATED, {
    note: noteToListItem(note),
    source: 'internal'
  })

  return note
}

// ============================================================================
// Read
// ============================================================================

export async function getNoteById(id: string): Promise<Note | null> {
  const db = getIndexDatabase()

  const cached = getNoteCacheById(db, id)
  if (!cached) {
    return null
  }

  const absolutePath = toAbsolutePath(cached.path)
  const fileContent = await safeRead(absolutePath)

  if (!fileContent) {
    logger.warn('getNoteById: file missing on disk, returning null (watcher handles cleanup)', {
      id,
      path: cached.path
    })
    return null
  }

  const parsed = parseNote(fileContent, cached.path)
  let responseTags = getNoteTags(db, id)
  let responseProperties = getNotePropertiesAsRecord(db, id)
  let responseWordCount = cached.wordCount ?? 0
  let responseEmoji = cached.emoji ?? (parsed.frontmatter as { emoji?: string }).emoji ?? null

  const duplicate = findDuplicateId(db, parsed.frontmatter.id, cached.path)
  if (duplicate) {
    const newId = generateNoteId()
    parsed.frontmatter.id = newId
    parsed.frontmatter.title = path.basename(cached.path, path.extname(cached.path))
    const newContent = serializeNote(parsed.frontmatter, parsed.content)
    await atomicWrite(absolutePath, newContent)
    deleteNoteFromCache(db, id)
    const syncResult = syncNoteToCache(
      db,
      {
        id: newId,
        path: cached.path,
        fileContent: newContent,
        frontmatter: parsed.frontmatter,
        parsedContent: parsed.content
      },
      { isNew: true }
    )

    id = newId
    responseTags = syncResult.tags
    responseProperties = syncResult.properties
    responseWordCount = syncResult.wordCount
    responseEmoji = syncResult.emoji
  }

  return {
    id,
    path: cached.path,
    title: parsed.frontmatter.title ?? cached.title,
    content: parsed.content,
    frontmatter: parsed.frontmatter,
    created: new Date(parsed.frontmatter.created),
    modified: new Date(parsed.frontmatter.modified),
    tags: responseTags,
    aliases: parsed.frontmatter.aliases ?? [],
    wordCount: responseWordCount,
    properties: responseProperties,
    emoji: responseEmoji
  }
}

export async function getFileById(id: string): Promise<FileMetadata | null> {
  const db = getIndexDatabase()

  const cached = getNoteCacheById(db, id)
  if (!cached) {
    return null
  }

  const fileType = cached.fileType ?? 'markdown'
  if (fileType === 'markdown') {
    return null
  }

  const absolutePath = toAbsolutePath(cached.path)
  try {
    await fs.access(absolutePath)
  } catch {
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

export async function getNoteByPath(notePath: string): Promise<Note | null> {
  const db = getIndexDatabase()

  const cached = getNoteCacheByPath(db, notePath)
  if (cached) {
    return getNoteById(cached.id)
  }

  const absolutePath = toAbsolutePath(notePath)
  const fileContent = await safeRead(absolutePath)

  if (!fileContent) {
    return null
  }

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

export async function updateNote(input: NoteUpdateInput): Promise<Note> {
  const db = getIndexDatabase()
  const dataDb = getDatabase()

  const existing = await getNoteById(input.id)
  if (!existing) {
    throw new NoteError(`Note not found: ${input.id}`, NoteErrorCode.NOT_FOUND, input.id)
  }

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
  const newProperties = input.properties ?? existing.properties
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

  if (newEmoji !== undefined) {
    newFrontmatter.emoji = newEmoji
  }

  const fileContent = serializeNote(newFrontmatter, newContent)
  const absolutePath = toAbsolutePath(existing.path)
  await atomicWrite(absolutePath, fileContent)

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

  const tagsChanged =
    newTags.length !== existing.tags.length || newTags.some((t) => !existing.tags.includes(t))

  if (tagsChanged) {
    ensureTagDefinitions(dataDb, newTags)
  }

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
    properties: newProperties,
    emoji: newEmoji
  }

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

  if (tagsChanged) {
    emitNoteEvent('notes:tags-changed', undefined)
  }

  return note
}

// ============================================================================
// Delete
// ============================================================================

export async function deleteNote(id: string): Promise<void> {
  const db = getIndexDatabase()

  const cached = getNoteCacheById(db, id)
  if (!cached) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  const absolutePath = toAbsolutePath(cached.path)
  await deleteFile(absolutePath)

  deleteNoteFromCache(db, id)

  emitNoteEvent(NotesChannels.events.DELETED, {
    id,
    path: cached.path,
    source: 'internal'
  })
}

// ============================================================================
// Folders
// ============================================================================

export async function getFolders(): Promise<FolderInfo[]> {
  const notesDir = getNotesDir()
  const paths = await listDirectories(notesDir, notesDir)
  const db = getDatabase()

  return Promise.all(
    paths.map(async (folderPath) => {
      if (db) {
        const dbRow = db
          .select({ icon: folderConfigs.icon })
          .from(folderConfigs)
          .where(eq(folderConfigs.path, folderPath))
          .get()
        if (dbRow) {
          return { path: folderPath, icon: dbRow.icon ?? null }
        }
      }

      const config = await readFolderConfig(folderPath)
      return { path: folderPath, icon: config?.icon ?? null }
    })
  )
}

export async function createFolder(folderPath: string): Promise<void> {
  const notesDir = getNotesDir()
  const absolutePath = path.join(notesDir, folderPath)
  await ensureDirectory(absolutePath)
}

export async function renameFolder(oldPath: string, newPath: string): Promise<void> {
  const notesDir = getNotesDir()
  const oldAbsPath = path.join(notesDir, oldPath)
  const newAbsPath = path.join(notesDir, newPath)

  const { rename } = await import('fs/promises')
  await rename(oldAbsPath, newAbsPath)
}

export async function deleteFolder(folderPath: string): Promise<void> {
  const notesDir = getNotesDir()
  const absPath = path.join(notesDir, folderPath)

  const { rm } = await import('fs/promises')
  await rm(absPath, { recursive: true, force: true })
}

// ============================================================================
// Utilities
// ============================================================================

export function noteExists(titleOrPath: string): boolean {
  const db = getIndexDatabase()

  if (titleOrPath.endsWith('.md')) {
    const cached = getNoteCacheByPath(db, titleOrPath)
    return cached !== undefined
  }

  const resolved = resolveNoteByTitle(db, titleOrPath)
  return resolved !== undefined
}

export async function openExternal(id: string): Promise<void> {
  const db = getIndexDatabase()
  const cached = getNoteCacheById(db, id)

  if (!cached) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  const absolutePath = toAbsolutePath(cached.path)
  await shell.openPath(absolutePath)
}

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
// File Import
// ============================================================================

export async function importFiles(input: ImportFilesInput): Promise<ImportFilesResult> {
  const { sourcePaths, targetFolder = '' } = input
  const status = getStatus()

  if (!status.isOpen || !status.path) {
    throw new Error('No vault is open')
  }

  const notesPath = path.join(status.path, 'notes', targetFolder)

  await ensureDirectory(notesPath)

  const errors: string[] = []
  const importedFiles: ImportedFileInfo[] = []
  let imported = 0
  let failed = 0

  for (const sourcePath of sourcePaths) {
    try {
      await fs.access(sourcePath)

      const filename = path.basename(sourcePath)

      let destFilename = filename
      let destPath = path.join(notesPath, destFilename)
      let counter = 1

      while (true) {
        try {
          await fs.access(destPath)
          const ext = path.extname(filename)
          const base = path.basename(filename, ext)
          destFilename = `${base} (${counter})${ext}`
          destPath = path.join(notesPath, destFilename)
          counter++
        } catch {
          break
        }
      }

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
