/**
 * Note rename and move operations — a filesystem rename plus cache resync.
 *
 * A rename leaves the bytes alone: the title lives in the DBs, not in the file.
 * A move to a different folder cannot, because the note's body carries refs that
 * are relative to the folder the note was in — see `rewrite-note-refs.ts`.
 *
 * Pulled from notes.ts during the Phase 3.1 split
 * (.claude/plans/tech-debt-remediation.md).
 *
 * @module vault/notes-rename
 */

import path from 'path'
import fs from 'fs/promises'
import { parseNote } from './frontmatter'
import { syncNoteToCache, syncFileToCache } from './note-sync'
import {
  ensureDirectory,
  sanitizeFilename,
  generateUniquePath,
  safeRead,
  atomicWrite
} from './file-ops'
import { rewriteNoteRefsForMove } from './rewrite-note-refs'
import { replaceNoteBodyInCrdt } from '../sync/crdt-feed'
import { markWritebackIgnored } from '../sync/crdt-writeback'
import { getNoteCacheById } from '@main/database/queries/notes'
import {
  carryPositionToPath,
  deleteNotePosition,
  placeNewItemAtTop
} from '@main/database/queries/note-positions'
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

  // Position rows are keyed by path, so the rename that follows every "new
  // note" would otherwise drop the row this note was just given and send it
  // back to the bottom of a hand-ordered folder (#1646).
  carryPositionToPath(getDatabase(), existing.path, newRelativePath)

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

  // Filesystem rename first; the body, if it needs re-pointing, is rewritten in
  // place below rather than during the move, so a failed write cannot strand the
  // file between two folders.
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
    const original = (await safeRead(newPath)) ?? ''
    // Null means every ref still resolves from the new folder, which is the
    // common case (same depth, or a note with no relative refs at all): nothing
    // is written, so the file keeps its mtime and its sync state.
    const rewritten = rewriteNoteRefsForMove(original, existing.path, newRelativePath)
    if (rewritten !== null) {
      // The watcher's external-edit feed must not race the CRDT push below; the
      // sync note handler marks its own writes the same way before touching a
      // file it is about to reconcile itself.
      markWritebackIgnored(newPath)
      await atomicWrite(newPath, rewritten)
    }
    const fileContent = rewritten ?? original
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

    if (rewritten !== null) {
      // Mandatory, not bookkeeping. Main owns the Y.Doc and it is keyed by note
      // id, so a move never invalidates it; the doc still holds the pre-move
      // body and the next write-back would serialize that straight back over the
      // file we just corrected — and persist it, so closing the note would not
      // undo the loss. The cache row already points at the new path, so the
      // embed resolution inside this call reads the note from where it now
      // lives. Same order `applyTemplateToNote` uses: file first, then the doc.
      await replaceNoteBodyInCrdt(id, parsed.content)
    }
  }

  // The old row can never be reached again — it is keyed by a path nothing
  // holds now — and leaving it would hand its slot to the next note created
  // there. The note takes the top of its new folder, same as a fresh one.
  const dataDb = getDatabase()
  deleteNotePosition(dataDb, existing.path)
  placeNewItemAtTop(
    dataDb,
    newRelativePath,
    path.posix.dirname(newRelativePath).replace(/^\.$/, '')
  )

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
