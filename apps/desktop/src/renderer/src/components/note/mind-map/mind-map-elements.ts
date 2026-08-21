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
 * and restrained on purpose — the map is a reading surface, not a chart. Three
 * treatments, not one per node kind: the title, the structure, and what is
 * already done.
 */
const ROOT_STROKE = '#ff671a'
const ROOT_FILL = '#fff1e8'
const NODE_STROKE = '#868e96'
const NODE_FILL = '#ffffff'
const LABEL_COLOR = '#1e1e1e'
const EDGE_STROKE = '#adb5bd'
/** Ticked items stay on the map and step back from it. */
const DONE_STROKE = '#ced4da'
const DONE_FILL = '#f8f9fa'
const DONE_LABEL = '#adb5bd'
/** Adaptive corner radius. */
const ROUNDNESS = { type: 3 }

/**
 * The deep link a box carries, or `undefined` when there is no note to point
 * at. The root has no block of its own — it is the note's title — so its link
 * carries no anchor, which reads as "this note, from the top".
 */
function nodeLink(node: MindMapPositionedNode, noteId: string | undefined): string | undefined {
  if (!noteId) return undefined
  return (
    buildMemryHref({
      kind: 'note',
      id: noteId,
      anchor: node.blockId ? { type: 'block', id: node.blockId } : null
    }) ?? undefined
  )
}

/** What the box actually holds: the label, then its badge line when there is one. */
function boxText(node: MindMapPositionedNode): string {
  return node.detail === '' ? node.label : `${node.label}\n${node.detail}`
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
  noteId?: string
): MindMapElement[] {
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

    elements.push({
      type: 'line',
      id: `${node.id}-edge`,
      x: startX,
      y: startY,
      points: [
        [0, 0],
        [endX - startX, endY - startY]
      ],
      strokeColor: EDGE_STROKE,
      strokeWidth: 1,
      roughness: 0
    })
  }

  for (const node of nodes) {
    const isRoot = node.kind === 'root'
    elements.push({
      type: 'rectangle',
      id: node.id,
      link: nodeLink(node, noteId),
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      strokeColor: isRoot ? ROOT_STROKE : node.isDone ? DONE_STROKE : NODE_STROKE,
      backgroundColor: isRoot ? ROOT_FILL : node.isDone ? DONE_FILL : NODE_FILL,
      fillStyle: 'solid',
      strokeWidth: 1,
      roughness: 0,
      roundness: ROUNDNESS,
      label: {
        text: boxText(node),
        fontSize: MIND_MAP_FONT_SIZE,
        textAlign: direction === 'rtl' ? 'right' : 'left',
        verticalAlign: 'middle',
        strokeColor: node.isDone ? DONE_LABEL : LABEL_COLOR
      }
    })
  }

  // Last, so a rule is never painted under the box it belongs to.
  for (const node of nodes) {
    if (node.isDone) elements.push(...strikeRules(node, direction))
  }

  return elements
}
