/**
 * Pure helpers for adding many items to a canvas at once (#2484): every item
 * from a tag, a folder or one of their saved views, and multi-row drags from a
 * folder or tag view.
 *
 * React- and Excalidraw-free (types only), mirroring canvas-cards.ts, so the
 * mapping, dedup and layout unit-test without either library.
 */

import type { CanvasEntityRef } from '@memry/contracts/canvas-api'
import type { FilterExpression, NoteWithProperties } from '@memry/contracts/folder-view-api'
import { evaluateFilter } from '@/lib/filter-evaluator'
import {
  CANVAS_ITEM_DRAG_MIME,
  CARD_PLACEMENT_GAP,
  canvasDragPayloadMany,
  entityKey,
  findFreeCardCenter,
  type CanvasCardRef,
  type SceneRect
} from './canvas-cards'

/**
 * Above this many new cards the picker asks before placing. Every card is a
 * mounted preview once it is in view and a few hundred bytes of the synced
 * scene, so a tag with 400 notes is a decision, not a click.
 */
export const BULK_ADD_CONFIRM_THRESHOLD = 50

/** A folder or tag view row, as far as carding it goes. */
export type ViewRowLike = Pick<NoteWithProperties, 'id' | 'kind' | 'fileType'>

/**
 * The card a folder or tag view row becomes, or null for a row kind a canvas
 * cannot hold (inbox items). A non-markdown file row is a file card: it opens
 * in the file viewer, never the markdown editor (#800).
 */
export function refFromViewRow(row: ViewRowLike): CanvasEntityRef | null {
  const kind = row.kind ?? 'note'
  if (kind === 'task') return { entityType: 'task', entityId: row.id }
  if (kind !== 'note') return null
  const fileType = row.fileType ?? 'markdown'
  return { entityType: fileType === 'markdown' ? 'note' : 'file', entityId: row.id }
}

/**
 * Card refs for view rows, in row order, each entity once. With a saved view's
 * `filter`, only the rows that view shows. A filter that fails to evaluate
 * keeps every row, which is what the view itself falls back to (see
 * useFolderView).
 */
export function refsFromViewRows(
  rows: readonly NoteWithProperties[],
  filter?: FilterExpression
): CanvasEntityRef[] {
  let matching = rows
  if (filter) {
    try {
      matching = rows.filter((row) => evaluateFilter(row, filter))
    } catch {
      matching = rows
    }
  }
  const seen = new Set<string>()
  const refs: CanvasEntityRef[] = []
  for (const row of matching) {
    const ref = refFromViewRow(row)
    if (!ref) continue
    const key = entityKey(ref.entityType, ref.entityId)
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}

/**
 * The refs a drag out of a folder or tag view carries: every selected row when
 * the dragged row is part of the selection, otherwise just the dragged row.
 * That is the rule the task list and drag-context already use for multi-drag,
 * so a row dragged from outside the selection never drags the selection along.
 */
export function dragRefsForRow(
  rows: readonly ViewRowLike[],
  draggedId: string,
  selectedIds: ReadonlySet<string>
): CanvasEntityRef[] {
  const dragged = selectedIds.has(draggedId)
    ? rows.filter((row) => selectedIds.has(row.id))
    : rows.filter((row) => row.id === draggedId)
  return dragged.map(refFromViewRow).filter((ref): ref is CanvasEntityRef => ref !== null)
}

/** The slice of a DOM/React drag event `startCanvasRowsDrag` touches. */
interface RowDragEventLike {
  target: EventTarget | null
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>
  preventDefault: () => void
}

/**
 * Starts a view-row drag the canvas can drop (see CanvasCardLayer's HTML5
 * drop handler). A drag that begins inside an editable cell is left alone, so
 * dragging selected text in an input still moves text. A row with nothing a
 * canvas can hold (an inbox item) does not start a drag at all.
 *
 * 'copy' only: nothing else accepts a view row, and the canvas drop asks for
 * 'copy' — Chromium refuses a drop that `effectAllowed` does not permit.
 */
export function startCanvasRowsDrag(event: RowDragEventLike, refs: CanvasEntityRef[]): void {
  const target = event.target as { closest?: (selector: string) => unknown } | null
  if (target?.closest?.('input, textarea, [contenteditable="true"]')) {
    return
  }
  if (refs.length === 0) {
    event.preventDefault()
    return
  }
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData(CANVAS_ITEM_DRAG_MIME, canvasDragPayloadMany(refs))
}

/**
 * Splits a batch into the refs that still need a card and a count of those
 * already on the board. A canvas keeps one card per entity, so a bulk add
 * never duplicates one; the count is reported back to the user.
 */
export function splitNewRefs(
  refs: readonly CanvasEntityRef[],
  onCanvas: ReadonlySet<string>
): { fresh: CanvasEntityRef[]; skipped: number } {
  const fresh: CanvasEntityRef[] = []
  let skipped = 0
  for (const ref of refs) {
    if (onCanvas.has(entityKey(ref.entityType, ref.entityId))) {
      skipped += 1
    } else {
      fresh.push(ref)
    }
  }
  return { fresh, skipped }
}

type Size = { width: number; height: number }
type Rect = { x: number; y: number; width: number; height: number }

function overlapsAny(block: Rect, cards: readonly Rect[]): boolean {
  return cards.some(
    (card) =>
      block.x < card.x + card.width &&
      card.x < block.x + block.width &&
      block.y < card.y + card.height &&
      card.y < block.y + block.height
  )
}

/**
 * Card centres for a batch, laid out as one row-major grid so the batch reads
 * in the order it came in (a tag view's sort) instead of scattering clockwise
 * the way single adds spiral.
 *
 * The whole grid is placed as one block through the same free-spot search a
 * single card uses, so it lands at the viewport centre when that is empty and
 * next to the existing cards when it is not. When nothing near the viewport is
 * free, the block goes below everything on the board rather than on top of it.
 */
export function planBatchPlacement(
  sizes: readonly Size[],
  occupied: readonly CanvasCardRef[],
  rect: SceneRect
): { x: number; y: number }[] {
  if (sizes.length === 0) return []
  const cellWidth = Math.max(...sizes.map((size) => size.width))
  const cellHeight = Math.max(...sizes.map((size) => size.height))
  const cols = Math.ceil(Math.sqrt(sizes.length))
  const rows = Math.ceil(sizes.length / cols)
  const block = {
    width: cols * cellWidth + (cols - 1) * CARD_PLACEMENT_GAP,
    height: rows * cellHeight + (rows - 1) * CARD_PLACEMENT_GAP
  }

  let center = findFreeCardCenter(occupied, rect, block)
  const placed = {
    x: center.x - block.width / 2,
    y: center.y - block.height / 2,
    width: block.width,
    height: block.height
  }
  if (overlapsAny(placed, occupied)) {
    const bottom = Math.max(...occupied.map((card) => card.y + card.height))
    center = { x: center.x, y: bottom + CARD_PLACEMENT_GAP * 4 + block.height / 2 }
  }

  const left = center.x - block.width / 2
  const top = center.y - block.height / 2
  return sizes.map((size, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    // Top-left aligned inside the cell, so a taller file card does not push
    // its row's notes off a common baseline.
    return {
      x: left + col * (cellWidth + CARD_PLACEMENT_GAP) + size.width / 2,
      y: top + row * (cellHeight + CARD_PLACEMENT_GAP) + size.height / 2
    }
  })
}
