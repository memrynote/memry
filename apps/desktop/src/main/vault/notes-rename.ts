/**
 * Note rename and move operations — pure filesystem rename plus cache resync;
 * file bytes are never touched. Pulled from notes.ts during the Phase 3.1
 * split (.claude/plans/tech-debt-remediation.md).
 *
 * @module vault/notes-rename
 */

import path from 'path'
import fs from 'fs/promises'
import { parseNote } from './frontmatter'
import { syncNoteToCache, syncFileToCache } from './note-sync'
import { ensureDirectory, sanitizeFilename, generateUniquePath, safeRead } from './file-ops'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { NotesChannels } from '@memry/contracts/notes-api'
import { isBinaryFileType, type FileType } from '@memry/shared/file-types'
import { updateNoteMetadata } from '@memry/storage-data'
import { emitNoteEvent, getVaultRoot, toAbsolutePath, toRelativePath } from './notes-io'
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

  // Pure filesystem rename — file bytes untouched; title/dates live in the DBs
  await fs.rename(oldPath, newPath)

  if (isBinary) {
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
    const fileContent = (await safeRead(newPath)) ?? ''
    const parsed = parseNote(fileContent, newRelativePath)
    syncNoteToCache(
      db,
      {
        id,
        path: newRelativePath,
        fileContent,
        frontmatter: parsed.frontmatter,
        parsedContent: parsed.content,
        title: newTitle,
        createdAt: cached?.createdAt ?? existing.created.toISOString(),
        modifiedAt: now,
        localOnly: cached?.localOnly ?? false,
        emoji: cached?.emoji ?? null
      },
      { isNew: false }
    )
  }

  const note: Note = {
    ...existing,
    path: newRelativePath,
    title: newTitle,
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
  // `newFolder` comes from the sidebar tree / folder view, which are
  // vault-relative — never re-root it through `defaultNoteFolder`.
  const notesDir = getVaultRoot()

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

  // Pure filesystem rename — file bytes untouched; dates live in the DBs
  await fs.rename(oldPath, newPath)

  if (isBinary) {
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
    const fileContent = (await safeRead(newPath)) ?? ''
    const parsed = parseNote(fileContent, newRelativePath)
    syncNoteToCache(
      db,
      {
        id,
        path: newRelativePath,
        fileContent,
        frontmatter: parsed.frontmatter,
        parsedContent: parsed.content,
        title: existing.title,
        createdAt: cached?.createdAt ?? existing.created.toISOString(),
        modifiedAt: now,
        localOnly: cached?.localOnly ?? false,
        emoji: cached?.emoji ?? null
      },
      { isNew: false }
    )
  }

  const note: Note = {
    ...existing,
    path: newRelativePath,
    modified: new Date(now)
  }

  emitNoteEvent(NotesChannels.events.MOVED, {
    id,
    oldPath: existing.path,
    newPath: newRelativePath
  })

  return note
}
