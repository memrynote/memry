import { getNoteMetadataById } from '@memry/storage-data'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { getCrdtProvider } from './crdt-provider'
import { sendPendingContentDelete } from './local-mutations'
import {
  coverPendingContentDeletes,
  isSupersededByLiveRow,
  listUncoveredContentDeletes,
  type PendingDelete
} from './pending-deletes'

const log = createLogger('LocalDocDelete')

/**
 * Runs `step` with the note's doc loaded, puts the doc's body vector into the
 * note's pending delete (`coverPendingContentDeletes`), and purges the doc.
 * Returns the note's pending deletes. A cover that fails leaves the delete
 * without a vector, as before #5681: the delete itself must not fail.
 */
async function coverThenPurge(
  db: DrizzleDb,
  noteId: string,
  step: () => void
): Promise<PendingDelete[]> {
  const provider = getCrdtProvider()
  let pending: PendingDelete[] = []
  await provider.withDocLoaded(noteId, () => {
    step()
    try {
      pending = coverPendingContentDeletes(db, noteId, provider.getStateVector(noteId))
    } catch (error) {
      log.warn('Could not put the body vector into a pending note delete', { noteId, error })
    }
  })
  try {
    await provider.purge(noteId)
  } catch (error) {
    log.error('CRDT purge failed for a deleted note', { noteId, error })
    trackMainError('notes', 'crdt_purge_for_deleted_note', error)
  }
  return pending
}

/**
 * A note or journal day deleted on this device. `raiseTombstone` runs with the
 * doc loaded and reads the vector clock out of the cache the caller drops
 * after. The pending delete it records then takes the doc's body vector
 * (chapter 05 §5.8, #3037), so a replay after the doc is gone carries it too.
 *
 * Then the doc is purged. A kept doc stayed in the provider's open map, where
 * the inactive-doc sweep pulled it and each pull's write-back re-created the
 * note in the default folder (#2175). The purge also drops the note's queued
 * body rows. And the server purges the body on the delete
 * (chapter 07 §7.15), so an id written again must start a new body: a journal
 * day's id is its date, and a doc kept across the delete made the re-created
 * day push updates on the purged generation, which every fresh device held
 * pending and showed empty (#5353). Awaited, so a create that follows opens
 * a new doc instead of the one still closing.
 *
 * With no row, the CLI deleted the note and queued its delete (#5661), and
 * this is the watcher's unlink: there is no clock to raise a tombstone from,
 * so the CLI's delete, with the vector, is sent now instead of at the next
 * sync runtime start.
 */
export async function deleteDocLocally(noteId: string, raiseTombstone: () => void): Promise<void> {
  const db = getDatabase()
  const rowGone = getNoteMetadataById(db, noteId) === undefined
  const pending = await coverThenPurge(db, noteId, raiseTombstone)
  if (rowGone) pending.forEach(sendPendingContentDelete)
}

/**
 * Gives every pending note or journal delete with no body vector the vector of
 * the doc this device still holds, then purges the doc: the CLI's delete made
 * while desktop was closed (#5661). Runs at a sync runtime start, before the
 * first pull: a pull drops body updates for an id with no row
 * (`landNoteBody`), so the doc holds exactly what this device had when the
 * note was deleted. `flushPendingLocalDeletes` sends the deletes after.
 */
export async function coverQueuedContentDeletes(db: DrizzleDb): Promise<void> {
  for (const item of listUncoveredContentDeletes(db)) {
    // A live row retires the delete in the flush; its doc is the note's.
    if (isSupersededByLiveRow(db, item.type, item.itemId)) continue
    await coverThenPurge(db, item.itemId, () => {})
  }
}
