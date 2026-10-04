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
 * An empty doc cannot take the edit, which with no store is every closed
 * note. The note then owes its file body (#2646): the marker makes the next
 * merge of the server body apply the file on top of it, and a full-state row
 * gets that merge and its push done.
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
import { writingFrontmatterOf, type WritingFrontmatter } from '@memry/shared'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getIndexDatabase } from '../database/client'
import { getCrdtProvider } from './crdt-provider'
import { replaceNoteBodyInCrdt } from './crdt-feed'
import { wasRecentNetworkUpdate } from './crdt-writeback'
import { clearOwedFileBody, owesFileBody, recordOwedFileBody } from './crdt-owed-file-body'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { toAbsolutePath } from '../vault/notes'
import { safeRead } from '../vault/file-ops'
import { parseNote } from '../vault/frontmatter'

// Full fragment replace: lossy re Yjs history, but these edits round-trip
// through markdown, which destroys that history anyway.
//
// Resolves true when the markdown is now the doc's body.
export async function feedExternalEditToCrdt(
  noteId: string,
  markdownContent: string,
  writing?: WritingFrontmatter
): Promise<boolean> {
  const provider = getCrdtProvider()

  const feed = async (): Promise<boolean> => {
    if (wasRecentNetworkUpdate(noteId)) {
      broadcastToAllWindows('sync:concurrent-edit', { noteId })
    }

    const fed = await replaceNoteBodyInCrdt(noteId, markdownContent, writing)
    if (fed) clearOwedFileBody(noteId)
    return fed
  }

  if (provider.getDoc(noteId)) {
    return feed()
  }

  const doc = await provider.open(noteId, undefined, { skipSeed: true })
  try {
    if (doc.getXmlFragment(CRDT_FRAGMENT_NAME).length === 0) {
      if (!provider.isNoteLocalOnly(noteId)) {
        recordOwedFileBody(noteId)
        provider.recordOwedFullState(noteId)
      }
      return false
    }

    return await feed()
  } finally {
    // Only if it is still editor-less: the renderer may have opened the note
    // while the replace was in flight, and that doc belongs to the editor now.
    await provider.closeIfInactive(noteId)
  }
}

/**
 * Feed the vault file into the note's doc when the note owes it. For a doc
 * that has just merged the server body, so the file lands on top of it.
 */
export async function feedOwedFileBody(noteId: string): Promise<boolean> {
  if (!owesFileBody(noteId)) return false
  const cached = getNoteCacheById(getIndexDatabase(), noteId)
  if (!cached) return false
  const raw = await safeRead(toAbsolutePath(cached.path))
  if (raw === null) return false
  const parsed = parseNote(raw, cached.path)
  return feedExternalEditToCrdt(noteId, parsed.content, writingFrontmatterOf(parsed.frontmatter))
}
