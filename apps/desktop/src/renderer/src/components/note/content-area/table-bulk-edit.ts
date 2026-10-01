import type { Node as PMNode } from '@tiptap/pm/model'
import { EditorState, type Transaction } from '@tiptap/pm/state'
import {
  CellSelection,
  TableMap,
  addColumn,
  addRow,
  cellAround,
  removeColumn,
  removeRow,
  type TableRect
} from '@tiptap/pm/tables'

export type TableAxis = 'row' | 'column'
export type TableInsertSide = 'before' | 'after'

/**
 * The rows or columns a table action addresses, from one target cell.
 *
 * When the selection is a cell selection in the same table that covers the
 * target along the axis, the action is for every row (or column) it spans: a
 * user who selects three rows and opens the menu means those three. Otherwise
 * it is for the target cell's own row or column, which is what the single-line
 * actions always did.
 */
export function tableLineRange(
  state: EditorState,
  cellPos: number,
  axis: TableAxis
): TableRect | null {
  const $cell = cellAround(state.doc.resolve(cellPos))
  if (!$cell) return null
  const table = $cell.node(-1)
  const tableStart = $cell.start(-1)
  const map = TableMap.get(table)
  const target = map.findCell($cell.pos - tableStart)

  const { selection } = state
  if (selection instanceof CellSelection && selection.$anchorCell.start(-1) === tableStart) {
    const selected = map.rectBetween(
      selection.$anchorCell.pos - tableStart,
      selection.$headCell.pos - tableStart
    )
    const covers =
      axis === 'row'
        ? selected.top <= target.top && target.bottom <= selected.bottom
        : selected.left <= target.left && target.right <= selected.right
    if (covers) return { ...selected, map, table, tableStart }
  }
  return { ...target, map, table, tableStart }
}

/** How many rows or columns `range` spans along `axis`. */
export function tableLineCount(range: TableRect, axis: TableAxis): number {
  return axis === 'row' ? range.bottom - range.top : range.right - range.left
}

function freshRect(tr: Transaction, range: TableRect): TableRect {
  // Every edit here lands inside the table, so its start never moves.
  const table = tr.doc.nodeAt(range.tableStart - 1) as PMNode
  return { ...range, table, map: TableMap.get(table) }
}

/**
 * Insert as many rows (or columns) as the range spans, all on one side of it,
 * in one transaction so a single undo takes them all back.
 */
export function insertTableLines(
  state: EditorState,
  cellPos: number,
  axis: TableAxis,
  side: TableInsertSide
): Transaction | null {
  const range = tableLineRange(state, cellPos, axis)
  if (!range) return null

  const at =
    axis === 'row'
      ? side === 'before'
        ? range.top
        : range.bottom
      : side === 'before'
        ? range.left
        : range.right
  const tr = state.tr
  for (let i = 0; i < tableLineCount(range, axis); i++) {
    // Each line is built on a scratch transaction over the doc so far, then
    // its steps are copied over. `addColumn` maps the positions it reads off
    // the table through every step already on the transaction it is given, so
    // handing it `tr` with the previous column's steps on it would map a fresh
    // table's positions a second time and scatter the new cells.
    const step = EditorState.create({ doc: tr.doc }).tr
    const rect = freshRect(step, range)
    if (axis === 'row') addRow(step, rect, at)
    else addColumn(step, rect, at)
    for (const each of step.steps) tr.step(each)
  }
  return tr
}

/**
 * Delete every row (or column) the range spans, in one transaction.
 *
 * Null when that would be every row or every column: a table with no rows is
 * not a table, and deleting the table is a different, block-level action.
 */
export function deleteTableLines(
  state: EditorState,
  cellPos: number,
  axis: TableAxis
): Transaction | null {
  const range = tableLineRange(state, cellPos, axis)
  if (!range) return null

  const total = axis === 'row' ? range.map.height : range.map.width
  if (tableLineCount(range, axis) >= total) return null

  const tr = state.tr
  // Last to first, so the indices still to remove are not shifted by the ones
  // already gone.
  const first = axis === 'row' ? range.top : range.left
  const last = (axis === 'row' ? range.bottom : range.right) - 1
  for (let line = last; line >= first; line--) {
    const rect = freshRect(tr, range)
    if (axis === 'row') removeRow(tr, rect, line)
    else removeColumn(tr, rect, line)
  }
  return tr
}
