import type { FC } from 'react'
import { useBlockNoteEditor, useComponentsContext } from '@blocknote/react'
import { useT } from '@memry/i18n/renderer'

import { getLiveProseMirrorView } from './live-prosemirror-view'
import {
  deleteTableLines,
  insertTableLines,
  tableLineCount,
  tableLineRange,
  type TableAxis,
  type TableInsertSide
} from './table-bulk-edit'

/**
 * Delete and insert rows or columns, as many at once as the selection spans
 * (#2568).
 *
 * BlockNote's own `AddButton` / `DeleteButton` act on one row or column, so
 * growing a table by ten rows took ten trips through the menu. These act on
 * every row (or column) a cell selection covers when it covers `cell`, and on
 * `cell`'s own row or column otherwise, so with a single cell selected they do
 * exactly what the stock items did.
 */
export const TableLineActions: FC<{ cell: HTMLTableCellElement; axis: TableAxis }> = ({
  cell,
  axis
}) => {
  const editor = useBlockNoteEditor()
  const Components = useComponentsContext()
  const { t } = useT('notes')
  const view = getLiveProseMirrorView(editor)
  if (!Components || !view || !cell.isConnected) return null

  const cellPos = view.posAtDOM(cell, 0)
  const range = tableLineRange(view.state, cellPos, axis)
  if (!range) return null
  const count = tableLineCount(range, axis)
  const total = axis === 'row' ? range.map.height : range.map.width

  const insert = (side: TableInsertSide): void => {
    editor.exec((state, dispatch) => {
      const tr = insertTableLines(state, cellPos, axis, side)
      if (!tr) return false
      dispatch?.(tr)
      return true
    })
  }
  const remove = (): void => {
    editor.exec((state, dispatch) => {
      const tr = deleteTableLines(state, cellPos, axis)
      if (!tr) return false
      dispatch?.(tr)
      return true
    })
  }

  const { Item } = Components.Generic.Menu
  if (axis === 'row') {
    return (
      <>
        {count < total && (
          <Item onClick={remove}>{t('editor.table.lines.deleteRows', { count })}</Item>
        )}
        <Item onClick={() => insert('before')}>
          {t('editor.table.lines.addRowsAbove', { count })}
        </Item>
        <Item onClick={() => insert('after')}>
          {t('editor.table.lines.addRowsBelow', { count })}
        </Item>
      </>
    )
  }

  // `before` is the column's inline-start side, which is the right in RTL.
  const rtl = getComputedStyle(cell).direction === 'rtl'
  return (
    <>
      {count < total && (
        <Item onClick={remove}>{t('editor.table.lines.deleteColumns', { count })}</Item>
      )}
      <Item onClick={() => insert(rtl ? 'after' : 'before')}>
        {t('editor.table.lines.addColumnsLeft', { count })}
      </Item>
      <Item onClick={() => insert(rtl ? 'before' : 'after')}>
        {t('editor.table.lines.addColumnsRight', { count })}
      </Item>
    </>
  )
}
