// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'

import { BlockNoteEditor } from '@blocknote/core'
import { createInlineCheckboxContent, createInlineImageContent } from '@memry/editor-schema/inline'

import { createMobileEditorSchema } from '../../editor-web/src/schema'

import {
  installEditorToolbar,
  TABLE_PICKER_GROUPS,
  type EditorToolbarActions,
  type EditorToolbarSelection
} from '../../editor-web/src/editor-toolbar'
import {
  applyTableStructureOp,
  handleCellPaste,
  hasMergedCells,
  readTableCursor,
  type TableContentLike,
  type TableEditorSurface
} from '../../editor-web/src/tables'

/**
 * Touch table editing in the guest (#2101).
 *
 * The structure operations are pure transforms over BlockNote's own
 * `tableContent`, so they can be asserted directly — which is the point of
 * writing them that way rather than through the mouse-driven
 * `TableHandlesExtension`.
 */

function cell(text: string) {
  return {
    type: 'tableCell' as const,
    content: text ? [{ type: 'text', text, styles: {} }] : [],
    props: { colspan: 1, rowspan: 1, backgroundColor: 'default' }
  }
}

function table(rows: string[][], extra: Partial<TableContentLike> = {}): TableContentLike {
  return {
    type: 'tableContent',
    headerRows: 1,
    rows: rows.map((cells) => ({ cells: cells.map(cell) })),
    ...extra
  }
}

function labels(content: TableContentLike): string[][] {
  return content.rows.map((row) =>
    row.cells.map((entry) => {
      const inline = (entry as { content: { text?: string }[] }).content
      return inline[0]?.text ?? ''
    })
  )
}

const GRID = [
  ['H1', 'H2'],
  ['a', 'b'],
  ['c', 'd']
]

describe('table structure operations', () => {
  it('inserts a row below the caret and leaves the other rows alone', () => {
    const next = applyTableStructureOp(
      table(GRID),
      { rowIndex: 1, colIndex: 0 },
      {
        kind: 'insert-row',
        side: 'below'
      }
    )
    expect(next && labels(next)).toEqual([
      ['H1', 'H2'],
      ['a', 'b'],
      ['', ''],
      ['c', 'd']
    ])
  })

  it('pushes a row inserted above the header down under it, so GFM still round-trips', () => {
    const next = applyTableStructureOp(
      table(GRID),
      { rowIndex: 0, colIndex: 0 },
      {
        kind: 'insert-row',
        side: 'above'
      }
    )
    expect(next && labels(next)).toEqual([
      ['H1', 'H2'],
      ['', ''],
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('refuses to delete the header row or the last body row', () => {
    expect(
      applyTableStructureOp(table(GRID), { rowIndex: 0, colIndex: 0 }, { kind: 'delete-row' })
    ).toBeNull()

    const twoRow = table([
      ['H1', 'H2'],
      ['a', 'b']
    ])
    expect(
      applyTableStructureOp(twoRow, { rowIndex: 1, colIndex: 0 }, { kind: 'delete-row' })
    ).toBeNull()
  })

  it('deletes a body row', () => {
    const next = applyTableStructureOp(
      table(GRID),
      { rowIndex: 1, colIndex: 1 },
      {
        kind: 'delete-row'
      }
    )
    expect(next && labels(next)).toEqual([
      ['H1', 'H2'],
      ['c', 'd']
    ])
  })

  it('inserts a column in every row and gives it no dragged width', () => {
    const next = applyTableStructureOp(
      table(GRID, { columnWidths: [120, 80] }),
      { rowIndex: 1, colIndex: 0 },
      { kind: 'insert-column', side: 'after' }
    )
    expect(next && labels(next)).toEqual([
      ['H1', '', 'H2'],
      ['a', '', 'b'],
      ['c', '', 'd']
    ])
    expect(next?.columnWidths).toEqual([120, undefined, 80])
  })

  it('deletes a column with its width, and refuses the last one', () => {
    const next = applyTableStructureOp(
      table(GRID, { columnWidths: [120, 80] }),
      { rowIndex: 0, colIndex: 1 },
      { kind: 'delete-column' }
    )
    expect(next && labels(next)).toEqual([['H1'], ['a'], ['c']])
    expect(next?.columnWidths).toEqual([120])

    const single = table([['H1'], ['a'], ['b']])
    expect(
      applyTableStructureOp(single, { rowIndex: 1, colIndex: 0 }, { kind: 'delete-column' })
    ).toBeNull()
  })

  it('reorders rows inside the body only', () => {
    const down = applyTableStructureOp(
      table(GRID),
      { rowIndex: 1, colIndex: 0 },
      {
        kind: 'move-row',
        direction: 'down'
      }
    )
    expect(down && labels(down)).toEqual([
      ['H1', 'H2'],
      ['c', 'd'],
      ['a', 'b']
    ])

    // The first body row cannot climb into the header band, and the last one
    // cannot walk off the end.
    expect(
      applyTableStructureOp(
        table(GRID),
        { rowIndex: 1, colIndex: 0 },
        {
          kind: 'move-row',
          direction: 'up'
        }
      )
    ).toBeNull()
    expect(
      applyTableStructureOp(
        table(GRID),
        { rowIndex: 2, colIndex: 0 },
        {
          kind: 'move-row',
          direction: 'down'
        }
      )
    ).toBeNull()
  })

  it('reorders columns and carries their widths along', () => {
    const next = applyTableStructureOp(
      table(GRID, { columnWidths: [120, 80] }),
      { rowIndex: 1, colIndex: 1 },
      { kind: 'move-column', direction: 'start' }
    )
    expect(next && labels(next)).toEqual([
      ['H2', 'H1'],
      ['b', 'a'],
      ['d', 'c']
    ])
    expect(next?.columnWidths).toEqual([80, 120])

    expect(
      applyTableStructureOp(
        table(GRID),
        { rowIndex: 1, colIndex: 1 },
        {
          kind: 'move-column',
          direction: 'end'
        }
      )
    ).toBeNull()
  })

  it('refuses every structure operation on a table with a merged cell', () => {
    const merged = table(GRID)
    const first = merged.rows[1].cells[0] as { props: Record<string, unknown> }
    first.props.colspan = 2

    expect(hasMergedCells(merged)).toBe(true)
    expect(
      applyTableStructureOp(
        merged,
        { rowIndex: 1, colIndex: 0 },
        {
          kind: 'insert-row',
          side: 'below'
        }
      )
    ).toBeNull()
  })

  it('keeps the legacy bare-array cell shape when a table uses it', () => {
    const legacy: TableContentLike = {
      type: 'tableContent',
      headerRows: 1,
      rows: [{ cells: [[], []] }, { cells: [[], []] }, { cells: [[], []] }]
    }
    const next = applyTableStructureOp(
      legacy,
      { rowIndex: 1, colIndex: 0 },
      {
        kind: 'insert-row',
        side: 'below'
      }
    )
    expect(next?.rows).toHaveLength(4)
    expect(next?.rows[2].cells).toEqual([[], []])
  })
})

/** A resolved position shaped like ProseMirror's, for the cursor reader. */
function surface(path: { name: string; index: number }[]): TableEditorSurface {
  const $from = {
    depth: path.length - 1,
    node: (depth: number) => ({ type: { name: path[depth]?.name ?? 'doc' } }),
    index: (depth: number) => path[depth]?.index ?? 0
  }
  return { transact: (cb) => cb({ selection: { $from } }) }
}

describe('readTableCursor', () => {
  it('reads the row and column off the resolved position', () => {
    // doc > blockContainer > table > tableRow > tableCell > tableParagraph
    const cursor = readTableCursor(
      surface([
        { name: 'doc', index: 0 },
        { name: 'blockContainer', index: 0 },
        { name: 'table', index: 2 },
        { name: 'tableRow', index: 1 },
        { name: 'tableCell', index: 0 },
        { name: 'tableParagraph', index: 0 }
      ])
    )
    expect(cursor).toEqual({ rowIndex: 2, colIndex: 1 })
  })

  it('treats a header cell as a cell', () => {
    const cursor = readTableCursor(
      surface([
        { name: 'doc', index: 0 },
        { name: 'blockContainer', index: 0 },
        { name: 'table', index: 0 },
        { name: 'tableRow', index: 3 },
        { name: 'tableHeader', index: 0 },
        { name: 'tableParagraph', index: 0 }
      ])
    )
    expect(cursor).toEqual({ rowIndex: 0, colIndex: 3 })
  })

  it('is null outside a table', () => {
    expect(
      readTableCursor(
        surface([
          { name: 'doc', index: 0 },
          { name: 'blockContainer', index: 0 },
          { name: 'paragraph', index: 0 }
        ])
      )
    ).toBeNull()
  })
})

describe('paste into a cell', () => {
  const inCell = surface([
    { name: 'doc', index: 0 },
    { name: 'blockContainer', index: 0 },
    { name: 'table', index: 0 },
    { name: 'tableRow', index: 0 },
    { name: 'tableCell', index: 0 },
    { name: 'tableParagraph', index: 0 }
  ])
  const outside = surface([
    { name: 'doc', index: 0 },
    { name: 'blockContainer', index: 0 },
    { name: 'paragraph', index: 0 }
  ])

  it('stops `text/plain` being read as markdown inside a cell', () => {
    const defaultPasteHandler = vi.fn(() => true)
    handleCellPaste(inCell, { defaultPasteHandler })
    expect(defaultPasteHandler).toHaveBeenCalledWith({
      prioritizeMarkdownOverHTML: false,
      plainTextAsMarkdown: false
    })
  })

  it('leaves paste alone everywhere else', () => {
    const defaultPasteHandler = vi.fn(() => true)
    handleCellPaste(outside, { defaultPasteHandler })
    expect(defaultPasteHandler).toHaveBeenCalledWith()
  })
})

function toolbarActions(): EditorToolbarActions {
  return {
    insert: vi.fn(),
    tableAction: vi.fn(),
    styleAction: vi.fn(),
    turnInto: vi.fn(),
    toggleStyle: vi.fn(),
    toggleBulletedList: vi.fn(),
    createLink: vi.fn(),
    focusEditor: vi.fn(),
    insertWikiLink: vi.fn(),
    insertImage: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    dismissKeyboard: vi.fn(),
    openBlockActions: vi.fn(),
    blockAction: vi.fn()
  }
}

function button(name: string): HTMLButtonElement {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.getAttribute('aria-label') === name
  )
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`)
  return match
}

function selection(table: EditorToolbarSelection['table']): EditorToolbarSelection {
  return {
    blockLabel: 'T',
    alignment: 'left',
    textColour: 'default',
    backgroundColour: 'default',
    canNest: false,
    canUnnest: false,
    table,
    activeStyles: { bold: false, italic: false, underline: false, strike: false, code: false }
  }
}

describe('table panel', () => {
  it('shows the Table button only while the caret is in a cell', () => {
    document.body.replaceChildren()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const controller = installEditorToolbar(host, toolbarActions())
    controller.setKeyboardVisible(true)

    expect(document.querySelector('[aria-label="Table"]')).toBeNull()

    controller.update(selection({ structureLocked: false }))
    expect(document.querySelector('[aria-label="Table"]')).not.toBeNull()

    controller.update(selection(null))
    expect(document.querySelector('[aria-label="Table"]')).toBeNull()
  })

  it('dispatches the picked row and column operations', () => {
    document.body.replaceChildren()
    const actions = toolbarActions()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const controller = installEditorToolbar(host, actions)
    controller.setKeyboardVisible(true)
    controller.update(selection({ structureLocked: false }))

    button('Table').click()
    button('Insert below').click()

    expect(actions.tableAction).toHaveBeenCalledWith({
      kind: 'structure',
      op: { kind: 'insert-row', side: 'below' }
    })
    // A structure operation keeps the panel up, so a second row is one tap away.
    expect(controller.isPanelOpen()).toBe(true)

    button('Delete table').click()
    expect(actions.tableAction).toHaveBeenLastCalledWith({ kind: 'delete-table' })
    expect(controller.isPanelOpen()).toBe(false)
  })

  it('offers the two inline specs a cell can hold', () => {
    document.body.replaceChildren()
    const actions = toolbarActions()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const controller = installEditorToolbar(host, actions)
    controller.setKeyboardVisible(true)
    controller.update(selection({ structureLocked: false }))

    button('Table').click()
    button('Checkbox').click()
    expect(actions.tableAction).toHaveBeenCalledWith({ kind: 'inline-checkbox' })

    controller.update(selection({ structureLocked: false }))
    button('Table').click()
    button('Image').click()
    expect(actions.tableAction).toHaveBeenCalledWith({ kind: 'inline-image' })
  })

  it('hides the structure rows and says why when the table has merged cells', () => {
    document.body.replaceChildren()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const controller = installEditorToolbar(host, toolbarActions())
    controller.setKeyboardVisible(true)
    controller.update(selection({ structureLocked: true }))

    button('Table').click()

    expect(document.querySelector('[aria-label="Insert below"]')).toBeNull()
    expect(document.querySelector('[aria-label="Delete column"]')).toBeNull()
    // The cell and table-level rows survive: neither re-indexes anything.
    expect(button('Checkbox')).toBeInstanceOf(HTMLButtonElement)
    expect(document.querySelector('.editor-picker-note')?.textContent).toContain('merged cells')
  })

  it('closes itself when the caret leaves the table', () => {
    document.body.replaceChildren()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const controller = installEditorToolbar(host, toolbarActions())
    controller.setKeyboardVisible(true)
    controller.update(selection({ structureLocked: false }))
    button('Table').click()
    expect(controller.isPanelOpen()).toBe(true)

    controller.update(selection(null))
    expect(controller.isPanelOpen()).toBe(false)
  })

  it('covers every table action the panel can produce', () => {
    const kinds = new Set(TABLE_PICKER_GROUPS.flatMap((g) => g.items.map((i) => i.action.kind)))
    expect([...kinds].sort()).toEqual([
      'delete-table',
      'inline-checkbox',
      'inline-image',
      'structure'
    ])
  })
})

/**
 * The pure transforms above are only worth anything if BlockNote accepts what
 * they produce. This drives a real editor built from the mobile schema, so the
 * `tableContent` written back is the one the shared Y.Doc carries.
 */
describe('against a live editor', () => {
  function liveEditor() {
    const editor = BlockNoteEditor.create({
      schema: createMobileEditorSchema(),
      initialContent: [
        { type: 'paragraph', content: 'intro' },
        {
          type: 'table',
          content: {
            type: 'tableContent',
            headerRows: 1,
            rows: [{ cells: ['H1', 'H2'] }, { cells: ['a', 'b'] }, { cells: ['c', 'd'] }]
          }
        }
      ]
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    editor.mount(host)
    return editor
  }

  function tableBlock(editor: ReturnType<typeof liveEditor>) {
    const block = editor.document.find((candidate) => candidate.type === 'table')
    if (!block) throw new Error('no table block')
    return block
  }

  function text(editor: ReturnType<typeof liveEditor>): string[][] {
    return labels(tableBlock(editor).content as unknown as TableContentLike)
  }

  it('puts the caret in a cell on the table block, which is what the toolbar keys off', () => {
    const editor = liveEditor()
    editor.setTextCursorPosition(tableBlock(editor), 'start')

    expect(editor.getTextCursorPosition().block.type).toBe('table')
    expect(readTableCursor(editor as unknown as TableEditorSurface)).toEqual({
      rowIndex: 0,
      colIndex: 0
    })
  })

  it('accepts a row inserted by the pure transform', () => {
    const editor = liveEditor()
    const block = tableBlock(editor)
    const next = applyTableStructureOp(
      block.content as unknown as TableContentLike,
      { rowIndex: 1, colIndex: 0 },
      { kind: 'insert-row', side: 'below' }
    )
    expect(next).not.toBeNull()
    editor.updateBlock(block, { content: next as never })

    expect(text(editor)).toEqual([
      ['H1', 'H2'],
      ['a', 'b'],
      ['', ''],
      ['c', 'd']
    ])
  })

  it('accepts a deleted column and a reordered row', () => {
    const editor = liveEditor()
    const dropped = applyTableStructureOp(
      tableBlock(editor).content as unknown as TableContentLike,
      { rowIndex: 1, colIndex: 1 },
      { kind: 'delete-column' }
    )
    editor.updateBlock(tableBlock(editor), { content: dropped as never })
    expect(text(editor)).toEqual([['H1'], ['a'], ['c']])

    const swapped = applyTableStructureOp(
      tableBlock(editor).content as unknown as TableContentLike,
      { rowIndex: 1, colIndex: 0 },
      { kind: 'move-row', direction: 'down' }
    )
    editor.updateBlock(tableBlock(editor), { content: swapped as never })
    expect(text(editor)).toEqual([['H1'], ['c'], ['a']])
  })

  it('takes an inline checkbox and an inline image inside a cell', () => {
    const editor = liveEditor()
    editor.setTextCursorPosition(tableBlock(editor), 'start')
    editor.insertInlineContent([createInlineCheckboxContent(false), ' '])
    editor.insertInlineContent([createInlineImageContent('attachments/n1/shot.png', 'shot')])

    const cells = (tableBlock(editor).content as unknown as TableContentLike).rows[0].cells
    const types = (cells[0] as { content: { type: string }[] }).content.map((run) => run.type)
    expect(types).toContain('inlineCheckbox')
    expect(types).toContain('inlineImage')
  })
})
