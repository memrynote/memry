/**
 * Drop the duplicate rows a case-only folder rename left on macOS and Windows.
 *
 * Before the watcher read event paths in their disk case, renaming
 * `Supernotes` to `SuperNotes` in the app moved every note, then indexed each
 * file a second time under a fresh id at its old-case path, because chokidar
 * kept reporting the old spelling. Those copies drew the old folder in the
 * sidebar next to the renamed one, though only one folder exists on disk.
 *
 * A row that names the disk's file in another case is not always a copy:
 * two distinct notes whose paths differ only in case share one file here
 * (#5263). Only a real copy is dropped (#5297).
 *
 * @module vault/case-variant-heal
 */

import { eq } from 'drizzle-orm'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { NotesChannels } from '@memry/contracts/notes-api'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { getDatabase, getIndexDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { flushProjectionEvents } from '../projections'
import { readLocalBodyFacts } from '../sync/note-sync-state'
import { getCrdtProvider } from '../sync/crdt-provider'
import type { CrdtStoreReader } from '../sync/crdt-persistence'
import { sameBody } from '../sync/crdt-seed-duplicates'
import { stateVectorCovers } from '@memry/sync-client/delete-keep'
import { getNoteMetadataById } from '@memry/storage-data'
import { diskCaseOf } from './disk-case'
import { getNoteCacheById } from '@main/database/queries/notes'
import { deleteNoteFromCache } from './note-sync'
import { emitNoteEvent } from './notes-io'

const logger = createLogger('CaseVariantHeal')

interface NoteRow {
  id: string
  path: string
  clock: unknown
  syncedAt: string | null
  modifiedAt: string
}

/**
 * Groups of rows whose paths differ only in case, and within each group the
 * rows that name the same file as the row the disk spells, so are its copies.
 * A case-sensitive file system (Linux) keeps such paths as separate files, and
 * every row there names its own file.
 */
function caseVariantCopies<T extends { path: string }>(
  vaultPath: string,
  rows: T[]
): Array<{ copy: T; kept: T }> {
  const byFoldedPath = new Map<string, T[]>()
  for (const row of rows) {
    const key = row.path.toLowerCase()
    byFoldedPath.set(key, [...(byFoldedPath.get(key) ?? []), row])
  }

  const copies: Array<{ copy: T; kept: T }> = []
  for (const group of byFoldedPath.values()) {
    if (group.length < 2) continue
    const onDisk = diskCaseOf(vaultPath, group[0].path)
    const kept = group.find((row) => row.path === onDisk)
    if (onDisk === null || !kept) continue
    for (const row of group) {
      if (row.path !== onDisk && diskCaseOf(vaultPath, row.path) === onDisk) {
        copies.push({ copy: row, kept })
      }
    }
  }
  return copies
}

/**
 * Whether a case-variant note row is a copy of the note the disk spells, and
 * not a distinct case twin: the index read the same body for it as for the
 * kept note, as when the old watcher indexed one file twice. Whether it ever
 * synced says nothing about its body. A twin keeps its row, so the twin rule
 * (`refusesCaseTwinFile`) still sees both rows, and neither takes the other's
 * body (#5297).
 *
 * The hash only says what the file held when it was indexed. A row with a
 * change still waiting to sync can hold text or fields the kept note lacks, so
 * it stays until the change is sent, and a later open drops it. A record change
 * saved but not yet queued is the one `recoverDirtyNotes` re-pushes: a clock
 * and no sync since the last change.
 */
function isNoteCopy(
  note: NoteRow,
  keptId: string,
  dataDb: ReturnType<typeof getDatabase>,
  indexDb: ReturnType<typeof getIndexDatabase>
): boolean {
  const hash = getNoteCacheById(indexDb, note.id)?.contentHash
  if (!hash || hash !== getNoteCacheById(indexDb, keptId)?.contentHash) return false
  const unsyncedRecord =
    note.clock !== null && (note.syncedAt === null || note.modifiedAt > note.syncedAt)
  return !unsyncedRecord && !readLocalBodyFacts(dataDb, note.id).waiting
}

/** `noteId`'s doc as an open editor holds it now, else as the store saved it. */
function docOf(noteId: string, saved: Uint8Array[]): Y.Doc {
  const doc = new Y.Doc()
  const live = getCrdtProvider().getDoc(noteId)
  const updates = live ? [Y.encodeStateAsUpdate(live)] : saved
  doc.transact(() => {
    for (const update of updates) Y.applyUpdate(doc, update)
  })
  return doc
}

/**
 * Whether dropping the copy's row loses no body its doc holds: the doc is
 * empty, holds the kept note's body (a seed of the same file), or the server
 * already took every change in it (`pushedStateVector`), as with a copy
 * indexed before #5297 whose old doc differs from the kept note's forever.
 * With sync off nothing is queued or pushed, and the doc is the one place an
 * edit not yet written to the shared file lives. Synchronous, so the caller
 * drops the row on the very doc this read.
 */
function docLosesNothing(
  copyId: string,
  keptId: string,
  saved: Map<string, Uint8Array[]>,
  dataDb: ReturnType<typeof getDatabase>
): boolean {
  const copy = docOf(copyId, saved.get(copyId) ?? [])
  const kept = docOf(keptId, saved.get(keptId) ?? [])
  try {
    if (copy.getXmlFragment(CRDT_FRAGMENT_NAME).length === 0 || sameBody(copy, kept)) return true
    const pushed = readLocalBodyFacts(dataDb, copyId).pushedStateVector
    const held = Buffer.from(Y.encodeStateVector(copy)).toString('base64')
    return pushed !== null && stateVectorCovers(pushed, held)
  } finally {
    copy.destroy()
    kept.destroy()
  }
}

/**
 * Whether a case-variant folder_config row is a local copy of the row the disk
 * spells: it never entered sync (no clock), so the server holds nothing for
 * it, and its icon is null or the kept row's, so it holds nothing the kept row
 * lacks. The old watcher wrote such rows with a null icon after a case-only
 * rename (`syncFolderConfigDiscovered`). A row with a clock can be on the
 * server, and dropping it leaves this device short of the server's records,
 * which the manifest check pulls back and the next open drops again (#5327).
 * A kept twin changes nothing shown: `getFolders` reads the row the disk
 * spells.
 */
function isFolderCopy(
  folder: { clock: unknown; icon: string | null },
  kept: { icon: string | null }
): boolean {
  return folder.clock === null && (folder.icon === null || folder.icon === kept.icon)
}

/**
 * Remove each note row and each folder_config row that is a case-variant copy
 * of another.
 *
 * Local only, and no file is touched: the copy's file is the kept row's file.
 * No delete is synced either. A peer on a case-insensitive file system can
 * hold the copy and the kept note in that one file, and a synced delete
 * unlinks the copy's file there, which would take the kept note with it.
 */
export async function healCaseVariantRows(
  vaultPath: string
): Promise<{ notes: number; folders: number }> {
  const dataDb = getDatabase()

  const indexDb = getIndexDatabase()
  const caseVariants = caseVariantCopies(
    vaultPath,
    dataDb
      .select({
        id: noteMetadata.id,
        path: noteMetadata.path,
        clock: noteMetadata.clock,
        syncedAt: noteMetadata.syncedAt,
        modifiedAt: noteMetadata.modifiedAt
      })
      .from(noteMetadata)
      .all()
  )
  const isCopy = ({ copy, kept }: (typeof caseVariants)[number]): boolean =>
    isNoteCopy(copy, kept.id, dataDb, indexDb)
  const candidates = caseVariants.filter(isCopy)
  const twins = caseVariants.length - candidates.length
  if (twins > 0) logger.warn('Kept case twins that share a file with another note', { twins })

  // Without the store, a copy's saved doc is unknown, so every row stays. The
  // store opens off the vault-open path, so it is waited for only when a row
  // may go.
  let store: CrdtStoreReader | null = null
  if (candidates.length > 0) {
    const provider = getCrdtProvider()
    await provider.awaitPendingInit()
    store = provider.hasPersistence() ? provider.readOnlyStore() : null
    if (!store) {
      logger.warn('Kept case-variant note rows: the doc store is not open', {
        count: candidates.length
      })
    }
  }
  const saved = new Map<string, Uint8Array[]>()
  if (store) {
    for (const { copy, kept } of candidates) {
      for (const id of [copy.id, kept.id]) {
        if (!saved.has(id)) saved.set(id, await store.updates(id))
      }
    }
  }

  // No await from here to the drop: a change made during the reads above is
  // in the row's queue or its live doc, and both are read again here.
  const noteCopies: Array<{ id: string; path: string }> = []
  for (const variant of store ? candidates : []) {
    const { copy: note, kept } = variant
    const now = getNoteMetadataById(dataDb, note.id)
    if (
      !now ||
      !isNoteCopy(now, kept.id, dataDb, indexDb) ||
      !docLosesNothing(note.id, kept.id, saved, dataDb)
    ) {
      logger.warn('Kept a case copy whose doc holds a body the kept note lacks', { id: note.id })
      continue
    }
    noteCopies.push({ id: note.id, path: note.path })
    deleteNoteFromCache(indexDb, note.id)
    emitNoteEvent(NotesChannels.events.DELETED, {
      id: note.id,
      path: note.path,
      source: 'external'
    })
  }
  await flushProjectionEvents()

  const folderVariants = caseVariantCopies(
    vaultPath,
    dataDb
      .select({ path: folderConfigs.path, icon: folderConfigs.icon, clock: folderConfigs.clock })
      .from(folderConfigs)
      .all()
  )
  const folderCopies = folderVariants.filter(({ copy, kept }) => isFolderCopy(copy, kept))
  for (const { copy: folder } of folderCopies) {
    dataDb.delete(folderConfigs).where(eq(folderConfigs.path, folder.path)).run()
  }
  const folderTwins = folderVariants.length - folderCopies.length
  if (folderTwins > 0) logger.info('Kept case twins of folders', { count: folderTwins })

  if (noteCopies.length > 0 || folderCopies.length > 0) {
    logger.info('Dropped case-variant copies of notes and folders', {
      notes: noteCopies.length,
      folders: folderCopies.length
    })
  }
  return { notes: noteCopies.length, folders: folderCopies.length }
}
