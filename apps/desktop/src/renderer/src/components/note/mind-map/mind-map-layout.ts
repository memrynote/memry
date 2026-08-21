/**
 * Private step 2 — a logical tree becomes positioned nodes.
 *
 * A horizontal tidy tree with variable node heights, root on the leading side.
 * Every number below is integer arithmetic over the label text and the tree
 * shape alone: no measurement, no randomness, no clock. That is what makes the
 * same note lay out identically on every open, which is the whole point — a map
 * that jumps between toggles costs the user the spatial memory it was meant to
 * give them.
 */

import type {
  MindMapBounds,
  MindMapDirection,
  MindMapNode,
  MindMapPositionedNode
} from './mind-map-types'

/** Box metrics. Kept generous so the drawing library never has to grow a box. */
export const MIND_MAP_FONT_SIZE = 16
export const CHAR_WIDTH = 9
export const PADDING_X = 16
const PADDING_Y = 10
export const LINE_HEIGHT = 22
const MIN_WIDTH = 96
const MAX_WIDTH = 264
const MIN_HEIGHT = 42
/** Horizontal room between one depth column and the next. */
const COLUMN_GAP = 72
/** Vertical room between two boxes that share a column. */
const SIBLING_GAP = 16

export const MAX_CHARS_PER_LINE = Math.floor((MAX_WIDTH - PADDING_X * 2) / CHAR_WIDTH)

/** How many wrapped lines a run of text needs inside a box. */
export function lineCount(text: string): number {
  return text === '' ? 0 : Math.ceil(text.length / MAX_CHARS_PER_LINE)
}

/**
 * A node's text as the box has to hold it: the label, then its badge line when
 * there is one. Both are one text run to the drawing library, so both are
 * measured the same way — a box the library has to grow is the one failure
 * worth avoiding here.
 */
function boxWidth(node: MindMapNode): number {
  const chars = Math.max(node.label.length, node.detail.length)
  const ideal = PADDING_X * 2 + chars * CHAR_WIDTH
  if (ideal < MIN_WIDTH) return MIN_WIDTH
  if (ideal > MAX_WIDTH) return MAX_WIDTH
  return ideal
}

function boxHeight(node: MindMapNode): number {
  const lines = Math.max(1, lineCount(node.label)) + lineCount(node.detail)
  return Math.max(MIN_HEIGHT, lines * LINE_HEIGHT + PADDING_Y * 2)
}

interface Measured {
  node: MindMapNode
  parentId: string | null
  width: number
  height: number
  children: Measured[]
}

function measure(node: MindMapNode, parentId: string | null): Measured {
  return {
    node,
    parentId,
    width: boxWidth(node),
    height: boxHeight(node),
    children: node.children.map((child) => measure(child, node.id))
  }
}

/** Widest box in each depth column, so columns never overlap. */
function columnWidths(root: Measured): number[] {
  const widths: number[] = []
  const walk = (measured: Measured): void => {
    const depth = measured.node.depth
    widths[depth] = Math.max(widths[depth] ?? 0, measured.width)
    for (const child of measured.children) walk(child)
  }
  walk(root)
  return widths
}

/** Leading edge of each depth column, measured from the root's leading edge. */
function columnOffsets(widths: number[]): number[] {
  const offsets: number[] = []
  let cursor = 0
  for (let depth = 0; depth < widths.length; depth += 1) {
    offsets[depth] = cursor
    cursor += widths[depth] + COLUMN_GAP
  }
  return offsets
}

/**
 * Places every node and returns them in depth-first order — the same order the
 * accessible tree projection walks, so one list serves both surfaces.
 */
export function layoutMindMap(
  tree: MindMapNode,
  direction: MindMapDirection
): { nodes: MindMapPositionedNode[]; bounds: MindMapBounds } {
  const measured = measure(tree, null)
  const offsets = columnOffsets(columnWidths(measured))
  const tops = new Map<string, number>()

  // Post-order: a leaf takes the next free slot in its column; a parent centres
  // itself on the span between its first and last child.
  let cursor = 0
  const place = (item: Measured): void => {
    if (item.children.length === 0) {
      tops.set(item.node.id, cursor)
      cursor += item.height + SIBLING_GAP
      return
    }
    for (const child of item.children) place(child)
    const first = item.children[0]
    const last = item.children[item.children.length - 1]
    const firstCentre = (tops.get(first.node.id) ?? 0) + first.height / 2
    const lastCentre = (tops.get(last.node.id) ?? 0) + last.height / 2
    tops.set(item.node.id, Math.round((firstCentre + lastCentre) / 2 - item.height / 2))
  }
  place(measured)

  const nodes: MindMapPositionedNode[] = []
  const emit = (item: Measured): void => {
    const offset = offsets[item.node.depth] ?? 0
    nodes.push({
      id: item.node.id,
      blockId: item.node.blockId,
      label: item.node.label,
      kind: item.node.kind,
      level: item.node.level,
      depth: item.node.depth,
      isDone: item.node.isDone,
      taskId: item.node.taskId,
      wikiTarget: item.node.wikiTarget,
      tags: item.node.tags,
      contents: item.node.contents,
      detail: item.node.detail,
      parentId: item.parentId,
      // RTL mirrors the whole map about the root's leading edge, so the tree
      // grows with the reading direction instead of against it.
      x: direction === 'rtl' ? -(offset + item.width) : offset,
      y: tops.get(item.node.id) ?? 0,
      width: item.width,
      height: item.height
    })
    for (const child of item.children) emit(child)
  }
  emit(measured)

  const bounds = nodes.reduce<MindMapBounds>(
    (acc, node) => ({
      minX: Math.min(acc.minX, node.x),
      minY: Math.min(acc.minY, node.y),
      maxX: Math.max(acc.maxX, node.x + node.width),
      maxY: Math.max(acc.maxY, node.y + node.height)
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY
    }
  )

  return { nodes, bounds }
}
