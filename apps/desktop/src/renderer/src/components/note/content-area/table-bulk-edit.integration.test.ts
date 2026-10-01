import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import type { EditorView } from '@tiptap/pm/view'
import { CellSelection, cellAround } from '@tiptap/pm/tables'
import { getLiveProseMirrorView } from './live-prosemirror-view'
import { parseMarkdownPreservingBlanks, serializeBlocksPreservingBlanks } from './markdown-utils'
import { buildTableContent } from './slash-menu-utils'
import {
  deleteTableLines,
  insertTableLines,
  tableLineCount,
  tableLineRange
} from './table-bulk-edit'
import type { Block } from './types'

// #2568: rows and columns added or deleted several at a time. Run against a
// real mounted BlockNote editor because the edits are prosemirror-tables'
// own, and the result has to come back out of BlockNote as a table block and
// through markdown as the same table.

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
            { cells: ['A3', 'B3', 'C3'] },
            { cells: ['A4', 'B4', 'C4'] }
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

function liveView(editor: BlockNoteEditor): EditorView {
  const view = getLiveProseMirrorView(editor)
  if (!view) throw new Error('the editor has no view')
  return view
}

/** A position inside the cell whose text is `text`. */
function cellPos(editor: BlockNoteEditor, text: string): number {
  let found: number | null = null
  liveView(editor).state.doc.descendants((node, pos) => {
    if (found === null && node.isText && node.text === text) found = pos
  })
  if (found === null) throw new Error(`no cell reads "${text}"`)
  return found
}

function selectCells(editor: BlockNoteEditor, from: string, to: string): void {
  const view = liveView(editor)
  const { doc } = view.state
  const $anchor = cellAround(doc.resolve(cellPos(editor, from)))
  const $head = cellAround(doc.resolve(cellPos(editor, to)))
  if (!$anchor || !$head) throw new Error('not a cell')
  view.dispatch(view.state.tr.setSelection(new CellSelection($anchor, $head)))
}

/** The table's cells as plain strings, row by row. */
function tableCells(blocks: Block[]): string[][] {
  const table = blocks.find((block) => block.type === 'table')
  if (!table) throw new Error('the document lost its table')
  const content = table.content as unknown as {
    rows: { cells: { content?: { type: string; text?: string }[] }[] }[]
  }
  return content.rows.map((row) =>
    row.cells.map((cell) => (cell.content ?? []).map((inline) => inline.text ?? '').join(''))
  )
}

async function roundTrip(editor: BlockNoteEditor): Promise<string[][]> {
  const markdown = await serializeBlocksPreservingBlanks(editor, editor.document as Block[])
  return tableCells(await parseMarkdownPreservingBlanks(editor, markdown))
}

function run(
  editor: BlockNoteEditor,
  build: (view: EditorView) => ReturnType<typeof insertTableLines>
) {
  const view = liveView(editor)
  const tr = build(view)
  if (!tr) throw new Error('the edit was refused')
  view.dispatch(tr)
}

describe('tableLineRange', () => {
  it('is the target cell alone without a cell selection', () => {
    const editor = mountEditor()
    const range = tableLineRange(liveView(editor).state, cellPos(editor, 'B2'), 'row')

    expect(range && tableLineCount(range, 'row')).toBe(1)
  })

  it('is every selected row when the selection covers the target', () => {
    const editor = mountEditor()
    selectCells(editor, 'A2', 'A4')
    const range = tableLineRange(liveView(editor).state, cellPos(editor, 'B3'), 'row')

    expect(range && tableLineCount(range, 'row')).toBe(3)
  })

  it('ignores a selection that does not cover the target', () => {
    const editor = mountEditor()
    selectCells(editor, 'A2', 'A3')
    const range = tableLineRange(liveView(editor).state, cellPos(editor, 'A4'), 'row')

    expect(range && tableLineCount(range, 'row')).toBe(1)
  })
})

describe('insertTableLines', () => {
  it('adds as many rows below as are selected, in one transaction', async () => {
    const editor = mountEditor()
    selectCells(editor, 'A2', 'C3')

    run(editor, (view) => insertTableLines(view.state, cellPos(editor, 'A2'), 'row', 'after'))

    const expected = [
      ['A1', 'B1', 'C1'],
      ['A2', 'B2', 'C2'],
      ['A3', 'B3', 'C3'],
      ['', '', ''],
      ['', '', ''],
      ['A4', 'B4', 'C4']
    ]
    expect(tableCells(editor.document as Block[])).toEqual(expected)
    // The header row stays the header, so markdown gives back the same table.
    expect(await roundTrip(editor)).toEqual(expected)
  })

  it('adds as many columns before as are selected', async () => {
    const editor = mountEditor()
    selectCells(editor, 'B1', 'C2')

    run(editor, (view) => insertTableLines(view.state, cellPos(editor, 'B1'), 'column', 'before'))

    const expected = [
      ['A1', '', '', 'B1', 'C1'],
      ['A2', '', '', 'B2', 'C2'],
      ['A3', '', '', 'B3', 'C3'],
      ['A4', '', '', 'B4', 'C4']
    ]
    expect(tableCells(editor.document as Block[])).toEqual(expected)
    expect(await roundTrip(editor)).toEqual(expected)
  })

  it('adds one row for a single cell, like the stock item', () => {
    const editor = mountEditor()

    run(editor, (view) => insertTableLines(view.state, cellPos(editor, 'A4'), 'row', 'after'))

    expect(tableCells(editor.document as Block[])).toHaveLength(5)
  })
})

describe('deleteTableLines', () => {
  it('deletes every selected row at once', async () => {
    const editor = mountEditor()
    selectCells(editor, 'B2', 'B3')

    run(editor, (view) => deleteTableLines(view.state, cellPos(editor, 'B2'), 'row'))

    const expected = [
      ['A1', 'B1', 'C1'],
      ['A4', 'B4', 'C4']
    ]
    expect(tableCells(editor.document as Block[])).toEqual(expected)
    expect(await roundTrip(editor)).toEqual(expected)
  })

  it('deletes every selected column at once', async () => {
    const editor = mountEditor()
    selectCells(editor, 'A1', 'B1')

    run(editor, (view) => deleteTableLines(view.state, cellPos(editor, 'A1'), 'column'))

    const expected = [['C1'], ['C2'], ['C3'], ['C4']]
    expect(tableCells(editor.document as Block[])).toEqual(expected)
    expect(await roundTrip(editor)).toEqual(expected)
  })

  it('refuses to delete every row of the table', () => {
    const editor = mountEditor()
    selectCells(editor, 'A1', 'A4')

    expect(deleteTableLines(liveView(editor).state, cellPos(editor, 'A1'), 'row')).toBeNull()
  })
})

describe('a table inserted from the size picker', () => {
  it('round-trips through markdown at the picked size', async () => {
    const editor = mountEditor()
    const content = buildTableContent({ rows: 5, columns: 4 })
    // Headed, because BlockNote's markdown parser drops an all-empty header
    // row on the way in, whatever inserted the table.
    content.rows[0].cells = ['H1', 'H2', 'H3', 'H4']
    editor.replaceBlocks(editor.document, [{ type: 'table', content }])

    const cells = await roundTrip(editor)

    expect(cells).toHaveLength(5)
    expect(cells.every((row) => row.length === 4)).toBe(true)
  })
})
