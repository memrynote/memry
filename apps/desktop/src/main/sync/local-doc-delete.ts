import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'
import { getCrdtProvider } from './crdt-provider'

const log = createLogger('LocalDocDelete')

/**
 * A note or journal day deleted on this device. `raiseTombstone` runs with the
 * doc loaded, so the tombstone carries its body vector (chapter 05 §5.8,
 * #3037), and reads the vector clock out of the cache the caller drops after.
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
 */
export async function deleteDocLocally(noteId: string, raiseTombstone: () => void): Promise<void> {
  const provider = getCrdtProvider()
  await provider.withDocLoaded(noteId, raiseTombstone)
  try {
    await provider.purge(noteId)
  } catch (error) {
    log.error('CRDT purge failed for a deleted note', { noteId, error })
    trackMainError('notes', 'crdt_purge_for_deleted_note', error)
  }
}
