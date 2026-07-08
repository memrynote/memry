/**
 * Shared CRDT body-replace: swap an open note's editor body for new markdown.
 * Used by the vault watcher (external file edits) and template-apply.
 *
 * @module sync/crdt-feed
 */

import { getCrdtProvider, ORIGIN_LOCAL } from './crdt-provider'
import { markdownToBlocks, blocksToYFragment } from './blocknote-converter'

/**
 * Full XML-fragment replace of a note's body inside its live Y.Doc.
 * No-op (returns false) when the doc is not open or the markdown is unparseable.
 * Lossy re: Yjs history, but round-tripping through markdown discards it anyway.
 */
export async function replaceNoteBodyInCrdt(noteId: string, markdown: string): Promise<boolean> {
  const provider = getCrdtProvider()
  const doc = provider.getDoc(noteId)
  if (!doc) return false

  const blocks = await markdownToBlocks(markdown)
  if (!blocks) return false

  const fragment = doc.getXmlFragment('prosemirror')
  doc.transact(() => {
    fragment.delete(0, fragment.length)
    blocksToYFragment(blocks, fragment)
  }, ORIGIN_LOCAL)

  return true
}
