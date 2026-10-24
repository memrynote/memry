/**
 * Where a dragged sidebar-tree row would land.
 *
 * The answer is derived from rectangles measured when the drag began, never
 * from which element the pointer is hovering. That distinction is the whole
 * point: a native drag reads its target from DOM hover, so anything that MOVES
 * the row under the cursor (a margin, a real reorder) moves the cursor off it,
 * fires dragleave, undoes the move, and puts the row back — the indicator
 * oscillates instead of settling. A rect-derived answer cannot feed back into
 * its own input.
 *
 * Row-to-row sliding is NOT here: dnd-kit's sorting strategy already does it,
 * and the sidebar tree uses the same one the projects list does.
 */
export type DropSide = 'before' | 'after' | 'inside'

export interface Rect {
  top: number
  height: number
}

/**
 * Where a dragged row would land relative to the row it is over.
 *
 * Computed from the dragged row's TRANSLATED rectangle against the target's
 * rectangle — both measured once when the drag began — never from which
 * element the pointer happens to be hovering. That is the whole point: a
 * transform moves a row visually and for hit-testing, so a hover-driven answer
 * changes the moment the answer is applied, and the indicator oscillates.
 *
 * `acceptsInside` is true for a row you can drop INTO (a folder). Its middle
 * half claims the drop; the outer quarters still reorder, so a folder never
 * becomes impossible to reorder past.
 */
export function dropSideFor(input: {
  draggedRect: Rect
  targetRect: Rect
  acceptsInside: boolean
}): DropSide {
  const { draggedRect, targetRect, acceptsInside } = input
  if (targetRect.height <= 0) return 'after'

  const draggedCenter = draggedRect.top + draggedRect.height / 2
  const ratio = (draggedCenter - targetRect.top) / targetRect.height

  if (acceptsInside && ratio > 0.25 && ratio < 0.75) return 'inside'
  return ratio < 0.5 ? 'before' : 'after'
}
