import fs from 'fs'
import path from 'path'
import { NotesChannels } from '@memry/contracts/ipc-channels'
import type { NoteUpdatedEvent } from '@memry/contracts/notes-api'
import { createLogger } from '../../lib/logger'
import { broadcastToAllWindows } from '../../lib/window-broadcast'
import {
  backfillUnresolvedLinksByTitle,
  unresolveLinksToNote,
  deleteNoteCache,
  extractDateFromPath,
  getNoteCacheById,
  getOutgoingLinks,
  getPropertyType,
  insertNoteCache,
  listNoteCacheFilesAfter,
  setMarkdownNoteLinks,
  setNoteLinks,
  setNoteProperties,
  setNoteTags,
  updateNoteCache,
  type NoteCacheFileRow
} from '@main/database/queries/notes'
import { classifyMarkdownContent, classifyMarkdownStat } from '@memry/shared/markdown-class'
import { getIndexDatabase, type IndexDb } from '../../database'
import { extractWikiLinks } from '@memry/shared/wiki-target'
import { inferPropertyType, parseNote } from '../../vault/frontmatter'
import type { NoteProjectionRecord, ProjectionEvent, ProjectionProjector } from '../types'

const logger = createLogger('Projections:NoteState')

// Rows read per keyset page, and how many `stat` calls are in flight at once.
// The pass used to load every note in one query and walk it with `fs.existsSync`,
// which parked the Electron main thread for thousands of blocking syscalls on
// every vault open.
const RECONCILE_PAGE_SIZE = 500
const RECONCILE_STAT_CONCURRENCY = 8

/**
 * The text of the note's HTML blocks changed: rebuild its links from the file
 * on disk plus the new text. A file that cannot be read keeps its links, and
 * a large file keeps none, as at indexing (note-sync.ts `syncLargeFileBodyToCache`).
 */
async function refreshMarkdownNoteLinks(vaultPath: string | null, noteId: string): Promise<void> {
  const db = getIndexDatabase()
  const note = getNoteCacheById(db, noteId)
  if (!vaultPath || !note || note.fileType !== 'markdown') return
  const absolutePath = path.join(vaultPath, note.path)
  let raw: string
  // One handle for the size check and the read, so both see the same file.
  let file: fs.promises.FileHandle | null = null
  try {
    file = await fs.promises.open(absolutePath, 'r')
    if (classifyMarkdownStat((await file.stat()).size)) return
    raw = await file.readFile('utf-8')
  } catch (error) {
    logger.warn('Keeping note links: file unreadable', { noteId, error })
    return
  } finally {
    await file?.close().catch(() => {})
  }
  if (classifyMarkdownContent(raw).sizeClass === 'large-file') return
  if (!isCurrentIndexDatabase(db) || getNoteCacheById(db, noteId)?.path !== note.path) return
  const before = linkKeys(db, noteId)
  setMarkdownNoteLinks(db, noteId, extractWikiLinks(parseNote(raw, note.path).content))
  announceLinkChanges(noteId, before, linkKeys(db, noteId))
}

/** One key per outbound link: the resolved target, or the title it names. */
function linkKeys(db: IndexDb, noteId: string): Map<string, string | null> {
  return new Map(
    getOutgoingLinks(db, noteId).map((link) => [
      `${link.targetId ?? ''}\u0000${link.targetTitle}`,
      link.targetId
    ])
  )
}

/**
 * Links rewritten here land after the renderer's own refresh for the note
 * save, so tell the source note and every target that gained or lost a
 * backlink. An empty `changes` refreshes their links panels and nothing else.
 */
function announceLinkChanges(
  noteId: string,
  before: Map<string, string | null>,
  after: Map<string, string | null>
): void {
  const unchanged = before.size === after.size && [...after.keys()].every((key) => before.has(key))
  if (unchanged) return
  const touched = new Set([noteId])
  for (const [key, targetId] of before) if (!after.has(key) && targetId) touched.add(targetId)
  for (const [key, targetId] of after) if (!before.has(key) && targetId) touched.add(targetId)
  for (const id of touched) {
    const event: NoteUpdatedEvent = { id, changes: {}, source: 'internal' }
    broadcastToAllWindows(NotesChannels.events.UPDATED, event)
  }
}

function persistMarkdownNote(note: Extract<NoteProjectionRecord, { kind: 'markdown' }>): void {
  const db = getIndexDatabase()
  const existing = getNoteCacheById(db, note.noteId)
  // Tier 0 of ingest publishes identity only. Its null measurements mean
  // "not read yet", so they must not be written over a row that already
  // carries real ones, and no body-derived state can be rebuilt from them.
  const bodyUnread = note.parsedContent === null

  if (existing) {
    updateNoteCache(
      db,
      note.noteId,
      bodyUnread
        ? { path: note.path, title: note.title, modifiedAt: note.modifiedAt }
        : {
            path: note.path,
            title: note.title,
            emoji: note.emoji,
            localOnly: note.localOnly,
            contentHash: note.contentHash,
            wordCount: note.wordCount,
            characterCount: note.characterCount,
            snippet: note.snippet,
            modifiedAt: note.modifiedAt
          }
    )
  } else {
    insertNoteCache(db, {
      id: note.noteId,
      path: note.path,
      title: note.title,
      emoji: note.emoji,
      localOnly: note.localOnly,
      fileType: 'markdown',
      fileSize: note.fileSize ?? null,
      contentHash: note.contentHash,
      wordCount: note.wordCount,
      characterCount: note.characterCount,
      snippet: note.snippet,
      date: note.date ?? extractDateFromPath(note.path),
      createdAt: note.createdAt,
      modifiedAt: note.modifiedAt
    })

    // This note just appeared. Any note anywhere that links to it by title
    // was, until now, an unresolved link with no edge in `note_links` — the
    // gap create-from-link (and every other creation route) hits (#2209).
    // Resolve those rows retroactively so the new note gets its backlink.
    backfillUnresolvedLinksByTitle(db, note.noteId, note.title)
  }

  if (bodyUnread) return

  setNoteTags(db, note.noteId, note.tags)
  setNoteProperties(db, note.noteId, note.properties ?? {}, (name, value) =>
    getPropertyType(db, name, value, inferPropertyType)
  )

  // Null properties after a body read mark the large-file tier, which keeps no links.
  if (note.properties === null) {
    setNoteLinks(db, note.noteId, [])
    return
  }
  setMarkdownNoteLinks(db, note.noteId, note.wikiLinks)
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
  unresolveLinksToNote(db, noteId)
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
      return (
        event.type === 'note.upserted' ||
        event.type === 'note.deleted' ||
        event.type === 'note.text-extracted'
      )
    },

    async project(event: ProjectionEvent): Promise<void> {
      if (event.type === 'note.deleted') {
        deleteNote(getIndexDatabase(), event.noteId)
        return
      }

      if (event.type === 'note.text-extracted') {
        await refreshMarkdownNoteLinks(getVaultPath(), event.noteId)
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
