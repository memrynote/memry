import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { BlockNoteEditor } from '@blocknote/core'
import { BlockNoteContext, ComponentsContext, type Components } from '@blocknote/react'
import { CellSelection, cellAround } from '@tiptap/pm/tables'
import { getLiveProseMirrorView } from './live-prosemirror-view'
import { TableLineActions } from './table-line-actions'
import type { TableAxis } from './table-bulk-edit'

// The menu items behind the cell nub and the keyboard menu (#2568), against a
// real mounted BlockNote editor: the labels and the edits both come from the
// live selection, which a mocked editor cannot have.

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

function mountEditor(): BlockNoteEditor {
  const editor = BlockNoteEditor.create({
    initialContent: [
      {
        type: 'table',
        content: {
          type: 'tableContent',
          headerRows: 1,
          rows: [
            { cells: ['A1', 'B1', 'C1'] },
            { cells: ['A2', 'B2', 'C2'] },
            { cells: ['A3', 'B3', 'C3'] }
          ]
        }
      }
    ]
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return editor
}

function cellElement(editor: BlockNoteEditor, text: string): HTMLTableCellElement {
  const cell = [
    ...(editor.domElement?.querySelectorAll<HTMLTableCellElement>('td, th') ?? [])
  ].find((each) => each.textContent === text)
  if (!cell) throw new Error(`no cell reads "${text}"`)
  return cell
}

function selectCells(editor: BlockNoteEditor, from: string, to: string): void {
  const view = getLiveProseMirrorView(editor)
  if (!view) throw new Error('no view')
  const $anchor = cellAround(view.state.doc.resolve(view.posAtDOM(cellElement(editor, from), 0)))
  const $head = cellAround(view.state.doc.resolve(view.posAtDOM(cellElement(editor, to), 0)))
  if (!$anchor || !$head) throw new Error('not a cell')
  view.dispatch(view.state.tr.setSelection(new CellSelection($anchor, $head)))
}

const Item = ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
  <button type="button" onClick={onClick}>
    {children}
  </button>
)
// SAFETY: only `Generic.Menu.Item` is read by the component under test.
const components = { Generic: { Menu: { Item } } } as unknown as Components

function renderActions(editor: BlockNoteEditor, text: string, axis: TableAxis): void {
  render(
    <BlockNoteContext.Provider value={{ editor }}>
      <ComponentsContext.Provider value={components}>
        <TableLineActions cell={cellElement(editor, text)} axis={axis} />
      </ComponentsContext.Provider>
    </BlockNoteContext.Provider>
  )
}

function rowCount(editor: BlockNoteEditor): number {
  const table = editor.document[0].content as unknown as { rows: unknown[] }
  return table.rows.length
}

function columnCount(editor: BlockNoteEditor): number {
  const table = editor.document[0].content as unknown as { rows: { cells: unknown[] }[] }
  return table.rows[0].cells.length
}

describe('TableLineActions', () => {
  it("offers the stock single-row items for a cell's own row", () => {
    const editor = mountEditor()
    renderActions(editor, 'B2', 'row')

    expect(screen.getByRole('button', { name: 'Delete row' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add row below' }))

    expect(rowCount(editor)).toBe(4)
  })

  it('counts and acts on every selected row', () => {
    const editor = mountEditor()
    selectCells(editor, 'A2', 'A3')
    renderActions(editor, 'A2', 'row')

    fireEvent.click(screen.getByRole('button', { name: 'Add 2 rows above' }))

    expect(rowCount(editor)).toBe(5)
  })

  it('deletes every selected column at once', () => {
    const editor = mountEditor()
    selectCells(editor, 'A1', 'B1')
    renderActions(editor, 'A1', 'column')

    fireEvent.click(screen.getByRole('button', { name: 'Delete 2 columns' }))

    expect(columnCount(editor)).toBe(1)
  })

  it('adds columns on either side', () => {
    const editor = mountEditor()
    renderActions(editor, 'B2', 'column')

    fireEvent.click(screen.getByRole('button', { name: 'Add column left' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add column right' }))

    expect(columnCount(editor)).toBe(5)
  })

  it('does not offer to delete every row', () => {
    const editor = mountEditor()
    selectCells(editor, 'A1', 'A3')
    renderActions(editor, 'A1', 'row')

    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add 3 rows below' })).toBeInTheDocument()
  })
})
