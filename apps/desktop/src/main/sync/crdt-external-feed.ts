/**
 * Feed a main-originated markdown edit into a note's CRDT body — including a
 * note whose doc is NOT currently open.
 *
 * `replaceNoteBodyInCrdt` alone is only half the job for a closed note: the
 * Y.Doc persisted when the note was last closed still carries the OLD body,
 * `seedFromMarkdown` seeds an EMPTY fragment only, and nothing re-reads the
 * file afterwards — reopening the note would show the body from before the
 * edit while the vault file on disk holds the new one, and that stale body is
 * what syncs to every other device. So when no editor holds the note, the
 * persisted doc is opened (`skipSeed`, because an empty fragment means the
 * note has no CRDT body at all and its next open will seed from the file —
 * minting a doc for it now would push a body nothing asked for), fed, and
 * closed again.
 *
 * Used by the vault watcher for out-of-app edits and by the rename-time
 * wiki-link rewrite (`vault/rename-link-rewrite.ts`); both are main-originated
 * edits to a file the renderer may or may not have open. Lives apart from
 * `crdt-feed.ts` so `replaceNoteBodyInCrdt` stays a cross-module call the
 * watcher tests can observe.
 *
 * @module sync/crdt-external-feed
 */

import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { getCrdtProvider } from './crdt-provider'
import { replaceNoteBodyInCrdt } from './crdt-feed'
import { wasRecentNetworkUpdate } from './crdt-writeback'
import { broadcastToAllWindows } from '../lib/window-broadcast'

// Full fragment replace: lossy re Yjs history, but these edits round-trip
// through markdown, which destroys that history anyway.
export async function feedExternalEditToCrdt(
  noteId: string,
  markdownContent: string
): Promise<void> {
  const provider = getCrdtProvider()

  const feed = async (): Promise<void> => {
    if (wasRecentNetworkUpdate(noteId)) {
      broadcastToAllWindows('sync:concurrent-edit', { noteId })
    }

    await replaceNoteBodyInCrdt(noteId, markdownContent)
  }

  if (provider.getDoc(noteId)) {
    await feed()
    return
  }

  const doc = await provider.open(noteId, undefined, { skipSeed: true })
  try {
    if (doc.getXmlFragment(CRDT_FRAGMENT_NAME).length === 0) return

    await feed()
  } finally {
    // Only if it is still editor-less: the renderer may have opened the note
    // while the replace was in flight, and that doc belongs to the editor now.
    await provider.closeIfInactive(noteId)
  }
}
