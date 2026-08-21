/**
 * What happens when a map node is activated.
 *
 * One dispatch for every surface: the tree projection calls it with the node it
 * was clicked on, the drawing calls it with the node its deep link resolves to,
 * and the outline panel calls the same underlying action directly. One control
 * never gets two behaviours because there is only ever one place that decides.
 *
 * Pure: no DOM, no React. The host supplies the actions; this file only routes.
 * Adding a node kind makes the switch non-exhaustive, so a new kind cannot be
 * drawn without someone deciding what activating it does.
 */

import { parseMemryHref } from '@/lib/memry-links'
import type { MindMapPositionedNode } from './mind-map-types'

/**
 * Everything a node can ask the note page to do. It has one member today
 * because every kind the map draws is a place in THIS note; opening another
 * note (a wiki-link node) and opening a task join it with their own kinds.
 */
export interface MindMapNodeActions {
  /**
   * Close the map and land at this block in the note. `null` is the top of the
   * note — the root node stands for the title, which is not a block.
   */
  navigateToBlock: (blockId: string | null) => void
}

/** Called with the node the user activated, however they reached it. */
export type MindMapNodeActivation = (node: MindMapPositionedNode) => void

export function activateMindMapNode(
  node: MindMapPositionedNode,
  actions: MindMapNodeActions
): void {
  switch (node.kind) {
    case 'root':
    case 'heading':
    case 'bullet':
    case 'numbered':
    case 'check':
    case 'task':
    case 'toggle':
    case 'callout':
      // Every kind the map draws is a place in this note, so they all land the
      // same way: the granularity the user sees is the granularity they get
      // back. The root's `blockId` is null, which already reads as "the top of
      // the note" — one branch, not two, because a node's block IS what it
      // navigates to. A task will open its task instead once it carries a task
      // id (#1672); until it does, its block is the honest answer and doing
      // nothing is not.
      actions.navigateToBlock(node.blockId)
      return
    default: {
      // Compile-time only. A kind added to the map without a case here fails to
      // assign, so a new node kind cannot ship silently doing nothing.
      const unhandled: never = node.kind
      void unhandled
    }
  }
}

/**
 * The node a drawn box's deep link stands for.
 *
 * The drawing is a bitmap: a click reaches us as the link on the element it
 * landed on, and nothing else. The link is read with the vault's own parser
 * rather than by string surgery, so the one grammar keeps working — an anchor
 * form this build cannot place resolves to no node instead of the wrong one.
 *
 * Null for a link that is not a place in THIS note. A link to another note is
 * not this map's business, and answering it with this map's root would send the
 * user somewhere they did not click.
 */
export function nodeFromMindMapLink(
  href: string,
  nodes: readonly MindMapPositionedNode[],
  noteId: string
): MindMapPositionedNode | null {
  const parsed = parseMemryHref(href)
  if (!parsed || parsed.kind !== 'note' || parsed.id !== noteId) return null

  const anchor = parsed.anchor
  if (!anchor) return nodes.find((node) => node.kind === 'root') ?? null
  if (anchor.type !== 'block') return null
  return nodes.find((node) => node.blockId === anchor.id) ?? null
}
