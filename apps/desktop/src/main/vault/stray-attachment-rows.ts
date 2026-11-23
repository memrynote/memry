/**
 * Drop the note rows an older Windows build made of attachment files (#5607).
 *
 * Its watcher never matched the vault-root `attachments` folder, so every
 * pasted image or PDF became a binary note at `attachments/<noteId>/<file>`.
 * Those notes synced, and every device that pulled one holds a row for it.
 * Each such row is a copy of a file another note embeds, shown in the sidebar
 * as a note of its own.
 *
 * @module vault/stray-attachment-rows
 */

import path from 'path'
import { eq, like } from 'drizzle-orm'
import { NotesChannels } from '@memry/contracts/notes-api'
import { attachmentFiles } from '@memry/db-schema/schema/attachment-files'
import { noteBodySync } from '@memry/db-schema/schema/note-body-sync'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import { recordDeclinedRef } from '@memry/sync-client/declined-refs'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { deleteNotePosition } from '@main/database/queries/note-positions'
import { getDatabase, getIndexDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { flushProjectionEvents } from '../projections'
import { clearUpload } from '../sync/attachment-outbox'
import { getCrdtProvider } from '../sync/crdt-provider'
import { settleCrdtBodyDebts } from '../sync/engine/crdt-body-debts'
import { isAttachmentStoreRow } from './attachments'
import { deleteNoteFromCache } from './note-sync'
import { emitNoteEvent } from './notes-io'

const logger = createLogger('StrayAttachmentRows')

/**
 * Remove each binary note row in the attachment store from this device: its
 * index and canonical rows, its sidebar position, its queued sync items and
 * uploads, its owed bodies, its CRDT doc, and the record of the files and
 * body pushes the server holds for its id. Every reader of that record looks
 * up a note this device still syncs, and the declined id is never one again.
 *
 * Local only. The file stays, because the note that embeds it still shows it,
 * and no delete is synced: a peer on an older build unlinks a deleted note's
 * file, which is that embed. The id is declined, so the manifest check does
 * not fetch the record back, and the note handler declines the record when a
 * pull delivers it. The server keeps the record and its blob.
 *
 * Without the CRDT store the rows stay, so their docs are not left behind,
 * and the next open drops them. With no such row it changes nothing, so it
 * runs at every open.
 */
export async function forgetStrayAttachmentRows(vaultPath: string): Promise<string[]> {
  const dataDb = getDatabase()
  const indexDb = getIndexDatabase()
  // `like` folds case and either separator follows `attachments`; the
  // predicate decides.
  const candidates = new Map<string, string>()
  const rows = [
    ...dataDb
      .select({ id: noteMetadata.id, path: noteMetadata.path, fileType: noteMetadata.fileType })
      .from(noteMetadata)
      .where(like(noteMetadata.path, 'attachments%'))
      .all(),
    ...indexDb
      .select({ id: noteCache.id, path: noteCache.path, fileType: noteCache.fileType })
      .from(noteCache)
      .where(like(noteCache.path, 'attachments%'))
      .all()
  ]
  for (const row of rows) if (isAttachmentStoreRow(row)) candidates.set(row.id, row.path)
  if (candidates.size === 0) return []

  const provider = getCrdtProvider()
  await provider.awaitPendingInit()
  if (!provider.hasPersistence()) {
    logger.warn('Kept stray attachment rows: the doc store is not open', {
      count: candidates.size
    })
    return []
  }

  const queue = new SyncQueueManager(dataDb)
  const noteIds = [...candidates.keys()]
  for (const [id, relativePath] of candidates) {
    recordDeclinedRef(dataDb, { type: 'note', id })
    queue.removeByItemId(id)
    clearUpload(dataDb, id, path.join(vaultPath, relativePath))
    deleteNotePosition(dataDb, relativePath)
    dataDb.delete(attachmentFiles).where(eq(attachmentFiles.noteId, id)).run()
    dataDb.delete(noteBodySync).where(eq(noteBodySync.noteId, id)).run()
    deleteNoteFromCache(indexDb, id)
    emitNoteEvent(NotesChannels.events.DELETED, { id, path: relativePath, source: 'internal' })
  }
  settleCrdtBodyDebts(dataDb, noteIds)
  await flushProjectionEvents()
  for (const id of noteIds) await provider.purge(id)

  logger.info('Dropped note rows made of attachment files', { count: noteIds.length })
  return noteIds
}
