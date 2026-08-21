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
 * Everything a node can ask the note page to do.
 *
 * Three members rather than one widened one: a node kind that opens something
 * else is not a block navigation with a different argument, and collapsing
 * them would let a caller wire the wrong destination without the compiler
 * noticing.
 */
export interface MindMapNodeActions {
  /**
   * Close the map and land at this block in the note. `null` is the top of the
   * note — the root node stands for the title, which is not a block.
   */
  navigateToBlock: (blockId: string | null) => void
  /**
   * Open the note (or file) a `[[wiki link]]` names, given the target exactly
   * as it was written.
   *
   * A target, not an id, because that is what the note page's own wiki-link
   * handler takes: the map is deliberately routed through it so a link opens
   * the way it does everywhere else, honouring the open-in-new-tab preference
   * the user already set. A surface that opens notes differently from every
   * other surface becomes a bug report months later.
   */
  openNote: (wikiTarget: string) => void
  /** Open a task, through the note page's own task-opening path. */
  openTask: (taskId: string) => void
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
    case 'toggle':
    case 'callout':
      // Every kind here is a place in this note, so they all land the same way:
      // the granularity the user sees is the granularity they get back. The
      // root's `blockId` is null, which already reads as "the top of the note"
      // — one branch, not two, because a node's block IS what it navigates to.
      actions.navigateToBlock(node.blockId)
      return
    case 'task':
      // A task node opens its task (#1667). #1671 shipped it landing on its
      // block instead, naming this ticket as the one that changes it: that
      // wording was about sharing one activation mechanism, not about the
      // destination. A task block written before task ids existed still has
      // none, and for that one its block is the honest answer.
      if (node.taskId) actions.openTask(node.taskId)
      else actions.navigateToBlock(node.blockId)
      return
    case 'wikiLink':
      // Not a place in this note at all, so it never touches the map's
      // scrolling path. An empty target mints no node, so the guard is only
      // ever a guard.
      if (node.wikiTarget) actions.openNote(node.wikiTarget)
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
 * A box that stands for a block resolves through its block; one that has no
 * block of its own — a wiki link — resolves through its node id, which is what
 * its href was minted with. Blocks are tried first, so an id that could somehow
 * be both still means what it has always meant.
 *
 * Null for a link that is not a place in THIS map. A link naming another note
 * is not one of these boxes: a wiki-link box points at its own node here, and
 * WHERE that node goes is `wikiTarget` on it, read by `activateMindMapNode`.
 * Answering an unknown link with this map's root would send the user somewhere
 * they did not click.
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
  return (
    nodes.find((node) => node.blockId === anchor.id) ??
    nodes.find((node) => node.id === anchor.id) ??
    null
  )
}
