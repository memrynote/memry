/**
 * Rename-time vault-wide wiki-link rewrite (#1711).
 *
 * Wiki-links address notes by TITLE, so renaming a note silently disconnects
 * every inbound `[[Old Title]]` in the vault — the next click on one creates a
 * duplicate note. This module is the persistence half of the Obsidian-model
 * fix: `rewrite-wiki-links.ts` decides which occurrences to rewrite; this one
 * finds the source notes through the `note_links` index and lands the rewrite
 * everywhere a note body lives, in the same order the watcher lands an
 * out-of-app edit:
 *
 *  1. the vault file (`markWritebackIgnored` first, so the watcher does not
 *     re-ingest our own write),
 *  2. the index/canonical rows via `syncNoteToCache` — the re-projection is
 *     what refreshes `note_links.target_title`, so backlinks and the graph
 *     survive without a rebuild,
 *  3. the renderer, via the same `notes:updated` event an external edit emits,
 *  4. the note's CRDT body via `feedExternalEditToCrdt`, which reaches an open
 *     doc, a closed-but-persisted doc, and correctly leaves a note with no
 *     CRDT body alone. This is also what carries the rewrite to other devices.
 *
 * A source that fails is logged and skipped: the rename itself already
 * happened, and repairing nine of ten links beats unwinding a filesystem
 * rename over one unreadable file.
 *
 * @module vault/rename-link-rewrite
 */

import { splitWikiTarget } from '@memry/shared/wiki-target'
import { isBinaryFileType } from '@memry/shared/file-types'
import { NotesChannels, JournalChannels } from '@memry/contracts/ipc-channels'
import type { NoteUpdatedEvent } from '@memry/contracts/notes-api'
import {
  getInboundLinkSourceIds,
  getNoteCacheById,
  resolveNoteByTitle,
  isJournalEntry,
  extractDateFromPath
} from '@main/database/queries/notes'
import { getIndexDatabase, type IndexDb } from '../database'
import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { markWritebackIgnored } from '../sync/crdt-writeback'
import { rewriteWikiLinksForRename } from './rewrite-wiki-links'
import { parseNote } from './frontmatter'
import { syncNoteToCache } from './note-sync'
import { safeRead, atomicWrite } from './file-ops'
import { emitNoteEvent, toAbsolutePath } from './notes-io'
import { createLogger } from '../lib/logger'

const log = createLogger('RenameLinkRewrite')

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value
}

export interface InboundLinkRewriteInput {
  noteId: string
  oldTitle: string
  newTitle: string
  /**
   * The renamed note's post-rename vault-relative path. Projection is async,
   * so its own cache row may still hold the pre-rename path when this runs —
   * and a note that links to itself is one of the sources being rewritten.
   */
  newPath: string
}

/**
 * Rewrite every inbound `[[oldTitle]]` in the vault to `[[newTitle]]`.
 *
 * Never throws — the filesystem rename this follows has already happened, and
 * a broken link repair must not unwind it. Deliberately never flushes
 * projections inline (rename is a hot path; projector runs async on its own
 * schedule): the pre-rename `note_links` rows are exactly the sources that
 * need repairing, and the per-source `syncNoteToCache` re-projection is what
 * refreshes their `target_title` rows.
 */
export async function rewriteInboundWikiLinksForRename(
  input: InboundLinkRewriteInput
): Promise<void> {
  try {
    await doRewriteInboundLinks(input)
  } catch (err) {
    log.warn('Inbound wiki-link rewrite failed after rename', {
      renamedNoteId: input.noteId,
      error: err
    })
  }
}

async function doRewriteInboundLinks(input: InboundLinkRewriteInput): Promise<void> {
  const { noteId, oldTitle, newTitle } = input
  if (!oldTitle.trim() || oldTitle === newTitle) return

  const db = getIndexDatabase()

  // Links are indexed under their SPLIT note-half (`extractWikiLinks`), so a
  // `[[Sprint #4]]` inbound row is stored as `Sprint`.
  const indexedTitle = splitWikiTarget(oldTitle).note || oldTitle
  const sourceIds = getInboundLinkSourceIds(db, noteId, indexedTitle)
  if (sourceIds.length === 0) return

  // "Split resolution would have won": a note OTHER than the renamed one
  // currently claiming this title. See `rewriteWikiLinksForRename`.
  const otherNoteWithTitleExists = (title: string): boolean => {
    const match = resolveNoteByTitle(db, title)
    return match !== undefined && match.id !== noteId
  }

  for (const sourceId of sourceIds) {
    try {
      await rewriteSource(db, sourceId, input, otherNoteWithTitleExists)
    } catch (err) {
      log.warn('Failed to rewrite inbound wiki-links in a source note', {
        sourceId,
        renamedNoteId: noteId,
        error: err
      })
    }
  }
}

async function rewriteSource(
  db: IndexDb,
  sourceId: string,
  input: InboundLinkRewriteInput,
  otherNoteWithTitleExists: (title: string) => boolean
): Promise<void> {
  const { noteId, oldTitle, newTitle } = input

  const cached = getNoteCacheById(db, sourceId)
  if (!cached) return
  if (cached.fileType && isBinaryFileType(cached.fileType)) return

  // The renamed note linking to itself: its cache row lags the rename (the
  // projector is async), so its file lives at the caller-supplied new path.
  const sourcePath = sourceId === noteId ? input.newPath : cached.path
  const absolutePath = toAbsolutePath(sourcePath)
  const original = await safeRead(absolutePath)
  if (!original) return

  const rewritten = rewriteWikiLinksForRename(
    original,
    oldTitle,
    newTitle,
    otherNoteWithTitleExists
  )
  if (rewritten === null) return

  // Same guard the sync note handler and `moveNote` use before touching a file
  // the watcher is also watching: this write is already being reconciled here.
  markWritebackIgnored(absolutePath)
  await atomicWrite(absolutePath, rewritten)

  const now = new Date().toISOString()
  const parsed = parseNote(rewritten, sourcePath)
  const syncResult = syncNoteToCache(
    db,
    {
      id: sourceId,
      path: sourcePath,
      fileContent: rewritten,
      frontmatter: parsed.frontmatter,
      parsedContent: parsed.content,
      title: sourceId === noteId ? newTitle : cached.title,
      createdAt: toIso(cached.createdAt),
      modifiedAt: now,
      localOnly: cached.localOnly ?? false,
      emoji: cached.emoji ?? null
    },
    { isNew: false }
  )

  const event: NoteUpdatedEvent = {
    id: sourceId,
    changes: {
      content: parsed.content,
      modified: new Date(now),
      wordCount: syncResult.wordCount
    },
    source: 'external'
  }
  emitNoteEvent(NotesChannels.events.UPDATED, event)

  await feedExternalEditToCrdt(sourceId, parsed.content)

  if (isJournalEntry(sourcePath)) {
    const journalDate = extractDateFromPath(sourcePath) ?? ''
    emitNoteEvent(JournalChannels.events.ENTRY_UPDATED, {
      date: journalDate,
      entry: {
        date: journalDate,
        content: parsed.content,
        tags: syncResult.tags,
        wordCount: syncResult.wordCount,
        characterCount: syncResult.characterCount,
        modified: new Date(now),
        created: new Date(toIso(cached.createdAt))
      },
      source: 'external'
    })
  }
}
