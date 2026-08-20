import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { TextSelection } from '@tiptap/pm/state'
import { handleEditorPaste, isSelectionInTableCell } from './table-cell-paste'
import { parseMarkdownPreservingBlanks, serializeBlocksPreservingBlanks } from './markdown-utils'
import type { Block } from './types'

// Issue #1641: "I can't even cut and paste the text into the row and have to
// re-write it." These run against a real mounted BlockNote editor and a real
// clipboard payload, because the damage happens inside ProseMirror's paste
// pipeline — a mocked editor would report success either way.
//
// Uses the default BlockNote schema: it already carries the table blocks, and
// the custom schema's extra specs drag react-pdf into jsdom.

/* eslint-disable @typescript-eslint/no-explicit-any */

// jsdom ships neither, and BlockNote's paste path constructs both.
class FakeDataTransfer {
  private readonly store = new Map<string, string>()
  readonly files: unknown[] = []

  clearData(): void {
    this.store.clear()
  }

  setData(type: string, value: string): void {
    this.store.set(type, value)
  }

  getData(type: string): string {
    return this.store.get(type) ?? ''
  }

  get types(): string[] {
    return [...this.store.keys()]
  }
}

beforeEach(() => {
  if ((globalThis as any).ClipboardEvent) return
  class StubClipboardEvent extends Event {
    clipboardData = new FakeDataTransfer()
  }
  ;(globalThis as any).ClipboardEvent = StubClipboardEvent
})

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

function mountEditor(): BlockNoteEditor {
  const editor = BlockNoteEditor.create({
    pasteHandler: handleEditorPaste,
    initialContent: [
      { type: 'paragraph', content: 'Intro' },
      {
        type: 'table',
        content: {
          type: 'tableContent',
          headerRows: 1,
          rows: [
            { cells: ['Task', 'Owner'] },
            { cells: ['Ship it', 'Kaan'] },
            { cells: ['Review', 'Nobody'] }
          ]
        }
      }
    ] as any
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el })
  return editor
}

function view(editor: BlockNoteEditor): any {
  return (editor as any).prosemirrorView
}

/** Document position of a run of text, so a test can aim at one cell by name. */
function findText(editor: BlockNoteEditor, needle: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null
  view(editor).state.doc.descendants((node: any, pos: number) => {
    if (found || !node.isText || node.text !== needle) return
    found = { from: pos, to: pos + needle.length }
  })
  if (!found) throw new Error(`no text node reads "${needle}"`)
  return found
}

function placeCursorAfter(editor: BlockNoteEditor, cellText: string): void {
  const { to } = findText(editor, cellText)
  select(editor, to, to)
}

function select(editor: BlockNoteEditor, from: number, to: number): void {
  const v = view(editor)
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, from, to)))
}

function dispatchClipboardEvent(
  editor: BlockNoteEditor,
  type: 'copy' | 'cut' | 'paste',
  data: FakeDataTransfer
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: data })

  if (type === 'paste') {
    view(editor).dom.dispatchEvent(event)
    return
  }

  // BlockNote's copy handler bails out when the DOM selection is collapsed,
  // which under jsdom it always is — the real selection lives in ProseMirror.
  const realGetSelection = window.getSelection
  window.getSelection = (() => ({ isCollapsed: false, focusNode: null })) as any
  try {
    view(editor).dom.dispatchEvent(event)
  } finally {
    window.getSelection = realGetSelection
  }
}

function pastePlainText(editor: BlockNoteEditor, text: string): void {
  const data = new FakeDataTransfer()
  data.setData('text/plain', text)
  dispatchClipboardEvent(editor, 'paste', data)
}

/** The table's cells as plain strings, row by row. */
function tableCells(editor: BlockNoteEditor): string[][] {
  const table = editor.document.find((block) => block.type === 'table') as any
  if (!table) throw new Error('the document lost its table')
  return table.content.rows.map((row: any) =>
    row.cells.map((cell: any) =>
      (cell.content ?? [])
        .map((inline: any) => (inline.type === 'text' ? inline.text : `<${inline.type}>`))
        .join('')
    )
  )
}

describe('pasting into a table cell', () => {
  it('drops a plain sentence into the cell holding the cursor', () => {
    const editor = mountEditor()
    placeCursorAfter(editor, 'Ship it')

    pastePlainText(editor, ' today')

    expect(tableCells(editor)).toEqual([
      ['Task', 'Owner'],
      ['Ship it today', 'Kaan'],
      ['Review', 'Nobody']
    ])
  })

  it('keeps multi-line text inside the one cell instead of splitting the row', () => {
    const editor = mountEditor()
    placeCursorAfter(editor, 'Review')

    pastePlainText(editor, 'first line\nsecond line')

    const cells = tableCells(editor)
    expect(cells).toHaveLength(3)
    expect(cells.every((row) => row.length === 2)).toBe(true)
    expect(cells[2][0]).toContain('first line')
    expect(cells[2][0]).toContain('second line')
  })

  it('pastes text that looks like a markdown table as text, leaving the row alone', () => {
    const editor = mountEditor()
    placeCursorAfter(editor, 'Nobody')

    // Read as markdown this is a 2x2 table, and prosemirror-tables used to
    // splice its cells over the row — wiping "Nobody" and growing a column.
    pastePlainText(editor, '| a | b |\n| - | - |\n| 1 | 2 |')

    const cells = tableCells(editor)
    expect(cells.every((row) => row.length === 2)).toBe(true)
    expect(cells[2][1]).toContain('Nobody')
    expect(cells[2][1]).toContain('| a | b |')
  })

  it('pastes text that looks like a markdown list as text', () => {
    const editor = mountEditor()
    placeCursorAfter(editor, 'Nobody')

    pastePlainText(editor, '- one\n- two')

    const cells = tableCells(editor)
    expect(cells.every((row) => row.length === 2)).toBe(true)
    expect(cells[2][1]).toContain('- one')
    expect(cells[2][1]).toContain('- two')
  })

  it('leaves the default handler untouched outside a table', () => {
    const editor = mountEditor()
    const intro = findText(editor, 'Intro')
    select(editor, intro.to, intro.to)

    expect(isSelectionInTableCell(editor)).toBe(false)

    // Outside a cell the handler must forward with no options at all, so
    // BlockNote keeps reading pasted text as markdown everywhere else.
    const calls: Array<unknown> = []
    handleEditorPaste({
      editor,
      defaultPasteHandler: (options) => {
        calls.push(options)
        return true
      }
    } as any)
    expect(calls).toEqual([undefined])
  })

  it('turns markdown parsing off inside a cell', () => {
    const editor = mountEditor()
    placeCursorAfter(editor, 'Nobody')

    expect(isSelectionInTableCell(editor)).toBe(true)

    const calls: Array<unknown> = []
    handleEditorPaste({
      editor,
      defaultPasteHandler: (options) => {
        calls.push(options)
        return true
      }
    } as any)
    expect(calls).toEqual([{ prioritizeMarkdownOverHTML: false, plainTextAsMarkdown: false }])
  })

  it('moves text from one cell to another on cut and paste', () => {
    const editor = mountEditor()
    const source = findText(editor, 'Nobody')
    select(editor, source.from, source.to)

    const clipboard = new FakeDataTransfer()
    dispatchClipboardEvent(editor, 'cut', clipboard)
    expect(tableCells(editor)[2][1]).toBe('')

    placeCursorAfter(editor, 'Kaan')
    dispatchClipboardEvent(editor, 'paste', clipboard)

    expect(tableCells(editor)).toEqual([
      ['Task', 'Owner'],
      ['Ship it', 'KaanNobody'],
      ['Review', '']
    ])
  })

  it('still pastes a copied cell range as a range', () => {
    const editor = mountEditor()
    const start = findText(editor, 'Ship it')
    const end = findText(editor, 'Kaan')
    select(editor, start.from, end.to)

    const clipboard = new FakeDataTransfer()
    dispatchClipboardEvent(editor, 'copy', clipboard)
    expect(clipboard.types).toContain('blocknote/html')

    placeCursorAfter(editor, 'Review')
    dispatchClipboardEvent(editor, 'paste', clipboard)

    // A range keeps its shape: the two copied cells land side by side.
    expect(tableCells(editor)[2].slice(0, 2)).toEqual(['Ship it', 'Kaan'])
  })

  it('keeps the pasted text through a save and reopen', async () => {
    const editor = mountEditor()
    placeCursorAfter(editor, 'Nobody')
    pastePlainText(editor, ' (unassigned)')

    const markdown = await serializeBlocksPreservingBlanks(editor, editor.document as Block[])
    expect(markdown).toContain('(unassigned)')

    const reopened = await parseMarkdownPreservingBlanks(editor, markdown)
    const table = reopened.find((block) => block.type === 'table') as any
    const reopenedCells = table.content.rows.map((row: any) =>
      row.cells.map((cell: any) =>
        (cell.content ?? []).map((inline: any) => inline.text ?? '').join('')
      )
    )
    expect(reopenedCells.at(-1)).toEqual(['Review', 'Nobody (unassigned)'])
  })
})
