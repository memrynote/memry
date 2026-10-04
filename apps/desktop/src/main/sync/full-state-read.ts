/**
 * The note-body outbox's full-state read: merge the server's state into the
 * note's doc, then read the whole doc for the push.
 *
 * A note that owes its file body (#2646) keeps its doc open from before the
 * merge to after the read. With no store, the merge closes a doc it opened
 * itself, so the file would be fed into a fresh empty doc and never meet the
 * server body.
 *
 * @module sync/full-state-read
 */

import type { CrdtProvider } from './crdt-provider'
import { owesFileBody } from './crdt-owed-file-body'

export async function readMergedFullState(
  provider: CrdtProvider,
  noteId: string,
  mergeRemote: (noteId: string) => Promise<boolean>,
  aborted: () => boolean
): Promise<Uint8Array | null> {
  const merge = async (): Promise<void> => {
    if (!(await mergeRemote(noteId))) throw new Error('Server CRDT state did not merge')
    if (aborted()) throw new Error('Sync runtime stopped')
  }

  if (!owesFileBody(noteId)) {
    await merge()
    return provider.readSyncableState(noteId)
  }

  const wasOpen = provider.getDoc(noteId) !== undefined
  const doc = await provider.open(noteId, undefined, { skipSeed: true })
  try {
    await merge()
    await provider.takeFileAfterMerge(noteId, doc, true)
    return await provider.readSyncableState(noteId)
  } finally {
    if (!wasOpen) await provider.closeIfInactive(noteId)
  }
}
