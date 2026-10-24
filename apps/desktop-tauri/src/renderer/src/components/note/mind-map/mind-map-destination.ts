/**
 * Naming where a node's link goes, instead of printing the link.
 *
 * Both surfaces used to hand the user a raw href —
 * `memry://note/skfe4c9o0z15#^mm-d5f2a543-…-link-1` — because that is all
 * either of them had to show. For a wiki-link box the anchor is a synthetic
 * node id minted by the projection (#1672 anchors wiki boxes on their own id,
 * since resolving a wiki target to a note id is a database lookup the pure
 * pipeline cannot do), so it is a machine identifier that will never mean
 * anything to a person — and wiki boxes are exactly the ones worth hovering.
 *
 * What is shown instead is the DESTINATION, said as a short chain:
 * `… → Q3 Risks → Hire a designer`.
 *
 * "Destination" is the whole point, and it is not the same as "where the node
 * sits in the picture":
 *
 * - a heading, list, toggle, callout or task node names the path down to it;
 * - a **wiki-link** node names the note it points AT. Naming the note the map
 *   is of would be zero information — the reader is already in it;
 * - a **fold marker** names the node whose children are folded, because that is
 *   where the rows it stands for actually live (and, in a saved canvas, where
 *   its heading anchor lands);
 * - the **root** is just the note's name.
 *
 * Pure, and with no translator of its own: the one piece of chrome in the
 * string — the separator between segments — is passed in, exactly as
 * `formatContentCount` and `formatMore` are passed into the pipeline. Node
 * labels, note titles and heading text are user content and are never
 * translated.
 */

import { isBlockReference, splitWikiTarget } from '@memry/shared/wiki-target'
import { truncateLabel } from '@/pages/canvas/canvas-link-label'
import type { MindMapPositionedNode } from './mind-map-types'

/**
 * How many segments of the path survive.
 *
 * The question a hover answers is "where will I land", and the nearest ancestor
 * plus the target answer it. A full six-level path overflows the line, and in a
 * saved canvas it overflows the link bubble, which is a single row of text.
 */
const CHAIN_SEGMENTS = 2

/** Stands in for the ancestors that did not fit. */
const ELLIPSIS = '…'

/** Used when the caller has no translator to hand — tests, mostly. */
const DEFAULT_SEPARATOR = '→'

export interface MindMapDestinationOptions {
  /**
   * Between segments. Translated chrome: an RTL locale supplies an arrow that
   * points the way that locale reads.
   */
  separator?: string
}

/**
 * The text one node contributes.
 *
 * A heading contributes its `headingText`, never its `label`. `label` is a
 * display string that `clipLabel` shortens past 72 characters, so a long
 * heading would arrive here already ending in an ellipsis and be clipped a
 * second time; `headingText` is kept whole for exactly this reason. Everything
 * else has only its label — which for a numbered item still carries its `3. `,
 * and should: the number is part of what the user wrote.
 */
function segmentOf(node: MindMapPositionedNode): string {
  const text = node.kind === 'heading' && node.headingText ? node.headingText : node.label
  return text.trim()
}

/**
 * The path from the root down to this node, nearest-last.
 *
 * `parentId` lives on the positioned node rather than the logical one, which is
 * why this takes the map both surfaces already build. Blank segments are
 * dropped rather than drawn as gaps — a blank heading mints no box and never
 * joins the level stack, so its descendants legitimately have one fewer step.
 *
 * The `seen` set is a cycle guard, not a real case: the layout emits a tree.
 * It costs one Set and turns a hypothetical hang into a short chain.
 */
function ancestry(
  node: MindMapPositionedNode,
  byId: ReadonlyMap<string, MindMapPositionedNode>
): string[] {
  const segments: string[] = []
  const seen = new Set<string>()

  let current: MindMapPositionedNode | undefined = node
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const segment = segmentOf(current)
    if (segment !== '') segments.unshift(segment)
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return segments
}

/**
 * What a wiki link names, read the way the rest of the app reads it.
 *
 * `[[Roadmap#Q3]]` is a note and a place inside it, so it says both. A block
 * reference (`[[Roadmap#^b3]]`) says only the note: `^b3` is the same kind of
 * machine identifier this whole change exists to stop showing.
 */
function wikiSegments(target: string): string[] {
  const { note, heading } = splitWikiTarget(target)
  const segments = [note]
  if (heading && !isBlockReference(heading)) segments.push(heading)

  const named = segments.map((segment) => segment.trim()).filter((segment) => segment !== '')
  // `[[#Heading]]` addresses this note, so the note half is empty and the
  // heading is all there is to say. A target that is nothing but `#` leaves
  // nothing at all, and the raw target is then the only honest answer.
  return named.length > 0 ? named : [target.trim()]
}

function destinationSegments(
  node: MindMapPositionedNode,
  byId: ReadonlyMap<string, MindMapPositionedNode>
): string[] {
  if (node.kind === 'wikiLink' && node.wikiTarget !== null && node.wikiTarget.trim() !== '') {
    return wikiSegments(node.wikiTarget)
  }

  if (node.kind === 'more') {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId)
    return parent ? ancestry(parent, byId) : []
  }

  return ancestry(node, byId)
}

/**
 * The destination of one node, as a line of text.
 *
 * Clipped with the link bubble's own `truncateLabel`, because the saved canvas
 * renders this string in that bubble and the bubble applies no budget of its
 * own to a `memry://` label. Sharing the function rather than the number is
 * what keeps the two from drifting apart.
 *
 * The empty string when there is nothing to say, which the callers read as
 * "write no label" rather than as an empty one.
 */
export function mindMapDestination(
  node: MindMapPositionedNode,
  byId: ReadonlyMap<string, MindMapPositionedNode>,
  { separator }: MindMapDestinationOptions = {}
): string {
  const joiner = separator?.trim() || DEFAULT_SEPARATOR
  const segments = destinationSegments(node, byId)
  if (segments.length === 0) return ''

  const kept = segments.slice(-CHAIN_SEGMENTS)
  const parts = segments.length > kept.length ? [ELLIPSIS, ...kept] : kept
  return truncateLabel(parts.join(` ${joiner} `))
}

/** Every node's destination, keyed by node id. */
export function mindMapDestinations(
  nodes: readonly MindMapPositionedNode[],
  options: MindMapDestinationOptions = {}
): Map<string, string> {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return new Map(nodes.map((node) => [node.id, mindMapDestination(node, byId, options)]))
}
