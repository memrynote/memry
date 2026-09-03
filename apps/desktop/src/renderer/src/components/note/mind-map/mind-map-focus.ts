/**
 * Finding the drawn box that stands for a block.
 *
 * The outline panel and the map are keyed by the same thing without ever having
 * agreed to be: an outline entry's `id` IS the BlockNote block id, and that is
 * exactly what a node carries in `blockId`. So a heading click can name a box on
 * the map with no new identifier and no lookup table to keep in sync.
 *
 * The answer is an HREF rather than an element or an index, because the drawing
 * library regenerates every element id on the way in — the same reason the map's
 * deep link travels in `customData` (see `MindMapBoxElement.customData`). The
 * href is the one handle that survives the conversion, and it is already what
 * the canvas' hit test hands back and what `hoverLabels` is keyed by.
 *
 * Null is a real answer, not a failure: a heading folded away behind a "+N more"
 * marker, or dropped at the node cap, has no box to move the camera to. The
 * caller reads that as "this one cannot be shown on the map" and falls back to
 * opening the note at it.
 *
 * Pure: no DOM, no React, no library.
 */

import { mindMapHrefOf } from './mind-map-hover'
import type { MindMap } from './mind-map-types'

/**
 * The deep link of the box drawn for this block, or null when the block has no
 * box on this map.
 *
 * Matched through the node rather than by scanning hrefs, because a box's href
 * is minted from its node and reading it back out by string surgery would be a
 * second grammar to keep in step with `nodeLink`.
 */
export function mindMapHrefForBlock(map: MindMap, blockId: string): string | null {
  const node = map.nodes.find((candidate) => candidate.blockId === blockId)
  if (!node) return null

  // Elements carry the NODE id, which is stable within one build. (The library
  // replaces it on import; nothing here reads the live scene.)
  const element = map.elements.find((candidate) => candidate.id === node.id)
  if (!element || element.type !== 'rectangle') return null

  return mindMapHrefOf(element)
}
