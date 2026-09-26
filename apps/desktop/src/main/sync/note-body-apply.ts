import { getNoteMetadataById } from '@memry/storage-data'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { createLogger } from '../lib/logger'
import { getNoteCacheById } from '../database/queries/notes'
import { getIndexDatabase, isIndexDatabaseInitialized } from '../database/client'
import type { CrdtProvider } from './crdt-provider'

const log = createLogger('NoteBodyApply')

export interface NoteBodyLandingDeps {
  provider: Pick<
    CrdtProvider,
    'getDoc' | 'getStateVector' | 'open' | 'mergeRemoteUpdate' | 'closeIfInactive'
  >
  /** A note or journal row exists on this device. */
  isKnownNote(noteId: string): boolean
  /** The doc cannot take the body: the note is owed its whole server body. */
  onMissingBase(noteId: string): void
}

/**
 * Land change-feed bodies of one CRDT document (#2297). Resolves only once the
 * store holds every update it merged and rejects otherwise; the caller refuses
 * a document whose landing rejects. Resolves `true` only when the doc now holds
 * every update: nothing else may be recorded as merged (a snapshot watermark).
 *
 * Only a note or journal this device has, whose doc already holds persisted
 * state, takes a body: opened without a markdown seed, the same way the CRDT
 * pull opens a doc it merges server state into, and merged live, so an open
 * editor sees it and the write-back rewrites the vault file. Nothing else is
 * ever stored, because bytes the store holds unmerged make every later merge
 * of the same state a no-op, and the write-back that would write the vault
 * file never runs:
 *
 * - an id with no row: dropped. It may be a note deleted on an earlier page, or
 *   one whose record has not arrived yet; the page that brings the record pulls
 *   its whole body, and a deleted note must get nothing. The row is checked
 *   again after the open, since a delete can land while the open awaits the
 *   store. It is not owed a pull either: that pull's merge would write a
 *   deleted note back.
 * - a known note whose doc holds nothing: owed its whole body. A delta merged
 *   into an empty doc can integrate in part and write a partial body over the
 *   file.
 */
export async function landNoteBody(
  deps: NoteBodyLandingDeps,
  noteId: string,
  updates: Uint8Array[]
): Promise<boolean> {
  const { provider } = deps
  if (!deps.isKnownNote(noteId)) return false

  const wasOpen = provider.getDoc(noteId) != null
  await provider.open(noteId, undefined, { skipSeed: true })
  try {
    if (!deps.isKnownNote(noteId)) return false
    if ((provider.getStateVector(noteId)?.length ?? 0) <= 1) {
      deps.onMissingBase(noteId)
      return false
    }
    for (const update of updates) {
      // A doc compacting only buffers the update (#2299): not landed.
      if (!(await provider.mergeRemoteUpdate(noteId, update))) {
        deps.onMissingBase(noteId)
        return false
      }
    }
    // Pending structs mean the doc lacks what these updates build on. The
    // write-back only ever sees what integrated, so the whole body is fetched.
    const store = provider.getDoc(noteId)?.store
    if (store && (store.pendingStructs !== null || store.pendingDs !== null)) {
      log.warn('Change-feed body does not integrate into the local doc', { noteId })
      deps.onMissingBase(noteId)
      return false
    }
    return true
  } finally {
    if (!wasOpen) await provider.closeIfInactive(noteId)
  }
}

export function isKnownNote(db: DrizzleDb, noteId: string): boolean {
  if (getNoteMetadataById(db, noteId)) return true
  return isIndexDatabaseInitialized() && getNoteCacheById(getIndexDatabase(), noteId) != null
}
