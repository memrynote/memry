/**
 * Note rename and move operations — filesystem rename, frontmatter rewrite for
 * markdown, and cache resync. Pulled from notes.ts during the Phase 3.1 split
 * (.claude/plans/tech-debt-remediation.md).
 *
 * @module vault/notes-rename
 */

import path from 'path'
import fs from 'fs/promises'
import { serializeNote, type NoteFrontmatter } from './frontmatter'
import { syncNoteToCache, syncFileToCache } from './note-sync'
import {
  atomicWrite,
  deleteFile,
  ensureDirectory,
  sanitizeFilename,
  generateUniquePath
} from './file-ops'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { NotesChannels } from '@memry/contracts/notes-api'
import { isBinaryFileType, type FileType } from '@memry/shared/file-types'
import { updateNoteMetadata } from '@memry/storage-data'
import { emitNoteEvent, getNotesDir, toAbsolutePath, toRelativePath } from './notes-io'
import { getNoteById } from './notes-crud'
import type { Note } from './notes-crud'

// ============================================================================
// Rename
// ============================================================================

export async function renameNote(id: string, newTitle: string): Promise<Note> {
  const db = getIndexDatabase()

  const existing = await getNoteById(id)
  if (!existing) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  const cached = getNoteCacheById(db, id)
  const isBinary = cached?.fileType ? isBinaryFileType(cached.fileType) : false

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
    await fs.rename(oldPath, newPath)
    syncFileToCache(db, {
      id,
      path: newRelativePath,
      title: newTitle,
      fileType: cached?.fileType as Exclude<FileType, 'markdown'>,
      mimeType: cached?.mimeType ?? null,
      fileSize: cached?.fileSize ?? 0,
      createdAt: existing.created,
      modifiedAt: new Date(now)
    })
    updateNoteMetadata(getDatabase(), id, {
      path: newRelativePath,
      title: newTitle,
      modifiedAt: now
    })
  } else {
    const fileContent = serializeNote(newFrontmatter, existing.content)
    await atomicWrite(newPath, fileContent)
    await deleteFile(oldPath)
    syncNoteToCache(
      db,
      {
        id,
        path: newRelativePath,
        fileContent,
        frontmatter: newFrontmatter,
        parsedContent: existing.content
      },
      { isNew: false }
    )
  }

  const note: Note = {
    ...existing,
    path: newRelativePath,
    title: newTitle,
    frontmatter: newFrontmatter,
    modified: new Date(now)
  }

  emitNoteEvent(NotesChannels.events.RENAMED, {
    id,
    oldPath: existing.path,
    newPath: newRelativePath,
    oldTitle: existing.title,
    newTitle
  })

  return note
}

// ============================================================================
// Move
// ============================================================================

export async function moveNote(id: string, newFolder: string): Promise<Note> {
  const db = getIndexDatabase()
  const notesDir = getNotesDir()

  const existing = await getNoteById(id)
  if (!existing) {
    throw new NoteError(`Note not found: ${id}`, NoteErrorCode.NOT_FOUND, id)
  }

  const cached = getNoteCacheById(db, id)
  const isBinary = cached?.fileType ? isBinaryFileType(cached.fileType) : false

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
    await fs.rename(oldPath, newPath)
    syncFileToCache(db, {
      id,
      path: newRelativePath,
      title: existing.title,
      fileType: cached?.fileType as Exclude<FileType, 'markdown'>,
      mimeType: cached?.mimeType ?? null,
      fileSize: cached?.fileSize ?? 0,
      createdAt: existing.created,
      modifiedAt: new Date(now)
    })
    updateNoteMetadata(getDatabase(), id, {
      path: newRelativePath,
      modifiedAt: now
    })
  } else {
    const fileContent = serializeNote(newFrontmatter, existing.content)
    await atomicWrite(newPath, fileContent)
    await deleteFile(oldPath)
    syncNoteToCache(
      db,
      {
        id,
        path: newRelativePath,
        fileContent,
        frontmatter: newFrontmatter,
        parsedContent: existing.content
      },
      { isNew: false }
    )
  }

  const note: Note = {
    ...existing,
    path: newRelativePath,
    frontmatter: newFrontmatter,
    modified: new Date(now)
  }

  emitNoteEvent(NotesChannels.events.MOVED, {
    id,
    oldPath: existing.path,
    newPath: newRelativePath
  })

  return note
}
