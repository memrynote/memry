/**
 * Replace a note fragment's body with another one while the blocks both
 * share at the start and at the end keep their Yjs items (#5319).
 *
 * A full replace deletes every block, so an edit another device made to the
 * old body integrates into deleted blocks and never shows: an outside edit
 * fed at open would erase the peer edit the next pull brings. Keeping the
 * unchanged blocks keeps every concurrent edit inside them. Only the blocks
 * between the shared start and end are replaced, where both sides changed
 * the same stretch of text.
 *
 * @module sync/fragment-reconcile
 */

import * as Y from 'yjs'

/** A block's content, without the block ids a fresh parse assigns anew. */
function blockKey(block: Y.XmlElement | Y.XmlText): string {
  return block.toString().replace(/ id="[^"]*"/g, '')
}

/** The one block group a BlockNote fragment holds, or null for another shape. */
function blockGroupOf(fragment: Y.XmlFragment): Y.XmlElement | null {
  const root = fragment.length === 1 ? fragment.get(0) : null
  return root instanceof Y.XmlElement ? root : null
}

/**
 * Makes `live` hold `next`'s body. Call inside a transaction on `live`'s doc;
 * `next` belongs to another doc and is left unchanged.
 */
export function replaceKeepingUnchangedBlocks(live: Y.XmlFragment, next: Y.XmlFragment): void {
  const liveGroup = blockGroupOf(live)
  const nextGroup = blockGroupOf(next)
  if (!liveGroup || !nextGroup || liveGroup.nodeName !== nextGroup.nodeName) {
    live.delete(0, live.length)
    live.insert(
      0,
      next.toArray().map((node) => node.clone())
    )
    return
  }

  const liveKeys = liveGroup.toArray().map(blockKey)
  const nextBlocks = nextGroup.toArray()
  const nextKeys = nextBlocks.map(blockKey)
  let start = 0
  while (
    start < liveKeys.length &&
    start < nextKeys.length &&
    liveKeys[start] === nextKeys[start]
  ) {
    start++
  }
  let end = 0
  while (
    end < liveKeys.length - start &&
    end < nextKeys.length - start &&
    liveKeys[liveKeys.length - 1 - end] === nextKeys[nextKeys.length - 1 - end]
  ) {
    end++
  }

  liveGroup.delete(start, liveKeys.length - start - end)
  const inserted = nextBlocks.slice(start, nextBlocks.length - end).map((block) => block.clone())
  if (inserted.length > 0) liveGroup.insert(start, inserted)
}
