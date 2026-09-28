/**
 * Pure layout for accepted cluster suggestions: where each card moves and
 * where each group's frame goes.
 *
 * Excalidraw-runtime-free for the same reason canvas-draw-plan.ts is — the
 * barrel does not load under jsdom, and a layout is worth testing.
 *
 * Placement rule: the groups are laid out as a grid of frames starting at the
 * top-left of the cards being grouped. If anything else is on the board, the
 * grid starts to the right of it instead, so a frame never lands on top of a
 * drawing the user did not ask to rearrange.
 *
 * @module pages/canvas/canvas-cluster-layout
 */

import type { CanvasDrawElement, CanvasElementEdit } from '@memry/contracts/canvas-draw'

import { FRAME_PADDING } from './canvas-draw-plan'
import type { SceneEditElement } from './canvas-scene-edit'

/** Space between cards inside a frame. */
export const CLUSTER_CARD_GAP = 24
/** Space between frames; leaves room for the frame's name above it. */
export const CLUSTER_FRAME_GAP = 96
/** Frames per row before the grid wraps. */
export const CLUSTER_FRAMES_PER_ROW = 3

export interface ClusterLayoutGroup {
  name: string
  /** Scene ids of the card elements to put in this group's frame. */
  elementIds: readonly string[]
}

export interface ClusterLayout {
  /** Card moves, as element edits. */
  moves: CanvasElementEdit[]
  /** One frame spec per non-empty group, children already assigned. */
  frames: CanvasDrawElement[]
}

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function boundsOf(elements: readonly SceneEditElement[]): Box | null {
  if (elements.length === 0) return null
  return {
    minX: Math.min(...elements.map((el) => el.x)),
    minY: Math.min(...elements.map((el) => el.y)),
    maxX: Math.max(...elements.map((el) => el.x + el.width)),
    maxY: Math.max(...elements.map((el) => el.y + el.height))
  }
}

export function planClusterLayout(
  scene: readonly SceneEditElement[],
  groups: readonly ClusterLayoutGroup[]
): ClusterLayout {
  const live = scene.filter((el) => !el.isDeleted)
  const byId = new Map(live.map((el) => [el.id, el]))

  const resolved = groups
    .map((group) => ({
      name: group.name,
      cards: [...new Set(group.elementIds)]
        .map((id) => byId.get(id))
        .filter((el): el is SceneEditElement => el !== undefined)
    }))
    .filter((group) => group.cards.length > 0)
  if (resolved.length === 0) return { moves: [], frames: [] }

  const moving = new Set(resolved.flatMap((group) => group.cards.map((card) => card.id)))
  const cardsBox = boundsOf(resolved.flatMap((group) => group.cards)) as Box
  // Everything that stays put: not a moving card and not a caption riding on one.
  const staying = live.filter(
    (el) =>
      !moving.has(el.id) && !(typeof el.containerId === 'string' && moving.has(el.containerId))
  )
  const stayingBox = boundsOf(staying)
  const originX = stayingBox ? stayingBox.maxX + CLUSTER_FRAME_GAP : cardsBox.minX
  const originY = cardsBox.minY

  const moves: CanvasElementEdit[] = []
  const frames: CanvasDrawElement[] = []

  let cursorX = originX
  let cursorY = originY
  let rowHeight = 0

  resolved.forEach((group, index) => {
    if (index > 0 && index % CLUSTER_FRAMES_PER_ROW === 0) {
      cursorX = originX
      cursorY += rowHeight + CLUSTER_FRAME_GAP
      rowHeight = 0
    }

    const count = group.cards.length
    const cols = Math.ceil(Math.sqrt(count))
    const rows = Math.ceil(count / cols)
    const cellWidth = Math.max(...group.cards.map((card) => card.width))
    const cellHeight = Math.max(...group.cards.map((card) => card.height))

    const width = cols * cellWidth + (cols - 1) * CLUSTER_CARD_GAP + 2 * FRAME_PADDING
    const height = rows * cellHeight + (rows - 1) * CLUSTER_CARD_GAP + 2 * FRAME_PADDING

    group.cards.forEach((card, position) => {
      const col = position % cols
      const row = Math.floor(position / cols)
      moves.push({
        elementId: card.id,
        x: cursorX + FRAME_PADDING + col * (cellWidth + CLUSTER_CARD_GAP),
        y: cursorY + FRAME_PADDING + row * (cellHeight + CLUSTER_CARD_GAP)
      })
    })

    frames.push({
      type: 'frame',
      x: cursorX,
      y: cursorY,
      width,
      height,
      name: group.name,
      children: group.cards.map((card) => card.id)
    })

    cursorX += width + CLUSTER_FRAME_GAP
    rowHeight = Math.max(rowHeight, height)
  })

  return { moves, frames }
}
