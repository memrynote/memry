import fs from 'fs'
import path from 'path'
import { createLogger } from '../../lib/logger'
import {
  deleteLinksToNote,
  deleteNoteCache,
  extractDateFromPath,
  getNoteCacheById,
  getPropertyType,
  insertNoteCache,
  listNoteCacheFilesAfter,
  resolveNotesByTitles,
  setNoteLinks,
  setNoteProperties,
  setNoteTags,
  updateNoteCache,
  type NoteCacheFileRow
} from '@main/database/queries/notes'
import { getIndexDatabase, type IndexDb } from '../../database'
import { inferPropertyType } from '../../vault/frontmatter'
import type { NoteProjectionRecord, ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:NoteState')

// Rows read per keyset page, and how many `stat` calls are in flight at once.
// The pass used to load every note in one query and walk it with `fs.existsSync`,
// which parked the Electron main thread for thousands of blocking syscalls on
// every vault open.
const RECONCILE_PAGE_SIZE = 500
const RECONCILE_STAT_CONCURRENCY = 8

function persistMarkdownNote(note: Extract<NoteProjectionRecord, { kind: 'markdown' }>): void {
  const db = getIndexDatabase()
  const existing = getNoteCacheById(db, note.noteId)

  if (existing) {
    updateNoteCache(db, note.noteId, {
      path: note.path,
      title: note.title,
      emoji: note.emoji,
      localOnly: note.localOnly,
      contentHash: note.contentHash,
      wordCount: note.wordCount,
      characterCount: note.characterCount,
      snippet: note.snippet,
      modifiedAt: note.modifiedAt
    })
  } else {
    insertNoteCache(db, {
      id: note.noteId,
      path: note.path,
      title: note.title,
      emoji: note.emoji,
      localOnly: note.localOnly,
      fileType: 'markdown',
      contentHash: note.contentHash,
      wordCount: note.wordCount,
      characterCount: note.characterCount,
      snippet: note.snippet,
      date: note.date ?? extractDateFromPath(note.path),
      createdAt: note.createdAt,
      modifiedAt: note.modifiedAt
    })
  }

  setNoteTags(db, note.noteId, note.tags)
  setNoteProperties(db, note.noteId, note.properties, (name, value) =>
    getPropertyType(db, name, value, inferPropertyType)
  )

  const resolvedTitles = resolveNotesByTitles(db, note.wikiLinks)
  const links = note.wikiLinks.map((title) => {
    const resolved = resolvedTitles.get(title)
    return { targetTitle: title, targetId: resolved?.id }
  })
  setNoteLinks(db, note.noteId, links)
}

function persistFileNote(note: Extract<NoteProjectionRecord, { kind: 'file' }>): void {
  const db = getIndexDatabase()
  const existing = getNoteCacheById(db, note.noteId)

  if (existing) {
    updateNoteCache(db, note.noteId, {
      path: note.path,
      title: note.title,
      fileType: note.fileType,
      mimeType: note.mimeType,
      fileSize: note.fileSize,
      modifiedAt: note.modifiedAt
    })
    return
  }

  insertNoteCache(db, {
    id: note.noteId,
    path: note.path,
    title: note.title,
    fileType: note.fileType,
    mimeType: note.mimeType,
    fileSize: note.fileSize,
    contentHash: null,
    wordCount: null,
    characterCount: null,
    snippet: null,
    emoji: null,
    date: null,
    createdAt: note.createdAt,
    modifiedAt: note.modifiedAt
  })
}

function deleteNote(db: IndexDb, noteId: string): void {
  deleteLinksToNote(db, noteId)
  deleteNoteCache(db, noteId)
}

/**
 * Only ENOENT/ENOTDIR mean the file is genuinely gone. Every other failure
 * (EACCES, EIO, EBUSY, a timeout on a network volume) leaves the note alone:
 * `fs.existsSync` folded all of those into `false` and dropped the cache row for
 * a file that is still on disk.
 */
async function isFileMissing(absolutePath: string): Promise<boolean> {
  try {
    await fs.promises.stat(absolutePath)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return true
    }

    logger.warn('Keeping cached note: file check failed', { path: absolutePath, code })
    return false
  }
}

/**
 * The pass yields between pages now, so a vault switch or close can land in the
 * middle of it. The handle is read once and re-checked against the live one
 * before any write: ids read out of one vault's index must never be deleted from
 * another's.
 */
function isCurrentIndexDatabase(db: IndexDb): boolean {
  try {
    return getIndexDatabase() === db
  } catch {
    return false
  }
}

async function reconcileMissingFiles(getVaultPath: () => string | null): Promise<void> {
  const vaultPath = getVaultPath()

  if (!vaultPath) {
    return
  }

  const db = getIndexDatabase()
  let afterId = ''

  for (;;) {
    if (!isCurrentIndexDatabase(db)) {
      logger.debug?.('Stopping note reconcile: index database changed')
      return
    }

    const page = listNoteCacheFilesAfter(db, afterId, RECONCILE_PAGE_SIZE)
    if (page.length === 0) {
      return
    }

    afterId = page[page.length - 1].id

    const absent: NoteCacheFileRow[] = []
    for (let i = 0; i < page.length; i += RECONCILE_STAT_CONCURRENCY) {
      const batch = page.slice(i, i + RECONCILE_STAT_CONCURRENCY)
      const results = await Promise.all(
        batch.map((row) => isFileMissing(path.join(vaultPath, row.path)))
      )
      results.forEach((missing, index) => {
        if (missing) {
          absent.push(batch[index])
        }
      })
    }

    if (absent.length === 0) {
      continue
    }

    if (!isCurrentIndexDatabase(db)) {
      logger.debug?.('Stopping note reconcile: index database changed')
      return
    }

    // Re-read and delete in one synchronous turn, so nothing can interleave
    // between the check and the write. A row whose path or indexedAt moved while
    // its old path was being stat'd was rewritten by a rename or a re-index —
    // the file it points at now was never checked, so it is left alone.
    for (const row of absent) {
      const current = getNoteCacheById(db, row.id)
      if (!current || current.path !== row.path || current.indexedAt !== row.indexedAt) {
        continue
      }

      deleteNote(db, row.id)
    }
  }
}

export function createNoteDerivedStateProjector(
  getVaultPath: () => string | null
): ProjectionProjector {
  return {
    name: 'note-derived-state',
    handles(event: ProjectionEvent): boolean {
      return event.type === 'note.upserted' || event.type === 'note.deleted'
    },

    async project(event: ProjectionEvent): Promise<void> {
      if (event.type === 'note.deleted') {
        deleteNote(getIndexDatabase(), event.noteId)
        return
      }

      if (event.type !== 'note.upserted') {
        return
      }

      const note = event.note

      if (note.kind === 'markdown') {
        persistMarkdownNote(note)
        return
      }

      persistFileNote(note)
    },

    async rebuild(): Promise<void> {
      await reconcileMissingFiles(getVaultPath)
    },

    async reconcile(): Promise<void> {
      await reconcileMissingFiles(getVaultPath)
      logger.debug?.('Reconciled note-derived state')
    }
  }
}
