/**
 * The one public entry point into the mind map.
 *
 * An editor block tree plus options in; the logical tree, the positioned nodes
 * and the drawing elements out, together. Projection, layout and element
 * minting are private steps behind this call, so every rule about any of them
 * is asserted here — at whichever layer of the result suits the assertion — and
 * the internal decomposition stays free to change without a red suite.
 *
 * Pure: no DOM, no clock, no randomness. The same blocks always produce the
 * same result, coordinates included.
 */

import { layoutMindMap } from './mind-map-layout'
import { mintElements } from './mind-map-elements'
import { projectBlocks } from './mind-map-projection'
import type { MindMap, MindMapOptions, MindMapSourceBlock } from './mind-map-types'

export function buildMindMap(
  blocks: readonly MindMapSourceBlock[],
  options: MindMapOptions
): MindMap {
  const direction = options.direction ?? 'ltr'
  const { tree, reachedNodeCap } = projectBlocks(blocks, options)
  const { nodes, bounds } = layoutMindMap(tree, direction)

  return {
    tree,
    nodes,
    elements: mintElements(nodes, direction, { noteId: options.noteId }),
    direction,
    nodeCount: nodes.length,
    reachedNodeCap,
    isEmpty: tree.children.length === 0,
    bounds
  }
}
