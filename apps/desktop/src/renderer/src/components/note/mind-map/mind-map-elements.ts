/**
 * Private step 3 — positioned nodes become drawing elements.
 *
 * Plain data only: the drawing library turns these into a scene, and the same
 * descriptors are what a saved canvas will be minted from later. One code path
 * for both is the reason the map is drawn with the canvas renderer at all — two
 * renderers would make "save as canvas" a WYSIWYG lie.
 */

import { buildMemryHref } from '@/lib/memry-links'
import {
  CHAR_WIDTH,
  LINE_HEIGHT,
  MIND_MAP_FONT_SIZE,
  PADDING_X,
  lineCount
} from './mind-map-layout'
import type { MindMapDirection, MindMapElement, MindMapPositionedNode } from './mind-map-types'

/**
 * Authored for the light theme; the drawing library derives the dark one. Calm
 * and restrained on purpose — the map is a reading surface, not a chart. Four
 * treatments, not one per node kind: the title, the structure, what is already
 * done, and what is not this note at all.
 *
 * A wiki link is drawn in a different colour AND with a dashed outline, so "a
 * piece of this note" and "another document" stay distinguishable without
 * colour vision.
 */
const ROOT_STROKE = '#ff671a'
const ROOT_FILL = '#fff1e8'
const NODE_STROKE = '#868e96'
const NODE_FILL = '#ffffff'
const LABEL_COLOR = '#1e1e1e'
const EDGE_STROKE = '#adb5bd'
/** A link out of the note. Blue is what a link has always been. */
const LINK_STROKE = '#4c6ef5'
const LINK_FILL = '#edf2ff'
const LINK_LABEL = '#364fc7'
/** Ticked items stay on the map and step back from it. */
const DONE_STROKE = '#ced4da'
const DONE_FILL = '#f8f9fa'
const DONE_LABEL = '#adb5bd'
/**
 * A fold marker reads as a control rather than as content: the accent outline
 * is the same one the root carries, on the ordinary white fill, so it is
 * recognisably ours and unmistakably not a piece of the note.
 *
 * Deliberately NOT dashed. A dashed outline is #1672's "this is another
 * document" signal, and a fold marker is the opposite — it stands for content
 * of THIS note that is folded away. Two meanings on one outline would make
 * neither readable.
 */
const MORE_STROKE = '#ff671a'
/** Adaptive corner radius. */
const ROUNDNESS = { type: 3 }

/**
 * Which anchor a box's deep link carries.
 *
 * - `block` — the drawn map, handed straight back into the session that minted
 *   it. Exact, and worthless anywhere else: a block id lives exactly as long as
 *   the document that minted it.
 * - `heading` — a map written to a file. Heading TEXT is all a link can carry
 *   that outlives the document, and it is the house convention already
 *   (`[[Note#Heading]]`). A node with no heading above it anchors on nothing,
 *   which reads as "this note, from the top".
 */
export type MindMapLinkAnchor = 'block' | 'heading'

export interface MintElementsOptions {
  /** Given, every box carries a deep link back into this note. */
  noteId?: string
  /** Defaults to `block` — the drawn map's anchor. */
  anchor?: MindMapLinkAnchor
  /**
   * An extra badge on the root box, ahead of whatever it already carries. The
   * saved snapshot puts its generation date here so a canvas found months later
   * says what it is; the drawn map passes nothing and reads as it always has.
   *
   * Ahead of, never instead of: the root's own detail may say how much folded
   * into it, and replacing that line would drop the one thing telling the
   * reader the map is not the whole note.
   */
  rootDetail?: string
  /**
   * Node id → the href that node's box should carry instead of an anchor into
   * this note. Only read in `heading` mode, and only ever supplied for
   * wiki-link nodes: their target is a title, and resolving a title to a note
   * id is a database lookup this pure pipeline cannot do. The save path does
   * the lookup and hands the answers in.
   */
  wikiHrefs?: ReadonlyMap<string, string>
  /**
   * Node id → the name to carry on that node's href as a `?label=` hint.
   *
   * Only read in `heading` mode, because only a file needs it. The drawn map
   * renders its own affordance from the node it hit, so an on-screen href never
   * has to describe itself — and leaving the hint off keeps those hrefs exactly
   * the strings they have always been.
   *
   * A saved canvas has no such affordance: the drawing library prints
   * `element.link` verbatim in its bubble, and the only hook into that text is
   * the label the href carries (`canvas-link-label.ts` reads it, `CanvasEditor`
   * swaps it in). Composed by the caller, because the name is a destination
   * chain whose separator is translated chrome and this module has no
   * translator.
   */
  labels?: ReadonlyMap<string, string>
}

/**
 * The deep link a box carries, or `undefined` when there is no note to point
 * at.
 *
 * Every box needs a link of its OWN, because the link is the only handle a
 * click on a bitmap has: two boxes sharing one would send a click to whichever
 * came first.
 *
 * WHERE the box carries it differs by mode, and that is not cosmetic. In a file
 * it goes in `element.link`, which is what makes the box clickable in an
 * ordinary canvas at all. On the drawn map it goes in `customData` instead:
 * `element.link` also paints a permanent blue glyph, one per linked element,
 * and on a map where EVERY box is linked that marks nothing and buries the one
 * thing the picture is for — its shape. The map renders its own hover
 * affordance from this href instead (see `mind-map-hover.ts`).
 *
 * **On screen (`block`)** the link is an address within this session:
 *
 * - a box standing for a block anchors on that block;
 * - the root has no block — it is the note's title — so it carries no anchor,
 *   which reads as "this note, from the top";
 * - every OTHER blockless box anchors on its own node id. Today that is a
 *   wiki link, whose id is minted from the block that held it, and a "+N more"
 *   fold marker, whose id is minted from the parent it folds. One rule rather
 *   than one per kind: the root is the only box that may share the unanchored
 *   href, and everything else is told apart by its own id.
 *
 * Where a wiki-link box actually goes is `wikiTarget` on the node, not this
 * href: a wiki target is a title, and turning one into a note id is a database
 * lookup this pure pipeline cannot do. What a fold marker does is expand, which
 * is not a destination at all. Both are decided in `activateMindMapNode`; this
 * href only has to say WHICH box was clicked.
 *
 * **In a file (`heading`)** none of that survives. A node id means nothing to
 * the device that opens the canvas, and there is no `activateMindMapNode` on
 * the other side to interpret it — so every box anchors on the heading it sits
 * under, and a box with no heading above it anchors on nothing and opens the
 * note at the top. A wiki-link box is the one exception: it points OUT of this
 * note, so the caller resolves its target and hands the href in through
 * `wikiHrefs`, and a target that resolves to nothing falls back to the same
 * heading anchor as everything else — which is at least where the link is
 * written.
 */
function nodeLink(
  node: MindMapPositionedNode,
  { noteId, anchor, wikiHrefs, labels }: MintElementsOptions & { anchor: MindMapLinkAnchor }
): string | undefined {
  // Resolved by the caller, because a wiki target is a title and turning one
  // into an id is a database lookup this pipeline must not grow. Its label is
  // the caller's too, for the same reason.
  if (anchor === 'heading') {
    const resolved = wikiHrefs?.get(node.id)
    if (resolved) return resolved
  }

  if (!noteId) return undefined

  if (anchor === 'heading') {
    return (
      buildMemryHref({
        kind: 'note',
        id: noteId,
        // Additive, and additive is the whole compatibility story: `label` sits
        // in the query, which the parser has always read, and a build that has
        // never heard of it drops it and opens the same note at the same
        // heading. It cannot disturb the anchor, which lives in the fragment.
        label: labels?.get(node.id) ?? null,
        anchor: node.headingText ? { type: 'heading', text: node.headingText } : null
      }) ?? undefined
    )
  }

  const anchorId = node.blockId ?? (node.kind === 'root' ? null : node.id)
  return (
    buildMemryHref({
      kind: 'note',
      id: noteId,
      anchor: anchorId ? { type: 'block', id: anchorId } : null
    }) ?? undefined
  )
}

/** What the box actually holds: the label, then its badge line when there is one. */
function boxText(node: MindMapPositionedNode, detail: string): string {
  return detail === '' ? node.label : `${node.label}\n${detail}`
}

/** How many wrapped lines a run of text takes inside a box of this width. */
function linesIn(text: string, width: number): number {
  if (text === '') return 0
  const perLine = Math.max(1, Math.floor((width - PADDING_X * 2) / CHAR_WIDTH))
  return Math.ceil(text.length / perLine)
}

/**
 * The rules that strike a completed item's label out.
 *
 * The surface is a bitmap with no text decorations, so this is drawn: one rule
 * per wrapped line of the label, over the text and not over the badges. The
 * geometry mirrors the box's own — the label block is centred vertically, and
 * the text hangs off whichever side the reading direction starts on.
 */
function strikeRules(node: MindMapPositionedNode, direction: MindMapDirection): MindMapElement[] {
  const labelLines = Math.max(1, lineCount(node.label))
  const totalLines = labelLines + lineCount(node.detail)
  const textTop = node.y + Math.round((node.height - totalLines * LINE_HEIGHT) / 2)
  const perLine = Math.ceil(node.label.length / labelLines)

  return Array.from({ length: labelLines }, (_, line) => {
    const chars = Math.min(perLine, node.label.length - line * perLine)
    const length = Math.max(CHAR_WIDTH, chars * CHAR_WIDTH)
    const startX =
      direction === 'rtl' ? node.x + node.width - PADDING_X - length : node.x + PADDING_X
    return {
      type: 'line' as const,
      id: `${node.id}-strike-${line + 1}`,
      x: startX,
      y: textTop + line * LINE_HEIGHT + Math.round(LINE_HEIGHT / 2),
      points: [
        [0, 0],
        [length, 0]
      ] as Array<[number, number]>,
      strokeColor: DONE_LABEL,
      strokeWidth: 1,
      roughness: 0
    }
  })
}

export function mintElements(
  nodes: readonly MindMapPositionedNode[],
  direction: MindMapDirection,
  options: MintElementsOptions = {}
): MindMapElement[] {
  const { noteId, anchor = 'block', rootDetail, wikiHrefs, labels } = options
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const elements: MindMapElement[] = []

  // Connectors first so the boxes sit on top of them.
  for (const node of nodes) {
    if (node.parentId === null) continue
    const parent = byId.get(node.parentId)
    if (!parent) continue

    // The connector leaves the parent's trailing edge and lands on the child's
    // leading edge — which side that is follows the reading direction.
    const startX = direction === 'rtl' ? parent.x : parent.x + parent.width
    const startY = parent.y + Math.round(parent.height / 2)
    const endX = direction === 'rtl' ? node.x + node.width : node.x
    const endY = node.y + Math.round(node.height / 2)

    // A bound arrow, not a line between two frozen points. The coordinates
    // above are only where it STARTS life; the binding is what keeps it
    // attached to both boxes once someone drags one, which is the whole
    // difference between a picture and a canvas the user can work in.
    elements.push({
      type: 'arrow',
      id: `${node.id}-edge`,
      x: startX,
      y: startY,
      points: [
        [0, 0],
        [endX - startX, endY - startY]
      ],
      start: { id: parent.id },
      end: { id: node.id },
      startArrowhead: null,
      endArrowhead: null,
      roundness: null,
      strokeColor: EDGE_STROKE,
      strokeWidth: 1,
      roughness: 0
    })
  }

  for (const node of nodes) {
    const isRoot = node.kind === 'root'
    const isLink = node.kind === 'wikiLink'
    const isMore = node.kind === 'more'
    const detail =
      isRoot && rootDetail
        ? [rootDetail, node.detail].filter((part) => part !== '').join(' · ')
        : node.detail
    const href = nodeLink(node, { noteId, anchor, wikiHrefs, labels })
    // One href, two homes. See `nodeLink` for why the drawn map keeps its out
    // of `link`: that field is what paints the glyph, and a map is nothing but
    // linked boxes.
    const address =
      href === undefined
        ? {}
        : anchor === 'heading'
          ? { link: href }
          : { customData: { memryHref: href } }
    elements.push({
      type: 'rectangle',
      id: node.id,
      ...address,
      x: node.x,
      y: node.y,
      width: node.width,
      // A dated root needs lines the layout did not budget for. Grown here
      // rather than in the layout, and downwards only: the drawn map's geometry
      // stays byte-identical to what it has always been, and the root is alone
      // in its column so nothing sits under it to collide with.
      height:
        node.height +
        (linesIn(detail, node.width) - linesIn(node.detail, node.width)) * LINE_HEIGHT,
      strokeColor: isRoot
        ? ROOT_STROKE
        : isLink
          ? LINK_STROKE
          : isMore
            ? MORE_STROKE
            : node.isDone
              ? DONE_STROKE
              : NODE_STROKE,
      backgroundColor: isRoot
        ? ROOT_FILL
        : isLink
          ? LINK_FILL
          : node.isDone
            ? DONE_FILL
            : NODE_FILL,
      fillStyle: 'solid',
      strokeWidth: 1,
      roughness: 0,
      roundness: ROUNDNESS,
      ...(isLink && { strokeStyle: 'dashed' as const }),
      label: {
        text: boxText(node, detail),
        fontSize: MIND_MAP_FONT_SIZE,
        textAlign: direction === 'rtl' ? 'right' : 'left',
        verticalAlign: 'middle',
        strokeColor: isLink ? LINK_LABEL : node.isDone ? DONE_LABEL : LABEL_COLOR
      }
    })
  }

  // Last, so a rule is never painted under the box it belongs to.
  for (const node of nodes) {
    if (node.isDone) elements.push(...strikeRules(node, direction))
  }

  return elements
}
