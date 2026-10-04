/**
 * The note-body outbox's full-state read: merge the server's state into the
 * note's doc, then read the whole doc for the push.
 *
 * A note that owes its file body (#2646) holds its doc from before the merge
 * to after the read (`CrdtProvider.holdDoc`). With no store, a doc closed in
 * between drops the merged server body, and the file would never meet it. A
 * doc closed anyway, as by an editor closing its tab, fails the read, and the
 * outbox keeps the row for its next flush.
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

  const release = provider.holdDoc(noteId)
  try {
    const doc = await provider.open(noteId, undefined, { skipSeed: true })
    await merge()
    if (!(await provider.takeFileAfterMerge(noteId, doc))) {
      throw new Error('Full-state doc was closed during the merge')
    }
    return await provider.readSyncableState(noteId)
  } finally {
    await release()
  }
}
